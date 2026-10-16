const assert = require('node:assert/strict');
const {test} = require('node:test');
const {server, Sheet, fixture} = require('./fake-sheets.cjs');

test('opening the editor is read-only and preserves every source sheet identity', () => {
  const instance = server(), before = instance.source();
  instance.context.getEditorState();
  assert.equal(instance.source(), before); assert.equal(instance.sheets.size, 5);
});
test('adding a location touches only master and the selected world map', () => {
  const {context, sheets} = server();
  const original = JSON.stringify(sheets.get('Tableau Data').rows);
  context.addLocation({world: 'Nether', name: 'A', x: 0, z: 0, type: 'Base', owner: 'Player', showOnMap: true});
  assert.equal(sheets.get('Nether Data').rows.length, 2);
  assert.equal(JSON.stringify(sheets.get('Tableau Data').rows), original);
  assert.equal(sheets.get('Land Claim Data').rows.length, 2);
});
test('partial save can be retried without duplicating master entries', () => {
  const {context, sheets, lock} = server();
  const input = {world: 'Overworld', name: 'D', x: 10, z: 20, type: 'Base', owner: 'Player', showOnMap: true};
  sheets.get('Tableau Data').failWrite = true;
  assert.throws(() => context.addLocation(input), /master entry was saved/);
  assert.equal(lock.held, false);
  context.addLocation(input); context.addLocation(input);
  assert.equal(sheets.get('Master Locations').rows.filter(row => row[1] === 'D').length, 1);
  assert.equal(sheets.get('Tableau Data').rows.filter(row => row[2] === 'D').length, 1);
});
test('stale connection previews are rejected; fresh ones append exactly two rows', () => {
  const {context, sheets} = server();
  const input = {world: 'Overworld', source: 'A', destinations: ['Café 🌳']};
  const preview = context.previewConnections(input);
  context.addConnections({...input, preview});
  assert.equal(sheets.get('Tableau Data').rows.length, fixture.length + 2);
  assert.throws(() => context.addConnections({...input, preview}), /changed since/);
});
test('document lock refuses a simultaneous save without mutation', () => {
  const instance = server(), before = instance.source(); instance.lock.denied = true;
  assert.throws(() => instance.context.prepareRelease(), /Another editor/);
  assert.equal(instance.source(), before); assert.equal(instance.sheets.size, 5);
});
test('prepare and approve preserve Tableau-connected tabs and use the exact snapshot', () => {
  const instance = server(), before = instance.source();
  const draft = instance.context.prepareRelease();
  assert.equal(draft.status, 'draft');
  const approved = instance.context.approveRelease({releaseId: draft.release_id, tableauConfirmed: true});
  assert.equal(approved.status, 'approved'); assert.ok(approved.approved_at);
  assert.equal(instance.source(), before);
  assert.equal(JSON.stringify(instance.sheets.get('_App Export').rows), JSON.stringify(fixture));
});
test('approval requires confirmation and rejects changes to source or snapshot', () => {
  for (const tab of ['Tableau Data', '_App Export']) {
    const {context, sheets} = server(); const draft = context.prepareRelease();
    assert.throws(() => context.approveRelease({releaseId: draft.release_id, tableauConfirmed: false}), /confirm/);
    sheets.get(tab).rows[3][3] = 999;
    assert.throws(() => context.approveRelease({releaseId: draft.release_id, tableauConfirmed: true}), /changed after/);
  }
});
test('new preparation invalidates previous approval before any export overwrite', () => {
  const {context, sheets} = server(); const draft = context.prepareRelease();
  context.approveRelease({releaseId: draft.release_id, tableauConfirmed: true});
  sheets.get('_App Export').failWrite = true;
  assert.throws(() => context.prepareRelease(), /write failure/);
  assert.equal(context.getEditorState().release.status, 'preparing');
});
test('existing unowned internal tabs are never overwritten', () => {
  const {context, sheets} = server(); const sheet = new Sheet('_App Export', [['Keep me']], 99); sheets.set('_App Export', sheet);
  assert.throws(() => context.prepareRelease(), /not owned/);
  assert.deepEqual(sheet.rows, [['Keep me']]);
});

const editInput = context => ({action: 'location', revision: context.getEditorState().revision,
  world: 'Overworld', originalName: 'A', name: 'New A', x: 15, z: -25, type: 'Town', owner: 'New Player'});
const railInput = context => ({action: 'rails', revision: context.getEditorState().revision,
  world: 'Overworld', source: 'A', destinations: []});

test('edit preview is read-only; a confirmed edit preserves sheet IDs, headers, and export approval', () => {
  const instance = server(), {context, sheets} = instance;
  const draft = context.prepareRelease();
  context.approveRelease({releaseId: draft.release_id, tableauConfirmed: true});
  const before = instance.source(), snapshot = JSON.stringify(sheets.get('_App Export').rows);
  const ids = [...sheets.values()].map(sheet => sheet.id);
  const headers = [...sheets.values()].map(sheet => sheet.rows[0]);
  const input = editInput(context), preview = context.previewEdit(input);
  assert.equal(instance.source(), before);
  context.applyEdit(input, preview.token, true);
  assert.deepEqual([...sheets.values()].map(sheet => sheet.id), ids);
  assert.deepEqual([...sheets.values()].map(sheet => sheet.rows[0]), headers);
  assert.equal(sheets.get('Master Locations').rows[1][1], 'New A');
  assert.equal(sheets.get('Tableau Data').rows[1][2], 'New A');
  assert.equal(sheets.get('Land Claim Data').rows[1][2], 'New A');
  assert.equal(JSON.stringify(sheets.get('_App Export').rows), snapshot);
  assert.equal(context.getEditorState().release.status, 'approved');
});
test('stale forms, stale previews, and tampered edit inputs cannot overwrite newer data', () => {
  const instance = server(), {context, sheets} = instance;
  const input = editInput(context), preview = context.previewEdit(input);
  assert.throws(() => context.applyEdit({...input, owner: 'Tampered'}, preview.token, true), /match its preview/);
  sheets.get('Land Claim Data').rows[1][4] = 99;
  const before = instance.source();
  assert.throws(() => context.previewEdit(input), /changed since/);
  assert.throws(() => context.applyEdit(input, preview.token, true), /changed since/);
  assert.equal(instance.source(), before);
});
test('removals require explicit confirmation and preserve both endpoint locations', () => {
  const instance = server(), {context, sheets} = instance, before = instance.source();
  const input = railInput(context), preview = context.previewEdit(input);
  assert.equal(preview.destructive, true);
  assert.throws(() => context.applyEdit(input, preview.token, false), /Confirm the removal/);
  assert.equal(instance.source(), before);
  context.applyEdit(input, preview.token, true);
  assert.equal(context.getEditorState().connections.length, 0);
  assert.equal(sheets.get('Tableau Data').rows[1][2], 'A');
  assert.equal(sheets.get('Tableau Data').rows[2][2], 'B');
  assert.throws(() => context.applyEdit(input, preview.token, true), /changed since/);
});
test('edit preflight rejects protected cells before any source values change', () => {
  const instance = server(), {context, sheets} = instance, before = instance.source();
  const input = editInput(context), preview = context.previewEdit(input);
  sheets.get('Land Claim Data').protected = true;
  assert.throws(() => context.applyEdit(input, preview.token, true), /cannot edit/);
  assert.equal(instance.source(), before);
});
test('a write failure in any edited tab rolls back earlier writes and releases the lock', () => {
  for (const tab of ['Master Locations', 'Tableau Data', 'Land Claim Data']) {
    const instance = server(), {context, sheets, lock, properties} = instance, before = instance.source();
    const input = editInput(context), preview = context.previewEdit(input);
    sheets.get(tab).failWrite = true;
    assert.throws(() => context.applyEdit(input, preview.token, true), /original cell values were restored/);
    assert.equal(instance.source(), before);
    assert.equal(lock.held, false);
    assert.equal(properties.has('realm-tools:pending-edit'), false);
    context.applyEdit(input, preview.token, true);
    assert.equal(sheets.get('Master Locations').rows[1][1], 'New A');
  }
});
test('interrupted edits block further edits and publishing until source data is recovered', () => {
  const {context, sheets, properties} = server();
  const before = context.getEditorState().revision;
  properties.set('realm-tools:pending-edit', JSON.stringify({before, after: 'different-revision'}));
  sheets.get('Master Locations').rows[1][1] = 'Half-saved';
  assert.throws(() => context.prepareRelease(), /previous edit was interrupted/);
  assert.throws(() => context.getEditorState(), /previous edit was interrupted/);
  assert.throws(() => context.addLocation({}), /previous edit was interrupted/);
  sheets.get('Master Locations').rows[1][1] = 'A';
  context.getEditorState();
  assert.equal(properties.has('realm-tools:pending-edit'), false);
});
test('place deletion compacts only affected data, clears obsolete tail rows, and remains valid', () => {
  const {context, sheets} = server();
  const input = {...editInput(context), action: 'delete-location', originalName: 'Café 🌳'};
  const preview = context.previewEdit(input);
  assert.throws(() => context.applyEdit(input, preview.token, false), /Confirm/);
  context.applyEdit(input, preview.token, true);
  assert.equal(context.getEditorState().locations.some(place => place.name === 'Café 🌳'), false);
  assert.ok(sheets.get('Master Locations').rows[3].every(value => value === ''));
  assert.ok(sheets.get('Tableau Data').rows[3].every(value => value === ''));
});
test('edits after preparation cannot be approved as the old snapshot', () => {
  const {context} = server(), draft = context.prepareRelease();
  const input = editInput(context), preview = context.previewEdit(input);
  context.applyEdit(input, preview.token, true);
  assert.throws(() => context.approveRelease({releaseId: draft.release_id, tableauConfirmed: true}), /changed after/);
});
test('failed rollback leaves a persistent recovery guard until original values are restored', () => {
  const {context, sheets, properties} = server();
  const original = structuredClone(sheets.get('Master Locations').rows);
  const input = editInput(context), preview = context.previewEdit(input);
  sheets.get('Tableau Data').failWrite = true;
  sheets.get('Master Locations').failWriteAt = [2];
  assert.throws(() => context.applyEdit(input, preview.token, true), /recovery was incomplete/);
  assert.equal(properties.has('realm-tools:pending-edit'), true);
  assert.throws(() => context.prepareRelease(), /previous edit was interrupted/);
  sheets.get('Master Locations').rows = original;
  context.getEditorState();
  assert.equal(properties.has('realm-tools:pending-edit'), false);
});
test('a fully saved operation with an uncleared recovery marker can resume safely', () => {
  const {context, properties} = server();
  properties.set('realm-tools:pending-edit', JSON.stringify({before: 'old-revision', after: context.getEditorState().revision}));
  context.getEditorState();
  assert.equal(properties.has('realm-tools:pending-edit'), false);
});
test('world moves write the new map and remove obsolete old rows, preserving all sheet IDs', () => {
  const {context, sheets} = server();
  const ids = [...sheets.values()].map(sheet => sheet.id);
  const input = {...editInput(context), originalName: 'Café 🌳', newWorld: 'End', name: 'Moved café'};
  const preview = context.previewEdit(input);
  context.applyEdit(input, preview.token, true);
  assert.ok(context.getEditorState().locations.some(place => place.name === 'Moved café' && place.world === 'End'));
  assert.equal(context.getEditorState().locations.some(place => place.name === 'Café 🌳'), false);
  assert.equal(sheets.get('End Data').rows[1][2], 'Moved café');
  assert.deepEqual([...sheets.values()].map(sheet => sheet.id), ids);
});
test('formula-like claim literals are rejected before writing or executing them', () => {
  const instance = server(), {context, sheets} = instance;
  sheets.get('Land Claim Data').rows[1][1] = '=unsafe()';
  const before = instance.source(), input = editInput(context), preview = context.previewEdit(input);
  assert.throws(() => context.applyEdit(input, preview.token, true), /formula-like literal/);
  assert.equal(instance.source(), before);
});
test('moving or hiding internal tabs does not alter edits or snapshot publication', () => {
  const {context, sheets} = server(); context.prepareRelease();
  for (const name of ['_App Export', '_App Release']) {
    const sheet = sheets.get(name); sheet.hidden = true;
    sheets.delete(name); sheets.set(name, sheet);
  }
  const input = editInput(context), preview = context.previewEdit(input);
  context.applyEdit(input, preview.token, true);
  const draft = context.prepareRelease();
  context.approveRelease({releaseId: draft.release_id, tableauConfirmed: true});
  assert.equal(sheets.get('_App Export').hidden, true);
  assert.equal(sheets.get('_App Release').hidden, true);
  assert.equal(sheets.size, 7);
});

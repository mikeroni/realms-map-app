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

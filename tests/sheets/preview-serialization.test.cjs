const assert = require('node:assert/strict');
const {test} = require('node:test');
const {server, rpcCopy} = require('./fake-sheets.cjs');

function client(instance) {
  return (method, ...args) => rpcCopy(instance.context[method](
    ...rpcCopy(args, method === 'applyEdit')), true);
}

function ownerEdit(call) {
  return {action: 'location', revision: call('getEditorState').revision,
    world: 'Overworld', originalName: 'A', newWorld: 'Overworld',
    name: 'A', x: '0', z: '-1', type: 'Base', owner: 'New Owner'};
}

test('preview serialization sorts nested object keys, not arrays or scalar types', () => {
  const {context} = server();
  const value = {input: {owner: 'Éowyn', x: '0', destinations: ['B', 'A']},
    plan: {next: {maps: {Overworld: [['Origin', '', 'A', 0, -1, '', '']]}, claims: []},
      summary: ['Owner changed'], destructive: false}, optional: null};
  const encoded = context.previewJson_(value);
  assert.equal(context.previewJson_(rpcCopy(value, true)), encoded);
  assert.deepEqual(JSON.parse(encoded), value);
  assert.notEqual(context.previewJson_({...value, input: {...value.input, x: 0}}), encoded);
  assert.notEqual(context.previewJson_({...value, input: {...value.input, destinations: ['A', 'B']}}), encoded);
});

test('preview tokens ignore request key order without changing preview values', () => {
  const instance = server(), call = client(instance), input = ownerEdit(call);
  const before = instance.source();
  const first = instance.context.previewEdit(rpcCopy(input));
  const second = instance.context.previewEdit(rpcCopy(input, true));
  assert.notDeepEqual(Object.keys(rpcCopy(input)), Object.keys(rpcCopy(input, true)));
  assert.equal(JSON.stringify(first.summary), JSON.stringify(second.summary));
  assert.equal(first.token, second.token);
  assert.equal(instance.source(), before);
});

test('add a place then save three rails through independently serialized requests', () => {
  const instance = server(), call = client(instance);
  call('addLocation', {world: 'Overworld', name: 'New D', x: '10', z: '-20',
    type: 'Base', owner: 'Player', showOnMap: true});
  const input = {action: 'rails', revision: call('getEditorState').revision,
    world: 'Overworld', source: 'New D', destinations: ['A', 'B', 'Café 🌳']};
  const before = instance.source(), preview = call('previewEdit', input);
  assert.equal(instance.source(), before);
  assert.equal(preview.summary.length, 3);
  call('applyEdit', input, preview.token, true);
  const state = call('getEditorState');
  assert.equal(state.connections.filter(pair => pair.includes('New D')).length, 3);
  assert.equal(state.locations.filter(place => place.name === 'New D').length, 1);
  for (const target of input.destinations) {
    const rows = instance.sheets.get('Tableau Data').rows.filter(row => row[1] === 'New D to ' + target);
    assert.deepEqual(rows.map(row => [row[0], row[2]]), [['Origin', 'New D'], ['Destination', target]]);
  }
});

test('new disconnected place can be deleted after a separate preview request', () => {
  const instance = server(), call = client(instance);
  call('addLocation', {world: 'Overworld', name: 'Temporary D', x: 10, z: 20,
    type: '', owner: '', showOnMap: true});
  const input = {action: 'delete-location', revision: call('getEditorState').revision,
    world: 'Overworld', originalName: 'Temporary D'};
  const preview = call('previewEdit', input), before = instance.source();
  assert.throws(() => call('applyEdit', input, preview.token, false), /Confirm/);
  assert.equal(instance.source(), before);
  call('applyEdit', input, preview.token, true);
  assert.equal(call('getEditorState').locations.some(place => place.name === 'Temporary D'), false);
});

test('existing place accepts rail additions and removals across the RPC boundary', () => {
  const instance = server(), call = client(instance);
  for (const destinations of [['B', 'Café 🌳'], []]) {
    const input = {action: 'rails', revision: call('getEditorState').revision,
      world: 'Overworld', source: 'A', destinations};
    const preview = call('previewEdit', input);
    call('applyEdit', input, preview.token, true);
    const state = call('getEditorState');
    assert.equal(state.connections.filter(pair => pair.includes('A')).length, destinations.length);
    assert.equal(state.locations.length, 3);
  }
});

test('owner edit updates matching claims without changing geometry or frozen export', () => {
  const instance = server(), call = client(instance);
  const release = call('prepareRelease');
  call('approveRelease', {releaseId: release.release_id, tableauConfirmed: true});
  const exportBefore = JSON.stringify(instance.sheets.get('_App Export').rows);
  const claimBefore = instance.sheets.get('Land Claim Data').rows[1].slice();
  const input = ownerEdit(call), preview = call('previewEdit', input);
  call('applyEdit', input, preview.token, true);
  const claimAfter = instance.sheets.get('Land Claim Data').rows[1];
  assert.equal(call('getEditorState').locations.find(place => place.name === 'A').owner, 'New Owner');
  assert.equal(claimAfter[7], 'New Owner');
  assert.deepEqual(claimAfter.slice(0, 7), claimBefore.slice(0, 7));
  assert.equal(JSON.stringify(instance.sheets.get('_App Export').rows), exportBefore);
  assert.equal(call('getEditorState').release.status, 'approved');
  assert.throws(() => call('approveRelease', {releaseId: release.release_id, tableauConfirmed: true}), /Prepare a release/);
});

test('changed values and stale Sheet data still fail before any write', () => {
  const instance = server(), call = client(instance), input = ownerEdit(call);
  const preview = call('previewEdit', input), before = instance.source();
  for (const changed of [{...input, owner: 'Other Owner'}, {...input, x: '99'}]) {
    assert.throws(() => call('applyEdit', changed, preview.token, true), /match its preview/);
    assert.equal(instance.source(), before);
  }
  instance.sheets.get('Land Claim Data').rows[1][4] = 42;
  const newer = instance.source();
  assert.throws(() => call('applyEdit', input, preview.token, true), /changed since/);
  assert.equal(instance.source(), newer);
});

test('changing destination values or order invalidates the reviewed rail request', () => {
  const instance = server(), call = client(instance);
  const input = {action: 'rails', revision: call('getEditorState').revision,
    world: 'Overworld', source: 'A', destinations: ['B', 'Café 🌳']};
  const preview = call('previewEdit', input), before = instance.source();
  for (const destinations of [['B'], ['Café 🌳', 'B']]) {
    assert.throws(() => call('applyEdit', {...input, destinations}, preview.token, true), /match its preview/);
    assert.equal(instance.source(), before);
  }
});

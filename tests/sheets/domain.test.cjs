const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');
const {createHash} = require('node:crypto');

const root = join(__dirname, '../..');
const core = vm.runInNewContext(readFileSync(join(root, 'apps-script/Domain.gs'), 'utf8') + '\nRealmData;');
const plain = value => JSON.parse(JSON.stringify(value));
const place = (world, name, x = 0, z = 0) => [world, name, x, z, 'Base', 'Player'];
const master = [plain(core.masterHeader), place('Overworld', 'A'), place('Overworld', 'B', 80),
  place('Overworld', 'C', -20), place('Nether', 'A', 10)];
const maps = {
  Overworld: [plain(core.mapHeader), ['Origin', 'legacy-short-name', 'A', 0, 0, 'Base', 'Player'],
    ['Destination', 'legacy-short-name', 'B', 80, 0, 'Base', 'Player']],
  Nether: [plain(core.mapHeader)], End: [plain(core.mapHeader)],
};
const input = {world: 'Overworld', name: 'D', x: '0', z: '-32', type: 'Base', owner: 'Player', showOnMap: true};
const source = {master, maps, claims: [plain(core.claimHeader),
  [0, 'polygon', 'A', 0, -10, -20, 'Base', 'Player'], [0, 'polygon', 'A', 1, 10, 20, 'Base', 'Player']]};
const edit = {action: 'location', world: 'Overworld', originalName: 'A', name: 'New A', x: 5, z: 7, type: 'Town', owner: 'New Player'};

test('master locations are keyed by world; existing legacy path IDs survive', () => {
  const data = core.model(master, maps);
  assert.equal(data.places.size, 4);
  assert.ok(data.networks.Overworld.paths.has('legacy-short-name'));
});
test('new location adds a master row and a standalone point, including zero and negative coordinates', () => {
  const plan = plain(core.planLocation(master, maps, input));
  assert.deepEqual(plan.masterRows, [place('Overworld', 'D', 0, -32)]);
  assert.deepEqual(plan.mapRows, [['Origin', '', 'D', 0, -32, 'Base', 'Player']]);
});
test('master-only locations remain available for future connections', () => {
  assert.equal(core.planLocation(master, maps, {...input, showOnMap: false}).mapRows.length, 0);
  const result = plain(core.planConnections(master, maps, {world: 'Overworld', source: 'A', destinations: ['C']}));
  assert.equal(result.rows[1][2], 'C');
});
test('save is retry-safe after master entry succeeded but standalone map append failed', () => {
  const existing = [...master, place('Overworld', 'D', 0, -32)];
  assert.equal(core.planLocation(existing, maps, input).masterRows.length, 0);
  assert.equal(core.planLocation(existing, maps, input).mapRows.length, 1);
});
test('mapped places missing from master are preserved and can be explicitly registered', () => {
  const missing = master.filter(row => row[1] !== 'B');
  assert.equal(core.model(missing, maps).warnings.length, 1);
  const plan = core.planLocation(missing, maps, {...input, name: 'B', x: 80, z: 0});
  assert.equal(plan.masterRows.length, 1); assert.equal(plan.mapRows.length, 0);
});
test('reject mismatched metadata, case collisions, malformed coordinates, and formula inputs', () => {
  for (const changes of [{name: 'a'}, {name: 'A', x: 1}, {x: ''}, {x: null}, {x: true}, {x: 'NaN'},
    {z: 'Infinity'}, {x: '1.1'}, {name: '=IMPORTXML("url")'}, {name: 'Bad\nName'}]) {
    assert.throws(() => core.planLocation(master, maps, {...input, ...changes}));
  }
});
test('new paths are paired and bidirectional duplicates do not add rows', () => {
  const result = core.planConnections(master, maps, {world: 'Overworld', source: 'B', destinations: ['A', 'C', 'C']});
  assert.deepEqual(plain(result.added), ['B to C']);
  assert.equal(result.rows.length, 2);
  assert.deepEqual(plain(result.rows.map(row => row[0])), ['Origin', 'Destination']);
});
test('self-links, missing destinations, and non-Overworld rail writes are rejected', () => {
  for (const value of [{world: 'Overworld', source: 'A', destinations: ['A']},
    {world: 'Overworld', source: 'A', destinations: ['Missing']},
    {world: 'Nether', source: 'A', destinations: ['B']}]) {
    assert.throws(() => core.planConnections(master, maps, value));
  }
});
test('path-name collisions get a new ID, never overwrite the existing path', () => {
  const custom = structuredClone(maps);
  custom.Overworld[1][1] = custom.Overworld[2][1] = 'A to C';
  assert.deepEqual(plain(core.planConnections(master, custom, {world: 'Overworld', source: 'A', destinations: ['C']}).added), ['A to C (2)']);
});
test('malformed or duplicate connections and missing headers fail closed', () => {
  const variants = [maps.Overworld.slice(0, 2),
    [core.mapHeader, maps.Overworld[1], {...maps.Overworld[2]}],
    [...maps.Overworld, ...maps.Overworld.slice(1).map(row => [row[0], 'duplicate', ...row.slice(2)])]];
  for (const rows of variants) assert.throws(() => core.validateMap(rows, 'Overworld'));
  assert.throws(() => core.model([['wrong']], maps));
});
test('model rejects master/map disagreements without silently replacing either', () => {
  const changed = structuredClone(master); changed[1][2] = 999;
  assert.throws(() => core.model(changed, maps), /Master\/map mismatch/);
});
test('planning does not mutate any source rows or non-rail tabs', () => {
  const original = JSON.stringify({master, maps});
  core.planLocation(master, maps, input);
  core.planConnections(master, maps, {world: 'Overworld', source: 'A', destinations: ['C']});
  assert.equal(JSON.stringify({master, maps}), original);
});
test('canonical hash is stable across ordering and matches the Python release fixture', () => {
  const rows = JSON.parse(readFileSync(join(__dirname, 'release-fixture.json'), 'utf8'));
  const encoded = core.canonical(rows);
  assert.equal(encoded, core.canonical([rows[0], ...rows.slice(1).reverse()]));
  const hash = createHash('sha256').update(encoded).digest('hex');
  const expected = readFileSync(join(__dirname, 'release-fixture.sha256'), 'utf8').trim();
  assert.equal(hash, expected);
});

test('edits update master, every endpoint and claim metadata without changing path IDs or polygon geometry', () => {
  const original = JSON.stringify(source);
  const expanded = structuredClone(source);
  expanded.maps.Overworld.push(['Origin', '', 'A', 0, 0, 'Base', 'Player']);
  const plan = plain(core.planEdit(expanded, edit));
  assert.deepEqual(plan.next.master[1], ['Overworld', 'New A', 5, 7, 'Town', 'New Player']);
  for (const row of [plan.next.maps.Overworld[1], plan.next.maps.Overworld[3]]) {
    assert.deepEqual(row.slice(2), ['New A', 5, 7, 'Town', 'New Player']);
  }
  assert.equal(plan.next.maps.Overworld[1][1], 'legacy-short-name');
  assert.deepEqual(plan.next.maps.Overworld[2], maps.Overworld[2]);
  assert.deepEqual(plan.next.master[4], master[4]); // Same name in Nether is a different place.
  assert.deepEqual(plan.next.claims[1], [0, 'polygon', 'New A', 0, -10, -20, 'Town', 'New Player']);
  assert.deepEqual(plan.next.claims[2], [0, 'polygon', 'New A', 1, 10, 20, 'Town', 'New Player']);
  assert.deepEqual(plan.next.maps.Nether, maps.Nether);
  assert.equal(JSON.stringify(source), original);
});
test('owner edits apply only to the selected place, including all matching claim rows', () => {
  const plan = core.planEdit(source, {...edit, name: 'A', x: 0, z: 0, type: 'Base'});
  assert.equal(plan.next.master[1][5], 'New Player');
  assert.equal(plan.next.master[2][5], 'Player');
  assert.equal(plan.next.claims[2][7], 'New Player');
});
test('Nether and End edits preserve Overworld claims and other worlds', () => {
  const plan = core.planEdit(source, {...edit, world: 'Nether', x: 10, z: 0});
  assert.equal(plan.next.master[4][1], 'New A');
  assert.deepEqual(plain(plan.next.claims), source.claims);
  assert.deepEqual(plain(plan.next.maps.Overworld), maps.Overworld);
});
test('edits reject name collisions, invalid input, missing places, and unsupported claim schemas', () => {
  for (const changes of [{name: 'b'}, {name: '=SUM(A1)'}, {name: 'A,B'}, {owner: '=IMPORTXML(A1)'},
    {x: ''}, {z: 0.5}, {originalName: 'Missing'}, {world: 'Unknown'}]) {
    assert.throws(() => core.planEdit(source, {...edit, ...changes}));
  }
  assert.throws(() => core.planEdit({...source, claims: [['unknown']]}, edit), /column headings/);
});
test('conflicting claim owners/types and colliding claim labels fail without mutation', () => {
  for (const column of [6, 7]) {
    const changed = structuredClone(source); changed.claims[1][column] = 'Someone else';
    assert.throws(() => core.planEdit(changed, edit), /different/);
  }
  const changed = structuredClone(source);
  changed.claims.push([1, 'polygon', 'New A', 0, 50, 50, 'Base', 'Player']);
  assert.throws(() => core.planEdit(changed, edit), /Another land claim/);
});
test('case-only rename works, same-name places in other worlds stay untouched, and unchanged form is a no-op', () => {
  assert.equal(core.planEdit(source, {...edit, name: 'a'}).next.master[1][1], 'a');
  assert.equal(core.planEdit(source, {...edit, name: 'A', x: 0, z: 0, type: 'Base', owner: 'Player'}).summary.length, 0);
});
test('removing a rail link preserves endpoint points and adding another retains valid pairs', () => {
  const plan = core.planEdit(source, {action: 'rails', world: 'Overworld', source: 'A', destinations: ['C']});
  const network = core.validateMap(plan.next.maps.Overworld, 'Overworld');
  assert.equal(plan.destructive, true);
  assert.equal(network.paths.has('legacy-short-name'), false);
  assert.equal(network.paths.has('A to C'), true);
  assert.equal(network.places.size, 3);
  assert.deepEqual(plain(plan.next.maps.Overworld.find(row => row[2] === 'B')), ['Origin', '', 'B', 80, 0, 'Base', 'Player']);
  assert.deepEqual(plain(plan.next.master), master);
  assert.deepEqual(plain(plan.next.claims), source.claims);
});
test('reverse-direction removal works; unchanged checkboxes are a no-op', () => {
  const plan = core.planEdit(source, {action: 'rails', world: 'Overworld', source: 'B', destinations: []});
  assert.equal(core.validateMap(plan.next.maps.Overworld, 'Overworld').paths.size, 0);
  const unchanged = core.planEdit(source, {action: 'rails', world: 'Overworld', source: 'A', destinations: ['B']});
  assert.equal(unchanged.summary.length, 0);
  assert.deepEqual(plain(unchanged.next), source);
});
test('place removal refuses connected places and claims, but removes an unconnected place from master and map', () => {
  assert.throws(() => core.planEdit(source, {...edit, action: 'delete-location'}), /connection/);
  const disconnected = core.planEdit(source, {action: 'rails', world: 'Overworld', source: 'A', destinations: []}).next;
  assert.throws(() => core.planEdit(disconnected, {...edit, action: 'delete-location'}), /land-claim polygon/);
  const removed = core.planEdit(disconnected, {...edit, action: 'delete-location', originalName: 'B'});
  assert.equal(core.model(removed.next.master, removed.next.maps).places.has('Overworld\u0000b'), false);
  assert.equal(removed.destructive, true);
});
test('mapped-only locations can be edited without silently creating master entries', () => {
  const missing = {...source, master: master.filter(row => row[1] !== 'B')};
  const plan = core.planEdit(missing, {...edit, originalName: 'B', name: 'New B'});
  assert.equal(plan.next.master.length, missing.master.length);
  assert.equal(plan.next.maps.Overworld[2][2], 'New B');
});
test('world edits move standalone points, preserve coordinates, and leave unrelated worlds untouched', () => {
  const expanded = structuredClone(source);
  expanded.maps.Overworld.push(['Origin', '', 'C', -20, 0, 'Base', 'Player']);
  const plan = core.planEdit(expanded, {...edit, originalName: 'C', name: 'C', newWorld: 'End', x: -20, z: 0, type: 'Base', owner: 'Player'});
  assert.deepEqual(plain(plan.next.master[3]), ['End', 'C', -20, 0, 'Base', 'Player']);
  assert.equal(core.validateMap(plan.next.maps.Overworld, 'Overworld').places.has('Overworld\u0000c'), false);
  assert.deepEqual(plain(plan.next.maps.End[1]), ['Origin', '', 'C', -20, 0, 'Base', 'Player']);
  assert.deepEqual(plain(plan.next.claims), source.claims);
  assert.deepEqual(plain(plan.next.maps.Nether), maps.Nether);
});
test('world moves refuse connected places, land claims, invalid worlds, and target collisions', () => {
  assert.throws(() => core.planEdit(source, {...edit, newWorld: 'End'}), /connections before moving/);
  const disconnected = core.planEdit(source, {action: 'rails', world: 'Overworld', source: 'A', destinations: []}).next;
  assert.throws(() => core.planEdit(disconnected, {...edit, newWorld: 'End'}), /land-claim/);
  assert.throws(() => core.planEdit(source, {...edit, originalName: 'C', newWorld: 'Unknown'}), /Choose Overworld/);
  assert.throws(() => core.planEdit(source, {...edit, originalName: 'C', newWorld: 'Nether', name: 'A'}), /already has that name/);
});
test('a master-only world move does not add a map point unexpectedly', () => {
  const plan = core.planEdit(source, {...edit, originalName: 'C', newWorld: 'End'});
  assert.equal(plan.next.maps.End.length, 1);
  assert.equal(plan.next.master[3][0], 'End');
});
test('repeated rail remove/add cycles do not accumulate standalone duplicates', () => {
  let next = source;
  for (let cycle = 0; cycle < 4; cycle++) {
    next = core.planEdit(next, {action: 'rails', world: 'Overworld', source: 'A', destinations: []}).next;
    assert.equal(next.maps.Overworld.length, 3);
    next = core.planEdit(next, {action: 'rails', world: 'Overworld', source: 'A', destinations: ['B']}).next;
    assert.equal(next.maps.Overworld.length, 5);
  }
});

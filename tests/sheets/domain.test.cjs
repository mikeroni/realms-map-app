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

const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const vm = require('node:vm');
const {createHash, randomUUID} = require('node:crypto');
const root = join(__dirname, '../..');
const fixture = JSON.parse(readFileSync(join(__dirname, 'release-fixture.json'), 'utf8'));
const masterHeader = ['World', 'Location', 'X', 'Z', 'Type', 'Owner'];

class Sheet {
  constructor(name, rows, id) { this.name = name; this.rows = structuredClone(rows); this.id = id; this.capacity = 1000; }
  getSheetId() { return this.id; }
  getMaxRows() { return this.capacity; }
  insertRowsAfter(_, count) { this.capacity += count; }
  getLastRow() { return this.rows.length; }
  getDataRange() { return this.getRange(1, 1, Math.max(1, this.rows.length), Math.max(1, ...this.rows.map(row => row.length))); }
  getRange(start, column, count, width) {
    return {
      getValues: () => Array.from({length: count}, (_, index) => Array.from({length: width}, (_, col) => this.rows[start - 1 + index]?.[column - 1 + col] ?? '')),
      getFormulas: () => Array.from({length: count}, () => Array(width).fill('')),
      setValues: values => {
        if (this.failWrite) { this.failWrite = false; throw new Error('simulated write failure'); }
        values.forEach((row, index) => {
          this.rows[start - 1 + index] ||= [];
          row.forEach((value, col) => { this.rows[start - 1 + index][column - 1 + col] = value; });
        });
      },
    };
  }
  clearContents() { this.rows = []; }
}

function server() {
  const sheets = new Map();
  const properties = new Map();
  let sequence = 0;
  const add = (name, rows) => { const sheet = new Sheet(name, rows, ++sequence); sheets.set(name, sheet); return sheet; };
  add('Master Locations', [masterHeader, ['Overworld', 'A', 0, -1, 'Base', 'Player'],
    ['Overworld', 'B', 80, 0, 'Base', 'Player'], ['Overworld', 'Café 🌳', -20, 40, 'Landmark', 'Éowyn']]);
  add('Tableau Data', fixture); add('Nether Data', [fixture[0]]); add('End Data', [fixture[0]]);
  add('Land Claim Data', [['shapeId', 'X', 'Z'], [0, 1, 2]]);
  const book = {getSheetByName: name => sheets.get(name), insertSheet: name => add(name, []), getId: () => 'original-sheet-id'};
  const lock = {held: false, denied: false, tryLock() { if (this.denied || this.held) return false; this.held = true; return true; }, releaseLock() { this.held = false; }};
  const context = vm.createContext({
    SpreadsheetApp: {getActiveSpreadsheet: () => book, flush: () => {}},
    LockService: {getDocumentLock: () => lock},
    PropertiesService: {getDocumentProperties: () => ({getProperty: key => properties.get(key) ?? null, setProperty: (key, value) => properties.set(key, value)})},
    Utilities: {getUuid: randomUUID, DigestAlgorithm: {SHA_256: 'sha256'}, Charset: {UTF_8: 'utf8'},
      computeDigest: (_, value) => [...createHash('sha256').update(value).digest()]},
  });
  for (const name of ['Domain.gs', 'Code.gs']) vm.runInContext(readFileSync(join(root, 'apps-script', name), 'utf8'), context);
  return {context, sheets, lock, source: () => JSON.stringify([...sheets].filter(([name]) => !name.startsWith('_')).map(([name, sheet]) => [name, sheet.id, sheet.rows]))};
}

module.exports = {server, Sheet, fixture};

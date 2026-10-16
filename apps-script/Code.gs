/** @OnlyCurrentDoc */

const EXPORT_TAB = '_App Export';
const RELEASE_TAB = '_App Release';

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Realm tools').addItem('Locations and rails', 'showRealmEditor').addToUi();
}

function showRealmEditor() {
  SpreadsheetApp.getUi().showSidebar(HtmlService.createHtmlOutputFromFile('Sidebar').setTitle('Realm tools'));
}

function locked_(operation) {
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(10000)) throw new Error('Another editor is saving. Please try again.');
  try { return operation(SpreadsheetApp.getActiveSpreadsheet()); }
  finally {
    try { SpreadsheetApp.flush(); }
    finally { lock.releaseLock(); }
  }
}

function read_(book, name) {
  const sheet = book.getSheetByName(name);
  if (!sheet) throw new Error('Missing tab: ' + name + '. No existing tabs are renamed or replaced.');
  const range = sheet.getDataRange();
  if (range.getFormulas().some(row => row.some(Boolean))) {
    throw new Error(name + ' contains formulas. This editor expects literal source data; no formulas were changed.');
  }
  return range.getValues();
}

function source_(book) {
  return {
    master: read_(book, 'Master Locations'),
    maps: Object.fromEntries(Object.entries(RealmData.worlds).map(([world, tab]) => [world, read_(book, tab)])),
  };
}

function digest_(values) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, RealmData.canonical(values), Utilities.Charset.UTF_8)
    .map(byte => (byte & 255).toString(16).padStart(2, '0')).join('');
}

function append_(book, tab, rows) {
  if (!rows.length) return;
  const sheet = book.getSheetByName(tab);
  const last = sheet.getLastRow();
  if (last + rows.length > sheet.getMaxRows()) {
    sheet.insertRowsAfter(sheet.getMaxRows(), last + rows.length - sheet.getMaxRows());
  }
  sheet.getRange(last + 1, 1, rows.length, rows[0].length).setValues(rows);
  SpreadsheetApp.flush();
}

function getEditorState() {
  return locked_(book => {
    const source = source_(book);
    const data = RealmData.model(source.master, source.maps);
    return {
      locations: [...data.places.values()], warnings: data.warnings,
      connections: [...data.networks.Overworld.paths.values()].map(rows => [rows[0][2], rows[1][2]]),
      release: release_(book),
    };
  });
}

function addLocation(input) {
  return locked_(book => {
    const source = source_(book);
    const plan = RealmData.planLocation(source.master, source.maps, input);
    // Append only. If the second write fails, the identical request safely completes it on retry.
    append_(book, 'Master Locations', plan.masterRows);
    try { append_(book, RealmData.worlds[plan.world], plan.mapRows); }
    catch (error) { throw new Error('The master entry was saved, but the map row failed. Retry the same form. ' + error.message); }
    return {message: plan.name + ' saved.', name: plan.name, world: plan.world};
  });
}

function previewConnections(input) {
  return locked_(book => {
    const source = source_(book);
    return RealmData.planConnections(source.master, source.maps, input).added;
  });
}

function addConnections(input) {
  return locked_(book => {
    const source = source_(book);
    const plan = RealmData.planConnections(source.master, source.maps, input);
    if (JSON.stringify(plan.added) !== JSON.stringify(input.preview)) {
      throw new Error('Connections changed since your preview. Reload and preview again.');
    }
    append_(book, 'Tableau Data', plan.rows);
    return {message: plan.added.length + ' rail connection(s) added.'};
  });
}

function ownedSheet_(book, name, create) {
  const properties = PropertiesService.getDocumentProperties();
  const property = 'realm-tools:' + name;
  let sheet = book.getSheetByName(name);
  if (sheet && String(sheet.getSheetId()) !== properties.getProperty(property)) {
    throw new Error(name + ' already exists but is not owned by Realm tools. Nothing was overwritten.');
  }
  if (!sheet && create) {
    sheet = book.insertSheet(name);
    properties.setProperty(property, String(sheet.getSheetId()));
  }
  return sheet;
}

function release_(book) {
  const sheet = ownedSheet_(book, RELEASE_TAB, false);
  if (!sheet) return null;
  return Object.fromEntries(sheet.getDataRange().getValues().slice(1)
    .map(([key, value]) => [String(key), value == null ? '' : String(value)]));
}

function writeRelease_(sheet, metadata) {
  sheet.getRange(1, 1, Object.keys(metadata).length + 1, 2)
    .setValues([['key', 'value'], ...Object.entries(metadata)]);
  SpreadsheetApp.flush();
}

function prepareRelease() {
  return locked_(book => {
    const source = source_(book);
    RealmData.model(source.master, source.maps);
    const values = [RealmData.mapHeader, ...RealmData.validateMap(source.maps.Overworld, 'Overworld').rows];
    const digest = digest_(values);
    const exportSheet = ownedSheet_(book, EXPORT_TAB, true);
    const releaseSheet = ownedSheet_(book, RELEASE_TAB, true);
    const metadata = {
      schema: '1', status: 'preparing', release_id: Utilities.getUuid(), digest,
      source_spreadsheet_id: book.getId(), prepared_at: new Date().toISOString(), approved_at: '',
    };
    // Invalidate the old approval before changing the export. Readers also verify both metadata reads.
    writeRelease_(releaseSheet, metadata);
    exportSheet.clearContents();
    if (exportSheet.getMaxRows() < values.length) {
      exportSheet.insertRowsAfter(exportSheet.getMaxRows(), values.length - exportSheet.getMaxRows());
    }
    exportSheet.getRange(1, 1, values.length, 7).setValues(values);
    SpreadsheetApp.flush();
    metadata.status = 'draft';
    writeRelease_(releaseSheet, metadata);
    return metadata;
  });
}

function approveRelease(input) {
  return locked_(book => {
    const metadata = release_(book);
    if (!metadata || metadata.schema !== '1' || metadata.source_spreadsheet_id !== book.getId()
        || metadata.status !== 'draft' || metadata.release_id !== input.releaseId
        || input.tableauConfirmed !== true) {
      throw new Error('Prepare a release, verify Tableau, and check the confirmation first.');
    }
    const snapshot = read_(book, EXPORT_TAB);
    const current = read_(book, 'Tableau Data');
    if (digest_(snapshot) !== metadata.digest || digest_(current) !== metadata.digest) {
      throw new Error('Data changed after preparation. Prepare a new release and verify Tableau again.');
    }
    metadata.status = 'approved';
    metadata.approved_at = new Date().toISOString();
    writeRelease_(ownedSheet_(book, RELEASE_TAB, false), metadata);
    return metadata;
  });
}

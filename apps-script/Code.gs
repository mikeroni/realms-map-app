/** @OnlyCurrentDoc */

const EXPORT_TAB = '_App Export';
const RELEASE_TAB = '_App Release';
const EDIT_RECOVERY_KEY = 'realm-tools:pending-edit';

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Realm tools').addItem('Locations and rails', 'showRealmEditor').addToUi();
}

function showRealmEditor() {
  SpreadsheetApp.getUi().showSidebar(HtmlService.createHtmlOutputFromFile('Sidebar').setTitle('Realm tools'));
}

function locked_(operation) {
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(10000)) throw new Error('Another editor is saving. Please try again.');
  try {
    const book = SpreadsheetApp.getActiveSpreadsheet();
    checkRecovery_(book);
    return operation(book);
  }
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
    claims: read_(book, 'Land Claim Data'),
  };
}

function hash_(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8)
    .map(byte => (byte & 255).toString(16).padStart(2, '0')).join('');
}

function revision_(source) {
  // Empty trailing rows can disappear from getDataRange after a deletion/rollback.
  const trim = rows => {
    let end = rows.length;
    while (end > 1 && rows[end - 1].every(value => value === '')) end--;
    return rows.slice(0, end);
  };
  return hash_(JSON.stringify({master: trim(source.master),
    maps: Object.fromEntries(Object.entries(source.maps).map(([world, rows]) => [world, trim(rows)])),
    claims: trim(source.claims)}));
}

function checkRecovery_(book) {
  const properties = PropertiesService.getDocumentProperties();
  const pending = properties.getProperty(EDIT_RECOVERY_KEY);
  if (!pending) return;
  const {before, after} = JSON.parse(pending);
  const current = revision_(source_(book));
  if (current === before || current === after) properties.deleteProperty(EDIT_RECOVERY_KEY);
  else throw new Error('A previous edit was interrupted or could not be restored. Stop editing and restore the affected source data with Sheets version history, then reload. Publishing is blocked until the original or complete edited data is restored.');
}

function digest_(values) {
  return hash_(RealmData.canonical(values));
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
      revision: revision_(source),
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

function editPlan_(book, input) {
  const source = source_(book);
  if (input.revision !== revision_(source)) {
    throw new Error('Sheet data changed since you loaded it. Reload data and review the edit again.');
  }
  const plan = RealmData.planEdit(source, input);
  return {source, plan, token: hash_(JSON.stringify({source, input, plan}))};
}

function previewEdit(input) {
  return locked_(book => {
    const {plan, token} = editPlan_(book, input);
    return {token, summary: plan.summary, destructive: plan.destructive};
  });
}

function changedRanges_(before, after) {
  const tables = source => ({'Master Locations': source.master,
    ...Object.fromEntries(Object.entries(RealmData.worlds).map(([world, tab]) => [tab, source.maps[world]])),
    'Land Claim Data': source.claims});
  const oldTables = tables(before), newTables = tables(after), changes = [];
  for (const [tab, oldRows] of Object.entries(oldTables)) {
    const newRows = newTables[tab], width = oldRows[0].length;
    if (JSON.stringify(oldRows[0]) !== JSON.stringify(newRows[0])) throw new Error('An edit cannot change column headings.');
    let block;
    for (let index = 1; index < Math.max(oldRows.length, newRows.length); index++) {
      const oldRow = oldRows[index] || Array(width).fill('');
      const newRow = newRows[index] || Array(width).fill('');
      if (JSON.stringify(oldRow) === JSON.stringify(newRow)) { block = null; continue; }
      if (!block) { block = {tab, start: index + 1, width, before: [], after: []}; changes.push(block); }
      block.before.push(oldRow); block.after.push(newRow);
    }
  }
  return changes;
}

// SpreadsheetApp has no multi-tab transaction. Preflight every range, then keep
// originals for rollback on a reported failure. Never replace connected sheets.
function writeEdit_(book, changes, before, after) {
  for (const change of changes) {
    if ([...change.before, ...change.after].some(row => row.some(value => typeof value === 'string' && value.startsWith('=')))) {
      throw new Error('Affected rows contain formula-like literal text. Resolve it in the Sheet before editing. Nothing was saved.');
    }
    const sheet = book.getSheetByName(change.tab);
    const end = change.start + change.after.length - 1;
    if (end > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), end - sheet.getMaxRows());
    change.range = sheet.getRange(change.start, 1, change.after.length, change.width);
    if (!change.range.canEdit()) throw new Error('You cannot edit all affected cells in ' + change.tab + '. Nothing was saved.');
    if (JSON.stringify(change.range.getValues()) !== JSON.stringify(change.before)) {
      throw new Error('Cells changed while preparing the edit. Reload and review again.');
    }
  }
  const properties = PropertiesService.getDocumentProperties();
  properties.setProperty(EDIT_RECOVERY_KEY, JSON.stringify({before: revision_(before), after: revision_(after)}));
  const attempted = [];
  try {
    for (const change of changes) {
      attempted.push(change); // Include a range whose write might only partially succeed.
      change.range.setValues(change.after);
      SpreadsheetApp.flush();
      if (JSON.stringify(change.range.getValues()) !== JSON.stringify(change.after)) throw new Error('Could not verify saved cells in ' + change.tab + '.');
    }
    if (revision_(source_(book)) !== revision_(after)) throw new Error('Source data changed during this save.');
    properties.deleteProperty(EDIT_RECOVERY_KEY);
  } catch (error) {
    let restored = true;
    for (const change of attempted.reverse()) {
      try {
        change.range.setValues(change.before);
        SpreadsheetApp.flush();
        if (JSON.stringify(change.range.getValues()) !== JSON.stringify(change.before)) restored = false;
      } catch (_) { restored = false; }
    }
    if (restored) properties.deleteProperty(EDIT_RECOVERY_KEY);
    throw new Error((restored ? 'Save failed; original cell values were restored. Reload before retrying. '
      : 'Save failed and recovery was incomplete. Stop editing and restore the affected data with Sheets version history before publishing. ') + error.message);
  }
}

function applyEdit(input, token, confirmed) {
  return locked_(book => {
    const result = editPlan_(book, input);
    if (token !== result.token) throw new Error('The edit does not match its preview. Preview it again.');
    if (result.plan.destructive && confirmed !== true) throw new Error('Confirm the removal before saving.');
    const changes = changedRanges_(result.source, result.plan.next);
    if (!changes.length) return {message: 'No changes to save.'};
    writeEdit_(book, changes, result.source, result.plan.next);
    return {message: 'Changes saved. Refresh Tableau, then prepare and approve a new snapshot to update the app.'};
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

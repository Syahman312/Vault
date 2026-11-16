/**
 * Vault bridge — Google Apps Script backend for the Vault PWA.
 *
 *   PWA  --HTTPS POST (text/plain JSON, app key in body)-->  this web app
 *        --> Sheet "Vault Data" (index)
 *        --> Drive  Vault/<Category>/<Year>/  (files)
 *        --> Calendar "Vault"                 (expiry reminders)
 *
 * First run:  select `setup` in the editor toolbar and press Run.
 *             The app key is printed in the execution log — copy it once.
 * Lost key:   run `rotateKey`   (prints a new one, old one stops working).
 * Locked out: run `unlock`      (after 10 wrong keys the bridge locks itself).
 * Link key:   run `rotateLinkKey` (read-only key for Garage / Ledger / Flow).
 */

const VERSION = '1.0.0';

const CFG = {
  SHEET_NAME: 'Vault Data',
  ROOT_FOLDER: 'Vault',
  CALENDAR: 'Vault',
  MAX_FILE_BYTES: 20 * 1024 * 1024,
  CHUNK_RAW_BYTES: 3 * 1024 * 1024,     // client sends 3 MB raw (= 4 MB base64) per chunk
  DOWNLOAD_CHUNK: 3 * 1024 * 1024,
  RATE_PER_MIN: 150,
  MAX_FAILS: 10,
  TRASH_DAYS: 30,
  BACKUP_KEEP: 30,
  SHARE_HOURS: 24,
  LOG_KEEP: 3000,
};

const TABS = {
  Documents: ['ID', 'Created', 'Updated', 'Title', 'Category', 'Owner', 'DocNumber', 'Issuer',
    'IssueDate', 'ExpiryDate', 'RenewalLeadDays', 'Tags', 'Files', 'LinkedApp', 'LinkedID',
    'Notes', 'Status', 'Pinned', 'Extra', 'PrevID', 'Encrypted'],
  Categories: ['Name', 'Icon', 'Colour', 'FolderID', 'LeadDays', 'Fields', 'Encrypt', 'Order'],
  People: ['Name', 'Relationship', 'Colour'],
  Reminders: ['DocID', 'Date', 'Kind', 'CalendarEventID', 'Done'],
  Shares: ['ID', 'DocID', 'DriveID', 'Created', 'Expires', 'Revoked', 'Url'],
  _Log: ['Time', 'Action', 'DocID', 'Detail'],
  _Deleted: ['ID', 'DeletedAt', 'Title', 'Row', 'Purged', 'Restored'],
};

const SEED_CATEGORIES = [
  ['Identity', '🪪', '#5B8DEF', 30, 'IC / licence class'],
  ['Travel', '✈️', '#3FB6A8', 180, 'Country'],
  ['Vehicle', '🚗', '#E07A5F', 14, 'Plate no.'],
  ['Insurance', '🛡️', '#8E7CC3', 30, 'Sum insured, Premium'],
  ['Property', '🏠', '#C98B4A', 60, 'Address'],
  ['Finance & Tax', '💰', '#6AA84F', 30, 'Year of assessment'],
  ['Employment', '💼', '#4A90A4', 30, 'Employer'],
  ['Education (ACCA)', '🎓', '#D4A72C', 30, 'Paper / Level'],
  ['Medical', '🩺', '#E06C75', 30, 'Panel / Hospital'],
  ['Warranty & Receipts', '🧾', '#9AA0A6', 30, 'Purchase price, Shop'],
  ['Household', '🔑', '#7FB069', 30, ''],
  ['Wedding', '💍', '#E8A0BF', 30, ''],
];

const SEED_PEOPLE = [
  ['Me', 'Self', '#C9A227'],
  ['Wife', 'Spouse', '#E8A0BF'],
  ['Brother', 'Sibling', '#5B8DEF'],
  ['Household', 'Shared', '#9AA0A6'],
];

const WRITE_ACTIONS = {
  saveDoc: 1, renewDoc: 1, deleteDoc: 1, restoreDoc: 1, uploadChunk: 1, share: 1, revokeShare: 1,
  saveCategory: 1, savePerson: 1, deletePerson: 1, importAll: 1, setEnc: 1, setLinks: 1,
  backupNow: 1, rebuildReminders: 1,
};

/* ============================== HTTP ============================== */

function doGet() {
  return ContentService.createTextOutput('Vault bridge is running. This URL only accepts POST from the Vault app.');
}

function doPost(e) {
  let body = {};
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'bad_json' });
  }
  try {
    rateLimit_();
    const role = auth_(body);
    const action = String(body.action || '');
    if (role === 'link' && action !== 'list') throw new VaultError('forbidden');
    const fn = ACTIONS[action];
    if (!fn) throw new VaultError('unknown_action');
    if (body.appUrl && role === 'full') rememberAppUrl_(body.appUrl);
    let result;
    if (WRITE_ACTIONS[action]) {
      const lock = LockService.getScriptLock();
      if (!lock.tryLock(25000)) throw new VaultError('busy');
      try { result = fn(body); } finally { lock.releaseLock(); }
    } else {
      result = fn(body);
    }
    return json_(Object.assign({ ok: true }, result || {}));
  } catch (err) {
    const code = err instanceof VaultError ? err.message : 'server_error';
    if (!(err instanceof VaultError)) {
      console.error(err && err.stack || err);
      try { log_('error', '', String(err && err.message || err).slice(0, 300)); } catch (e2) {}
    }
    return json_({ ok: false, error: code, detail: err instanceof VaultError ? undefined : String(err && err.message || err).slice(0, 200) });
  }
}

class VaultError extends Error {}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ============================== Security ============================== */

function props_() { return PropertiesService.getScriptProperties(); }

function sha256_(s) {
  const raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8);
  return raw.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function safeEqual_(a, b) {
  a = String(a || ''); b = String(b || '');
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

function auth_(body) {
  const p = props_();
  if (!p.getProperty('KEY_HASH')) throw new VaultError('not_setup');
  if (p.getProperty('LOCKED') === '1') throw new VaultError('locked');
  const h = sha256_(String(body.key || ''));
  if (safeEqual_(h, p.getProperty('KEY_HASH'))) {
    if (p.getProperty('FAILS') && p.getProperty('FAILS') !== '0') p.setProperty('FAILS', '0');
    return 'full';
  }
  if (body.action === 'list' && p.getProperty('LINK_KEY_HASH') && safeEqual_(h, p.getProperty('LINK_KEY_HASH'))) return 'link';
  const fails = Number(p.getProperty('FAILS') || 0) + 1;
  p.setProperty('FAILS', String(fails));
  if (fails >= CFG.MAX_FAILS) {
    p.setProperty('LOCKED', '1');
    try { log_('locked', '', 'Bridge locked after ' + fails + ' bad keys'); } catch (e) {}
  }
  throw new VaultError('unauthorized');
}

function rateLimit_() {
  const cache = CacheService.getScriptCache();
  const k = 'rl_' + Math.floor(Date.now() / 60000);
  const n = Number(cache.get(k) || 0) + 1;
  cache.put(k, String(n), 120);
  if (n > CFG.RATE_PER_MIN) throw new VaultError('rate_limited');
}

function newKey_(len) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  while (out.length < len) {
    const hex = Utilities.getUuid().replace(/-/g, '') + sha256_(Utilities.getUuid() + Date.now() + Math.random());
    for (let i = 0; i + 1 < hex.length && out.length < len; i += 2) {
      const byte = parseInt(hex.substr(i, 2), 16);
      if (byte < 228) out += chars[byte % chars.length]; // 228 = 57*4 → no modulo bias
    }
  }
  return out;
}

function rememberAppUrl_(url) {
  url = String(url).split('#')[0];
  if (!/^https:\/\/[^\s]+$/.test(url) || url.length > 200) return;
  const p = props_();
  if (p.getProperty('APP_URL') !== url) p.setProperty('APP_URL', url);
}

/** Run once from the editor. Safe to re-run: it only creates what is missing. */
function setup() {
  const p = props_();
  const ss = getSS_(true);
  Object.keys(TABS).forEach(function (name) { ensureTab_(ss, name); });
  const def = ss.getSheetByName('Sheet1');
  if (def && ss.getSheets().length > 1) ss.deleteSheet(def);

  const root = rootFolder_();
  ['_Inbox', '_Trash', '_Tmp', 'Backups'].forEach(function (n) { subFolder_(root, n); });

  const cats = ss.getSheetByName('Categories');
  if (cats.getLastRow() < 2) {
    SEED_CATEGORIES.forEach(function (c, i) {
      const folder = subFolder_(root, c[0]);
      cats.appendRow([c[0], c[1], c[2], folder.getId(), c[3], c[4], c[0] === 'Identity' ? 'ask' : '', i + 1]);
    });
  }
  const people = ss.getSheetByName('People');
  if (people.getLastRow() < 2) SEED_PEOPLE.forEach(function (r) { people.appendRow(r); });

  calendar_();
  installTriggers_();

  if (!p.getProperty('KEY_HASH')) {
    const key = newKey_(48);
    const link = newKey_(32);
    p.setProperty('KEY_HASH', sha256_(key));
    p.setProperty('LINK_KEY_HASH', sha256_(link));
    p.setProperty('FAILS', '0');
    p.deleteProperty('LOCKED');
    log_('setup', '', 'Initial setup, version ' + VERSION);
    console.log('\n================ VAULT SETUP DONE ================\n' +
      'APP KEY (paste into the Vault app, keep it secret):\n\n' + key + '\n\n' +
      'LINK KEY (read-only, for Garage / Ledger / Flow):\n\n' + link + '\n\n' +
      'Sheet: ' + ss.getUrl() + '\nDrive folder: ' + root.getUrl() +
      '\nNext: Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone).\n' +
      '==================================================');
  } else {
    console.log('Setup checked — everything exists. Key unchanged (run rotateKey for a new one).\nSheet: ' + ss.getUrl());
  }
}

function rotateKey() {
  const key = newKey_(48);
  const p = props_();
  p.setProperty('KEY_HASH', sha256_(key));
  p.setProperty('FAILS', '0');
  p.deleteProperty('LOCKED');
  log_('rotateKey', '', 'App key rotated');
  console.log('NEW APP KEY (old key no longer works):\n\n' + key);
}

function rotateLinkKey() {
  const link = newKey_(32);
  props_().setProperty('LINK_KEY_HASH', sha256_(link));
  log_('rotateLinkKey', '', 'Link key rotated');
  console.log('NEW LINK KEY (read-only list access):\n\n' + link);
}

function unlock() {
  const p = props_();
  p.setProperty('FAILS', '0');
  p.deleteProperty('LOCKED');
  log_('unlock', '', 'Bridge unlocked from editor');
  console.log('Bridge unlocked. If you did not cause the lockout, run rotateKey too.');
}

function installTriggers_() {
  const have = {};
  ScriptApp.getProjectTriggers().forEach(function (t) { have[t.getHandlerFunction()] = true; });
  if (!have.dailyJob) ScriptApp.newTrigger('dailyJob').timeBased().everyDays(1).atHour(3).create();
  if (!have.hourlyJob) ScriptApp.newTrigger('hourlyJob').timeBased().everyHours(1).create();
  if (!have.onSheetEdit) ScriptApp.newTrigger('onSheetEdit').forSpreadsheet(getSS_().getId()).onEdit().create();
}

/* ============================== Sheet helpers ============================== */

function getSS_(create) {
  const p = props_();
  const id = p.getProperty('SHEET_ID');
  if (id) {
    try { return SpreadsheetApp.openById(id); } catch (e) { if (!create) throw new VaultError('sheet_missing'); }
  }
  if (!create) throw new VaultError('not_setup');
  // Script opened from a Sheet (Extensions → Apps Script)? Use that Sheet as the index.
  let bound = null;
  try { bound = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) {}
  if (bound) {
    bound.setSpreadsheetTimeZone('Asia/Kuala_Lumpur');
    p.setProperty('SHEET_ID', bound.getId());
    return bound;
  }
  const ss = SpreadsheetApp.create(CFG.SHEET_NAME);
  ss.setSpreadsheetTimeZone('Asia/Kuala_Lumpur');
  p.setProperty('SHEET_ID', ss.getId());
  try { DriveApp.getFileById(ss.getId()).moveTo(rootFolder_()); } catch (e) {}
  return ss;
}

function ensureTab_(ss, name) {
  let sh = ss.getSheetByName(name);
  const headers = TABS[name];
  if (!sh) sh = ss.insertSheet(name);
  // append any missing headers at the end (keeps existing columns where they are)
  const have = sh.getLastColumn() ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].filter(String) : [];
  const missing = headers.filter(function (h) { return have.indexOf(h) === -1; });
  if (missing.length) sh.getRange(1, have.length + 1, 1, missing.length).setValues([missing]);
  sh.setFrozenRows(1);
  sh.getRange(1, 1, 1, sh.getLastColumn()).setFontWeight('bold');
  // keep everything as plain text so dates / IDs are never auto-converted
  sh.getRange(1, 1, sh.getMaxRows(), sh.getLastColumn()).setNumberFormat('@');
  if (name.charAt(0) === '_') sh.setTabColor('#555555');
  return sh;
}

function sheet_(name) {
  const sh = getSS_().getSheetByName(name);
  if (!sh) throw new VaultError('tab_missing:' + name);
  return sh;
}

function cellStr_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Kuala_Lumpur', "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").replace(/T00:00:00\.000Z$/, '');
  return v === null || v === undefined ? '' : String(v);
}

/** Reads a tab into {headers, rows:[{_row, ...}]} */
function readTab_(name) {
  const sh = sheet_(name);
  const values = sh.getDataRange().getValues();
  const headers = values.shift() || [];
  const rows = values.map(function (r, i) {
    const o = { _row: i + 2 };
    headers.forEach(function (h, j) { if (h) o[h] = cellStr_(r[j]); });
    return o;
  }).filter(function (o) { return headers.some(function (h) { return h && o[h] !== ''; }); });
  return { sh: sh, headers: headers, rows: rows };
}

function writeRow_(sh, headers, rowNum, obj) {
  const vals = headers.map(function (h) { return obj[h] === undefined || obj[h] === null ? '' : String(obj[h]); });
  if (rowNum) sh.getRange(rowNum, 1, 1, headers.length).setValues([vals]);
  else {
    const r = sh.getLastRow() + 1;
    sh.getRange(r, 1, 1, headers.length).setNumberFormat('@').setValues([vals]);
  }
}

function log_(action, docId, detail) {
  const sh = getSS_().getSheetByName('_Log');
  if (!sh) return;
  sh.appendRow([new Date().toISOString(), action, docId || '', String(detail || '').slice(0, 500)]);
}

function nowIso_() { return new Date().toISOString(); }
function todayStr_() { return Utilities.formatDate(new Date(), 'Asia/Kuala_Lumpur', 'yyyy-MM-dd'); }

/** onEdit trigger: bump `Updated` when a Documents row is changed by hand in the Sheet. */
function onSheetEdit(e) {
  try {
    const sh = e.range.getSheet();
    if (sh.getName() !== 'Documents' || e.range.getRow() < 2) return;
    const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    const col = headers.indexOf('Updated') + 1;
    if (!col || (e.range.getColumn() === col && e.range.getNumColumns() === 1)) return;
    const now = nowIso_();
    for (let r = e.range.getRow(); r < e.range.getRow() + e.range.getNumRows(); r++) sh.getRange(r, col).setValue(now);
  } catch (err) { console.error(err); }
}

/* ============================== Documents ============================== */

function docFromRow_(r) {
  const d = {};
  TABS.Documents.forEach(function (h) { d[h] = r[h] === undefined ? '' : r[h]; });
  try { d.Files = d.Files ? JSON.parse(d.Files) : []; } catch (e) { d.Files = []; }
  try { d.Extra = d.Extra ? JSON.parse(d.Extra) : {}; } catch (e) { d.Extra = {}; }
  d.Pinned = d.Pinned === 'true' || d.Pinned === 'TRUE' || d.Pinned === '1';
  d.Encrypted = d.Encrypted === 'true' || d.Encrypted === 'TRUE' || d.Encrypted === '1';
  d.RenewalLeadDays = d.RenewalLeadDays === '' ? '' : Number(d.RenewalLeadDays);
  return d;
}

function docToRow_(d) {
  const o = {};
  TABS.Documents.forEach(function (h) { o[h] = d[h]; });
  o.Files = JSON.stringify(d.Files || []);
  o.Extra = JSON.stringify(d.Extra || {});
  o.Pinned = d.Pinned ? 'true' : 'false';
  o.Encrypted = d.Encrypted ? 'true' : 'false';
  return o;
}

function autoStatus_(d) {
  if (d.Status === 'Archived') return 'Archived';
  if (d.ExpiryDate && /^\d{4}-\d{2}-\d{2}$/.test(d.ExpiryDate) && d.ExpiryDate < todayStr_()) return 'Expired';
  return 'Active';
}

function clean_(s, max) { return String(s === undefined || s === null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max || 500); }
function cleanDate_(s) { s = String(s || ''); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ''; }

function sanitizeDoc_(d, old) {
  const out = {
    ID: clean_(d.ID, 40).replace(/[^A-Za-z0-9_-]/g, ''),
    Title: clean_(d.Title, 200) || 'Untitled',
    Category: clean_(d.Category, 80),
    Owner: clean_(d.Owner, 80),
    DocNumber: clean_(d.DocNumber, 400),
    Issuer: clean_(d.Issuer, 120),
    IssueDate: cleanDate_(d.IssueDate),
    ExpiryDate: cleanDate_(d.ExpiryDate),
    RenewalLeadDays: d.RenewalLeadDays === '' || d.RenewalLeadDays === undefined || d.RenewalLeadDays === null ? '' : Math.max(0, Math.min(3650, Number(d.RenewalLeadDays) || 0)),
    Tags: clean_(d.Tags, 300).split(',').map(function (t) { return t.trim().replace(/^#/, ''); }).filter(String).join(', '),
    LinkedApp: clean_(d.LinkedApp, 20).toLowerCase(),
    LinkedID: clean_(d.LinkedID, 80),
    Notes: String(d.Notes || '').slice(0, 5000),
    Status: ['Active', 'Expired', 'Archived'].indexOf(d.Status) > -1 ? d.Status : 'Active',
    Pinned: !!d.Pinned,
    Encrypted: !!d.Encrypted,
    PrevID: clean_(d.PrevID, 40),
    Extra: (d.Extra && typeof d.Extra === 'object') ? d.Extra : {},
    Files: Array.isArray(d.Files) ? d.Files.slice(0, 30).map(function (f) {
      return {
        driveId: clean_(f.driveId, 80), name: clean_(f.name, 200), mime: clean_(f.mime, 100),
        size: Number(f.size) || 0, page: Number(f.page) || 0, ref: !!f.ref, enc: !!f.enc, origMime: clean_(f.origMime, 100),
        origName: clean_(f.origName, 200),
      };
    }).filter(function (f) { return f.driveId; }) : [],
    Created: old ? old.Created : nowIso_(),
    Updated: nowIso_(),
  };
  if (!out.ID) out.ID = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  out.Status = autoStatus_(out);
  return out;
}

function findDoc_(tab, id) {
  for (let i = 0; i < tab.rows.length; i++) if (tab.rows[i].ID === id) return tab.rows[i];
  return null;
}

function saveDoc_(input) {
  const tab = readTab_('Documents');
  const oldRow = findDoc_(tab, String(input.ID || ''));
  const old = oldRow ? docFromRow_(oldRow) : null;
  const d = sanitizeDoc_(input, old);
  // never let the client point a doc at a file that is outside the vault unless it is a read-only ref
  const known = old ? old.Files.map(function (f) { return f.driveId; }) : [];
  d.Files = d.Files.filter(function (f) { return f.ref || known.indexOf(f.driveId) > -1 || isVaultFile_(f.driveId); });
  if (old) {
    const keep = d.Files.map(function (f) { return f.driveId; });
    old.Files.forEach(function (f) { if (!f.ref && keep.indexOf(f.driveId) === -1) trashFile_(f.driveId); });
  }
  d.Files.forEach(function (f) { if (!f.ref) untrashFile_(f.driveId); });
  fileDoc_(d);
  writeRow_(tab.sh, tab.headers, oldRow ? oldRow._row : 0, docToRow_(d));
  const remindersChanged = !old || old.ExpiryDate !== d.ExpiryDate || String(old.RenewalLeadDays) !== String(d.RenewalLeadDays) ||
    old.Title !== d.Title || old.Status !== d.Status || old.Category !== d.Category;
  if (remindersChanged) syncReminders_(d);
  log_(old ? 'update' : 'create', d.ID, d.Title);
  return d;
}

function isVaultFile_(id) {
  try {
    const f = DriveApp.getFileById(id);
    const rootId = rootFolder_().getId();
    let parents = f.getParents();
    let guard = 0;
    while (parents.hasNext() && guard++ < 6) {
      const p = parents.next();
      if (p.getId() === rootId) return true;
      parents = p.getParents();
    }
  } catch (e) {}
  return false;
}

/** Moves + renames every owned file of a doc into Vault/<Category>/<Year>/YYYY-MM-DD_<Category>_<Title>_<Owner>.ext */
function fileDoc_(d) {
  const owned = d.Files.filter(function (f) { return !f.ref; });
  if (!owned.length) return;
  const catFolder = categoryFolder_(d.Category || 'Household');
  const dateStr = d.IssueDate || d.Created.slice(0, 10);
  const year = dateStr.slice(0, 4);
  const folder = subFolder_(catFolder, year);
  const base = [dateStr, d.Category, d.Title, d.Owner].map(function (s) {
    return String(s || '').replace(/[\\/:*?"<>|#%]+/g, ' ').replace(/\s+/g, ' ').trim();
  }).filter(String).join('_');
  owned.forEach(function (f, i) {
    try {
      const file = DriveApp.getFileById(f.driveId);
      const src = f.origName || f.name || '';
      let ext = (src.match(/\.([A-Za-z0-9]{1,5})$/) || [])[1] || extFromMime_(f.origMime || f.mime);
      ext = ext ? '.' + ext.toLowerCase() : '';
      const name = base + (owned.length > 1 ? ' (' + (i + 1) + ')' : '') + ext + (f.enc ? '.enc' : '');
      if (file.getName() !== name) file.setName(name);
      const parents = file.getParents();
      const inPlace = parents.hasNext() && parents.next().getId() === folder.getId();
      if (!inPlace) file.moveTo(folder);
      f.name = name;
      if (f.enc) file.setDescription('Encrypted by Vault (AES-GCM). Open it in the Vault app.');
    } catch (err) {
      console.error('fileDoc_ ' + f.driveId + ': ' + err);
    }
  });
}

/** Soft-delete: move to Vault/_Trash and stamp the date; dailyJob purges after TRASH_DAYS. */
function trashFile_(id) {
  try {
    const f = DriveApp.getFileById(id);
    f.moveTo(subFolder_(rootFolder_(), '_Trash'));
    f.setDescription('vault-trashed:' + nowIso_());
  } catch (e) {}
}

function untrashFile_(id) {
  try { const f = DriveApp.getFileById(id); if (/^vault-trashed:/.test(f.getDescription() || '')) f.setDescription(''); } catch (e) {}
}

function extFromMime_(m) {
  return ({ 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/heic': 'heic', 'image/webp': 'webp' })[m] || '';
}

function deleteDoc_(id) {
  const tab = readTab_('Documents');
  const row = findDoc_(tab, id);
  if (!row) throw new VaultError('not_found');
  const d = docFromRow_(row);
  d.Files.forEach(function (f) { if (!f.ref) trashFile_(f.driveId); });
  removeReminders_(id);
  const del = readTab_('_Deleted');
  writeRow_(del.sh, del.headers, 0, { ID: id, DeletedAt: nowIso_(), Title: d.Title, Row: JSON.stringify(docToRow_(d)), Purged: '', Restored: '' });
  tab.sh.deleteRow(row._row);
  log_('delete', id, d.Title);
  return { id: id };
}

function restoreDoc_(id) {
  const del = readTab_('_Deleted');
  let rec = null;
  del.rows.forEach(function (r) { if (r.ID === id && !r.Purged && !r.Restored) rec = r; });
  if (!rec) throw new VaultError('not_in_trash');
  const d = docFromRow_(JSON.parse(rec.Row));
  const missing = [];
  d.Files.forEach(function (f) {
    if (f.ref) return;
    try { DriveApp.getFileById(f.driveId).getName(); } catch (e) { missing.push(f.driveId); }
  });
  d.Files = d.Files.filter(function (f) { return missing.indexOf(f.driveId) === -1; });
  del.sh.getRange(rec._row, del.headers.indexOf('Restored') + 1).setValue(nowIso_());
  const saved = saveDoc_(d);
  log_('restore', id, saved.Title);
  return saved;
}

/* ============================== Drive ============================== */

function rootFolder_() {
  const p = props_();
  const id = p.getProperty('ROOT_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  const it = DriveApp.getRootFolder().getFoldersByName(CFG.ROOT_FOLDER);
  const f = it.hasNext() ? it.next() : DriveApp.getRootFolder().createFolder(CFG.ROOT_FOLDER);
  p.setProperty('ROOT_ID', f.getId());
  return f;
}

function subFolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function categoryFolder_(name) {
  const cats = readTab_('Categories');
  const row = cats.rows.filter(function (r) { return r.Name === name; })[0];
  if (row && row.FolderID) {
    try {
      const f = DriveApp.getFolderById(row.FolderID);
      if (f.getName() !== name) f.setName(name.replace(/[\\/]/g, '-'));
      return f;
    } catch (e) {}
  }
  const f = subFolder_(rootFolder_(), name.replace(/[\\/]/g, '-'));
  if (row) cats.sh.getRange(row._row, cats.headers.indexOf('FolderID') + 1).setValue(f.getId());
  return f;
}

function upload_(b) {
  const id = String(b.uploadId || '');
  if (!/^[A-Za-z0-9_-]{8,40}$/.test(id)) throw new VaultError('bad_upload_id');
  const total = Math.max(1, Math.min(10, Number(b.total) || 1));
  const index = Number(b.index) || 0;
  const size = Number(b.size) || 0;
  if (size > CFG.MAX_FILE_BYTES) throw new VaultError('too_large');
  const data = String(b.data || '');
  if (data.length > Math.ceil(CFG.CHUNK_RAW_BYTES / 3) * 4 + 16) throw new VaultError('chunk_too_large');
  const tmp = subFolder_(rootFolder_(), '_Tmp');
  const name = clean_(b.name, 180) || 'file';
  const mime = clean_(b.mime, 100) || 'application/octet-stream';
  if (total === 1) return { file: createUpload_(data, name, mime) };
  tmp.createFile(id + '_' + ('00' + index).slice(-3) + '.part', data, 'text/plain');
  if (index < total - 1) return { received: index };
  const parts = [];
  const it = tmp.searchFiles('title contains "' + id + '_"');
  while (it.hasNext()) parts.push(it.next());
  parts.sort(function (a, c) { return a.getName() < c.getName() ? -1 : 1; });
  if (parts.length !== total) throw new VaultError('missing_chunks');
  const joined = parts.map(function (f) { return f.getBlob().getDataAsString(); }).join('');
  const file = createUpload_(joined, name, mime);
  parts.forEach(function (f) { f.setTrashed(true); });
  return { file: file };
}

function createUpload_(b64, name, mime) {
  const bytes = Utilities.base64Decode(b64);
  if (bytes.length > CFG.MAX_FILE_BYTES) throw new VaultError('too_large');
  const inbox = subFolder_(rootFolder_(), '_Inbox');
  const file = inbox.createFile(Utilities.newBlob(bytes, mime, name));
  log_('upload', '', name + ' (' + bytes.length + ' B)');
  return { driveId: file.getId(), name: name, mime: mime, size: bytes.length };
}

function referencedIds_() {
  const set = {};
  readTab_('Documents').rows.forEach(function (r) {
    try { JSON.parse(r.Files || '[]').forEach(function (f) { set[f.driveId] = true; }); } catch (e) {}
  });
  return set;
}

function fileGet_(b) {
  const id = String(b.driveId || '');
  const cache = CacheService.getScriptCache();
  if (!cache.get('ref_' + id)) {
    if (!referencedIds_()[id]) throw new VaultError('not_a_vault_file');
    cache.put('ref_' + id, '1', 600);
  }
  const file = DriveApp.getFileById(id);
  const bytes = file.getBlob().getBytes();
  const offset = Math.max(0, Number(b.offset) || 0);
  const len = Math.min(CFG.DOWNLOAD_CHUNK, bytes.length - offset);
  const slice = offset === 0 && len === bytes.length ? bytes : bytes.slice(offset, offset + len);
  return { size: bytes.length, offset: offset, mime: file.getMimeType(), data: Utilities.base64Encode(slice) };
}

/* ============================== Reminders / Calendar ============================== */

function calendar_() {
  const p = props_();
  const id = p.getProperty('CAL_ID');
  if (id) { const c = CalendarApp.getCalendarById(id); if (c) return c; }
  const found = CalendarApp.getCalendarsByName(CFG.CALENDAR);
  const cal = found.length ? found[0] : CalendarApp.createCalendar(CFG.CALENDAR, { color: CalendarApp.Color.YELLOW, timeZone: 'Asia/Kuala_Lumpur' });
  p.setProperty('CAL_ID', cal.getId());
  return cal;
}

function parseDate_(s) { const m = String(s).split('-').map(Number); return new Date(m[0], m[1] - 1, m[2]); }
function fmtDate_(d) { return Utilities.formatDate(d, 'Asia/Kuala_Lumpur', 'yyyy-MM-dd'); }

function leadDaysFor_(d) {
  if (d.RenewalLeadDays !== '' && !isNaN(d.RenewalLeadDays)) return Number(d.RenewalLeadDays);
  const cat = readTab_('Categories').rows.filter(function (r) { return r.Name === d.Category; })[0];
  return cat && cat.LeadDays !== '' ? Number(cat.LeadDays) : 30;
}

function removeReminders_(docId) {
  const rem = readTab_('Reminders');
  const cal = calendar_();
  const rows = rem.rows.filter(function (r) { return r.DocID === docId; }).map(function (r) { return r._row; }).sort(function (a, b) { return b - a; });
  rem.rows.forEach(function (r) {
    if (r.DocID !== docId || !r.CalendarEventID) return;
    try { const ev = cal.getEventById(r.CalendarEventID); if (ev) ev.deleteEvent(); } catch (e) {}
  });
  rows.forEach(function (n) { rem.sh.deleteRow(n); });
}

function syncReminders_(d) {
  removeReminders_(d.ID);
  if (!d.ExpiryDate || d.Status === 'Archived') return;
  const cal = calendar_();
  const rem = readTab_('Reminders');
  const appUrl = props_().getProperty('APP_URL') || '';
  const expiry = parseDate_(d.ExpiryDate);
  const lead = leadDaysFor_(d);
  const remindAt = new Date(expiry.getTime());
  remindAt.setDate(remindAt.getDate() - lead);
  const today = parseDate_(todayStr_());
  const desc = (d.Owner ? d.Owner + ' · ' : '') + (d.Category || '') + '\nExpires ' + d.ExpiryDate +
    (appUrl ? '\n\nOpen in Vault: ' + appUrl + '#doc=' + d.ID : '');
  const list = [];
  if (lead > 0 && remindAt >= today) list.push(['lead', remindAt, '🔐 Renew: ' + d.Title]);
  if (expiry >= today) list.push(['expiry', expiry, '🔐 Renew: ' + d.Title + ' (expires today)']);
  list.forEach(function (x) {
    const ev = cal.createAllDayEvent(x[2], x[1], { description: desc });
    if (x[0] === 'lead') ev.addPopupReminder(9 * 60); // 15:00 the day before → simple nudge
    writeRow_(rem.sh, rem.headers, 0, { DocID: d.ID, Date: fmtDate_(x[1]), Kind: x[0], CalendarEventID: ev.getId(), Done: '' });
  });
}

function rebuildReminders_() {
  const docs = readTab_('Documents').rows.map(docFromRow_);
  docs.forEach(function (d) { syncReminders_(d); });
  log_('rebuildReminders', '', docs.length + ' docs');
  return { count: docs.length };
}

/* ============================== Renew ============================== */

function renewDoc_(b) {
  const tab = readTab_('Documents');
  const oldRow = findDoc_(tab, String(b.oldId || ''));
  if (!oldRow) throw new VaultError('not_found');
  const old = docFromRow_(oldRow);
  const n = b.doc || {};
  n.ID = n.ID || ('d' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
  n.PrevID = old.ID;
  const saved = saveDoc_(n);
  old.Status = 'Archived';
  old.Pinned = false;
  old.Updated = nowIso_();
  old.Tags = (old.Tags ? old.Tags + ', ' : '') + 'previous-version';
  const fresh = readTab_('Documents');
  const r = findDoc_(fresh, old.ID);
  writeRow_(fresh.sh, fresh.headers, r._row, docToRow_(old));
  removeReminders_(old.ID);
  log_('renew', saved.ID, 'replaces ' + old.ID);
  return { doc: saved, old: old };
}

/* ============================== Share ============================== */

function share_(b) {
  const tab = readTab_('Documents');
  const row = findDoc_(tab, String(b.docId || ''));
  if (!row) throw new VaultError('not_found');
  const d = docFromRow_(row);
  const f = d.Files[Number(b.fileIndex) || 0];
  if (!f) throw new VaultError('no_file');
  if (f.enc) throw new VaultError('encrypted_file');
  const file = DriveApp.getFileById(f.driveId);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  const hours = Math.max(1, Math.min(CFG.SHARE_HOURS, Number(b.hours) || CFG.SHARE_HOURS));
  const sh = readTab_('Shares');
  const rec = {
    ID: 's' + Date.now().toString(36), DocID: d.ID, DriveID: f.driveId, Created: nowIso_(),
    Expires: new Date(Date.now() + hours * 3600 * 1000).toISOString(), Revoked: '', Url: file.getUrl(),
  };
  writeRow_(sh.sh, sh.headers, 0, rec);
  log_('share', d.ID, f.name + ' until ' + rec.Expires);
  return { share: rec };
}

function revokeShare_(shareId, reason) {
  const sh = readTab_('Shares');
  const rec = sh.rows.filter(function (r) { return r.ID === shareId; })[0];
  if (!rec) throw new VaultError('not_found');
  if (!rec.Revoked) {
    const stillShared = sh.rows.some(function (r) { return r.ID !== rec.ID && r.DriveID === rec.DriveID && !r.Revoked && r.Expires > nowIso_(); });
    if (!stillShared) { try { DriveApp.getFileById(rec.DriveID).setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE); } catch (e) {} }
    sh.sh.getRange(rec._row, sh.headers.indexOf('Revoked') + 1).setValue(nowIso_());
    log_('unshare', rec.DocID, reason || 'manual');
  }
  return { id: shareId };
}

/* ============================== Jobs ============================== */

function dailyJob() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(60000)) return;
  try {
    // 1. statuses
    const tab = readTab_('Documents');
    tab.rows.forEach(function (r) {
      const d = docFromRow_(r);
      const s = autoStatus_(d);
      if (s !== d.Status) {
        tab.sh.getRange(r._row, tab.headers.indexOf('Status') + 1).setValue(s);
        tab.sh.getRange(r._row, tab.headers.indexOf('Updated') + 1).setValue(nowIso_());
      }
    });
    // 2. trash purge
    const cutoff = new Date(Date.now() - CFG.TRASH_DAYS * 86400000).toISOString();
    const del = readTab_('_Deleted');
    del.rows.forEach(function (r) {
      if (r.Purged || r.Restored || r.DeletedAt > cutoff) return;
      try {
        JSON.parse(JSON.parse(r.Row).Files || '[]').forEach(function (f) {
          if (!f.ref) { try { DriveApp.getFileById(f.driveId).setTrashed(true); } catch (e) {} }
        });
      } catch (e) {}
      del.sh.getRange(r._row, del.headers.indexOf('Purged') + 1).setValue(nowIso_());
      log_('purge', r.ID, r.Title);
    });
    // 2b. files removed from docs (stamped in _Trash) and no longer referenced
    const refs = referencedIds_();
    const trashIt = subFolder_(rootFolder_(), '_Trash').getFiles();
    while (trashIt.hasNext()) {
      const f = trashIt.next();
      const m = /^vault-trashed:(.+)$/.exec(f.getDescription() || '');
      if (m && m[1] <= cutoff && !refs[f.getId()]) f.setTrashed(true);
    }
    // 3. stale upload chunks
    const tmp = subFolder_(rootFolder_(), '_Tmp').getFiles();
    while (tmp.hasNext()) { const f = tmp.next(); if (Date.now() - f.getDateCreated().getTime() > 86400000) f.setTrashed(true); }
    // 4. backup
    backup_();
    // 5. trim log
    const log = sheet_('_Log');
    const extra = log.getLastRow() - 1 - CFG.LOG_KEEP;
    if (extra > 0) log.deleteRows(2, extra);
  } finally { lock.releaseLock(); }
}

function hourlyJob() {
  const sh = readTab_('Shares');
  const now = nowIso_();
  sh.rows.forEach(function (r) { if (!r.Revoked && r.Expires <= now) { try { revokeShare_(r.ID, 'auto-expired'); } catch (e) {} } });
}

function exportData_() {
  const out = { app: 'vault', version: VERSION, exported: nowIso_(), tabs: {} };
  ['Documents', 'Categories', 'People', 'Reminders', 'Shares', '_Deleted'].forEach(function (n) {
    out.tabs[n] = readTab_(n).rows.map(function (r) { const o = Object.assign({}, r); delete o._row; return o; });
  });
  return out;
}

function backup_() {
  const folder = subFolder_(rootFolder_(), 'Backups');
  const name = 'vault-backup-' + Utilities.formatDate(new Date(), 'Asia/Kuala_Lumpur', 'yyyy-MM-dd_HHmm') + '.json';
  folder.createFile(name, JSON.stringify(exportData_()), 'application/json');
  const files = [];
  const it = folder.getFiles();
  while (it.hasNext()) files.push(it.next());
  files.sort(function (a, b) { return b.getDateCreated() - a.getDateCreated(); });
  files.slice(CFG.BACKUP_KEEP).forEach(function (f) { f.setTrashed(true); });
  props_().setProperty('LAST_BACKUP', nowIso_());
  log_('backup', '', name);
  return name;
}

function importAll_(b) {
  const data = b.data || {};
  if (data.app !== 'vault' || !data.tabs) throw new VaultError('not_a_vault_backup');
  backup_(); // safety copy first
  const tab = readTab_('Documents');
  const have = {};
  tab.rows.forEach(function (r) { have[r.ID] = r; });
  let added = 0, updated = 0;
  (data.tabs.Documents || []).forEach(function (r) {
    const cur = have[r.ID];
    if (cur && cur.Updated >= r.Updated) return;
    const o = Object.assign({}, r);
    if (cur) { writeRow_(tab.sh, tab.headers, cur._row, o); updated++; } else { writeRow_(tab.sh, tab.headers, 0, o); added++; }
  });
  ['Categories', 'People'].forEach(function (n) {
    const t = readTab_(n);
    const names = t.rows.map(function (r) { return r.Name; });
    (data.tabs[n] || []).forEach(function (r) { if (names.indexOf(r.Name) === -1) writeRow_(t.sh, t.headers, 0, r); });
  });
  log_('import', '', added + ' added, ' + updated + ' updated');
  return { added: added, updated: updated };
}

/* ============================== Actions ============================== */

function meta_() {
  const p = props_();
  let links = {};
  try { links = JSON.parse(p.getProperty('LINKS') || '{}'); } catch (e) {}
  return {
    version: VERSION,
    serverTime: nowIso_(),
    lastBackup: p.getProperty('LAST_BACKUP') || '',
    encSalt: p.getProperty('ENC_SALT') || '',
    encCheck: p.getProperty('ENC_CHECK') || '',
    links: links,
    sheetUrl: 'https://docs.google.com/spreadsheets/d/' + p.getProperty('SHEET_ID'),
    folderUrl: 'https://drive.google.com/drive/folders/' + p.getProperty('ROOT_ID'),
  };
}

function lists_() {
  return {
    categories: readTab_('Categories').rows.map(function (r) {
      return { Name: r.Name, Icon: r.Icon, Colour: r.Colour, LeadDays: r.LeadDays === '' ? 30 : Number(r.LeadDays), Fields: r.Fields, Encrypt: r.Encrypt, Order: Number(r.Order) || 99 };
    }).sort(function (a, b) { return a.Order - b.Order; }),
    people: readTab_('People').rows.map(function (r) { return { Name: r.Name, Relationship: r.Relationship, Colour: r.Colour }; }),
  };
}

const ACTIONS = {
  ping: function () { return { version: VERSION, serverTime: nowIso_() }; },

  sync: function (b) {
    const since = String(b.since || '');
    const docs = readTab_('Documents').rows.filter(function (r) { return !since || r.Updated > since || r.Updated === ''; }).map(docFromRow_);
    const deleted = readTab_('_Deleted').rows.filter(function (r) { return !r.Restored && (!since || r.DeletedAt > since); }).map(function (r) { return r.ID; });
    const all = since ? readTab_('Documents').rows.map(function (r) { return r.ID; }) : null;
    return Object.assign({ docs: docs, deleted: deleted, allIds: all, full: !since, meta: meta_() }, lists_());
  },

  saveDoc: function (b) { return { doc: saveDoc_(b.doc || {}) }; },
  renewDoc: function (b) { return renewDoc_(b); },
  deleteDoc: function (b) { return deleteDoc_(String(b.id || '')); },
  restoreDoc: function (b) { return { doc: restoreDoc_(String(b.id || '')) }; },

  listTrash: function () {
    const cutoff = Date.now() - CFG.TRASH_DAYS * 86400000;
    return {
      items: readTab_('_Deleted').rows.filter(function (r) { return !r.Purged && !r.Restored; }).map(function (r) {
        return { ID: r.ID, Title: r.Title, DeletedAt: r.DeletedAt, purgeOn: new Date(new Date(r.DeletedAt).getTime() + CFG.TRASH_DAYS * 86400000).toISOString(), expired: new Date(r.DeletedAt).getTime() < cutoff };
      }).reverse(),
    };
  },

  uploadChunk: function (b) { return upload_(b); },
  fileGet: function (b) { return fileGet_(b); },

  share: function (b) { return share_(b); },
  revokeShare: function (b) { return revokeShare_(String(b.id || ''), 'manual'); },
  listShares: function () {
    const now = nowIso_();
    return { items: readTab_('Shares').rows.filter(function (r) { return !r.Revoked && r.Expires > now; }).map(function (r) { const o = Object.assign({}, r); delete o._row; return o; }) };
  },

  saveCategory: function (b) {
    const c = b.category || {};
    const t = readTab_('Categories');
    const name = clean_(c.Name, 80);
    if (!name) throw new VaultError('name_required');
    const orig = clean_(c.original || name, 80);
    const row = t.rows.filter(function (r) { return r.Name === orig; })[0];
    const rec = {
      Name: name, Icon: clean_(c.Icon, 8) || '📁', Colour: /^#[0-9a-f]{6}$/i.test(c.Colour) ? c.Colour : '#9AA0A6',
      FolderID: row ? row.FolderID : '', LeadDays: Math.max(0, Number(c.LeadDays) || 0), Fields: clean_(c.Fields, 200),
      Encrypt: ['', 'ask', 'always'].indexOf(c.Encrypt) > -1 ? c.Encrypt : '', Order: row ? row.Order : t.rows.length + 1,
    };
    writeRow_(t.sh, t.headers, row ? row._row : 0, rec);
    if (row && orig !== name) {
      // rename category on every doc, then refile (folder renamed by categoryFolder_)
      const docs = readTab_('Documents');
      docs.rows.forEach(function (r) { if (r.Category === orig) { const d = docFromRow_(r); d.Category = name; saveDoc_(d); } });
    }
    categoryFolder_(name);
    log_('category', '', name);
    return lists_();
  },

  savePerson: function (b) {
    const p = b.person || {};
    const t = readTab_('People');
    const name = clean_(p.Name, 80);
    if (!name) throw new VaultError('name_required');
    const orig = clean_(p.original || name, 80);
    const row = t.rows.filter(function (r) { return r.Name === orig; })[0];
    writeRow_(t.sh, t.headers, row ? row._row : 0, { Name: name, Relationship: clean_(p.Relationship, 60), Colour: /^#[0-9a-f]{6}$/i.test(p.Colour) ? p.Colour : '#9AA0A6' });
    if (row && orig !== name) {
      readTab_('Documents').rows.forEach(function (r) { if (r.Owner === orig) { const d = docFromRow_(r); d.Owner = name; saveDoc_(d); } });
    }
    return lists_();
  },

  deletePerson: function (b) {
    const t = readTab_('People');
    const row = t.rows.filter(function (r) { return r.Name === b.name; })[0];
    if (row) t.sh.deleteRow(row._row);
    return lists_();
  },

  setEnc: function (b) {
    const p = props_();
    if (p.getProperty('ENC_SALT') && !b.force) throw new VaultError('enc_already_set');
    p.setProperty('ENC_SALT', clean_(b.salt, 100));
    p.setProperty('ENC_CHECK', clean_(b.check, 400));
    log_('encryption', '', 'Passphrase set');
    return { meta: meta_() };
  },

  setLinks: function (b) {
    const links = b.links || {};
    const out = {};
    ['garage', 'ledger', 'flow'].forEach(function (k) {
      const l = links[k] || {};
      const url = String(l.url || '');
      const page = String(l.page || '');
      out[k] = {
        url: /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url) ? url : '',
        key: clean_(l.key, 100),
        page: /^https:\/\/[^\s"'<>]+$/.test(page) ? page.slice(0, 200) : '',
        tasks: !!l.tasks,
      };
    });
    props_().setProperty('LINKS', JSON.stringify(out));
    log_('links', '', 'Linked apps updated');
    return { meta: meta_() };
  },

  /** Read-only list for Garage / Ledger / Flow (link key allowed). Never returns DocNumber or files. */
  list: function (b) {
    const f = b.filter || {};
    return {
      app: 'vault',
      items: readTab_('Documents').rows.map(docFromRow_).filter(function (d) {
        return (!f.linkedApp || d.LinkedApp === f.linkedApp) && (!f.linkedId || d.LinkedID === String(f.linkedId)) && (!f.category || d.Category === f.category);
      }).map(function (d) {
        return { id: d.ID, title: d.Title, category: d.Category, owner: d.Owner, issueDate: d.IssueDate, expiryDate: d.ExpiryDate, status: d.Status, tags: d.Tags, linkedApp: d.LinkedApp, linkedId: d.LinkedID, updated: d.Updated };
      }),
    };
  },

  exportAll: function () { return { data: exportData_() }; },
  importAll: function (b) { return importAll_(b); },
  backupNow: function () { return { name: backup_() }; },
  rebuildReminders: function () { return rebuildReminders_(); },

  log: function () {
    const sh = sheet_('_Log');
    const n = Math.min(60, Math.max(0, sh.getLastRow() - 1));
    if (!n) return { items: [] };
    return { items: sh.getRange(sh.getLastRow() - n + 1, 1, n, 4).getValues().map(function (r) { return r.map(cellStr_); }).reverse() };
  },

  checks: function () {
    const out = [];
    const add = function (name, fn) {
      try { const r = fn(); out.push({ name: name, ok: r !== false, detail: typeof r === 'string' ? r : '' }); }
      catch (e) { out.push({ name: name, ok: false, detail: String(e.message || e) }); }
    };
    add('Sheet opens', function () { return getSS_().getName(); });
    add('All tabs present', function () {
      const ss = getSS_();
      const missing = Object.keys(TABS).filter(function (n) { return !ss.getSheetByName(n); });
      if (missing.length) throw new Error('missing: ' + missing.join(', '));
      return Object.keys(TABS).length + ' tabs';
    });
    add('Drive root folder', function () { return rootFolder_().getName(); });
    add('Category folders', function () {
      const bad = readTab_('Categories').rows.filter(function (r) { try { DriveApp.getFolderById(r.FolderID); return false; } catch (e) { return true; } });
      if (bad.length) throw new Error('re-created on next save: ' + bad.map(function (r) { return r.Name; }).join(', '));
      return 'ok';
    });
    add('Calendar "Vault"', function () { return calendar_().getName(); });
    add('Triggers (daily, hourly, onEdit)', function () {
      const names = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
      const miss = ['dailyJob', 'hourlyJob', 'onSheetEdit'].filter(function (n) { return names.indexOf(n) === -1; });
      if (miss.length) throw new Error('missing: ' + miss.join(', ') + ' — run setup');
      return 'ok';
    });
    add('Backup in last 48 h', function () {
      const lb = props_().getProperty('LAST_BACKUP');
      if (!lb) throw new Error('never — tap "Backup now"');
      if (Date.now() - new Date(lb).getTime() > 48 * 3600000) throw new Error('last ' + lb.slice(0, 10));
      return lb.slice(0, 16).replace('T', ' ');
    });
    add('Expired shares revoked', function () {
      const now = nowIso_();
      const stale = readTab_('Shares').rows.filter(function (r) { return !r.Revoked && r.Expires <= now; });
      if (stale.length) throw new Error(stale.length + ' pending (hourly job)');
      return 'ok';
    });
    add('Failed key attempts', function () { return String(props_().getProperty('FAILS') || 0) + ' / ' + CFG.MAX_FAILS; });
    return { checks: out, version: VERSION };
  },
};

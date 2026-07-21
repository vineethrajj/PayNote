/**
 * Joseph Dental & Aesthetic Wellness — Statement Consolidation
 * ------------------------------------------------------------
 * Ingests multiple account/wallet statements (Axis, SBI, Paytm, GPay, …),
 * normalises every transaction onto one model, deduplicates BOTH across the
 * uploaded files AND against what is already in the "Transactions" ledger,
 * and appends only the genuinely-new transactions.
 *
 * Formats:
 *   - CSV / Excel  -> parsed inside Apps Script (fuzzy column detection, so
 *                     it tolerates each bank's different layout + metadata
 *                     rows above the header). Excel needs the advanced Drive
 *                     service enabled (see README).
 *   - PDF          -> sent to Claude's document API, which returns a JSON
 *                     array of transactions we then normalise.
 *
 * Dedup = "smart match": same amount + same direction AND
 *   (same non-empty reference/UTR)  OR  (date within +/-1 day AND fuzzy
 *   counterparty match). This catches the same payment appearing in both a
 *   wallet statement and its linked bank statement, and catches statements
 *   re-uploaded on top of rows already in the ledger.
 *
 * APPEND-ONLY: like the single-entry path, this only ever writes below the
 * current last row. Imported batches form a reconciliation block at the end
 * (chronologically ordered within the batch, with "◆ Month" headers as the
 * month changes). It never inserts into or edits prior rows, so the formulas
 * in the Dashboard / Expense / Payment / Summary tabs are never disturbed.
 *
 * Flow (front-end calls these two):
 *   previewConsolidation(files, pin) -> parse + dedup, returns a preview,
 *                                       writes NOTHING.
 *   commitConsolidation(newTxns, pin) -> re-validates + re-checks the ledger,
 *                                        appends the confirmed new rows.
 */

var IMPORT_PDF_MODEL = 'claude-haiku-4-5';
var MAX_PREVIEW_ROWS = 400;   // cap what we ship to the client
var DUP_DAY_WINDOW = 1;       // +/- days for smart date matching

// ---------------------------------------------------------------------------
// Public: preview (no writes)
// ---------------------------------------------------------------------------

/**
 * @param {Array} files  [{ name, mimeType, dataBase64 }]
 * @param {string} pin
 * @return {Object} preview summary + new/skipped lists
 */
function previewConsolidation(files, pin) {
  checkPin_(pin);
  if (!files || !files.length) throw new Error('No files uploaded.');

  var all = [];
  var perFile = [];
  for (var i = 0; i < files.length; i++) {
    var f = files[i] || {};
    try {
      var txns = parseStatementFile_(f);
      for (var j = 0; j < txns.length; j++) all.push(txns[j]);
      perFile.push({ name: f.name || ('file ' + (i + 1)), source: (txns[0] && txns[0].source) || detectSource_(f.name || '', '').label, count: txns.length, error: '' });
    } catch (e) {
      perFile.push({ name: f.name || ('file ' + (i + 1)), source: '', count: 0, error: String(e.message || e) });
    }
  }

  // 1) Dedup across the uploaded files.
  var batch = dedupeBatch_(all);

  // 2) Drop anything already in the ledger.
  var ledgerIndex = buildLedgerIndex_();
  var fresh = [];
  var alreadyInLedger = [];
  for (var k = 0; k < batch.unique.length; k++) {
    var t = batch.unique[k];
    if (matchInLedger_(t, ledgerIndex)) alreadyInLedger.push(t);
    else fresh.push(t);
  }

  fresh.sort(byDateAsc_);

  return {
    parsed: all.length,
    perFile: perFile,
    newCount: fresh.length,
    duplicateInBatchCount: batch.duplicates.length,
    alreadyInLedgerCount: alreadyInLedger.length,
    newTxns: fresh.slice(0, MAX_PREVIEW_ROWS).map(txnForClient_),
    skipped: batch.duplicates.slice(0, MAX_PREVIEW_ROWS).map(function (d) {
      return { date: isoDate_(d.txn.date), party: d.txn.party, amount: d.txn.amount, reason: d.reason };
    }),
    ledgerSkipped: alreadyInLedger.slice(0, MAX_PREVIEW_ROWS).map(function (t) {
      return { date: isoDate_(t.date), party: t.party, amount: t.amount, reason: 'already in ledger' };
    }),
    truncated: fresh.length > MAX_PREVIEW_ROWS
  };
}

// ---------------------------------------------------------------------------
// Public: commit (append-only write)
// ---------------------------------------------------------------------------

/**
 * @param {Array} newTxns  the client-confirmed new transactions (as sent by
 *                         previewConsolidation's newTxns, possibly edited).
 * @param {string} pin
 * @return {Object} { ok, appended, skippedNowInLedger, headersAdded }
 */
function commitConsolidation(newTxns, pin) {
  checkPin_(pin);
  if (!newTxns || !newTxns.length) throw new Error('Nothing to append.');

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var ss = SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID') || DEFAULT_SPREADSHEET_ID);
    var sheet = ss.getSheetByName(SHEET_NAME);
    if (!sheet) throw new Error('Sheet "' + SHEET_NAME + '" not found.');
    var tz = ss.getSpreadsheetTimeZone() || Session.getScriptTimeZone() || 'Asia/Kolkata';

    // Rebuild the ledger index NOW (it may have changed since preview) and
    // re-filter, so we never double-write even if two people import at once.
    var ledgerIndex = buildLedgerIndex_();

    // Normalise incoming, validate, re-check ledger, and also dedup within
    // this confirmed set again (belt and braces).
    var accepted = [];
    var skippedNow = 0;
    for (var i = 0; i < newTxns.length; i++) {
      var t = txnFromClient_(newTxns[i]);
      if (!t) continue;
      if (matchInLedger_(t, ledgerIndex)) { skippedNow++; continue; }
      if (findMatch_(accepted, t)) { skippedNow++; continue; }
      accepted.push(t);
      indexAddTxn_(ledgerIndex, t); // so later rows in this batch dedup too
    }
    if (!accepted.length) {
      return { ok: true, appended: 0, skippedNowInLedger: skippedNow, headersAdded: 0 };
    }

    accepted.sort(byDateAsc_);

    // Build the full block of rows (headers + entries), then write once.
    var startMonth = readLastMonth_(sheet, sheet.getLastRow(), tz);
    var block = [];
    var headersAdded = 0;
    var cur = startMonth;
    for (var m = 0; m < accepted.length; m++) {
      var tx = accepted[m];
      var monthStr = Utilities.formatDate(tx.date, tz, 'MMM yyyy');
      if (monthStr !== cur) {
        var header = blankRow_();
        header[0] = '◆  ' + monthStr;
        block.push(header);
        headersAdded++;
        cur = monthStr;
      }
      block.push(buildRow_(entryFromTxn_(tx), tx.date, monthStr));
    }

    var startRow = sheet.getLastRow() + 1;
    sheet.getRange(startRow, 1, block.length, TOTAL_COLUMNS).setValues(block);
    SpreadsheetApp.flush();

    return { ok: true, appended: accepted.length, skippedNowInLedger: skippedNow, headersAdded: headersAdded, firstRow: startRow };
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// File parsing — dispatch by type
// ---------------------------------------------------------------------------

function parseStatementFile_(f) {
  var name = String(f.name || '').toLowerCase();
  var mime = String(f.mimeType || '').toLowerCase();
  var bytes = f.dataBase64 ? Utilities.base64Decode(f.dataBase64) : null;
  if (!bytes) throw new Error('Empty file.');

  if (name.endsWith('.pdf') || mime.indexOf('pdf') > -1) {
    return parsePdf_(f.dataBase64, f.name);
  }
  if (name.endsWith('.csv') || mime.indexOf('csv') > -1 || mime.indexOf('text/plain') > -1) {
    var csv = Utilities.newBlob(bytes).getDataAsString();
    var values = Utilities.parseCsv(csv);
    return parseTabular_(values, f.name);
  }
  if (name.endsWith('.xlsx') || name.endsWith('.xls') || mime.indexOf('spreadsheet') > -1 || mime.indexOf('excel') > -1) {
    var rows = excelToValues_(Utilities.newBlob(bytes, f.mimeType || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', f.name));
    return parseTabular_(rows, f.name);
  }
  // Last resort: try CSV.
  try {
    return parseTabular_(Utilities.parseCsv(Utilities.newBlob(bytes).getDataAsString()), f.name);
  } catch (e) {
    throw new Error('Unsupported file type: ' + (f.name || mime));
  }
}

/** Convert an Excel blob to a 2-D array via the advanced Drive service. */
function excelToValues_(blob) {
  if (typeof Drive === 'undefined' || !Drive.Files) {
    throw new Error('Excel import needs the advanced Drive service enabled (see README). Export as CSV instead.');
  }
  var temp = Drive.Files.insert({ title: 'tmp-import-' + Date.now(), mimeType: 'application/vnd.google-apps.spreadsheet' }, blob, { convert: true });
  try {
    var ss = SpreadsheetApp.openById(temp.id);
    return ss.getSheets()[0].getDataRange().getValues();
  } finally {
    try { Drive.Files.remove(temp.id); } catch (e) {}
  }
}

/** Send a PDF statement to Claude and get back normalised transactions. */
function parsePdf_(base64, fileName) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY for PDF parsing.');

  var prompt = [
    'This is a bank or wallet account statement. Extract EVERY transaction row.',
    'Return ONLY a JSON array (no prose, no code fences). Each element:',
    '{',
    '  "date": "YYYY-MM-DD",',
    '  "description": string,          // narration / counterparty as printed',
    '  "amount": number,               // positive magnitude, no symbols/commas',
    '  "direction": "credit" | "debit",// credit = money IN, debit = money OUT',
    '  "reference": string,            // UTR / RRN / cheque / txn id, else ""',
    '  "balance": number               // running balance if shown, else 0',
    '}',
    'Ignore opening/closing balance summary lines and non-transaction rows.',
    'If a row shows a withdrawal it is "debit"; a deposit is "credit".'
  ].join('\n');

  var payload = {
    model: IMPORT_PDF_MODEL,
    max_tokens: 8000,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
        { type: 'text', text: prompt }
      ]
    }]
  };

  var resp = fetchWithRetry_(ANTHROPIC_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  }, 3);

  if (resp.getResponseCode() < 200 || resp.getResponseCode() >= 300) {
    throw new Error('PDF parsing failed (' + resp.getResponseCode() + ') for ' + fileName + '.');
  }
  var text = '';
  var api = JSON.parse(resp.getContentText());
  if (api.content) for (var i = 0; i < api.content.length; i++) if (api.content[i].type === 'text') text += api.content[i].text;

  var items = extractJsonArray_(text);
  if (!items) throw new Error('Could not read transactions from PDF ' + fileName + '.');

  var src = detectSource_(fileName, '');
  var out = [];
  for (var k = 0; k < items.length; k++) {
    var it = items[k] || {};
    var tx = makeTxn_({
      date: it.date,
      description: it.description,
      amount: it.amount,
      direction: it.direction,
      reference: it.reference,
      source: src.label,
      modeHint: src.mode
    });
    if (tx) out.push(tx);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tabular parsing (CSV / Excel) with fuzzy column detection
// ---------------------------------------------------------------------------

/**
 * Column-name matchers, checked case-insensitively against header cells.
 * Note: the debit/credit patterns deliberately require the full words
 * (debit/withdrawal, credit/deposit) so a combined "Dr/Cr" indicator column
 * is NOT mistaken for a money column — that column is caught by `drcr` and
 * the amount lives in a single "Amount" column instead.
 */
var COLPATS = {
  date: /(txn|transaction|value|posting|tran)?\s*date|^date$/i,
  desc: /narration|description|particular|remark|detail|transaction remarks|to\s*\/\s*from|payee|merchant/i,
  debit: /debit|withdrawal|withdrawn|paid\s*out|amount debited/i,
  credit: /credit|deposit|received|amount credited/i,
  amount: /^amount$|txn amount|transaction amount|amount\s*\(inr\)|amount\b/i,
  drcr: /dr\s*\/\s*cr|debit\s*\/\s*credit|cr\s*\/\s*dr|^type$|indicator/i,
  ref: /utr|rrn|ref(erence)?|cheque|chq|transaction id|txn id|order id|upi ref/i
};

function parseTabular_(values, fileName) {
  if (!values || !values.length) return [];
  var headerText = values.slice(0, 20).map(function (r) { return r.join(' '); }).join(' ');
  var src = detectSource_(fileName, headerText);

  var hIdx = findHeaderRow_(values);
  if (hIdx < 0) throw new Error('Could not find a transaction header row in ' + (fileName || 'file') + '.');
  var header = values[hIdx].map(function (c) { return String(c == null ? '' : c).trim(); });
  var map = mapColumns_(header);

  var out = [];
  for (var r = hIdx + 1; r < values.length; r++) {
    var row = values[r];
    if (!row || !row.join('').trim()) continue; // blank line
    var tx = rowToTxn_(row, map, src);
    if (tx) out.push(tx);
  }
  return out;
}

/** Find the row index that looks like the column header. */
function findHeaderRow_(values) {
  var limit = Math.min(values.length, 25);
  for (var r = 0; r < limit; r++) {
    var m = mapColumns_(values[r].map(function (c) { return String(c == null ? '' : c).trim(); }));
    var hasDate = m.date > -1;
    var hasMoney = (m.debit > -1 || m.credit > -1 || m.amount > -1);
    if (hasDate && hasMoney) return r;
  }
  return -1;
}

function mapColumns_(header) {
  var m = { date: -1, desc: -1, debit: -1, credit: -1, amount: -1, drcr: -1, ref: -1 };
  for (var i = 0; i < header.length; i++) {
    var h = header[i];
    if (!h) continue;
    if (m.date < 0 && COLPATS.date.test(h)) m.date = i;
    if (m.desc < 0 && COLPATS.desc.test(h)) m.desc = i;
    if (m.debit < 0 && COLPATS.debit.test(h)) m.debit = i;
    if (m.credit < 0 && COLPATS.credit.test(h)) m.credit = i;
    if (m.amount < 0 && COLPATS.amount.test(h)) m.amount = i;
    if (m.drcr < 0 && COLPATS.drcr.test(h)) m.drcr = i;
    if (m.ref < 0 && COLPATS.ref.test(h)) m.ref = i;
  }
  return m;
}

function rowToTxn_(row, map, src) {
  var cell = function (i) { return (i > -1 && row[i] != null) ? row[i] : ''; };
  var dateRaw = cell(map.date);
  var desc = String(cell(map.desc) || '').trim();
  var ref = String(cell(map.ref) || '').trim();

  var amount = 0, direction = '';
  if (map.debit > -1 || map.credit > -1) {
    var dv = parseMoney_(cell(map.debit));
    var cv = parseMoney_(cell(map.credit));
    if (cv > 0) { amount = cv; direction = 'credit'; }
    else if (dv > 0) { amount = dv; direction = 'debit'; }
    else return null; // no money on this row -> not a transaction
  } else if (map.amount > -1) {
    var raw = String(cell(map.amount));
    var n = parseMoney_(raw);
    if (!n) return null;
    amount = Math.abs(n);
    // Direction from sign, a Dr/Cr suffix, or a separate indicator column.
    var ind = String(cell(map.drcr) || '') + ' ' + raw;
    if (/\bcr\b|credit|\+/.test(ind.toLowerCase()) && n >= 0) direction = 'credit';
    else if (/\bdr\b|debit|-/.test(ind.toLowerCase()) || n < 0) direction = 'debit';
    else direction = n < 0 ? 'debit' : 'credit';
  } else {
    return null;
  }

  return makeTxn_({
    date: dateRaw, description: desc, amount: amount, direction: direction,
    reference: ref, source: src.label, modeHint: src.mode
  });
}

/** Money in a statement cell: strips ₹/commas and a trailing Cr/Dr. */
function parseMoney_(v) {
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  var s = String(v == null ? '' : v).replace(/₹|inr/gi, '').replace(/rs\.?/i, '').replace(/,/g, '').replace(/\s+/g, '');
  s = s.replace(/(cr|dr)$/i, '');
  var n = parseFloat(s);
  return isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------
// Normalisation into the common transaction model
// ---------------------------------------------------------------------------

/**
 * @return {Object|null} { date:Date, party, particulars, amount, direction,
 *                         mode, reference, source, raw }
 */
function makeTxn_(o) {
  var date = parseTxnDate_(o.date);
  var amount = normaliseAmount_(o.amount);
  var direction = (o.direction === 'credit' || o.direction === 'debit') ? o.direction : normaliseDirection_(o.direction);
  if (!date || !(amount > 0) || !direction) return null; // incomplete -> drop

  var desc = cleanStr_(o.description);
  return {
    date: date,
    party: counterparty_(desc),
    particulars: desc || 'Statement import',
    amount: amount,
    direction: direction,
    mode: modeFromContext_(o.modeHint, desc),
    reference: normRef_(o.reference),
    source: o.source || 'Statement',
    raw: desc
  };
}

/** Best-effort counterparty from a bank narration. */
function counterparty_(desc) {
  if (!desc) return '';
  var parts = desc.split(/[\/|:_\-]+/).map(function (p) { return p.trim(); }).filter(Boolean);
  // Prefer the longest alphabetic token that isn't a known code word.
  var skip = /^(upi|neft|imps|rtgs|pos|atm|ach|nach|ecs|tpt|mb|ib|inb|paytm|gpay|googlepay|ref|utr|txn|payment|to|from|by|via)$/i;
  var best = '';
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i];
    if (/[a-zA-Z]{3,}/.test(p) && !skip.test(p) && !/^\d+$/.test(p)) {
      if (p.length > best.length) best = p;
    }
  }
  return (best || desc).substring(0, 60);
}

function modeFromContext_(hint, desc) {
  var d = String(desc || '').toLowerCase();
  if (/\b(atm|cash)\b/.test(d)) return 'Cash';
  if (/\b(pos|card|visa|master|rupay|swipe)\b/.test(d)) return 'Card';
  if (/paytm/.test(d)) return 'PayTM';
  if (/gpay|google\s*pay/.test(d)) return 'GPay';
  var m = normaliseMode_(hint);
  return m || 'Other';
}

function normRef_(v) {
  return String(v == null ? '' : v).replace(/\s+/g, '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

/** Parse the many date shapes statements use. Returns a Date or null. */
function parseTxnDate_(v) {
  if (v instanceof Date && !isNaN(v.getTime())) return v;
  var s = String(v == null ? '' : v).trim();
  if (!s) return null;
  var m;
  // dd/mm/yyyy or dd-mm-yyyy (Indian day-first)
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (m) return mkDate_(+m[3], +m[2], +m[1]);
  // dd-MMM-yyyy / dd MMM yyyy / dd-MMM-yy
  m = s.match(/^(\d{1,2})[\s\-]([A-Za-z]{3,})[\s\-](\d{2,4})$/);
  if (m) { var mon = monthNum_(m[2]); if (mon) return mkDate_(+m[3], mon, +m[1]); }
  // yyyy-mm-dd (ISO)
  m = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  if (m) return mkDate_(+m[1], +m[2], +m[3]);
  // MMM dd, yyyy
  m = s.match(/^([A-Za-z]{3,})\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) { var mo = monthNum_(m[1]); if (mo) return mkDate_(+m[3], mo, +m[2]); }
  var d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function mkDate_(y, month, day) {
  if (y < 100) y += 2000;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  var d = new Date(y, month - 1, day, 12, 0, 0); // noon avoids TZ edge flips
  return isNaN(d.getTime()) ? null : d;
}

var MONTH_NUM = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function monthNum_(s) { return MONTH_NUM[String(s).slice(0, 3).toLowerCase()] || 0; }

/** Identify which bank/wallet a file is, from its name and any header text. */
function detectSource_(fileName, headerText) {
  var s = (String(fileName || '') + ' ' + String(headerText || '')).toLowerCase();
  if (/axis/.test(s)) return { label: 'Axis', mode: 'Other' };
  if (/\bsbi\b|state bank/.test(s)) return { label: 'SBI', mode: 'Other' };
  if (/paytm/.test(s)) return { label: 'Paytm', mode: 'PayTM' };
  if (/gpay|google\s*pay|google pay/.test(s)) return { label: 'GPay', mode: 'GPay' };
  return { label: 'Statement', mode: 'Other' };
}

// ---------------------------------------------------------------------------
// Dedup: within-batch and against the ledger
// ---------------------------------------------------------------------------

function dedupeBatch_(txns) {
  var sorted = txns.slice().sort(byDateAsc_);
  var unique = [];
  var duplicates = [];
  for (var i = 0; i < sorted.length; i++) {
    var t = sorted[i];
    var m = findMatch_(unique, t);
    if (m) {
      // Keep the one with a reference / richer description; note both sources.
      if (t.reference && !m.reference) m.reference = t.reference;
      if (m.source.indexOf(t.source) < 0) m.source += '+' + t.source;
      duplicates.push({ txn: t, reason: 'same as ' + m.source + ' (' + isoDate_(m.date) + ')' });
    } else {
      unique.push(t);
    }
  }
  return { unique: unique, duplicates: duplicates };
}

/** Return the first existing txn that is "the same" as t, else null. */
function findMatch_(list, t) {
  for (var i = 0; i < list.length; i++) {
    if (isSameTxn_(list[i], t)) return list[i];
  }
  return null;
}

/** Smart-match predicate. */
function isSameTxn_(a, b) {
  if (!amountEq_(a.amount, b.amount)) return false;
  if (a.direction !== b.direction) return false; // opposite legs of a transfer are NOT dupes
  if (a.reference && b.reference && a.reference === b.reference) return true;
  if (daysApart_(a.date, b.date) <= DUP_DAY_WINDOW && fuzzyNameMatch_(a, b)) return true;
  return false;
}

function amountEq_(x, y) { return Math.round(Number(x) * 100) === Math.round(Number(y) * 100); }
// Compare by CALENDAR day, not elapsed ms — a ledger row timestamped at
// entry time vs an imported date at noon must still count as the same day.
function daysApart_(a, b) {
  var da = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  var db = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.abs(da - db) / 86400000;
}

function fuzzyNameMatch_(a, b) {
  var na = normName_(a.party + ' ' + a.raw);
  var nb = normName_(b.party + ' ' + b.raw);
  if (!na || !nb) return false;
  if (na.indexOf(nb) > -1 || nb.indexOf(na) > -1) return true;
  var ta = tokens_(na), tb = tokens_(nb);
  for (var i = 0; i < ta.length; i++) {
    if (ta[i].length >= 3 && tb.indexOf(ta[i]) > -1) return true;
  }
  return false;
}

function normName_(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim(); }
function tokens_(s) { return normName_(s).split(' ').filter(function (w) { return w.length >= 3; }); }

// ---- Ledger index (existing rows) ------------------------------------------

/**
 * Build a lightweight index of what is already in the ledger, so imports can
 * skip transactions that are already recorded (manually or from a prior
 * import). The ledger has no reference column, so ledger matching relies on
 * amount + direction + date(+/-1) + fuzzy party name.
 */
function buildLedgerIndex_() {
  var ss = SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID') || DEFAULT_SPREADSHEET_ID);
  var sheet = ss.getSheetByName(SHEET_NAME);
  var idx = { byAmount: {} };
  if (!sheet) return idx;
  var lastRow = sheet.getLastRow();
  if (lastRow < 1) return idx;
  var data = sheet.getRange(1, 1, lastRow, TOTAL_COLUMNS).getValues();
  for (var r = 0; r < data.length; r++) {
    var row = data[r];
    var date = (row[0] instanceof Date) ? row[0] : null;
    if (!date) continue; // header / blank / non-data row
    var debit = Number(row[5]) || 0;
    var credit = Number(row[6]) || 0;
    var amount = credit > 0 ? credit : debit;
    if (!(amount > 0)) continue;
    var direction = credit > 0 ? 'credit' : 'debit';
    indexAddTxn_(idx, { date: date, amount: amount, direction: direction, party: String(row[1] || ''), raw: String(row[2] || '') });
  }
  return idx;
}

function indexAddTxn_(idx, t) {
  var key = amountKey_(t.amount);
  (idx.byAmount[key] = idx.byAmount[key] || []).push(t);
}

function amountKey_(a) { return String(Math.round(Number(a) * 100)); }

function matchInLedger_(t, idx) {
  var bucket = idx.byAmount[amountKey_(t.amount)];
  if (!bucket) return false;
  for (var i = 0; i < bucket.length; i++) {
    var e = bucket[i];
    if (e.direction !== t.direction) continue;
    if (daysApart_(e.date, t.date) <= DUP_DAY_WINDOW && fuzzyNameMatch_(e, t)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Small helpers / client marshalling
// ---------------------------------------------------------------------------

function byDateAsc_(a, b) { return a.date.getTime() - b.date.getTime(); }
function isoDate_(d) { return (d instanceof Date) ? Utilities.formatDate(d, 'Asia/Kolkata', 'yyyy-MM-dd') : ''; }

function entryFromTxn_(t) {
  return {
    party: t.party || t.raw || 'Unknown',
    particulars: t.particulars || 'Statement import',
    direction: t.direction,
    amount: t.amount,
    mode: (VALID_MODES.indexOf(t.mode) > -1) ? t.mode : 'Other',
    notes: buildNote_(t)
  };
}

function buildNote_(t) {
  var bits = [];
  if (t.source) bits.push('src:' + t.source);
  if (t.reference) bits.push('ref:' + t.reference);
  return bits.join(' ');
}

function txnForClient_(t) {
  return {
    date: isoDate_(t.date),
    party: t.party,
    particulars: t.particulars,
    amount: t.amount,
    direction: t.direction,
    mode: t.mode,
    reference: t.reference,
    source: t.source
  };
}

function txnFromClient_(o) {
  if (!o) return null;
  var date = parseTxnDate_(o.date);
  var amount = normaliseAmount_(o.amount);
  var direction = (o.direction === 'credit' || o.direction === 'debit') ? o.direction : normaliseDirection_(o.direction);
  if (!date || !(amount > 0) || !direction) return null;
  return {
    date: date,
    party: cleanStr_(o.party) || 'Unknown',
    particulars: cleanStr_(o.particulars) || 'Statement import',
    amount: amount,
    direction: direction,
    mode: (VALID_MODES.indexOf(o.mode) > -1) ? o.mode : normaliseMode_(o.mode) || 'Other',
    reference: normRef_(o.reference),
    source: cleanStr_(o.source) || 'Statement',
    raw: cleanStr_(o.particulars)
  };
}

/** Pull a JSON array out of model text (fences/prose tolerant). */
function extractJsonArray_(text) {
  if (text == null) return null;
  var t = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try { var v = JSON.parse(t); return Array.isArray(v) ? v : null; } catch (e) {}
  var start = t.indexOf('['); var end = t.lastIndexOf(']');
  if (start > -1 && end > start) {
    try { var a = JSON.parse(t.substring(start, end + 1)); return Array.isArray(a) ? a : null; } catch (e2) {}
  }
  return null;
}

// Merge these exports into the shared test bundle (Code.gs sets it first).
if (typeof module !== 'undefined' && module.exports) {
  Object.assign(module.exports, {
    previewConsolidation: previewConsolidation, commitConsolidation: commitConsolidation,
    parseTabular_: parseTabular_, findHeaderRow_: findHeaderRow_, mapColumns_: mapColumns_,
    rowToTxn_: rowToTxn_, makeTxn_: makeTxn_, parseTxnDate_: parseTxnDate_, parseMoney_: parseMoney_,
    counterparty_: counterparty_, modeFromContext_: modeFromContext_, detectSource_: detectSource_,
    dedupeBatch_: dedupeBatch_, isSameTxn_: isSameTxn_, fuzzyNameMatch_: fuzzyNameMatch_,
    buildLedgerIndex_: buildLedgerIndex_, matchInLedger_: matchInLedger_, indexAddTxn_: indexAddTxn_,
    entryFromTxn_: entryFromTxn_, txnFromClient_: txnFromClient_, extractJsonArray_: extractJsonArray_,
    normRef_: normRef_, normName_: normName_
  });
}

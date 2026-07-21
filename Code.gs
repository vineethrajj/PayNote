/**
 * Joseph Dental & Aesthetic Wellness — Bill Note
 * ------------------------------------------------
 * Google Apps Script Web App backend.
 *
 * Three jobs:
 *   1. Serve the mobile front-end (doGet -> Index.html).
 *   2. Parse a rough, casual payment sentence into structured JSON by
 *      calling the Anthropic Messages API server-side (parsePayment).
 *   3. Append the confirmed entry as a single row to the "Transactions"
 *      tab of the ledger spreadsheet (appendPayment).
 *
 * SAFETY: This script is APPEND-ONLY. It never inserts, updates, deletes,
 * or reorders existing rows. It only ever writes below the current last
 * row of the sheet. Other tabs (Dashboard, Expense Tracker, Payment
 * Tracker, Monthly Summary) read from "Transactions" via formulas that
 * must not be disturbed.
 *
 * ROBUSTNESS: rough human input is Claude's job to parse, but the model can
 * still return messy JSON (fenced, prose-wrapped, "2,000"/"2k"/"₹2000"
 * amounts, "google pay" modes, "received"/"paid" directions, or missing
 * fields). Every value coming back from the model is defensively
 * normalised and every value going into the sheet is re-validated
 * server-side, so a bad parse degrades to "ask the human to fill it in"
 * rather than a broken row. See the tests/ harness for the edge cases
 * exercised against these exact functions.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

var DEFAULT_SPREADSHEET_ID = '1IH0kwzT0UQAHkWuczVGpbv44S_gSYa-y';
var SHEET_NAME = 'Transactions';

var ANTHROPIC_MODEL = 'claude-haiku-4-5';
var ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
var ANTHROPIC_VERSION = '2023-06-01';

// Column layout of the "Transactions" tab (1-based), for reference:
//   1 Date | 2 From/Party | 3 Particulars | 4 Bank Details | 5 Method
//   6 Debit | 7 Credit | 8 Type | 9 Source | 10 Month | 11 Notes
var TOTAL_COLUMNS = 11;
var COL_A = 1;
var COL_MONTH = 10;
var SOURCE_TAG = 'Bill Note';

var VALID_MODES = ['Cash', 'GPay', 'PayTM', 'Card', 'Other'];
var MAX_INPUT_CHARS = 600;     // guard against pasted essays
var MAX_AMOUNT = 100000000;    // ₹10 crore sanity cap

// ---------------------------------------------------------------------------
// Web app entry point
// ---------------------------------------------------------------------------

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Joseph Dental — Bill Note')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ---------------------------------------------------------------------------
// Security helpers (optional shared PIN)
// ---------------------------------------------------------------------------

function isPinRequired() {
  var pin = PropertiesService.getScriptProperties().getProperty('APP_PIN');
  return !!(pin && String(pin).length > 0);
}

function checkPin_(pin) {
  var expected = PropertiesService.getScriptProperties().getProperty('APP_PIN');
  if (!expected) return; // no PIN configured -> allow
  if (String(pin || '') !== String(expected)) {
    throw new Error('Incorrect PIN. Ask the clinic admin for the current PIN.');
  }
}

// ---------------------------------------------------------------------------
// Step 1 — Parse rough text into structured JSON via Anthropic
// ---------------------------------------------------------------------------

/**
 * @param {string} rawText  e.g. "Prashanth paid 2000 cash for scaling"
 * @param {string} pin      shared PIN (ignored if no PIN configured)
 * @return {Object} { party, particulars, direction, amount, mode, notes }
 */
function parsePayment(rawText, pin) {
  checkPin_(pin);

  var text = String(rawText == null ? '' : rawText).trim();
  if (!text) {
    throw new Error('Please type a payment line first.');
  }
  if (text.length > MAX_INPUT_CHARS) {
    text = text.substring(0, MAX_INPUT_CHARS); // never reject, just cap
  }

  var apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) {
    throw new Error('Server not configured: missing ANTHROPIC_API_KEY script property.');
  }

  var systemPrompt = buildSystemPrompt_();

  var payload = {
    model: ANTHROPIC_MODEL,
    max_tokens: 400,
    system: systemPrompt,
    messages: [{ role: 'user', content: text }]
  };

  var response = fetchWithRetry_(ANTHROPIC_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  }, 3);

  var code = response.getResponseCode();
  var body = response.getContentText();
  if (code < 200 || code >= 300) {
    throw new Error('Parsing service is busy (' + code + '). Please try again, or fill the fields manually.');
  }

  var apiJson;
  try {
    apiJson = JSON.parse(body);
  } catch (e) {
    throw new Error('Could not read the parsing response. Please try again.');
  }

  var modelText = '';
  if (apiJson && apiJson.content && apiJson.content.length) {
    for (var i = 0; i < apiJson.content.length; i++) {
      if (apiJson.content[i] && apiJson.content[i].type === 'text') {
        modelText += apiJson.content[i].text;
      }
    }
  }

  var parsed = extractJson_(modelText);
  if (!parsed || typeof parsed !== 'object') {
    // Total parse failure: hand back a blank skeleton so the front-end can
    // still show the confirmation card and let the human fill everything.
    return normaliseParsed_({});
  }

  return normaliseParsed_(parsed);
}

function buildSystemPrompt_() {
  return [
    'You extract structured payment records for a dental clinic front desk.',
    'You will be given ONE rough, casual sentence describing a single payment.',
    'Return ONLY a JSON object, no prose, no markdown, no code fences.',
    '',
    'The JSON shape is exactly:',
    '{',
    '  "party": string,          // patient name (money received) or vendor/lab/consultant (money paid out)',
    '  "particulars": string,    // the service or expense, title-cased, concise',
    '  "direction": "credit" | "debit",  // credit = money received FROM a patient; debit = money the clinic PAID OUT',
    '  "amount": number,         // rupee amount as a plain number, no symbols or commas',
    '  "mode": "Cash" | "GPay" | "PayTM" | "Card" | "Other",',
    '  "notes": string           // extra free text, or "" if none',
    '}',
    '',
    'Rules:',
    '- "credit" means the clinic RECEIVED money (a patient paid for a treatment).',
    '- "debit" means the clinic PAID money out (lab bill, consultant fee, supplies, rent, etc.).',
    '- Expand shorthand amounts: "2k" -> 2000, "1.5k" -> 1500, "2 lakh" -> 200000.',
    '- Normalise payment mode: gpay/google pay/g pay -> "GPay"; paytm -> "PayTM";',
    '  card/credit card/debit card/swipe -> "Card"; cash -> "Cash";',
    '  phonepe/upi/bank transfer/cheque/anything else -> "Other".',
    '- If you CANNOT confidently determine amount, mode, or direction, return',
    '  0 for amount, "" for mode, and "" for direction rather than guessing.',
    '- Never invent a party or amount that is not implied by the text.',
    '',
    'Examples:',
    'Input: "Prashanth paid 2000 cash for scaling"',
    'Output: {"party":"Prashanth","particulars":"Scaling","direction":"credit","amount":2000,"mode":"Cash","notes":""}',
    'Input: "paid lab 5000 gpay for zirconia case"',
    'Output: {"party":"Lab","particulars":"Zirconia Case","direction":"debit","amount":5000,"mode":"GPay","notes":""}',
    'Input: "raj gpay 1200 consultation"',
    'Output: {"party":"Raj","particulars":"Consultation","direction":"credit","amount":1200,"mode":"GPay","notes":""}'
  ].join('\n');
}

/**
 * Fetch with retry/backoff on transient failures (429, 5xx, network errors).
 * Returns the HTTPResponse; only rethrows if every attempt threw.
 */
function fetchWithRetry_(url, options, tries) {
  tries = tries || 3;
  var wait = 800;
  var lastResp = null;
  for (var i = 0; i < tries; i++) {
    try {
      var resp = UrlFetchApp.fetch(url, options);
      var code = resp.getResponseCode();
      if (code === 429 || (code >= 500 && code < 600)) {
        lastResp = resp;
        if (i < tries - 1) { Utilities.sleep(wait); wait *= 2; continue; }
        return resp; // out of retries; let caller surface the code
      }
      return resp;
    } catch (e) {
      if (i < tries - 1) { Utilities.sleep(wait); wait *= 2; continue; }
      throw e;
    }
  }
  return lastResp;
}

/**
 * Pull a JSON object out of the model's text output, tolerating stray code
 * fences, prose before/after, or nested braces inside string values.
 */
function extractJson_(text) {
  if (text == null) return null;
  var t = String(text).trim();
  if (!t) return null;

  // 1) Try as-is (after stripping ``` fences).
  var fenced = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  var direct = tryParse_(fenced);
  if (direct) return direct;

  // 2) Find the first balanced {...} object, ignoring braces inside strings.
  var obj = firstBalancedObject_(t);
  if (obj) {
    var parsed = tryParse_(obj);
    if (parsed) return parsed;
  }
  return null;
}

function tryParse_(s) {
  try {
    var v = JSON.parse(s);
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v : null;
  } catch (e) {
    return null;
  }
}

/** Scan for the first top-level {...}, respecting quoted strings/escapes. */
function firstBalancedObject_(s) {
  var start = s.indexOf('{');
  if (start < 0) return null;
  var depth = 0, inStr = false, esc = false;
  for (var i = start; i < s.length; i++) {
    var c = s.charAt(i);
    if (inStr) {
      if (esc) { esc = false; }
      else if (c === '\\') { esc = true; }
      else if (c === '"') { inStr = false; }
      continue;
    }
    if (c === '"') { inStr = true; }
    else if (c === '{') { depth++; }
    else if (c === '}') {
      depth--;
      if (depth === 0) return s.substring(start, i + 1);
    }
  }
  return null;
}

/** Coerce whatever the model returned into safe, predictable field types. */
function normaliseParsed_(p) {
  p = (p && typeof p === 'object') ? p : {};
  return {
    party: cleanStr_(p.party),
    particulars: cleanStr_(p.particulars),
    direction: normaliseDirection_(p.direction),
    amount: normaliseAmount_(p.amount),
    mode: normaliseMode_(p.mode),
    notes: cleanStr_(p.notes)
  };
}

function cleanStr_(v) {
  if (v == null) return '';
  return String(v).replace(/\s+/g, ' ').trim();
}

/**
 * Parse an amount that might arrive as a number, or a string like
 * "2,000", "₹2000", "2k", "1.5k", "2 lakh", "rs 500". Returns a
 * non-negative number, or 0 if none can be found.
 */
function normaliseAmount_(v) {
  if (typeof v === 'number') {
    return (isFinite(v) && v > 0) ? capAmount_(v) : 0;
  }
  if (v == null) return 0;
  var s = String(v).toLowerCase().replace(/₹|rs\.?|inr/g, ' ').replace(/,/g, '');
  if (!s.trim()) return 0;

  var mult = 1;
  if (/\b(cr|crore|crores)\b/.test(s)) mult = 10000000;
  else if (/\b(l|lac|lakh|lakhs|lacs)\b/.test(s)) mult = 100000;
  else if (/\b(k|thousand|thousands)\b/.test(s) || /\d\s*k\b/.test(s)) mult = 1000;

  var m = s.match(/-?\d+(\.\d+)?/);
  if (!m) return 0;
  var n = parseFloat(m[0]);
  if (!isFinite(n) || n < 0) return 0;
  n = n * mult;
  return capAmount_(Math.round(n * 100) / 100);
}

function capAmount_(n) {
  if (n > MAX_AMOUNT) return MAX_AMOUNT;
  return n;
}

/** Map free-form mode text to one of the five allowed modes ('' if absent). */
function normaliseMode_(v) {
  var s = String(v == null ? '' : v).toLowerCase().trim();
  if (!s) return '';
  if (/cash/.test(s)) return 'Cash';
  if (/paytm/.test(s)) return 'PayTM';
  if (/gpay|g[\s-]*pay|google[\s-]*pay/.test(s)) return 'GPay';
  if (/card|visa|master|swipe|pos|rupay/.test(s)) return 'Card';
  // Recognised non-cash digital / bank methods all bucket to "Other".
  if (/phonepe|phone\s*pe|upi|bhim|neft|imps|rtgs|net\s*bank|netbank|cheque|check|dd\b|bank\s*transfer|transfer|online/.test(s)) {
    return 'Other';
  }
  // Exact match to a valid label?
  for (var i = 0; i < VALID_MODES.length; i++) {
    if (VALID_MODES[i].toLowerCase() === s) return VALID_MODES[i];
  }
  // Some mode WAS stated but we don't recognise it -> Other (the catch-all).
  return 'Other';
}

/** Map free-form direction text to 'credit' | 'debit' | '' (unknown). */
function normaliseDirection_(v) {
  var s = String(v == null ? '' : v).toLowerCase().trim();
  if (s === 'credit' || s === 'cr') return 'credit';
  if (s === 'debit' || s === 'dr') return 'debit';
  if (/receiv|incoming|collected|deposit|\bin\b|\bfrom\b/.test(s)) return 'credit';
  if (/paid|expense|outgoing|purchase|salary|\bout\b|\bto\b/.test(s)) return 'debit';
  return '';
}

// ---------------------------------------------------------------------------
// Step 2 — Append the confirmed entry to the sheet (APPEND-ONLY)
// ---------------------------------------------------------------------------

/**
 * Append one confirmed entry to the "Transactions" tab.
 *
 * APPEND-ONLY GUARANTEE: writes only at getLastRow()+1 (and, when a new
 * month starts, a month-header row followed by the entry row). It never
 * touches any existing row.
 *
 * @param {Object} entry { party, particulars, direction, amount, mode, notes }
 * @param {string} pin   shared PIN (ignored if no PIN configured)
 * @return {Object} { ok:true, month:string, row:number, addedHeader:boolean }
 */
function appendPayment(entry, pin) {
  checkPin_(pin);

  entry = sanitiseEntry_(entry);
  var errors = validateEntry_(entry);
  if (errors.length) {
    throw new Error(errors.join(' '));
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(20000); // serialise concurrent submissions from multiple staff
  try {
    var ssId = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID') || DEFAULT_SPREADSHEET_ID;
    var ss = SpreadsheetApp.openById(ssId);
    var sheet = ss.getSheetByName(SHEET_NAME);
    if (!sheet) {
      throw new Error('Sheet "' + SHEET_NAME + '" not found in the spreadsheet.');
    }

    var now = new Date();
    var tz = ss.getSpreadsheetTimeZone() || Session.getScriptTimeZone() || 'Asia/Kolkata';
    var monthStr = Utilities.formatDate(now, tz, 'MMM yyyy'); // e.g. "Jul 2026"

    var rowValues = buildRow_(entry, now, monthStr);

    var lastRow = sheet.getLastRow();
    var lastMonth = readLastMonth_(sheet, lastRow, tz);

    var writtenRow, addedHeader;
    if (lastRow >= 1 && lastMonth === monthStr) {
      // Same month as the most recent row/header -> append directly below it.
      writtenRow = lastRow + 1;
      addedHeader = false;
      sheet.getRange(writtenRow, 1, 1, TOTAL_COLUMNS).setValues([rowValues]);
    } else {
      // New month (or empty sheet) -> write a month header, then the entry.
      var headerRow = lastRow + 1;
      var headerValues = blankRow_();
      headerValues[0] = '◆  ' + monthStr; // "◆  Jul 2026" in column A
      sheet.getRange(headerRow, 1, 1, TOTAL_COLUMNS).setValues([headerValues]);

      writtenRow = headerRow + 1;
      addedHeader = true;
      sheet.getRange(writtenRow, 1, 1, TOTAL_COLUMNS).setValues([rowValues]);
    }

    SpreadsheetApp.flush();
    return { ok: true, month: monthStr, row: writtenRow, addedHeader: addedHeader };
  } finally {
    lock.releaseLock();
  }
}

/** Build the 11-cell row array in the exact ledger column order. */
function buildRow_(entry, dateObj, monthStr) {
  var isCash = (entry.mode === 'Cash');
  var isCredit = (entry.direction === 'credit');
  return [
    dateObj,                          // 1  Date
    entry.party,                      // 2  From / Party
    entry.particulars,                // 3  Particulars
    entry.mode,                       // 4  Bank Details (== payment mode)
    isCash ? 'Cash' : 'Online',       // 5  Method
    isCredit ? '' : entry.amount,     // 6  Debit  (only if debit)
    isCredit ? entry.amount : '',     // 7  Credit (only if credit)
    isCredit ? 'CR' : 'DR',           // 8  Type
    SOURCE_TAG,                       // 9  Source
    monthStr,                         // 10 Month
    entry.notes || ''                 // 11 Notes
  ];
}

function blankRow_() {
  var r = [];
  for (var i = 0; i < TOTAL_COLUMNS; i++) r.push('');
  return r;
}

/**
 * Determine the "month" of the current bottom of the sheet.
 * - If the last row is a "◆ Month Year" header, use the month it names
 *   (so we append under an existing header instead of duplicating it).
 * - Otherwise read the Month cell (column J); if that data row's month is
 *   blank, scan upward to the nearest non-blank month.
 * Returns '' for an empty sheet.
 */
function readLastMonth_(sheet, lastRow, tz) {
  if (lastRow < 1) return '';
  var lastA = String(sheet.getRange(lastRow, COL_A).getValue() || '').trim();
  if (lastA.charAt(0) === '◆') { // ◆ header row
    return lastA.replace(/^[◆\s]+/, '').trim();
  }
  var monthCell = monthCellToStr_(sheet.getRange(lastRow, COL_MONTH).getValue(), tz);
  if (monthCell) return monthCell;
  return scanUpwardForMonth_(sheet, lastRow, tz);
}

function monthCellToStr_(raw, tz) {
  if (raw instanceof Date) return Utilities.formatDate(raw, tz, 'MMM yyyy');
  return String(raw == null ? '' : raw).trim();
}

/** Walk up from `fromRow` (bounded) looking for the nearest non-blank month. */
function scanUpwardForMonth_(sheet, fromRow, tz) {
  var floor = Math.max(1, fromRow - 500);
  for (var r = fromRow - 1; r >= floor; r--) {
    var a = String(sheet.getRange(r, COL_A).getValue() || '').trim();
    if (a.charAt(0) === '◆') return a.replace(/^[◆\s]+/, '').trim();
    var m = monthCellToStr_(sheet.getRange(r, COL_MONTH).getValue(), tz);
    if (m) return m;
  }
  return '';
}

/** Coerce a client-supplied entry into clean, typed fields. */
function sanitiseEntry_(entry) {
  entry = (entry && typeof entry === 'object') ? entry : {};
  return {
    party: cleanStr_(entry.party),
    particulars: cleanStr_(entry.particulars),
    direction: (entry.direction === 'credit' || entry.direction === 'debit') ? entry.direction : normaliseDirection_(entry.direction),
    amount: normaliseAmount_(entry.amount),
    mode: (VALID_MODES.indexOf(entry.mode) > -1) ? entry.mode : normaliseMode_(entry.mode),
    notes: cleanStr_(entry.notes)
  };
}

/** Server-side required-field validation. Returns an array of messages. */
function validateEntry_(entry) {
  var errs = [];
  if (!entry || typeof entry !== 'object') { return ['Nothing to save.']; }
  if (!cleanStr_(entry.party)) errs.push('Party/name is required.');
  if (!cleanStr_(entry.particulars)) errs.push('Particulars are required.');
  if (entry.direction !== 'credit' && entry.direction !== 'debit') errs.push('Direction must be credit or debit.');
  var amt = Number(entry.amount);
  if (!isFinite(amt) || amt <= 0) errs.push('Amount must be greater than zero.');
  if (VALID_MODES.indexOf(entry.mode) === -1) errs.push('Payment mode is required.');
  return errs;
}

// ---------------------------------------------------------------------------
// Diagnostics — run manually from the editor, never from the web app
// ---------------------------------------------------------------------------

function diagnostic_readOnly() {
  var ssId = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID') || DEFAULT_SPREADSHEET_ID;
  var ss = SpreadsheetApp.openById(ssId);
  var sheet = ss.getSheetByName(SHEET_NAME);
  Logger.log('Spreadsheet: %s', ss.getName());
  Logger.log('Sheet found: %s', !!sheet);
  if (sheet) {
    var lastRow = sheet.getLastRow();
    Logger.log('Last row: %s', lastRow);
    if (lastRow >= 1) {
      Logger.log('Last row values: %s', JSON.stringify(sheet.getRange(lastRow, 1, 1, TOTAL_COLUMNS).getValues()[0]));
    }
  }
  Logger.log('API key set: %s', !!PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY'));
  Logger.log('PIN required: %s', isPinRequired());
}

function diagnostic_appendSample() {
  var res = appendPayment({
    party: 'Test Patient',
    particulars: 'Scaling (test)',
    direction: 'credit',
    amount: 1,
    mode: 'Cash',
    notes: 'diagnostic sample — safe to delete'
  }, PropertiesService.getScriptProperties().getProperty('APP_PIN') || '');
  Logger.log('Appended: %s', JSON.stringify(res));
}

// Export the pure helpers for the Node test harness. This block is a no-op
// inside Apps Script (there is no `module`), so it does not affect the web app.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parsePayment: parsePayment, appendPayment: appendPayment,
    extractJson_: extractJson_, firstBalancedObject_: firstBalancedObject_,
    normaliseParsed_: normaliseParsed_, normaliseAmount_: normaliseAmount_,
    normaliseMode_: normaliseMode_, normaliseDirection_: normaliseDirection_,
    validateEntry_: validateEntry_, sanitiseEntry_: sanitiseEntry_,
    buildRow_: buildRow_, readLastMonth_: readLastMonth_, cleanStr_: cleanStr_,
    isPinRequired: isPinRequired
  };
}

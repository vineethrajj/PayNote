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
 * Front-end <-> back-end communication uses google.script.run (not raw
 * HTTP POST). Because the page is served by this same Apps Script project,
 * google.script.run is the idiomatic, CORS-free way to invoke the
 * server-side parse/append functions. The architecture is unchanged from
 * the brief: parsing and sheet writes both happen server-side; the API
 * key never leaves the server.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Spreadsheet the ledger lives in. Set as a Script Property named
// SPREADSHEET_ID to override (recommended so you can point at a test copy
// without editing code). Falls back to the live ledger ID below.
var DEFAULT_SPREADSHEET_ID = '1IH0kwzT0UQAHkWuczVGpbv44S_gSYa-y';
var SHEET_NAME = 'Transactions';

// Anthropic model used for parsing. Cheap + fast is ideal here.
var ANTHROPIC_MODEL = 'claude-haiku-4-5';
var ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
var ANTHROPIC_VERSION = '2023-06-01';

// Column layout of the "Transactions" tab (1-based), for reference:
//   1 Date | 2 From/Party | 3 Particulars | 4 Bank Details | 5 Method
//   6 Debit | 7 Credit | 8 Type | 9 Source | 10 Month | 11 Notes
var TOTAL_COLUMNS = 11;
var COL_MONTH = 10;
var SOURCE_TAG = 'Bill Note';

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

/**
 * Returns true if a shared PIN is configured (Script Property APP_PIN).
 * When configured, the front-end will prompt for it and every server call
 * must carry the correct PIN. When not configured, no PIN is required.
 */
function isPinRequired() {
  var pin = PropertiesService.getScriptProperties().getProperty('APP_PIN');
  return !!(pin && pin.length > 0);
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
 * Called from the front-end. Sends the raw sentence to Claude and returns
 * a parsed object. Does NOT touch the sheet.
 *
 * @param {string} rawText  e.g. "Prashanth paid 2000 cash for scaling"
 * @param {string} pin      shared PIN (ignored if no PIN configured)
 * @return {Object} { party, particulars, direction, amount, mode, notes }
 */
function parsePayment(rawText, pin) {
  checkPin_(pin);

  if (!rawText || !String(rawText).trim()) {
    throw new Error('Please type a payment line first.');
  }

  var apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) {
    throw new Error('Server not configured: missing ANTHROPIC_API_KEY script property.');
  }

  var systemPrompt = [
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
    '- Normalise payment mode: gpay/google pay/g pay -> "GPay"; paytm -> "PayTM";',
    '  card/credit card/debit card/swipe -> "Card"; cash -> "Cash"; anything else -> "Other".',
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

  var payload = {
    model: ANTHROPIC_MODEL,
    max_tokens: 400,
    system: systemPrompt,
    messages: [
      { role: 'user', content: String(rawText).trim() }
    ]
  };

  var response = UrlFetchApp.fetch(ANTHROPIC_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  var code = response.getResponseCode();
  var body = response.getContentText();
  if (code < 200 || code >= 300) {
    throw new Error('Parsing service error (' + code + '). Please try again or enter details manually.');
  }

  var apiJson;
  try {
    apiJson = JSON.parse(body);
  } catch (e) {
    throw new Error('Could not read parsing response. Please try again.');
  }

  var text = '';
  if (apiJson.content && apiJson.content.length) {
    for (var i = 0; i < apiJson.content.length; i++) {
      if (apiJson.content[i].type === 'text') {
        text += apiJson.content[i].text;
      }
    }
  }

  var parsed = extractJson_(text);
  if (!parsed) {
    throw new Error('Could not understand that line. Please rephrase or fill the fields manually.');
  }

  return normaliseParsed_(parsed);
}

/**
 * Pull a JSON object out of the model's text output, tolerating stray
 * code fences or surrounding whitespace.
 */
function extractJson_(text) {
  if (!text) return null;
  var t = String(text).trim();
  // Strip ```json ... ``` fences if present.
  t = t.replace(/^```(?:json)?/i, '').replace(/```$/,'').trim();
  try {
    return JSON.parse(t);
  } catch (e) {
    var start = t.indexOf('{');
    var end = t.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(t.substring(start, end + 1));
      } catch (e2) {
        return null;
      }
    }
    return null;
  }
}

/** Coerce the model output into safe, predictable field types. */
function normaliseParsed_(p) {
  var validModes = ['Cash', 'GPay', 'PayTM', 'Card', 'Other'];
  var mode = String(p.mode || '').trim();
  // Case-insensitive match to a valid mode; blank if unknown.
  var matched = '';
  for (var i = 0; i < validModes.length; i++) {
    if (validModes[i].toLowerCase() === mode.toLowerCase()) { matched = validModes[i]; break; }
  }

  var direction = String(p.direction || '').trim().toLowerCase();
  if (direction !== 'credit' && direction !== 'debit') direction = '';

  var amount = Number(p.amount);
  if (!isFinite(amount) || amount < 0) amount = 0;

  return {
    party: String(p.party || '').trim(),
    particulars: String(p.particulars || '').trim(),
    direction: direction,
    amount: amount,
    mode: matched,
    notes: String(p.notes || '').trim()
  };
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
 * @return {Object} { ok:true, month:string, row:number }
 */
function appendPayment(entry, pin) {
  checkPin_(pin);

  // Re-validate server-side; never trust the client to have enforced this.
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

    var isCash = (entry.mode === 'Cash');
    var isCredit = (entry.direction === 'credit');

    var rowValues = [
      now,                                   // 1  Date
      entry.party,                           // 2  From / Party
      entry.particulars,                     // 3  Particulars
      entry.mode,                            // 4  Bank Details (== payment mode)
      isCash ? 'Cash' : 'Online',            // 5  Method
      isCredit ? '' : entry.amount,          // 6  Debit  (only if debit)
      isCredit ? entry.amount : '',          // 7  Credit (only if credit)
      isCredit ? 'CR' : 'DR',                // 8  Type
      SOURCE_TAG,                            // 9  Source
      monthStr,                              // 10 Month
      entry.notes || ''                      // 11 Notes
    ];

    // Determine the month of the current last row (column J / index 10).
    var lastRow = sheet.getLastRow();
    var lastMonth = '';
    if (lastRow >= 1) {
      var raw = sheet.getRange(lastRow, COL_MONTH).getValue();
      if (raw instanceof Date) {
        lastMonth = Utilities.formatDate(raw, tz, 'MMM yyyy');
      } else {
        lastMonth = String(raw || '').trim();
      }
    }

    var writtenRow;
    if (lastRow >= 1 && lastMonth === monthStr) {
      // Same month as the last row -> append the entry directly below.
      writtenRow = lastRow + 1;
      sheet.getRange(writtenRow, 1, 1, TOTAL_COLUMNS).setValues([rowValues]);
    } else {
      // New month (or empty sheet) -> write a month header, then the entry.
      var headerRow = lastRow + 1;
      var headerValues = new Array(TOTAL_COLUMNS).fill('');
      headerValues[0] = '◆  ' + monthStr; // "◆  Jul 2026" in column A
      sheet.getRange(headerRow, 1, 1, TOTAL_COLUMNS).setValues([headerValues]);

      writtenRow = headerRow + 1;
      sheet.getRange(writtenRow, 1, 1, TOTAL_COLUMNS).setValues([rowValues]);
    }

    SpreadsheetApp.flush();
    return { ok: true, month: monthStr, row: writtenRow };
  } finally {
    lock.releaseLock();
  }
}

/** Server-side required-field validation. Returns an array of messages. */
function validateEntry_(entry) {
  var errs = [];
  if (!entry || typeof entry !== 'object') { return ['Nothing to save.']; }
  if (!String(entry.party || '').trim()) errs.push('Party/name is required.');
  if (!String(entry.particulars || '').trim()) errs.push('Particulars are required.');
  if (entry.direction !== 'credit' && entry.direction !== 'debit') errs.push('Direction must be credit or debit.');
  var amt = Number(entry.amount);
  if (!isFinite(amt) || amt <= 0) errs.push('Amount must be greater than zero.');
  var validModes = ['Cash', 'GPay', 'PayTM', 'Card', 'Other'];
  if (validModes.indexOf(entry.mode) === -1) errs.push('Payment mode is required.');
  return errs;
}

// ---------------------------------------------------------------------------
// Diagnostics — run manually from the editor, never from the web app
// ---------------------------------------------------------------------------

/**
 * One-off check that the script can open the sheet and read its shape,
 * WITHOUT writing anything. Run from the Apps Script editor and read Logs.
 */
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

/**
 * End-to-end write test AGAINST WHATEVER SPREADSHEET_ID IS CONFIGURED.
 * Only run this when SPREADSHEET_ID points at a TEST COPY. It appends one
 * sample credit row.
 */
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

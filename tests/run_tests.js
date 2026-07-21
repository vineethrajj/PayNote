/**
 * Aggressive edge-case harness for Code.gs.
 *
 * It loads the REAL Code.gs (not a copy) into a Node VM with the Apps Script
 * globals stubbed — PropertiesService, UrlFetchApp, SpreadsheetApp,
 * Utilities, LockService, Session, Logger — so the exact production
 * functions run. UrlFetchApp returns canned Anthropic responses so we can
 * simulate messy model output; SpreadsheetApp is an in-memory sheet so we
 * can assert the append-only guarantee and month-header behaviour.
 *
 * Run: node tests/run_tests.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Apps Script stubs
// ---------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Controllable "current time" so month logic is deterministic.
let NOW = new Date(Date.UTC(2026, 6, 21, 6, 0, 0)); // Jul 2026

const scriptProps = new Map();
let fetchQueue = []; // array of () => ({code, body}) OR a value; supports throw

function makeResponse(code, bodyObj) {
  const body = typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj);
  return { getResponseCode: () => code, getContentText: () => body };
}

// In-memory sheet -------------------------------------------------------------
function makeSheet(rows) {
  // rows: array of arrays (ragged ok). Deep copy.
  const data = rows.map(r => r.slice());
  return {
    _data: data,
    getName: () => 'Transactions',
    getLastRow: () => data.length,
    getRange: (r, c, numRows = 1, numCols = 1) => ({
      getValue: () => {
        const row = data[r - 1] || [];
        const v = row[c - 1];
        return v === undefined ? '' : v;
      },
      getValues: () => {
        const out = [];
        for (let i = 0; i < numRows; i++) {
          const row = [];
          const src = data[r - 1 + i] || [];
          for (let j = 0; j < numCols; j++) {
            const v = src[c - 1 + j];
            row.push(v === undefined ? '' : v);
          }
          out.push(row);
        }
        return out;
      },
      setValues: (vals) => {
        for (let i = 0; i < vals.length; i++) {
          const tr = r - 1 + i;
          if (!data[tr]) data[tr] = [];
          for (let j = 0; j < vals[i].length; j++) {
            data[tr][c - 1 + j] = vals[i][j];
          }
        }
      }
    })
  };
}

let currentSheet = makeSheet([]);

const sandbox = {
  module: { exports: {} },
  console,
  Date, // real Date, but Code.gs calls `new Date()` -> patched below via proxy
  PropertiesService: {
    getScriptProperties: () => ({
      getProperty: (k) => (scriptProps.has(k) ? scriptProps.get(k) : null)
    })
  },
  UrlFetchApp: {
    fetch: () => {
      if (!fetchQueue.length) throw new Error('fetchQueue empty');
      const next = fetchQueue.shift();
      const r = next();
      if (r && r.__throw) throw new Error(r.__throw);
      return r;
    }
  },
  Utilities: {
    sleep: () => {}, // no real waiting in tests
    formatDate: (date, tz, fmt) => {
      const d = new Date(date);
      const mmm = MONTHS[d.getUTCMonth()];
      const yyyy = d.getUTCFullYear();
      if (fmt === 'MMM yyyy') return `${mmm} ${yyyy}`;
      return d.toISOString();
    }
  },
  LockService: {
    getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} })
  },
  Session: { getScriptTimeZone: () => 'Asia/Kolkata' },
  Logger: { log: () => {} },
  SpreadsheetApp: {
    openById: () => ({
      getName: () => 'Ledger (test)',
      getSpreadsheetTimeZone: () => 'Asia/Kolkata',
      getSheetByName: (n) => (n === 'Transactions' ? currentSheet : null)
    }),
    flush: () => {}
  }
};

// Make `new Date()` (no args) return NOW, but keep Date(args) real.
const RealDate = Date;
sandbox.Date = new Proxy(RealDate, {
  construct(target, args) {
    if (args.length === 0) return new RealDate(NOW.getTime());
    return new target(...args);
  }
});

// ---------------------------------------------------------------------------
// Load Code.gs into the sandbox
// ---------------------------------------------------------------------------
const vm = require('vm');
const code = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'Code.gs' });
const C = sandbox.module.exports;

// ---------------------------------------------------------------------------
// Tiny test runner
// ---------------------------------------------------------------------------
let pass = 0, fail = 0;
const failures = [];
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; }
  else { fail++; failures.push(`${msg}\n     expected ${e}\n     got      ${a}`); }
}
function ok(cond, msg) { if (cond) pass++; else { fail++; failures.push(msg); } }
function throws(fn, reMsg, msg) {
  try { fn(); fail++; failures.push(`${msg} — expected throw, none thrown`); }
  catch (e) {
    if (!reMsg || reMsg.test(e.message)) pass++;
    else { fail++; failures.push(`${msg} — wrong error: ${e.message}`); }
  }
}
function section(name) { console.log('\n== ' + name + ' =='); }

// ---------------------------------------------------------------------------
// 1) normaliseAmount_  — rough amounts
// ---------------------------------------------------------------------------
section('normaliseAmount_');
[
  [2000, 2000], ['2000', 2000], ['2,000', 2000], ['₹2000', 2000], ['rs 2000', 2000],
  ['rs.2000', 2000], ['2k', 2000], ['2K', 2000], ['1.5k', 1500], ['2 thousand', 2000],
  ['2 lakh', 200000], ['2.5 lakh', 250000], ['1 lac', 100000], ['1 crore', 10000000],
  ['₹1,50,000', 150000], ['  500  ', 500], ['abc', 0], ['', 0], [null, 0], [undefined, 0],
  [-5, 0], ['-5', 0], [0, 0], ['0', 0], [2000.5, 2000.5], ['2,00,000', 200000],
  [{}, 0], [[], 0], [NaN, 0], [Infinity, 0], ['twelve', 0], ['20 crore', 100000000 /* string capped */],
  [999999999999, 100000000 /* number capped */]
].forEach(([input, expected], i) => {
  eq(C.normaliseAmount_(input), expected, `amount[${i}] ${JSON.stringify(input)}`);
});

// ---------------------------------------------------------------------------
// 2) normaliseMode_
// ---------------------------------------------------------------------------
section('normaliseMode_');
[
  ['cash', 'Cash'], ['Cash', 'Cash'], ['CASH', 'Cash'], ['gpay', 'GPay'],
  ['g pay', 'GPay'], ['google pay', 'GPay'], ['GooglePay', 'GPay'], ['paytm', 'PayTM'],
  ['PayTM', 'PayTM'], ['card', 'Card'], ['credit card', 'Card'], ['debit card', 'Card'],
  ['swipe', 'Card'], ['visa', 'Card'], ['rupay', 'Card'], ['phonepe', 'Other'],
  ['phone pe', 'Other'], ['upi', 'Other'], ['bhim', 'Other'], ['neft', 'Other'],
  ['cheque', 'Other'], ['bank transfer', 'Other'], ['online', 'Other'], ['', ''],
  [null, ''], [undefined, ''], ['   ', ''], ['weirdmode', 'Other'], ['Other', 'Other']
].forEach(([input, expected], i) => {
  eq(C.normaliseMode_(input), expected, `mode[${i}] ${JSON.stringify(input)}`);
});

// ---------------------------------------------------------------------------
// 3) normaliseDirection_
// ---------------------------------------------------------------------------
section('normaliseDirection_');
[
  ['credit', 'credit'], ['CREDIT', 'credit'], ['cr', 'credit'], ['debit', 'debit'],
  ['DR', 'debit'], ['received', 'credit'], ['collected', 'credit'], ['deposit', 'credit'],
  ['paid', 'debit'], ['expense', 'debit'], ['salary', 'debit'], ['purchase', 'debit'],
  ['', ''], [null, ''], [undefined, ''], ['maybe', ''], ['incoming', 'credit'],
  ['outgoing', 'debit']
].forEach(([input, expected], i) => {
  eq(C.normaliseDirection_(input), expected, `dir[${i}] ${JSON.stringify(input)}`);
});

// ---------------------------------------------------------------------------
// 4) extractJson_ / firstBalancedObject_  — messy model text
// ---------------------------------------------------------------------------
section('extractJson_');
const good = { party: 'A', amount: 1 };
eq(C.extractJson_('{"party":"A","amount":1}'), good, 'plain json');
eq(C.extractJson_('```json\n{"party":"A","amount":1}\n```'), good, 'json fence');
eq(C.extractJson_('```\n{"party":"A","amount":1}\n```'), good, 'bare fence');
eq(C.extractJson_('Here is the result: {"party":"A","amount":1}'), good, 'prose prefix');
eq(C.extractJson_('{"party":"A","amount":1}\nHope that helps!'), good, 'prose suffix');
eq(C.extractJson_('  \n {"party":"A","amount":1}  \n'), good, 'whitespace');
eq(C.extractJson_('{"party":"A} B","amount":1}'), { party: 'A} B', amount: 1 }, 'brace inside string');
eq(C.extractJson_('{"party":"line1\\nline2","amount":1}'), { party: 'line1\nline2', amount: 1 }, 'escaped newline');
ok(C.extractJson_('sorry, I cannot parse that') === null, 'garbage -> null');
ok(C.extractJson_('') === null, 'empty -> null');
ok(C.extractJson_(null) === null, 'null -> null');
ok(C.extractJson_('[1,2,3]') === null, 'array -> null (not an object)');
ok(C.extractJson_('{ not json }') === null, 'invalid braces -> null');

// ---------------------------------------------------------------------------
// 5) normaliseParsed_  — full messy objects
// ---------------------------------------------------------------------------
section('normaliseParsed_');
eq(C.normaliseParsed_({ party: '  Prashanth ', particulars: 'Scaling', direction: 'credit', amount: '2,000', mode: 'cash', notes: '' }),
   { party: 'Prashanth', particulars: 'Scaling', direction: 'credit', amount: 2000, mode: 'Cash', notes: '' }, 'clean-ish');
eq(C.normaliseParsed_({ party: 'Lab', particulars: 'Zirconia', direction: 'paid', amount: '5k', mode: 'google pay' }),
   { party: 'Lab', particulars: 'Zirconia', direction: 'debit', amount: 5000, mode: 'GPay', notes: '' }, 'shorthand + inferred dir');
eq(C.normaliseParsed_({}),
   { party: '', particulars: '', direction: '', amount: 0, mode: '', notes: '' }, 'empty -> blanks');
eq(C.normaliseParsed_({ party: null, amount: null, mode: null, direction: null, notes: null }),
   { party: '', particulars: '', direction: '', amount: 0, mode: '', notes: '' }, 'nulls -> blanks');
eq(C.normaliseParsed_({ amount: -50, mode: 'xyz', direction: 'huh' }).amount, 0, 'neg amount -> 0');
eq(C.normaliseParsed_({ mode: 'xyz' }).mode, 'Other', 'unknown stated mode -> Other');
eq(C.normaliseParsed_({ party: 'a\n\n  b   c' }).party, 'a b c', 'whitespace collapse');
eq(C.normaliseParsed_('not an object'),
   { party: '', particulars: '', direction: '', amount: 0, mode: '', notes: '' }, 'non-object -> blanks');

// ---------------------------------------------------------------------------
// 6) validateEntry_
// ---------------------------------------------------------------------------
section('validateEntry_');
eq(C.validateEntry_({ party: 'A', particulars: 'B', direction: 'credit', amount: 100, mode: 'Cash' }), [], 'valid -> no errors');
ok(C.validateEntry_({ party: '', particulars: 'B', direction: 'credit', amount: 100, mode: 'Cash' }).length === 1, 'missing party');
ok(C.validateEntry_({ party: 'A', particulars: '', direction: 'credit', amount: 100, mode: 'Cash' }).length === 1, 'missing particulars');
ok(C.validateEntry_({ party: 'A', particulars: 'B', direction: '', amount: 100, mode: 'Cash' }).length === 1, 'missing direction');
ok(C.validateEntry_({ party: 'A', particulars: 'B', direction: 'credit', amount: 0, mode: 'Cash' }).length === 1, 'zero amount');
ok(C.validateEntry_({ party: 'A', particulars: 'B', direction: 'credit', amount: -5, mode: 'Cash' }).length === 1, 'neg amount');
ok(C.validateEntry_({ party: 'A', particulars: 'B', direction: 'credit', amount: 100, mode: 'Bitcoin' }).length === 1, 'bad mode');
ok(C.validateEntry_({}).length >= 4, 'empty -> many errors');
ok(C.validateEntry_(null).length === 1, 'null -> nothing to save');

// ---------------------------------------------------------------------------
// 7) buildRow_  — column mapping
// ---------------------------------------------------------------------------
section('buildRow_');
{
  const d = new Date(Date.UTC(2026, 6, 21));
  const cr = C.buildRow_({ party: 'Raj', particulars: 'Consultation', direction: 'credit', amount: 1200, mode: 'GPay', notes: 'n' }, d, 'Jul 2026');
  eq(cr, [d, 'Raj', 'Consultation', 'GPay', 'Online', '', 1200, 'CR', 'Bill Note', 'Jul 2026', 'n'], 'credit online row');
  const dr = C.buildRow_({ party: 'Lab', particulars: 'Zirconia', direction: 'debit', amount: 5000, mode: 'Cash', notes: '' }, d, 'Jul 2026');
  eq(dr, [d, 'Lab', 'Zirconia', 'Cash', 'Cash', 5000, '', 'DR', 'Bill Note', 'Jul 2026', ''], 'debit cash row');
  // Method is "Online" for every non-cash mode
  eq(C.buildRow_({ party: 'x', particulars: 'y', direction: 'credit', amount: 1, mode: 'Card', notes: '' }, d, 'Jul 2026')[4], 'Online', 'card -> Online');
}

// ---------------------------------------------------------------------------
// 8) readLastMonth_  — header/data/empty detection
// ---------------------------------------------------------------------------
section('readLastMonth_');
{
  const tz = 'Asia/Kolkata';
  eq(C.readLastMonth_(makeSheet([]), 0, tz), '', 'empty sheet');
  const dataRow = [new Date(), 'A', 'B', 'Cash', 'Cash', '', 1, 'CR', 'Bill Note', 'Jul 2026', ''];
  const s1 = makeSheet([dataRow]);
  eq(C.readLastMonth_(s1, 1, tz), 'Jul 2026', 'data row month from col J');
  const s2 = makeSheet([['◆  Jul 2026', '', '', '', '', '', '', '', '', '', '']]);
  eq(C.readLastMonth_(s2, 1, tz), 'Jul 2026', 'header row month parsed');
  const s3 = makeSheet([['◆ May 2025', '', '', '', '', '', '', '', '', '', '']]);
  eq(C.readLastMonth_(s3, 1, tz), 'May 2025', 'header single-space parsed');
  // Month cell stored as a real Date
  const dateMonthRow = dataRow.slice(); dateMonthRow[9] = new Date(Date.UTC(2026, 6, 1));
  eq(C.readLastMonth_(makeSheet([dateMonthRow]), 1, tz), 'Jul 2026', 'col J as Date object');
  // Blank month on last row -> scans upward
  const blankLast = dataRow.slice(); blankLast[9] = '';
  eq(C.readLastMonth_(makeSheet([dataRow, blankLast]), 2, tz), 'Jul 2026', 'blank month scans upward');
}

// ---------------------------------------------------------------------------
// 9) appendPayment  — APPEND-ONLY end-to-end against the in-memory sheet
// ---------------------------------------------------------------------------
section('appendPayment (append-only + month headers)');
scriptProps.set('ANTHROPIC_API_KEY', 'sk-test');
scriptProps.set('SPREADSHEET_ID', 'test-copy-id');

function snapshot(sheet, n) { return JSON.stringify(sheet._data.slice(0, n)); }
const sampleEntry = { party: 'Prashanth', particulars: 'Scaling', direction: 'credit', amount: 2000, mode: 'Cash', notes: '' };

// 9a. Empty sheet -> header + row
{
  currentSheet = makeSheet([]);
  const res = C.appendPayment(sampleEntry, '');
  ok(res.addedHeader === true, 'empty sheet writes a header');
  eq(currentSheet._data.length, 2, 'empty sheet -> 2 rows (header+entry)');
  eq(currentSheet._data[0][0], '◆  Jul 2026', 'header text');
  eq(currentSheet._data[1][1], 'Prashanth', 'entry party');
  eq(res.row, 2, 'entry at row 2');
}

// 9b. Same-month existing data -> append below, NO new header, existing untouched
{
  const existing = [
    ['◆  Jul 2026', '', '', '', '', '', '', '', '', '', ''],
    [new Date(Date.UTC(2026, 6, 1)), 'Old', 'Filling', 'Cash', 'Cash', '', 500, 'CR', 'Bill Note', 'Jul 2026', '']
  ];
  currentSheet = makeSheet(existing);
  const before = snapshot(currentSheet, 2);
  const res = C.appendPayment(sampleEntry, '');
  ok(res.addedHeader === false, 'same month -> no new header');
  eq(currentSheet._data.length, 3, 'appended one row');
  eq(snapshot(currentSheet, 2), before, 'existing rows byte-for-byte unchanged');
  eq(currentSheet._data[2][1], 'Prashanth', 'new row appended at bottom');
}

// 9c. New month started -> header then row
{
  const existing = [
    ['◆  May 2025', '', '', '', '', '', '', '', '', '', ''],
    [new Date(Date.UTC(2025, 4, 1)), 'Old', 'Filling', 'Cash', 'Cash', '', 500, 'CR', 'Bill Note', 'May 2025', '']
  ];
  currentSheet = makeSheet(existing);
  const before = snapshot(currentSheet, 2);
  const res = C.appendPayment(sampleEntry, '');
  ok(res.addedHeader === true, 'new month -> header added');
  eq(currentSheet._data.length, 4, 'header + row appended');
  eq(currentSheet._data[2][0], '◆  Jul 2026', 'new month header written');
  eq(currentSheet._data[3][1], 'Prashanth', 'entry below new header');
  eq(snapshot(currentSheet, 2), before, 'prior month rows untouched');
}

// 9d. Last row is a same-month header with no data yet -> append below, NO duplicate header
{
  currentSheet = makeSheet([['◆  Jul 2026', '', '', '', '', '', '', '', '', '', '']]);
  const res = C.appendPayment(sampleEntry, '');
  ok(res.addedHeader === false, 'existing same-month header -> not duplicated');
  eq(currentSheet._data.length, 2, 'only the entry row added');
  eq(currentSheet._data[1][1], 'Prashanth', 'entry directly under existing header');
}

// 9e. Debit entry lands amount in the Debit column, not Credit
{
  currentSheet = makeSheet([]);
  C.appendPayment({ party: 'Lab', particulars: 'Zirconia', direction: 'debit', amount: 5000, mode: 'GPay', notes: 'case #12' }, '');
  const row = currentSheet._data[1];
  eq(row[3], 'GPay', 'Bank Details = mode');
  eq(row[4], 'Online', 'Method Online for GPay');
  eq(row[5], 5000, 'Debit column filled');
  eq(row[6], '', 'Credit column blank');
  eq(row[7], 'DR', 'Type DR');
  eq(row[10], 'case #12', 'notes preserved');
}

// 9f. Rough client entry ("2,000", "google pay", "received") is sanitised then saved
{
  currentSheet = makeSheet([]);
  const res = C.appendPayment({ party: ' Raj ', particulars: 'Consultation', direction: 'received', amount: '2,000', mode: 'google pay', notes: '' }, '');
  ok(res.ok, 'rough entry accepted after sanitising');
  const row = currentSheet._data[1];
  eq(row[1], 'Raj', 'party trimmed');
  eq(row[3], 'GPay', 'mode normalised');
  eq(row[6], 2000, 'amount parsed from "2,000"');
  eq(row[7], 'CR', 'direction inferred from "received"');
}

// 9g. Invalid entry never touches the sheet
{
  currentSheet = makeSheet([['◆  Jul 2026', '', '', '', '', '', '', '', '', '', '']]);
  const before = snapshot(currentSheet, 1);
  throws(() => C.appendPayment({ party: '', particulars: '', direction: '', amount: 0, mode: '' }, ''), /required|greater/, 'blank entry rejected');
  eq(currentSheet._data.length, 1, 'sheet length unchanged after rejected entry');
  eq(snapshot(currentSheet, 1), before, 'sheet content unchanged after rejected entry');
}

// 9h. Month rollover across many appends only ever grows the sheet downward
{
  currentSheet = makeSheet([]);
  const grow = [];
  NOW = new Date(Date.UTC(2026, 6, 21)); // Jul
  C.appendPayment(sampleEntry, ''); grow.push(currentSheet._data.length);
  C.appendPayment(sampleEntry, ''); grow.push(currentSheet._data.length);
  NOW = new Date(Date.UTC(2026, 7, 2)); // Aug -> new header
  C.appendPayment(sampleEntry, ''); grow.push(currentSheet._data.length);
  NOW = new Date(Date.UTC(2026, 6, 21)); // reset
  // Jul: header+row+row = 3 ; Aug: header+row = 5
  eq(grow, [2, 3, 5], 'monotonic downward growth with a header at the month change');
  eq(currentSheet._data[3][0], '◆  Aug 2026', 'August header at row 4');
}

// ---------------------------------------------------------------------------
// 10) parsePayment  — mocked Anthropic, incl. retries and failure modes
// ---------------------------------------------------------------------------
section('parsePayment (mocked Anthropic)');
function claudeText(t) { return makeResponse(200, { content: [{ type: 'text', text: t }] }); }

// 10a. Clean parse of a fenced response
{
  fetchQueue = [() => claudeText('```json\n{"party":"Prashanth","particulars":"Scaling","direction":"credit","amount":2000,"mode":"Cash","notes":""}\n```')];
  const r = C.parsePayment('Prashanth paid 2000 cash for scaling', '');
  eq(r, { party: 'Prashanth', particulars: 'Scaling', direction: 'credit', amount: 2000, mode: 'Cash', notes: '' }, 'fenced parse');
}
// 10b. Prose-wrapped messy amount/mode still normalised
{
  fetchQueue = [() => claudeText('Sure! {"party":"Lab","particulars":"Zirconia Case","direction":"debit","amount":"5k","mode":"gpay","notes":""} ')];
  const r = C.parsePayment('paid lab 5k gpay zirconia', '');
  eq(r, { party: 'Lab', particulars: 'Zirconia Case', direction: 'debit', amount: 5000, mode: 'GPay', notes: '' }, 'prose+shorthand parse');
}
// 10c. Low-confidence model output (blanks) is passed through, not guessed
{
  fetchQueue = [() => claudeText('{"party":"Someone","particulars":"","direction":"","amount":0,"mode":""}')];
  const r = C.parsePayment('someone paid something', '');
  eq(r, { party: 'Someone', particulars: '', direction: '', amount: 0, mode: '', notes: '' }, 'blanks preserved for human to fill');
}
// 10d. Unparseable model text -> blank skeleton, no throw
{
  fetchQueue = [() => claudeText('I am not able to parse this into JSON.')];
  const r = C.parsePayment('asdfghjkl', '');
  eq(r, { party: '', particulars: '', direction: '', amount: 0, mode: '', notes: '' }, 'garbage -> blank skeleton');
}
// 10e. Transient 429 then success -> retry works
{
  fetchQueue = [
    () => makeResponse(429, { error: 'rate_limited' }),
    () => claudeText('{"party":"Raj","particulars":"Consultation","direction":"credit","amount":1200,"mode":"GPay","notes":""}')
  ];
  const r = C.parsePayment('raj gpay 1200 consultation', '');
  eq(r.party, 'Raj', 'retry after 429 succeeds');
}
// 10f. Network exception then success -> retry works
{
  fetchQueue = [
    () => ({ __throw: 'DNS failure' }),
    () => claudeText('{"party":"Raj","particulars":"X","direction":"credit","amount":10,"mode":"Cash","notes":""}')
  ];
  const r = C.parsePayment('raj 10 cash x', '');
  eq(r.party, 'Raj', 'retry after network error succeeds');
}
// 10g. Persistent 500 -> friendly error
{
  fetchQueue = [() => makeResponse(500, {}), () => makeResponse(500, {}), () => makeResponse(500, {})];
  throws(() => C.parsePayment('x', ''), /busy|try again/i, 'persistent 5xx surfaces friendly error');
}
// 10h. Empty input -> throws before any fetch
{
  fetchQueue = [];
  throws(() => C.parsePayment('   ', ''), /type a payment/i, 'blank input rejected');
}
// 10i. Missing API key -> throws
{
  scriptProps.delete('ANTHROPIC_API_KEY');
  fetchQueue = [];
  throws(() => C.parsePayment('x', ''), /ANTHROPIC_API_KEY/, 'missing key rejected');
  scriptProps.set('ANTHROPIC_API_KEY', 'sk-test');
}

// ---------------------------------------------------------------------------
// 11) PIN gate
// ---------------------------------------------------------------------------
section('PIN gate');
{
  scriptProps.set('APP_PIN', '4321');
  ok(C.isPinRequired() === true, 'pin required when APP_PIN set');
  currentSheet = makeSheet([]);
  throws(() => C.appendPayment(sampleEntry, '0000'), /Incorrect PIN/, 'wrong PIN rejected on append');
  throws(() => C.parsePayment('x', '0000'), /Incorrect PIN/, 'wrong PIN rejected on parse');
  const res = C.appendPayment(sampleEntry, '4321');
  ok(res.ok, 'correct PIN accepted');
  scriptProps.delete('APP_PIN');
  ok(C.isPinRequired() === false, 'pin not required when unset');
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------
console.log(`\n${'-'.repeat(48)}`);
if (fail === 0) {
  console.log(`ALL PASSED — ${pass} assertions`);
  process.exit(0);
} else {
  console.log(`FAILURES (${fail} of ${pass + fail}):\n`);
  failures.forEach((f, i) => console.log(`${i + 1}. ${f}`));
  process.exit(1);
}

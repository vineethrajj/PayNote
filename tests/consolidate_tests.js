/**
 * Edge-case harness for Consolidate.gs (statement import + dedup + append).
 *
 * Loads the REAL Code.gs AND Consolidate.gs into one Node VM with Apps Script
 * globals stubbed (in-memory sheet, canned Anthropic responses). Exercises:
 *   - fuzzy column detection across Axis/SBI/Paytm/GPay-style layouts
 *   - messy date/money parsing
 *   - within-batch smart dedup (incl. same payment in wallet + bank)
 *   - dedup against existing ledger rows
 *   - append-only, chronological, month-headered commit
 *   - PDF path via a mocked Claude document response
 *
 * Run: node tests/consolidate_tests.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
let NOW = new Date(Date.UTC(2026, 6, 21));
const scriptProps = new Map();
let fetchQueue = [];

function makeResponse(code, bodyObj) {
  const body = typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj);
  return { getResponseCode: () => code, getContentText: () => body };
}
function claudeText(t) { return makeResponse(200, { content: [{ type: 'text', text: t }] }); }

function makeSheet(rows) {
  const data = rows.map(r => r.slice());
  return {
    _data: data,
    getName: () => 'Transactions',
    getLastRow: () => data.length,
    getDataRange: () => ({ getValues: () => data.map(r => r.slice()) }),
    getSheets: () => [],
    getRange: (r, c, numRows = 1, numCols = 1) => ({
      getValue: () => { const row = data[r - 1] || []; const v = row[c - 1]; return v === undefined ? '' : v; },
      getValues: () => {
        const out = [];
        for (let i = 0; i < numRows; i++) {
          const row = []; const src = data[r - 1 + i] || [];
          for (let j = 0; j < numCols; j++) { const v = src[c - 1 + j]; row.push(v === undefined ? '' : v); }
          out.push(row);
        }
        return out;
      },
      setValues: (vals) => {
        for (let i = 0; i < vals.length; i++) {
          const tr = r - 1 + i; if (!data[tr]) data[tr] = [];
          for (let j = 0; j < vals[i].length; j++) data[tr][c - 1 + j] = vals[i][j];
        }
      }
    })
  };
}
let currentSheet = makeSheet([]);

const sandbox = {
  module: { exports: {} }, console,
  PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (scriptProps.has(k) ? scriptProps.get(k) : null) }) },
  UrlFetchApp: { fetch: () => { if (!fetchQueue.length) throw new Error('fetchQueue empty'); const r = fetchQueue.shift()(); if (r && r.__throw) throw new Error(r.__throw); return r; } },
  Utilities: {
    sleep: () => {},
    base64Decode: (s) => Buffer.from(s, 'base64'),
    newBlob: (bytes) => ({ getDataAsString: () => Buffer.from(bytes).toString('utf8') }),
    parseCsv: (str) => str.replace(/\r\n/g, '\n').replace(/\n+$/,'').split('\n').map(line => line.split(',')),
    formatDate: (date, tz, fmt) => {
      const d = new Date(date);
      const mmm = MONTHS[d.getUTCMonth()], yyyy = d.getUTCFullYear();
      const mm = String(d.getUTCMonth() + 1).padStart(2, '0'), dd = String(d.getUTCDate()).padStart(2, '0');
      if (fmt === 'MMM yyyy') return `${mmm} ${yyyy}`;
      if (fmt === 'yyyy-MM-dd') return `${yyyy}-${mm}-${dd}`;
      return d.toISOString();
    }
  },
  LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
  Session: { getScriptTimeZone: () => 'Asia/Kolkata' },
  Logger: { log: () => {} },
  HtmlService: {},
  SpreadsheetApp: {
    openById: () => ({ getName: () => 'Ledger (test)', getSpreadsheetTimeZone: () => 'Asia/Kolkata', getSheetByName: (n) => (n === 'Transactions' ? currentSheet : null) }),
    flush: () => {}
  }
};
const RealDate = Date;
sandbox.Date = new Proxy(RealDate, { construct(t, a) { return a.length === 0 ? new RealDate(NOW.getTime()) : new t(...a); } });

vm.createContext(sandbox);
// Note: parseTxnDate_ builds dates in LOCAL time; the harness runs in UTC
// (see the run command) so formatDate's getUTC* reads them back correctly.
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8'), sandbox, { filename: 'Code.gs' });
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'Consolidate.gs'), 'utf8'), sandbox, { filename: 'Consolidate.gs' });
const C = sandbox.module.exports;

let pass = 0, fail = 0; const failures = [];
function eq(a, e, m) { const A = JSON.stringify(a), E = JSON.stringify(e); if (A === E) pass++; else { fail++; failures.push(`${m}\n     expected ${E}\n     got      ${A}`); } }
function ok(c, m) { if (c) pass++; else { fail++; failures.push(m); } }
function section(n) { console.log('\n== ' + n + ' =='); }

scriptProps.set('ANTHROPIC_API_KEY', 'sk-test');
scriptProps.set('SPREADSHEET_ID', 'test-copy');

// ---------------------------------------------------------------------------
// 1) Date parsing
// ---------------------------------------------------------------------------
section('parseTxnDate_');
const iso = (d) => d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : null;
[
  ['21/07/2026', '2026-07-21'], ['21-07-2026', '2026-07-21'], ['21.07.2026', '2026-07-21'],
  ['21-Jul-2026', '2026-07-21'], ['21 Jul 2026', '2026-07-21'], ['2026-07-21', '2026-07-21'],
  ['01/05/2025', '2025-05-01'], ['9-Aug-26', '2026-08-09'], ['Jul 21, 2026', '2026-07-21'],
  ['', null], ['garbage', null], ['31/13/2026', null]
].forEach(([input, expected], i) => eq(iso(C.parseTxnDate_(input)), expected, `date[${i}] ${input}`));
ok(C.parseTxnDate_(new Date(Date.UTC(2026, 6, 21))) instanceof Date, 'passes through Date');

// ---------------------------------------------------------------------------
// 2) Money parsing (no crore/lakh multipliers, tolerant of Cr/Dr suffix)
// ---------------------------------------------------------------------------
section('parseMoney_');
[
  ['1,234.00', 1234], ['₹5,000', 5000], ['5000', 5000], [2500, 2500], ['1,234.00 Cr', 1234],
  ['500 Dr', 500], ['', 0], ['-750', -750], ['  2,00,000  ', 200000], ['Rs.1500', 1500]
].forEach(([input, expected], i) => eq(C.parseMoney_(input), expected, `money[${i}] ${JSON.stringify(input)}`));

// ---------------------------------------------------------------------------
// 3) Column detection + tabular parsing across differing layouts
// ---------------------------------------------------------------------------
section('parseTabular_ (bank layouts)');

// Axis-style: metadata rows above header, separate Debit/Credit columns
{
  const axis = [
    ['Statement of Account', '', '', '', ''],
    ['Account No: 123', '', '', '', ''],
    ['Tran Date', 'Particulars', 'Debit', 'Credit', 'Balance'],
    ['21/07/2026', 'UPI/PRASHANTH/scaling', '', '2000', '52000'],
    ['22/07/2026', 'NEFT/LAB/zirconia', '5000', '', '47000'],
    ['Closing Balance', '', '', '', '47000']
  ];
  const txns = C.parseTabular_(axis, 'Axis_statement.csv');
  eq(txns.length, 2, 'axis: 2 transactions (summary rows skipped)');
  eq(txns[0].direction, 'credit', 'axis row1 credit');
  eq(txns[0].amount, 2000, 'axis row1 amount');
  eq(txns[1].direction, 'debit', 'axis row2 debit');
  eq(txns[1].source, 'Axis', 'axis source detected');
  ok(/prashanth/i.test(txns[0].party), 'axis counterparty extracted');
}

// SBI-style: single signed Amount column + Dr/Cr indicator
{
  const sbi = [
    ['Txn Date', 'Description', 'Ref No', 'Amount', 'Dr/Cr'],
    ['01-Jul-2026', 'BY TRANSFER RAJ consultation', 'UTR123', '1200', 'Cr'],
    ['03-Jul-2026', 'ATM WDL', 'S456', '3000', 'Dr']
  ];
  const txns = C.parseTabular_(sbi, 'sbi-jul.csv');
  eq(txns.length, 2, 'sbi: 2 transactions');
  eq(txns[0].direction, 'credit', 'sbi Cr indicator');
  eq(txns[0].reference, 'UTR123', 'sbi reference captured');
  eq(txns[1].direction, 'debit', 'sbi Dr indicator');
  eq(txns[1].mode, 'Cash', 'sbi ATM -> Cash mode');
}

// Paytm wallet-style
{
  const paytm = [
    ['Date', 'Transaction Details', 'Amount', 'Type'],
    ['2026-07-05', 'Paid to Sunrise Dental Supplies', '800', 'Debit'],
    ['2026-07-06', 'Received from Meera', '1500', 'Credit']
  ];
  const txns = C.parseTabular_(paytm, 'paytm_report.csv');
  eq(txns.length, 2, 'paytm: 2 transactions');
  eq(txns[0].mode, 'PayTM', 'paytm mode from source');
  eq(txns[1].direction, 'credit', 'paytm credit');
}

// No usable header -> throws
{
  try { C.parseTabular_([['foo', 'bar'], ['1', '2']], 'weird.csv'); fail++; failures.push('expected throw on headerless file'); }
  catch (e) { ok(/header/i.test(e.message), 'headerless file rejected'); }
}

// ---------------------------------------------------------------------------
// 4) Within-batch smart dedup
// ---------------------------------------------------------------------------
section('dedupeBatch_');
const mk = (o) => C.makeTxn_(Object.assign({ source: 'X', modeHint: 'Other' }, o));
{
  // Same GPay payment appears in the GPay export and the Axis bank statement.
  const a = mk({ date: '2026-07-10', description: 'UPI/PRASHANTH/scaling', amount: 2000, direction: 'credit', reference: 'UTR999', source: 'GPay', modeHint: 'GPay' });
  const b = mk({ date: '2026-07-10', description: 'UPI PRASHANTH', amount: 2000, direction: 'credit', reference: 'UTR999', source: 'Axis', modeHint: 'Other' });
  const r = C.dedupeBatch_([a, b]);
  eq(r.unique.length, 1, 'same UTR across sources -> 1 unique');
  eq(r.duplicates.length, 1, 'the other flagged duplicate');
  ok(r.unique[0].source.indexOf('+') > -1, 'sources merged on kept row');
}
{
  // Same amount+name, no reference, 1 day apart -> still a dup (smart).
  const a = mk({ date: '2026-07-10', description: 'Meera consultation', amount: 1500, direction: 'credit' });
  const b = mk({ date: '2026-07-11', description: 'MEERA', amount: 1500, direction: 'credit' });
  eq(C.dedupeBatch_([a, b]).unique.length, 1, '±1 day + fuzzy name -> dup');
}
{
  // Same amount, opposite direction (bank->wallet transfer) -> NOT a dup.
  const a = mk({ date: '2026-07-10', description: 'transfer to paytm', amount: 5000, direction: 'debit' });
  const b = mk({ date: '2026-07-10', description: 'received from bank', amount: 5000, direction: 'credit' });
  eq(C.dedupeBatch_([a, b]).unique.length, 2, 'opposite legs of a transfer kept separate');
}
{
  // Same amount+day but clearly different parties -> NOT a dup.
  const a = mk({ date: '2026-07-10', description: 'Prashanth scaling', amount: 500, direction: 'credit' });
  const b = mk({ date: '2026-07-10', description: 'Anitha cleaning', amount: 500, direction: 'credit' });
  eq(C.dedupeBatch_([a, b]).unique.length, 2, 'different parties, same amount/day kept separate');
}

// ---------------------------------------------------------------------------
// 5) Ledger dedup
// ---------------------------------------------------------------------------
section('matchInLedger_ / buildLedgerIndex_');
{
  currentSheet = makeSheet([
    ['◆  Jul 2026', '', '', '', '', '', '', '', '', '', ''],
    [new Date(Date.UTC(2026, 6, 10)), 'Prashanth', 'Scaling', 'Cash', 'Cash', '', 2000, 'CR', 'Bill Note', 'Jul 2026', ''],
    [new Date(Date.UTC(2026, 6, 12)), 'Lab', 'Zirconia', 'GPay', 'Online', 5000, '', 'DR', 'Bill Note', 'Jul 2026', '']
  ]);
  const idx = C.buildLedgerIndex_();
  ok(C.matchInLedger_(mk({ date: '2026-07-10', description: 'UPI PRASHANTH scaling', amount: 2000, direction: 'credit' }), idx), 'matches manual credit already in ledger');
  ok(C.matchInLedger_(mk({ date: '2026-07-13', description: 'NEFT LAB', amount: 5000, direction: 'debit' }), idx), 'matches ledger debit within ±1 day + name');
  ok(!C.matchInLedger_(mk({ date: '2026-07-10', description: 'Prashanth', amount: 2000, direction: 'debit' }), idx), 'opposite direction not matched');
  ok(!C.matchInLedger_(mk({ date: '2026-07-25', description: 'Prashanth', amount: 2000, direction: 'credit' }), idx), 'far-off date not matched');
  ok(!C.matchInLedger_(mk({ date: '2026-07-10', description: 'Someone Else', amount: 2000, direction: 'credit' }), idx), 'same amount different name not matched');
}

// ---------------------------------------------------------------------------
// 6) previewConsolidation end-to-end (CSV files, no writes)
// ---------------------------------------------------------------------------
section('previewConsolidation');
function csvFile(name, text) {
  return { name, mimeType: 'text/csv', dataBase64: Buffer.from(text, 'utf8').toString('base64') };
}
{
  // Ledger already contains Prashanth 2000 on Jul 10.
  currentSheet = makeSheet([
    ['◆  Jul 2026', '', '', '', '', '', '', '', '', '', ''],
    [new Date(Date.UTC(2026, 6, 10)), 'Prashanth', 'Scaling', 'Cash', 'Cash', '', 2000, 'CR', 'Bill Note', 'Jul 2026', '']
  ]);
  const gpay = 'Date,Description,Amount,Type\n2026-07-10,UPI PRASHANTH scaling,2000,Credit\n2026-07-15,Raj consultation,1200,Credit\n';
  const axis = 'Tran Date,Particulars,Debit,Credit,Balance\n10/07/2026,UPI/PRASHANTH,,2000,52000\n16/07/2026,NEFT/LAB/zirconia,5000,,47000\n';
  const res = C.previewConsolidation([csvFile('gpay.csv', gpay), csvFile('axis.csv', axis)], '');
  eq(res.parsed, 4, 'parsed 4 raw rows across two files');
  // Prashanth 2000 appears twice in files (1 dup) and once in ledger (drop the survivor).
  eq(res.alreadyInLedgerCount, 1, 'Prashanth 2000 recognised as already in ledger');
  eq(res.duplicateInBatchCount, 1, 'Prashanth 2000 cross-file duplicate caught');
  eq(res.newCount, 2, 'only Raj 1200 + Lab 5000 are new');
  eq(currentSheet._data.length, 2, 'preview wrote nothing to the sheet');
  const amts = res.newTxns.map(t => t.amount).sort(function (a, b) { return a - b; });
  eq(amts, [1200, 5000], 'new rows are the 1200 credit + 5000 debit');
}

// ---------------------------------------------------------------------------
// 7) commitConsolidation — append-only, chronological, month headers
// ---------------------------------------------------------------------------
section('commitConsolidation');
{
  currentSheet = makeSheet([
    ['◆  Jun 2026', '', '', '', '', '', '', '', '', '', ''],
    [new Date(Date.UTC(2026, 5, 28)), 'Old', 'Filling', 'Cash', 'Cash', '', 500, 'CR', 'Bill Note', 'Jun 2026', '']
  ]);
  const before = JSON.stringify(currentSheet._data.slice(0, 2));
  const newTxns = [
    { date: '2026-07-16', party: 'Lab', particulars: 'Zirconia', amount: 5000, direction: 'debit', mode: 'GPay', reference: 'UTR1', source: 'Axis' },
    { date: '2026-07-15', party: 'Raj', particulars: 'Consultation', amount: 1200, direction: 'credit', mode: 'GPay', reference: 'UTR2', source: 'GPay' },
    { date: '2026-08-02', party: 'Meera', particulars: 'Cleaning', amount: 800, direction: 'credit', mode: 'PayTM', reference: 'UTR3', source: 'Paytm' }
  ];
  const res = C.commitConsolidation(newTxns, '');
  eq(res.appended, 3, 'appended 3');
  eq(res.headersAdded, 2, 'added Jul + Aug headers');
  eq(JSON.stringify(currentSheet._data.slice(0, 2)), before, 'pre-existing rows untouched');
  // Expect: row3 = Jul header, row4 = Raj(15th), row5 = Lab(16th), row6 = Aug header, row7 = Meera
  eq(currentSheet._data[2][0], '◆  Jul 2026', 'Jul header appended');
  eq(currentSheet._data[3][1], 'Raj', 'Raj first (chronological within batch)');
  eq(currentSheet._data[4][1], 'Lab', 'Lab second');
  eq(currentSheet._data[5][0], '◆  Aug 2026', 'Aug header appended');
  eq(currentSheet._data[6][1], 'Meera', 'Meera under Aug');
  // Column integrity on an imported row
  eq(currentSheet._data[4][5], 5000, 'Lab debit amount in Debit col');
  eq(currentSheet._data[4][7], 'DR', 'Lab type DR');
  eq(currentSheet._data[3][6], 1200, 'Raj credit amount in Credit col');
  ok(/src:GPay/.test(currentSheet._data[3][10]), 'note carries source');
  ok(/ref:UTR2/.test(currentSheet._data[3][10]), 'note carries reference');
}

// commit re-checks the ledger: a txn already present is skipped at commit time
{
  currentSheet = makeSheet([
    ['◆  Jul 2026', '', '', '', '', '', '', '', '', '', ''],
    [new Date(Date.UTC(2026, 6, 15)), 'Raj', 'Consultation', 'GPay', 'Online', '', 1200, 'CR', 'Bill Note', 'Jul 2026', '']
  ]);
  const res = C.commitConsolidation([
    { date: '2026-07-15', party: 'Raj', particulars: 'Consultation', amount: 1200, direction: 'credit', mode: 'GPay', reference: '', source: 'GPay' },
    { date: '2026-07-18', party: 'Anitha', particulars: 'Cleaning', amount: 900, direction: 'credit', mode: 'Cash', reference: '', source: 'GPay' }
  ], '');
  eq(res.appended, 1, 'only the genuinely-new row appended at commit');
  eq(res.skippedNowInLedger, 1, 'Raj skipped as already-in-ledger at commit');
  eq(currentSheet._data.length, 3, 'sheet grew by exactly one row');
}

// ---------------------------------------------------------------------------
// 8) PDF path via mocked Claude document response
// ---------------------------------------------------------------------------
section('parsePdf_ (mocked Claude)');
{
  currentSheet = makeSheet([]);
  const pdfJson = JSON.stringify([
    { date: '2026-07-20', description: 'UPI/ANITHA/cleaning', amount: 900, direction: 'credit', reference: 'UTR777', balance: 0 },
    { date: '2026-07-21', description: 'CARD POS SUPPLIES', amount: 1500, direction: 'debit', reference: '', balance: 0 }
  ]);
  fetchQueue = [() => claudeText('```json\n' + pdfJson + '\n```')];
  const res = C.previewConsolidation([{ name: 'axis-statement.pdf', mimeType: 'application/pdf', dataBase64: Buffer.from('%PDF-fake').toString('base64') }], '');
  eq(res.parsed, 2, 'PDF: 2 transactions extracted');
  eq(res.newCount, 2, 'both new');
  const modes = res.newTxns.map(t => t.mode);
  ok(modes.indexOf('Card') > -1, 'PDF: POS/CARD -> Card mode');
}

// ---------------------------------------------------------------------------
// 9) PIN gate on import
// ---------------------------------------------------------------------------
section('PIN gate (import)');
{
  scriptProps.set('APP_PIN', '4321');
  try { C.previewConsolidation([csvFile('a.csv', 'Date,Amount\n')], '0000'); fail++; failures.push('expected PIN throw'); }
  catch (e) { ok(/Incorrect PIN/.test(e.message), 'wrong PIN blocks import'); }
  scriptProps.delete('APP_PIN');
}

// ---------------------------------------------------------------------------
console.log(`\n${'-'.repeat(48)}`);
if (fail === 0) { console.log(`ALL PASSED — ${pass} assertions`); process.exit(0); }
console.log(`FAILURES (${fail} of ${pass + fail}):\n`);
failures.forEach((f, i) => console.log(`${i + 1}. ${f}`));
process.exit(1);

/**
 * Real-browser UI validation at iPhone 12 dimensions.
 *
 * Loads the actual Index.html in Chromium at 390x844 @3x with a mocked
 * google.script.run backend, drives the live flows (quick-log parse ->
 * confirm, statement import -> preview), asserts the DOM reacts correctly,
 * fails on any console/page error, and captures screenshots in light and
 * dark mode.
 *
 * Run: node tests/ui_validate.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'tests', 'screens');
const EXE = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const FILE_URL = 'file://' + path.join(ROOT, 'Index.html');

fs.mkdirSync(OUT, { recursive: true });
// A tiny CSV so the file input has something real to read in the import flow.
const TMP_CSV = path.join(OUT, '_sample.csv');
fs.writeFileSync(TMP_CSV, 'Date,Description,Amount,Type\n2026-07-15,Raj consultation,1200,Credit\n');

// Mock backend injected before the page's own script runs.
const MOCK = `
(function () {
  var PREVIEW = {
    parsed: 6,
    perFile: [
      { name: 'axis-jul.csv', source: 'Axis', count: 3, error: '' },
      { name: 'gpay-jul.pdf', source: 'GPay', count: 3, error: '' }
    ],
    newCount: 3, duplicateInBatchCount: 1, alreadyInLedgerCount: 2,
    newTxns: [
      { date: '2026-07-15', party: 'Raj', particulars: 'Consultation', amount: 1200, direction: 'credit', mode: 'GPay', source: 'GPay' },
      { date: '2026-07-16', party: 'Zirconia', particulars: 'NEFT/LAB/zirconia', amount: 5000, direction: 'debit', mode: 'Other', source: 'Axis' },
      { date: '2026-07-18', party: 'Anitha', particulars: 'Cleaning', amount: 900, direction: 'credit', mode: 'Cash', source: 'GPay' }
    ],
    skipped: [], ledgerSkipped: [], truncated: false
  };
  function reply(b, data) { setTimeout(function () { if (b._s) b._s(data); }, 120); }
  function builder() {
    var b = { _s: null, _f: null };
    b.withSuccessHandler = function (fn) { b._s = fn; return b; };
    b.withFailureHandler = function (fn) { b._f = fn; return b; };
    b.isPinRequired = function () { reply(b, false); };
    b.parsePayment = function () { reply(b, { party: 'Prashanth', particulars: 'Scaling', direction: 'credit', amount: 2000, mode: 'Cash', notes: '' }); };
    b.appendPayment = function () { reply(b, { ok: true, month: 'Jul 2026', row: 12 }); };
    b.previewConsolidation = function () { reply(b, PREVIEW); };
    b.commitConsolidation = function () { reply(b, { ok: true, appended: 3, skippedNowInLedger: 0, headersAdded: 1 }); };
    return b;
  }
  var run = {};
  run.withSuccessHandler = function (fn) { return builder().withSuccessHandler(fn); };
  run.withFailureHandler = function (fn) { return builder().withFailureHandler(fn); };
  window.google = { script: { run: run } };
})();
`;

let failures = [];
function check(cond, msg) { if (!cond) failures.push(msg); else console.log('  ok: ' + msg); }

async function newPage(browser, colorScheme) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },   // iPhone 12 logical size
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    colorScheme
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  await page.addInitScript(MOCK);
  return { ctx, page, errors };
}

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });

  // ---------- LIGHT MODE ----------
  {
    const { ctx, page, errors } = await newPage(browser, 'light');
    await page.goto(FILE_URL);
    await page.waitForTimeout(300);
    check(await page.isVisible('#tabs'), 'light: tabs visible after boot');
    check(await page.isVisible('#entryCard'), 'light: log entry card visible');
    await page.waitForTimeout(1300); // let the splash finish fading
    check(!(await page.isVisible('#splash')), 'light: splash auto-hides after launch');
    await page.screenshot({ path: path.join(OUT, '01-log-light.png') });

    // Quick-log: type -> Read it -> confirmation card
    await page.fill('#raw', 'Prashanth paid 2000 cash for scaling');
    await page.click('#submitBtn');
    await page.waitForSelector('#confirmCard:not(.hidden)', { timeout: 3000 });
    check(await page.inputValue('#fParty') === 'Prashanth', 'light: parsed party populated');
    check(await page.inputValue('#fAmount') === '2000', 'light: parsed amount populated');
    check(await page.getAttribute('#dirCredit', 'class') === 'on-credit', 'light: direction set to credit');
    await page.screenshot({ path: path.join(OUT, '02-confirm-light.png') });

    await ctx.close();
    if (errors.length) failures.push('light errors -> ' + errors.join(' | '));
  }

  // ---------- IMPORT FLOW (light) ----------
  {
    const { ctx, page, errors } = await newPage(browser, 'light');
    await page.goto(FILE_URL);
    await page.waitForTimeout(1400);
    await page.click('#tabImport');
    check(await page.isVisible('#importCard'), 'import: import card shown on tab switch');
    await page.setInputFiles('#files', TMP_CSV);
    check(!(await page.isDisabled('#parseBtn')), 'import: parse enabled after file chosen');
    await page.screenshot({ path: path.join(OUT, '03-import-pick-light.png') });

    await page.click('#parseBtn');
    await page.waitForSelector('#importPreview:not(.hidden)', { timeout: 3000 });
    await page.waitForSelector('table.preview', { timeout: 3000 });
    const rowCount = await page.$$eval('table.preview tbody tr', rs => rs.length);
    check(rowCount === 3, 'import: preview table shows 3 new rows (got ' + rowCount + ')');
    check((await page.textContent('#newCountTag')).indexOf('3 new') > -1, 'import: "3 new" tag');
    await page.screenshot({ path: path.join(OUT, '04-import-preview-light.png') });

    await ctx.close();
    if (errors.length) failures.push('import errors -> ' + errors.join(' | '));
  }

  // ---------- DARK MODE ----------
  {
    const { ctx, page, errors } = await newPage(browser, 'dark');
    await page.goto(FILE_URL);
    await page.waitForTimeout(1400);
    await page.screenshot({ path: path.join(OUT, '05-log-dark.png') });
    await page.fill('#raw', 'paid lab 5000 gpay for zirconia case');
    await page.click('#submitBtn');
    await page.waitForSelector('#confirmCard:not(.hidden)', { timeout: 3000 });
    // flip to debit to show the red state
    await page.click('#dirDebit');
    await page.screenshot({ path: path.join(OUT, '06-confirm-dark.png') });
    await ctx.close();
    if (errors.length) failures.push('dark errors -> ' + errors.join(' | '));
  }

  await browser.close();

  console.log('\n' + '-'.repeat(48));
  if (failures.length) {
    console.log('UI VALIDATION FAILURES:\n' + failures.map((f, i) => (i + 1) + '. ' + f).join('\n'));
    process.exit(1);
  }
  console.log('UI VALIDATION PASSED — screenshots in tests/screens/');
})().catch(e => { console.error(e); process.exit(1); });

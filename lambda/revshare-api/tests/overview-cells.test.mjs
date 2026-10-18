import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The Overview's hand-kept columns, merged for reading (2026-10-15). "There are some columns of
// data already, how would you suggest for UI display?" — 13 single-value columns became 5
// two-line cells, a status pill on the term, a "missing" tag where a required field is empty,
// and a completeness count on each header. DISPLAY ONLY: the editor, the new-merchant form and
// the Excel download keep the separate fields. Run, not read.
const app = readFileSync(new URL('../../../frontend/app.js', import.meta.url), 'utf8');
const grab = (n) => {
  const i = app.indexOf(`function ${n}(`);
  if (i < 0) throw new Error('missing ' + n);
  let d = 0;
  for (let k = app.indexOf('{', app.indexOf(')', i)); k < app.length; k++) {
    if (app[k] === '{') d++; else if (app[k] === '}') { d--; if (!d) return app.slice(i, k + 1); }
  }
};
const line = (start) => { const i = app.indexOf(start); if (i < 0) throw new Error('missing ' + start); return app.slice(i, app.indexOf('\n', i)); };
const block = (start, end) => { const i = app.indexOf(start); return app.slice(i, app.indexOf(end, i) + end.length); };

const today = new Date(); const iso = (d) => new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate() + d)).toISOString().slice(0, 10);
const lib = new Function('ENTITIES',
  'const escape = s => String(s);\nconst entityName = c => String(c.counterParty || "").trim();\n'
  + block('const INCOMPLETE_FIELDS = {', '};') + '\n'
  + grab('daysToEnd') + grab('renewalFlag') + grab('ruleHasValue') + block('const needsTerms =', ');') + '\n'
  + line('const ctMissing =') + '\n' + block('const GRID_MERGES = [', '];') + '\n' + grab('ctTermHtml') + grab('ctPayToHtml') + grab('ctFinanceContactHtml')
  + grab('ctCompleteCounts') + grab('gridDisplayColumns')
  + '\nreturn { ctTermHtml, ctPayToHtml, ctFinanceContactHtml, ctCompleteCounts, gridDisplayColumns };')([]);

const full = { startDate: iso(-100), endDate: iso(300), terminationNoticeDays: 30, autoRenewal: 'No' };

test('the term cell reads start → end, then notice and renewal', () => {
  const h = lib.ctTermHtml(full);
  assert.match(h, new RegExp(`${full.startDate} → ${full.endDate}`));
  assert.match(h, /30 days notice · no auto-renewal/);
  assert.match(h, /ct-pill-ok">Active/);
});

test('the pill says when a non-renewing contract is in its notice window, or has ended', () => {
  assert.match(lib.ctTermHtml({ ...full, endDate: iso(20) }), /ct-pill-soon"[^>]*>Ends in 20 days/);
  assert.match(lib.ctTermHtml({ ...full, endDate: iso(-3) }), /ct-pill-over"[^>]*>Expired/);
  // Auto-renewing: nothing to do at the end date, so no alarm.
  assert.match(lib.ctTermHtml({ ...full, endDate: iso(20), autoRenewal: 'Yes' }), /ct-pill-ok">Active/);
  assert.match(lib.ctTermHtml({}), /ct-pill-none">No dates/);
});

test('a required field that is empty says missing, by name', () => {
  const h = lib.ctTermHtml({ startDate: iso(-5) });
  assert.match(h, /ct-missing[^>]*>end date missing/);
  assert.match(h, /notice missing/);
});

test('pay to: bank and account number, then the account name', () => {
  const h = lib.ctPayToHtml({ bankName: 'ธนาคารกสิกรไทย', bankAccountNumber: '123-4-56789-0', bankAccountName: 'Classic Co.' });
  assert.match(h, /ธนาคารกสิกรไทย · 123-4-56789-0[\s\S]*Classic Co\./);
  assert.match(lib.ctPayToHtml({ bankName: 'KBank' }), /account no\. missing[\s\S]*account name missing/);
  assert.match(lib.ctPayToHtml({}), /ct-missing[^>]*>missing</, 'nothing at all is one tag, not three');
});

test('finance contact: name, then email', () => {
  assert.match(lib.ctFinanceContactHtml({ financeContactName: 'Ann', financeContactEmail: 'ap@x.com' }), /Ann[\s\S]*ap@x\.com/);
  assert.match(lib.ctFinanceContactHtml({ financeContactName: 'Ann' }), /email missing/);
});

test('each header counts complete brands with the same fields the Incomplete tabs use', () => {
  const rule = { type: 'percent', rows: [{ percent: 10 }] };
  const done = { ...full, counterParty: 'E', bankName: 'B', bankAccountName: 'N', bankAccountNumber: '1',
    financeContactName: 'F', financeContactEmail: 'f@x', rule, aggregationMode: 'whole' };
  const n = lib.ctCompleteCounts([done, { ...done, bankName: '' }, { noPayout: true }, { ...done, archived: true }]);
  assert.deepEqual(n, { total: 3, contract: 2, finance: 1, terms: 3 });
});

test('the grid merges the columns in place and keeps everything else', () => {
  const cols = ['merchantName', 'counterParty', 'startDate', 'endDate', 'terminationNoticeDays', 'autoRenewal',
    'contractLink', 'term.method', 'term.summary', 'bankName', 'bankAccountName', 'bankAccountNumber',
    'financeContactName', 'financeContactEmail'].map((key) => ({ key, group: 'x' }));
  assert.deepEqual(lib.gridDisplayColumns(cols).map((c) => c.key),
    ['merchantName', 'counterParty', '@term', 'contractLink', 'term.method', 'term.summary', '@payTo', '@financeContact']);
});

test('the layout uses the merged columns, and the editor still uses the real ones', () => {
  assert.match(grab('contractLayout'), /gridDisplayColumns\(CONTRACT_GRID_COLUMNS\)/);
  assert.match(grab('openContractEditor'), /CONTRACT_GRID_COLUMNS\.filter/);
});

test('a hand-kept cell no longer claims it comes from the upload', () => {
  const row = grab('contractRowHtml');
  assert.match(row, /isHandKept\(col\) \? ' title="Change it with Edit…/, 'the upload tooltip is for file-owned columns only');
});

test('each terms header carries its completeness count', () => {
  const head = grab('contractHeadHtml');
  assert.match(head, /ctCompleteCounts\(CONTRACTS\)/);
  assert.equal((head.match(/\$\{countOf\(seg\)\}/g) || []).length, 2, 'open and closed headers both show it');
});

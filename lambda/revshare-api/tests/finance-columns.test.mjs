import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeContractRow } from '../code/contracts.mjs';

// The Merchant view's "Finance Information" group (2026-09-04). Two halves that must agree:
// the grid columns in frontend/app.js, and WRITABLE in routes/contracts.mjs. A key present in
// one and not the other is silent — the cell opens, you type, the PUT drops the field, and the
// value is gone on the next paint. `pick()` never errors on an unknown key.
//
// BOTH regions since 2026-09-04. The columns shipped TH-only for half a day behind a REGION
// guard, because SG's WRITABLE did not yet carry the fields; the guard came off with the deploy
// that added them. What is pinned here is the invariant that outlived the guard: a finance key
// exists in the grid only if the backend can store it.
const app = readFileSync(new URL('../../../frontend/app.js', import.meta.url), 'utf8');
const routes = readFileSync(new URL('../code/routes/contracts.mjs', import.meta.url), 'utf8');

const grab = (n) => {
  const i = app.indexOf(`function ${n}(`);
  if (i < 0) throw new Error('missing ' + n);
  let d = 0;
  for (let k = app.indexOf('{', i); k < app.length; k++) {
    if (app[k] === '{') d++; else if (app[k] === '}') { d--; if (!d) return app.slice(i, k + 1); }
  }
};
// FINANCE_COLUMNS is a const array literal, not a function — take it verbatim.
const financeSrc = app.slice(app.indexOf('const FINANCE_COLUMNS = ['),
                             app.indexOf('];', app.indexOf('const FINANCE_COLUMNS = [')) + 2);

const columnsFor = (region) => new Function('REGION', 'UNIT_MODELS_FALLBACK',
  financeSrc + '\n' + grab('buildContractGridColumns') + '\nreturn buildContractGridColumns(["S5"]);'
)(region, ['S5']);

const FINANCE_KEYS = ['bankName', 'bankAccountName', 'bankAccountNumber',
                      'financeContactName', 'financeContactEmail'];

test('both regions get the Finance Information columns', () => {
  for (const region of ['th', 'sg']) {
    const keys = columnsFor(region).filter(c => c.group === 'finance').map(c => c.key);
    assert.deepEqual(keys, FINANCE_KEYS, `${region} should carry every finance column`);
  }
});

test('the finance columns sit between Contract and Share terms', () => {
  // Payment details follow the contract they are paid under. Order matters beyond taste: the
  // new-merchant form groups by RUNS of the same group key, so a split group would render two
  // "Finance Information" sections.
  const groups = columnsFor('th').map(c => c.group);
  assert.equal(groups.filter((g, i) => g === 'finance' && groups[i - 1] !== 'finance').length, 1);
  assert.equal(groups[groups.indexOf('finance') - 1], 'contract');
  assert.equal(groups[groups.lastIndexOf('finance') + 1], 'terms');
});

test('every finance column is writable by the backend', () => {
  const writable = routes.slice(routes.indexOf('const WRITABLE = ['),
                                routes.indexOf('];', routes.indexOf('const WRITABLE = [')));
  for (const key of FINANCE_KEYS) assert.ok(writable.includes(`'${key}'`), `WRITABLE is missing ${key}`);
});

test('the finance group is editable in the grid', () => {
  // Unlike Contact/Phone/Email, no upload file carries bank columns, so an import cannot
  // revert what is typed here — which is what makes inline editing honest.
  const m = app.match(/const EDITABLE_GROUPS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(m && m[1].includes("'finance'"));
});

// ── The download sheet (2026-09-04) ────────────────────────────────────────────────────────
// Export was asked for; import came with it. A column the sheet writes but the importer cannot
// read back loses an edit in silence — you change a bank number in Excel, upload, and nothing
// happens. So the sheet's headers ARE the grid's labels, and these tests pin the round trip.
const FINANCE_LABELS = columnsFor('th').filter(c => c.group === 'finance').map(c => c.label);
const sheetHeader = ['Merchant', ...FINANCE_LABELS];
const sheetGroups = ['Merchant', ...FINANCE_LABELS.map(() => 'Finance Information')];

test('the importer reads back every header the download writes', () => {
  const r = normalizeContractRow(
    ['Acme', 'Kasikornbank', 'Acme Co., Ltd.', '123-4-56789-0', 'Nutcha S.', 'ap@acme.com'],
    sheetHeader, sheetGroups);
  assert.equal(r.bankName, 'Kasikornbank');
  assert.equal(r.bankAccountName, 'Acme Co., Ltd.');
  assert.equal(r.bankAccountNumber, '123-4-56789-0');
  assert.equal(r.financeContactName, 'Nutcha S.');
  assert.equal(r.financeContactEmail, 'ap@acme.com');
});

test('an account number keeps its leading zeros and dashes', () => {
  // A number-coercing path would eat "007". Pin it: a mangled account number is a bounced
  // transfer, and nothing downstream would notice.
  const r = normalizeContractRow(['Acme', null, null, '007-0-00123-4', null, null],
    sheetHeader, sheetGroups);
  assert.equal(r.bankAccountNumber, '007-0-00123-4');
});

test('a blank finance cell states nothing, so an upload cannot clear a bank account', () => {
  // The same property the share-terms columns have: buildImportPlan spreads {...existing, ...row},
  // so a field the row does not carry keeps whatever is stored.
  const r = normalizeContractRow(['Acme', null, null, null, null, null], sheetHeader, sheetGroups);
  for (const k of FINANCE_KEYS) assert.ok(!(k in r), `${k} should be absent, not blank`);
});

test('the sheet derives its finance columns from the grid', () => {
  const src = grab('gridTemplateColumns');
  assert.match(src, /FINANCE_COLUMNS\.map/,
    'the sheet must derive its headers from FINANCE_COLUMNS, not retype them');
  const desc = app.slice(app.indexOf('const FINANCE_SHEET_DESC = {'),
                         app.indexOf('};', app.indexOf('const FINANCE_SHEET_DESC = {')));
  for (const key of FINANCE_KEYS) assert.ok(desc.includes(`${key}:`), `no sheet description for ${key}`);
});

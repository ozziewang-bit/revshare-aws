import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// A run stopped asking for the merchant list on 2026-09-29 — it is uploaded once, stored, and
// read. The property that makes that safe is narrow and worth holding directly:
//
//   THE ROSTER IS STORED AS ROWS, NEVER AS COUNTS.
//
// The engine counts roster rows, and a roster row is a STATION. `units` counts CABINETS. BTS has
// 36 stations holding 103 machines and is paid 4,000 per station = 144,000. Had the run read the
// stored counts instead, BTS would have been paid 412,000 — a 268,000/month overpayment from a
// change that looks like a workflow tidy-up. Measured on live data before this shipped.
const db = readFileSync(new URL('../code/db.mjs', import.meta.url), 'utf8');
const route = readFileSync(new URL('../code/routes/bulk-runs.mjs', import.meta.url), 'utf8');
const contracts = readFileSync(new URL('../code/routes/contracts.mjs', import.meta.url), 'utf8');
const app = readFileSync(new URL('../../../frontend/app.js', import.meta.url), 'utf8');

test('the stored roster keeps ROWS, not counts', () => {
  const block = db.slice(db.indexOf('export async function putRoster'));
  assert.match(block, /Body: JSON\.stringify\(doc\)/, 'the whole roster document goes to S3');
  assert.match(block, /doc\.merchants/, 'and the rows are what it counts');
  assert.match(block, /rosterCount: \(doc\.merchants \|\| \[\]\)\.length/);
  const put = block.slice(0, block.indexOf('export async function getRosterMeta'));
  assert.doesNotMatch(put, /\bunits\b/, 'it must never store or derive machine counts');
  assert.doesNotMatch(put, /installedUnits/);
});

test('a run reads the stored rows, and an uploaded roster still wins', () => {
  const prep = route.slice(route.indexOf('export async function prepareBulkRunRoute'),
                           route.indexOf('export function payoutDecision'));
  assert.match(prep, /Array\.isArray\(body\.merchants\) \? body\.merchants : \[\]/,
    'an uploaded list is still honoured');
  assert.match(prep, /await dbModule\.getRosterRows\(\)/, 'otherwise the stored rows are used');
});

test('db.mjs is read through a namespace import, never a named one', () => {
  // A named import of a symbol the target db.mjs lacks is a static ESM error that fails the whole
  // module load — the exact shape that has taken Singapore down three times (§8). db.mjs is never
  // synced, so a new export must degrade, not crash.
  assert.match(route, /import \* as dbModule from '\.\.\/db\.mjs'/);
  assert.match(contracts, /import \* as dbModule from '\.\.\/db\.mjs'/);
});

// REVISED 2026-09-29: the bulk Import and Review-only buttons were removed at the user's
// request — every merchant change is now one row, one click. Recording the file is no longer a
// button at all: it happens when the file is read, because a file you are working through IS
// your latest file. What matters is unchanged and asserted here — recording it creates and
// changes no merchant.
test('recording the file changes no merchant', () => {
  const i = app.indexOf('async function rememberUploadedFile');
  const fn = app.slice(i, app.indexOf('\n}\n', i));
  assert.match(fn, /api\('\/roster', \{ method: 'PUT'/);
  assert.ok(!/'\/contracts'/.test(fn), 'no merchant is created');
  assert.ok(!/'\/registry'/.test(fn), 'and the store index is written per row, not here');
});

test('the upload stores the roster parsed as a ROSTER, not as folded brands', () => {
  const fn = app.slice(app.indexOf('async function previewUpload'));
  assert.match(fn.slice(0, 2000), /parseMerchantList\(mf\)/,
    'the same parser the wizard used — one row per station, with device type');
  assert.match(fn.slice(0, 2000), /parseWeeklyMerchantFile\(mf\)/,
    'and the folded view for the merchant diff');
});

// The reason this screen exists at all.
test('the run says how old the stored merchant list is', () => {
  const fn = app.slice(app.indexOf('function wizRosterStatusHtml'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /Merchant list updated/);
  assert.match(body, /Machine list updated/, 'the machine list is reported separately');
  assert.match(body, /days >= 14/, 'and a stale list is called out');
  assert.match(body, /No merchant list stored yet/, 'the empty state sends you to Upload');
});

// ── The machine file must survive the upload (2026-10-01) ───────────────────────────────────
// "please read Central again for the branches and machines from my last file upload" — the
// branches were there; the machines were not. `putRosterRoute` has accepted a `machines` array
// since it was written, and the client never sent one: each upload stored `machineStoreCount:
// 2401` and discarded the 2,401 rows behind it. CLAUDE.md's rule is explicit — retain every
// column on upload so future features can reuse it.
import { test as t2 } from 'node:test';
import assert2 from 'node:assert/strict';
import { readFileSync as read2 } from 'node:fs';

// byStore entries carry machine STATE and BINDING since 2026-10-01 (`{counts, deployed, total}`),
// because the registry only takes a shop that is Approved AND has a deployed machine bound to it.
// Tests still state plain counts; this wraps them, so the shape lives in one place.
const M = (counts) => {
  const n = Object.values(counts).reduce((a, b) => a + b, 0);
  return { counts, deployed: n, total: n, businessId: null };
};

const appSrc = read2(new URL('../../../frontend/app.js', import.meta.url), 'utf8');
const remember = appSrc.slice(appSrc.indexOf('async function rememberUploadedFile('),
                               appSrc.indexOf('\n}', appSrc.indexOf('async function rememberUploadedFile(')));

t2('the upload sends the machine rows, not just how many there were', () => {
  assert2.match(remember, /machines: machines \? \[\.\.\.machines\.byStore\]/);
  assert2.match(remember, /store, counts: e\.counts, deployed: e\.deployed/,
    'the shop, its per-model counts, and HOW MANY ARE DEPLOYED');
  assert2.match(remember, /businessId: e\.businessId/, 'and what the machines are bound to');
  assert2.match(remember, /machineCount: machines \? machines\.counted : null/,
    'and the cabinet total, which store count is not');
});

t2('the route stores exactly what it is sent', () => {
  const route = read2(new URL('../code/routes/contracts.mjs', import.meta.url), 'utf8');
  const fn = route.slice(route.indexOf('export async function putRosterRoute'),
                         route.indexOf('\n}', route.indexOf('export async function putRosterRoute')));
  assert2.match(fn, /machines: Array\.isArray\(body\.machines\) \? body\.machines : \[\]/);
});

// The shape has to round-trip, or "retained" is a claim rather than a fact.
t2('a store with two models survives as two counts', () => {
  const byStore = new Map([
    ['เซ็นทรัลเวสต์เกต ชั้น1', M({ LL40: 2 })],
    ['7-Eleven สยาม', M({ S8: 1, S5: 3 })],
  ]);
  const sent = [...byStore].map(([store, e]) => ({
    store, counts: e.counts, deployed: e.deployed, total: e.total, businessId: e.businessId }));
  const back = new Map(sent.map(m => [m.store, m.counts]));
  assert2.deepEqual(back.get('7-Eleven สยาม'), { S8: 1, S5: 3 });
  const cabinets = sent.reduce((a, m) => a + Object.values(m.counts).reduce((x, y) => x + y, 0), 0);
  assert2.equal(cabinets, 6, 'cabinets, which is not the 2 stores');
  assert2.equal(sent.length, 2);
});

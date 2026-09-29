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

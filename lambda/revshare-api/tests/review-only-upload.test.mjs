import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { contractWrites, buildImportPlan } from '../code/contracts.mjs';

// A REVIEW-ONLY upload (2026-09-21): tell me what this file says, change nothing, and let me
// apply the parts I want afterwards. The property that makes it trustworthy is narrow and worth
// holding directly — a review produces NO writes — because everything else about the flow is
// shared with a real import on purpose, so the review cannot describe something an import
// would not do.

const rows = (names) => names.map(n => ({ merchantName: n, merchantType: 'Retail' }));
const existing = [{ contractId: 'c1', merchantName: 'Acme', merchantNameLower: 'acme' }];
let n = 0;
const newId = () => `new-${++n}`;

test('a review writes nothing at all, however much the file would change', () => {
  const plan = buildImportPlan(rows(['Acme', 'Brand New', 'Another New']), existing, []);
  assert.equal(plan.creates.length, 2, 'the plan itself still says what WOULD happen');
  assert.ok(plan.updates.length >= 1);
  assert.deepEqual(contractWrites(plan, { dryRun: true, newId }), []);
});

test('a real import writes the creates and the updates', () => {
  const plan = buildImportPlan(rows(['Acme', 'Brand New']), existing, []);
  const writes = contractWrites(plan, { dryRun: false, newId });
  assert.equal(writes.length, plan.creates.length + plan.updates.length);
  for (const w of writes) assert.ok(w.contractId, 'every written row carries an id');
});

test('a review never mints a contract id', () => {
  // Ids are the trace a write leaves. Minting them on a review would burn ulids for rows that
  // do not exist, and would make a dry run look like it had done something.
  const before = n;
  contractWrites(buildImportPlan(rows(['Brand New']), existing, []), { dryRun: true, newId });
  assert.equal(n, before);
});

test('an import that could create rows refuses to run without an id source', () => {
  // Defence in depth: a caller that forgets `newId` must fail loudly rather than write rows
  // with an undefined contractId, which would be unreachable and invisible.
  const plan = buildImportPlan(rows(['Brand New']), existing, []);
  assert.throws(() => contractWrites(plan, { dryRun: false }), /newId/);
});

test('the route sends `would*` counts for a review and plain counts for an import', () => {
  // The words matter: a review that answers `created: 12` reads as twelve merchants added.
  const src = readFileSync(new URL('../code/routes/contracts.mjs', import.meta.url), 'utf8');
  const route = src.slice(src.indexOf('export async function importContractsRoute'));
  assert.match(route, /wouldCreate: plan\.creates\.length/);
  assert.match(route, /wouldUpdate: plan\.updates\.length/);
  assert.match(route, /const dryRun = body\.dryRun === true;/,
    'dryRun must be an explicit true, never inferred from the request shape');
});

test('a review still records the upload', () => {
  // This is the whole point: the file becomes what the Merchant view marks and the Reconcile
  // tab compare against, WITHOUT the merchant rows changing. If recording were skipped on a
  // review, the screen would have nothing to compare and the feature would do nothing.
  const src = readFileSync(new URL('../code/routes/contracts.mjs', import.meta.url), 'utf8');
  const route = src.slice(src.indexOf('export async function importContractsRoute'));
  const record = route.indexOf('if (body.recordUpload)');
  assert.ok(record > 0, 'the recording block must still exist');
  assert.ok(!/if \(body\.recordUpload && !dryRun\)/.test(route),
    'recording must NOT be skipped on a review');
});

test('the browser sends one file through one path, differing only by dryRun', () => {
  // Review and Import share `submit(dryRun)`. Two separate handlers would let the review
  // describe an import that is not the one that would run.
  const app = readFileSync(new URL('../../../frontend/app.js', import.meta.url), 'utf8');
  assert.match(app, /const submit = async \(dryRun\) =>/);
  assert.match(app, /#am-import'\)\.addEventListener\('click', \(\) => submit\(false\)\)/);
  assert.match(app, /#am-review'\)\.addEventListener\('click', \(\) => submit\(true\)\)/);
  assert.match(app, /if \(machines && !dryRun\)/,
    'machine counts are merchant data too — a review must not write them either');
});

// ── The STORED record must not read as an accomplished fact either (2026-09-29) ─────────────
// The HTTP response has always said `wouldCreate`/`wouldUpdate` on a review. The row written to
// CONFIG/UPLOAD#LATEST did not: it recorded `counts: { created, updated }` unconditionally, so
// the 21 Sep review-only upload is stored as "25 created, 258 updated" when it wrote nothing.
// Found while working out why SEACON Bangkae had no branch count — the record said the file had
// been applied, and the contract's own updatedAt (17 Sep) said it had not.
test('a review records what it WOULD have done, not what it did', () => {
  const src = readFileSync(new URL('../code/routes/contracts.mjs', import.meta.url), 'utf8');
  const route = src.slice(src.indexOf('export async function importContractsRoute'));
  const block = route.slice(route.indexOf('if (body.recordUpload)'), route.indexOf('// Named `would*`'));
  assert.match(block, /dryRun/,
    'the stored counts must depend on whether anything was actually written');
  assert.doesNotMatch(block, /counts: \{ brands: doc\.brands\.length, created:/,
    'a review must not store its plan under the key `created`');
});

test('the stored counts name the same thing the response does', () => {
  const src = readFileSync(new URL('../code/routes/contracts.mjs', import.meta.url), 'utf8');
  const route = src.slice(src.indexOf('export async function importContractsRoute'));
  const block = route.slice(route.indexOf('if (body.recordUpload)'), route.indexOf('// Named `would*`'));
  assert.match(block, /wouldCreate/, 'a review stores wouldCreate, like the response');
  assert.match(block, /wouldUpdate/);
});

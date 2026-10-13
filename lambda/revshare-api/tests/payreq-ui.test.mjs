import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The run page's payment-request helpers, read out of app.js rather than copied (see
// run-view.test.mjs for the same trick).
const src = readFileSync(new URL('../../../frontend/app.js', import.meta.url), 'utf8');
const grab = (n) => { const i = src.indexOf(`function ${n}(`); if (i < 0) throw new Error('missing ' + n);
  let d = 0; for (let k = src.indexOf('{', i); k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); } } };
const { payReqEligible, payReqCell, payReqSummary } = new Function(
  'const escape = s => String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/"/g,"&quot;");\n'
  + grab('payReqEligible') + '\n' + grab('payReqCell') + '\n' + grab('payReqBucket') + '\n' + grab('payReqSummary')
  + '\nreturn { payReqEligible, payReqCell, payReqSummary };')();

const run = { archived: true };
test('eligibility', () => {
  assert.deepEqual(payReqEligible({ payout: 10, contractId: 'C' }, run, { rows: {} }), { ok: true, reason: '' });
  assert.equal(payReqEligible({ payout: 0, contractId: 'C' }, run, { rows: {} }).reason, 'No payout this month');
  assert.equal(payReqEligible({ payout: 10, contractId: 'C' }, { archived: false }, { rows: {} }).reason, 'Lock this month first');
  assert.equal(payReqEligible({ payout: 10, contractId: 'C' }, run, { rows: { C: {} } }).reason, 'Already requested');
});
test('cell links to the request in Payment Request and shows the live label', () => {
  const h = payReqCell({ requestId: 'abc', createdBy: 'ozzie.wang@inforich.com', createdAt: '2026-10-13T03:00:00Z',
    status: { label: 'Paid 2026-10-25', docNumber: 'PV-2026-0300' } }, 'https://pr.example');
  assert.match(h, /href="https:\/\/pr\.example\/#request\/abc"/);
  assert.match(h, /Paid 2026-10-25/); assert.match(h, /PV-2026-0300/);
  assert.match(h, /title="Created by ozzie\.wang@inforich\.com on 2026-10-13"/);
  assert.match(payReqCell({ requestId: 'x', status: 'unknown' }, 'https://p'), /status unavailable/);
  assert.equal(payReqCell(null, 'https://p'), '<span class="muted">—</span>');
});
test('summary line counts by stage', () => {
  const rows = { a: { status: { label: 'Draft' } }, b: { status: { label: 'Paid 2026-10-01' } },
    c: { status: { label: 'Submitted — awaiting finance' } }, d: { status: { label: 'Approved — ready to pay' } }, e: { status: 'unknown' } };
  assert.equal(payReqSummary(rows), '5 requested · 1 paid · 1 to pay · 1 in approval · 1 draft · 1 status unavailable');
  assert.equal(payReqSummary({}), '');
});

// ── Final-review fixes (2026-10-13) ─────────────────────────────────────────────────────────
test('a request whose amount no longer matches the run says so (I4)', () => {
  const row = { requestId: 'a', amount: 1420, status: { label: 'Draft' } };
  assert.doesNotMatch(payReqCell(row, 'https://p', 1420), /differs/);
  const h = payReqCell(row, 'https://p', 1500);
  assert.match(h, /amount differs/);
  assert.match(h, /1,420\.00/); assert.match(h, /1,500\.00/);
});
test('when the status could not be loaded, nothing is tickable (M1)', () => {
  const e = payReqEligible({ payout: 10, contractId: 'C' }, { archived: true }, { failed: true, rows: {} });
  assert.equal(e.ok, false);
  assert.match(e.reason, /could not be loaded/);
});
test('a statement over the Lambda limit is refused in the browser with a clear message (M7)', async () => {
  const fn = new Function(
    'const API_BODY_LIMIT = 10 * 1024 * 1024; const PR_BODY_LIMIT = ' + src.match(/^const PR_BODY_LIMIT = (.*);$/m)[1] + ';\n'
    + 'const byteLength = (s) => new TextEncoder().encode(s).length;\n'
    + 'const gzipBase64 = async () => null; const api = async () => "sent";\n'
    + 'async ' + grab('postLarge') + '\nreturn { postLarge, PR_BODY_LIMIT };')();
  const big = { statement: 'x'.repeat(7 * 1024 * 1024) };
  await assert.rejects(fn.postLarge('/p', big, 'statement', fn.PR_BODY_LIMIT), /too large/);
  assert.equal(await fn.postLarge('/p', { statement: 'small' }, 'statement', fn.PR_BODY_LIMIT), 'sent');
  assert.ok(fn.PR_BODY_LIMIT <= 6 * 1024 * 1024);
});

// Coming back to the tab re-reads the statuses and redraws only the request cells and ticks
// (2026-10-13: a draft deleted in Payment Request still read "Draft" until the run was reopened).
test('the Payment request cell: status if requested, a tick if it can be, otherwise a dash', () => {
  const { payReqColumnCell } = new Function(
    'const escape = s => String(s ?? "");\n' + grab('payReqEligible') + '\n' + grab('payReqCell') + '\n' + grab('payReqColumnCell')
    + '\nreturn { payReqColumnCell };')();
  const r = { contractId: 'C1', merchantName: 'Classic', payout: 20 };
  const run = { archived: true };
  const tick = payReqColumnCell(r, run, { rows: {} }, 'https://p', true);
  assert.match(tick, /class="pr-tick" data-cid="C1"/);
  assert.match(tick, /Request/);
  assert.match(payReqColumnCell(r, run, { rows: { C1: { requestId: 'x', status: { label: 'Draft' } } } }, 'https://p', true), /#request\/x/);
  // no tick for someone who cannot create, for a zero payout, or for an unlocked month
  assert.doesNotMatch(payReqColumnCell(r, run, { rows: {} }, 'https://p', false), /pr-tick/);
  assert.doesNotMatch(payReqColumnCell({ ...r, payout: 0 }, run, { rows: {} }, 'https://p', true), /pr-tick/);
  assert.doesNotMatch(payReqColumnCell(r, { archived: false }, { rows: {} }, 'https://p', true), /pr-tick/);
});
test('ticks and the Create button live in the Payment request column — no tick column, no selection bar', () => {
  assert.ok(!src.includes('pr-tick-cell'), 'no separate tick column');
  assert.ok(!src.includes('pr-selbar'), 'no selection bar');
  const thead = src.slice(src.indexOf('<table class="ts run-table"><thead>'), src.indexOf('</thead>', src.indexOf('<table class="ts run-table"><thead>')));
  assert.ok(thead.includes('id="pr-create"'), 'Create button in the header');
});
test('the run page re-checks payment requests when the tab comes back into view', () => {
  assert.match(src, /visibilitychange[\s\S]{0,400}refreshPayReqs/);
  assert.ok(src.includes('function refreshPayReqs('), 'refreshPayReqs exists');
});

// Run table filters (2026-10-13): contract entity, Brand, payment request — combined.
const F = new Function(
  'const escape = s => String(s ?? "");\n' + grab('payReqBucket') + '\n' + grab('runResultsFiltered')
  + '\nreturn { payReqBucket, runResultsFiltered };')();
const RESULTS = [
  { contractId: 'A', merchantName: 'AOT', payout: 100 },
  { contractId: 'B', merchantName: 'BTS', payout: 50 },
  { contractId: 'C', merchantName: 'Classic', payout: 20 },
  { contractId: 'D', merchantName: 'Dazzling', payout: 4 },
];
const ENT = { A: 'Airports of Thailand', B: 'BTSC', C: '', D: 'BTSC' };
const ROWS = { A: { status: { label: 'Paid 2026-10-01' } }, B: { status: { label: 'Draft' } },
  D: { status: { label: 'Submitted — awaiting finance' } } };
const ids = (f) => F.runResultsFiltered(RESULTS, f, ROWS, (cid) => ENT[cid]).map((r) => r.contractId);

test('payment-request buckets', () => {
  assert.equal(F.payReqBucket(undefined), 'none');
  assert.equal(F.payReqBucket({ status: 'unknown' }), 'unknown');
  assert.equal(F.payReqBucket({ status: { label: 'Draft' } }), 'draft');
  assert.equal(F.payReqBucket({ status: { label: 'Submitted — awaiting COO' } }), 'inflow');
  assert.equal(F.payReqBucket({ status: { label: 'Approved — paying 2026-10-20' } }), 'topay');
  assert.equal(F.payReqBucket({ status: { label: 'Paid 2026-10-01' } }), 'paid');
  assert.equal(F.payReqBucket({ status: { label: 'Rejected' } }), 'back');
  assert.equal(F.payReqBucket({ status: { label: 'Sent back' } }), 'back');
});
test('no filter keeps every Brand', () => assert.deepEqual(ids({}), ['A', 'B', 'C', 'D']));
test('by entity, including "no contract entity"', () => {
  assert.deepEqual(ids({ entity: 'btsc' }), ['B', 'D']);          // case-insensitive, like the grouping
  assert.deepEqual(ids({ entity: '__none__' }), ['C']);
});
test('by Brand', () => assert.deepEqual(ids({ brand: 'C' }), ['C']));
test('by payment request', () => {
  assert.deepEqual(ids({ pr: 'none' }), ['C']);
  assert.deepEqual(ids({ pr: 'paid' }), ['A']);
  assert.deepEqual(ids({ pr: 'inflow' }), ['D']);
});
test('filters combine', () => {
  assert.deepEqual(ids({ entity: 'btsc', pr: 'draft' }), ['B']);
  assert.deepEqual(ids({ entity: 'btsc', brand: 'A' }), []);
});
test('the three filters live in their column headers, not in a toolbar', () => {
  const thead = src.slice(src.indexOf('<table class="ts run-table"><thead>'), src.indexOf('</thead>', src.indexOf('<table class="ts run-table"><thead>')));
  for (const id of ['rf-entity', 'rf-brand', 'rf-pr']) assert.ok(thead.includes(`thFilter('${id}'`), id + ' in the header');
  assert.ok(src.includes('<select id="${id}"'), 'thFilter renders a real <select> with that id');
  assert.ok(!src.includes('run-filters'), 'no separate filter toolbar');
});

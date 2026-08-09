import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRosterRows, payoutDecision } from '../code/routes/bulk-runs.mjs';
import { evaluateRun } from '../code/engine.mjs';

const roster = [
  { merchantId: 'mA', name: 'Store A', nameLower: 'store a', contractId: 'c1', model: 'S8' },
  { merchantId: 'mB', name: 'Store B', nameLower: 'store b', contractId: 'c1', model: 'S8' },
  { merchantId: 'mC', name: 'Store C', nameLower: 'store c', contractId: 'c2', model: 'S5' },
];
const orders = [
  { merchantName: 'Store A', netAmount: 100 },
  { merchantName: 'Store A', netAmount: 50 },
  { merchantName: 'Ghost Store', netAmount: 9 },
];

test('every roster machine becomes a row; order-less rows are 0; contracts grouped', () => {
  const { groups } = buildRosterRows(roster, orders);
  const a = groups['c1'].find(r => r.merchantId === 'mA');
  const b = groups['c1'].find(r => r.merchantId === 'mB');
  assert.equal(a.rentals, 2); assert.equal(a.revenue, 150);
  assert.equal(b.rentals, 0); assert.equal(b.revenue, 0);   // order-less but present
  assert.equal(groups['c2'][0].merchantId, 'mC');
  assert.equal(groups['c2'][0].rentals, 0);
});

test('orders not in roster are unmatched, not paid', () => {
  const { unmatched, unmatchedOrderCount, unmatchedRevenue } = buildRosterRows(roster, orders);
  assert.deepEqual(unmatched, ['Ghost Store']);
  assert.equal(unmatchedOrderCount, 1);
  assert.equal(unmatchedRevenue, 9);
});

test('order-less machine still earns placement (flat_per_machine) via the engine', () => {
  const rule = { type: 'flat_per_machine', rows: [{ model: 'S8', amount: 100 }] };
  const { groups } = buildRosterRows(
    [ { merchantId: 'mA', name: 'A', nameLower: 'a', contractId: 'c1', model: 'S8' },
      { merchantId: 'mB', name: 'B', nameLower: 'b', contractId: 'c1', model: 'S8' } ],
    [ { merchantName: 'A', netAmount: 100 } ]   // only A has orders
  );
  const rows = groups['c1'].map(m => ({ storeId: m.merchantId, machineSerial: m.merchantId, model: m.model, rentals: m.rentals, revenue: m.revenue }));
  const res = evaluateRun({ rule, rows, aggregationMode: 'per_store', allowedModels: new Set(['S8']) });
  assert.equal(res.totalPayout, 200);   // both machines paid 100 each, incl. order-less B
});

test('buildRosterRows groups by contractId, not partnerId', () => {
  const roster = [
    { merchantId: 'm1', name: 'Store A', nameLower: 'store a', contractId: 'c1', model: 'S8' },
    { merchantId: 'm2', name: 'Store B', nameLower: 'store b', contractId: 'c1', model: 'S5' },
    { merchantId: 'm3', name: 'Store C', nameLower: 'store c', contractId: 'c2', model: 'S8' },
  ];
  const { groups } = buildRosterRows(roster, []);
  assert.deepEqual(Object.keys(groups).sort(), ['c1', 'c2']);
  assert.equal(groups.c1.length, 2);
  assert.equal(groups.c2.length, 1);
});

// This exercises the `if (!m.contractId) continue` guard directly, but that guard is not a
// live path in production: applyMerchantRoster auto-creates a noPayout stub CONTRACT for
// every roster label, so no real roster row ever reaches buildRosterRows without a
// contractId. It's defence in depth for a caller that skips applyMerchantRoster (e.g. this
// test). It does NOT model "the 436 case" (brands with no CONTRACT before a roster upload) —
// those get a contractId assigned during applyMerchantRoster and are skipped-but-matched at
// payout time instead (see payoutDecision + the `skipped` list in createBulkRunRoute).
test('buildRosterRows: defensive guard drops a contractId-less row without throwing', () => {
  const roster = [
    { merchantId: 'm1', name: 'Store A', nameLower: 'store a', contractId: 'c1', model: 'S8' },
    { merchantId: 'm2', name: 'Orphan',  nameLower: 'orphan',  contractId: null, model: 'S8' },
  ];
  const { groups } = buildRosterRows(roster, []);
  assert.deepEqual(Object.keys(groups), ['c1']);
  assert.equal(groups.c1.length, 1);
});

test('buildRosterRows still overlays orders by store name and reports unmatched', () => {
  const roster = [{ merchantId: 'm1', name: 'Store A', nameLower: 'store a', contractId: 'c1', model: 'S8' }];
  const { groups, unmatched, unmatchedOrderCount } = buildRosterRows(roster, [
    { merchantName: 'Store A', netAmount: 100 },
    { merchantName: 'Store A', netAmount: 50 },
    { merchantName: 'Nowhere', netAmount: 999 },
  ]);
  assert.equal(groups.c1[0].rentals, 2);
  assert.equal(groups.c1[0].revenue, 150);
  assert.deepEqual(unmatched, ['Nowhere']);
  assert.equal(unmatchedOrderCount, 1);
});

// payoutDecision — the pure, testable form of "is this contract paid, and why not if not."
// Ordering matters: missing contract -> warn; noPayout -> skip silently; a rule that pays
// nothing -> skip with warning; an invalid aggregationMode -> skip with warning; else pay.

test('payoutDecision: missing contract is skipped with a warning', () => {
  const d = payoutDecision(null, 'c-missing');
  assert.equal(d.pay, false);
  assert.match(d.warning, /c-missing/);
});

test('payoutDecision: missing contract names the brand when a sample name is available, instead of a bare ULID', () => {
  const d = payoutDecision(null, 'c-missing', 'Ghost Brand');
  assert.equal(d.pay, false);
  assert.match(d.warning, /Ghost Brand/);
});

// Archived is checked before everything except a missing contract: a merchant whose contract
// has ended is not paid whatever its rule still says. It warns (unlike noPayout) because a
// roster that still lists it means machines are live under an ended contract.
test('payoutDecision: an archived merchant is skipped with a warning, even with a paying rule', () => {
  const d = payoutDecision(
    { contractId: 'c1', merchantName: 'Ended Co', archived: true, rule: { type: 'percent', rows: [{ model: 'ALL', percent: 50 }] }, aggregationMode: 'whole' },
    'c1');
  assert.equal(d.pay, false);
  assert.match(d.warning, /Ended Co/);
  assert.match(d.warning, /archived/);
});

test('payoutDecision: noPayout with no rule is skipped silently, no warning', () => {
  const d = payoutDecision({ contractId: 'c1', merchantName: 'A', noPayout: true, rule: null, aggregationMode: 'per_store' }, 'c1');
  assert.equal(d.pay, false);
  assert.equal(d.warning, undefined);
});

test('payoutDecision: a rule that pays nothing is skipped with a warning naming the merchant', () => {
  const d = payoutDecision({ contractId: 'c1', merchantName: 'A', noPayout: false, rule: { type: 'percent', rows: [{ percent: 0 }] }, aggregationMode: 'per_store' }, 'c1');
  assert.equal(d.pay, false);
  assert.match(d.warning, /A/);
});

test('payoutDecision: a paying rule with per_store aggregation is paid', () => {
  const d = payoutDecision({ contractId: 'c1', merchantName: 'A', noPayout: false, rule: { type: 'percent', rows: [{ percent: 50 }] }, aggregationMode: 'per_store' }, 'c1');
  assert.equal(d.pay, true);
});

test('payoutDecision: a paying rule with no aggregationMode is skipped with a warning naming the mode', () => {
  const d = payoutDecision({ contractId: 'c1', merchantName: 'A', noPayout: false, rule: { type: 'percent', rows: [{ percent: 50 }] } }, 'c1');
  assert.equal(d.pay, false);
  assert.match(d.warning, /unset/);
});

test('payoutDecision: a paying rule with whole aggregation is paid', () => {
  const d = payoutDecision({ contractId: 'c1', merchantName: 'A', noPayout: false, rule: { type: 'percent', rows: [{ percent: 50 }] }, aggregationMode: 'whole' }, 'c1');
  assert.equal(d.pay, true);
});

test('payoutDecision: noPayout wins over a 0% rule — no warning', () => {
  const d = payoutDecision({ contractId: 'c1', merchantName: 'A', noPayout: true, rule: { type: 'percent', rows: [{ percent: 0 }] }, aggregationMode: 'per_store' }, 'c1');
  assert.equal(d.pay, false);
  assert.equal(d.warning, undefined);
});

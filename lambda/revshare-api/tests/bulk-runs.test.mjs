import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRosterRows } from '../code/routes/bulk-runs.mjs';
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

test('buildRosterRows drops stores with no contract — the 436 case — without throwing', () => {
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

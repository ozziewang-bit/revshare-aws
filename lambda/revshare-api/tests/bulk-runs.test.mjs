import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRosterRows } from '../code/routes/bulk-runs.mjs';
import { evaluateRun } from '../code/engine.mjs';

const roster = [
  { merchantId: 'mA', name: 'Store A', nameLower: 'store a', partnerId: 'p1', model: 'S8' },
  { merchantId: 'mB', name: 'Store B', nameLower: 'store b', partnerId: 'p1', model: 'S8' },
  { merchantId: 'mC', name: 'Store C', nameLower: 'store c', partnerId: 'p2', model: 'S5' },
];
const orders = [
  { merchantName: 'Store A', netAmount: 100 },
  { merchantName: 'Store A', netAmount: 50 },
  { merchantName: 'Ghost Store', netAmount: 9 },
];

test('every roster machine becomes a row; order-less rows are 0; partners grouped', () => {
  const { groups } = buildRosterRows(roster, orders);
  const a = groups['p1'].find(r => r.merchantId === 'mA');
  const b = groups['p1'].find(r => r.merchantId === 'mB');
  assert.equal(a.rentals, 2); assert.equal(a.revenue, 150);
  assert.equal(b.rentals, 0); assert.equal(b.revenue, 0);   // order-less but present
  assert.equal(groups['p2'][0].merchantId, 'mC');
  assert.equal(groups['p2'][0].rentals, 0);
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
    [ { merchantId: 'mA', name: 'A', nameLower: 'a', partnerId: 'p1', model: 'S8' },
      { merchantId: 'mB', name: 'B', nameLower: 'b', partnerId: 'p1', model: 'S8' } ],
    [ { merchantName: 'A', netAmount: 100 } ]   // only A has orders
  );
  const rows = groups['p1'].map(m => ({ storeId: m.merchantId, machineSerial: m.merchantId, model: m.model, rentals: m.rentals, revenue: m.revenue }));
  const res = evaluateRun({ rule, rows, aggregationMode: 'per_store', allowedModels: new Set(['S8']) });
  assert.equal(res.totalPayout, 200);   // both machines paid 100 each, incl. order-less B
});

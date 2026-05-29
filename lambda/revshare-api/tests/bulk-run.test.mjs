import { test } from 'node:test';
import { strict as assert } from 'node:assert';

// Copy of the pure function from routes/bulk-runs.mjs (tested in isolation)
function groupOrders(orders, merchantMap) {
  const groups = {};
  const unmatchedSet = new Set();
  for (const { merchantName, netAmount } of orders) {
    const key = (merchantName || '').toLowerCase().trim();
    const merchant = merchantMap[key];
    if (!merchant) { unmatchedSet.add(merchantName); continue; }
    if (!groups[merchant.partnerId]) groups[merchant.partnerId] = [];
    const g = groups[merchant.partnerId];
    const existing = g.find(m => m.merchantId === merchant.merchantId);
    if (existing) { existing.rentals++; existing.revenue += netAmount; }
    else g.push({ merchantId: merchant.merchantId, merchantName: merchant.name, model: merchant.machineModel || 'S8', rentals: 1, revenue: netAmount });
  }
  return { groups, unmatched: [...unmatchedSet] };
}

const MERCHANT_MAP = {
  '7-eleven store a': { merchantId: 'M1', name: '7-Eleven Store A', partnerId: 'P1', machineModel: 'S8' },
  'glow fish': { merchantId: 'M2', name: 'Glow Fish', partnerId: 'P2', machineModel: 'S5' },
};

test('groupOrders: known merchants are grouped by partnerId', () => {
  const { groups, unmatched } = groupOrders([
    { merchantName: '7-Eleven Store A', netAmount: 20 },
    { merchantName: '7-Eleven Store A', netAmount: 40 },
  ], MERCHANT_MAP);
  assert.equal(unmatched.length, 0);
  assert.ok(groups['P1']);
  assert.equal(groups['P1'][0].rentals, 2);
  assert.equal(groups['P1'][0].revenue, 60);
});

test('groupOrders: unknown merchant goes to unmatched', () => {
  const { groups, unmatched } = groupOrders([
    { merchantName: 'Unknown Place', netAmount: 20 },
  ], MERCHANT_MAP);
  assert.equal(unmatched.length, 1);
  assert.equal(unmatched[0], 'Unknown Place');
  assert.deepEqual(groups, {});
});

test('groupOrders: name matching is case-insensitive and trims whitespace', () => {
  const { groups } = groupOrders([
    { merchantName: '  Glow Fish  ', netAmount: 100 },
  ], MERCHANT_MAP);
  assert.ok(groups['P2']);
  assert.equal(groups['P2'][0].revenue, 100);
});

test('groupOrders: two merchants same partner accumulate separately', () => {
  const map = {
    'store a': { merchantId: 'M1', name: 'Store A', partnerId: 'P1', machineModel: 'S8' },
    'store b': { merchantId: 'M2', name: 'Store B', partnerId: 'P1', machineModel: 'S8' },
  };
  const { groups } = groupOrders([
    { merchantName: 'Store A', netAmount: 50 },
    { merchantName: 'Store B', netAmount: 80 },
  ], map);
  assert.equal(groups['P1'].length, 2);
  assert.equal(groups['P1'].find(m => m.merchantId === 'M1').revenue, 50);
  assert.equal(groups['P1'].find(m => m.merchantId === 'M2').revenue, 80);
});

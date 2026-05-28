import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MACHINE_MODELS, evaluateRun } from '../code/engine.mjs';

test('MACHINE_MODELS enum contains all nine models', () => {
  assert.deepEqual([...MACHINE_MODELS].sort(),
    ['L20','L40','S10','S5','S8','T10','T20','T35','T8']);
});

test('evaluateRun with bad rule throws', () => {
  assert.throws(() => evaluateRun({ rule: null, rows: [], aggregationMode: 'whole' }),
    /rule must be a node/);
});

test('flat_per_machine with single ALL row: 3 machines × 500 = 1500', () => {
  const result = evaluateRun({
    rule: { type: 'flat_per_machine', rows: [{ model: 'ALL', amount: 500 }] },
    rows: [
      { storeId: 'A', machineSerial: 'M1', model: 'S5',  rentals: 10, revenue: 1000 },
      { storeId: 'A', machineSerial: 'M2', model: 'T35', rentals:  5, revenue: 2000 },
      { storeId: 'A', machineSerial: 'M3', model: 'L20', rentals:  0, revenue:    0 },
    ],
    aggregationMode: 'whole'
  });
  assert.equal(result.totalPayout, 1500);
});

test('flat_per_machine: per-model overrides + ALL catch-all', () => {
  const result = evaluateRun({
    rule: { type: 'flat_per_machine', rows: [
      { model: 'S5',  amount: 300 },
      { model: 'T35', amount: 800 },
      { model: 'ALL', amount: 100 },
    ]},
    rows: [
      { storeId: 'A', machineSerial: 'M1', model: 'S5',  rentals: 1, revenue: 0 },
      { storeId: 'A', machineSerial: 'M2', model: 'S5',  rentals: 1, revenue: 0 },
      { storeId: 'A', machineSerial: 'M3', model: 'T35', rentals: 1, revenue: 0 },
      { storeId: 'A', machineSerial: 'M4', model: 'L20', rentals: 1, revenue: 0 },
    ],
    aggregationMode: 'whole'
  });
  // 2×300 + 1×800 + 1×100 = 1500
  assert.equal(result.totalPayout, 1500);
});

test('flat_per_machine: model not covered and no ALL row → 0 contribution', () => {
  const result = evaluateRun({
    rule: { type: 'flat_per_machine', rows: [{ model: 'S5', amount: 300 }] },
    rows: [
      { storeId: 'A', machineSerial: 'M1', model: 'S5', rentals: 1, revenue: 0 },
      { storeId: 'A', machineSerial: 'M2', model: 'L20', rentals: 1, revenue: 0 },
    ],
    aggregationMode: 'whole'
  });
  assert.equal(result.totalPayout, 300);
});

test('percent leaf: 10% on S5 revenue, 5% on T35', () => {
  const result = evaluateRun({
    rule: { type: 'percent', rows: [
      { model: 'S5', percent: 10 }, { model: 'T35', percent: 5 },
    ]},
    rows: [
      { storeId: 'A', machineSerial: 'M1', model: 'S5',  rentals: 0, revenue: 10000 },
      { storeId: 'A', machineSerial: 'M2', model: 'T35', rentals: 0, revenue: 20000 },
    ],
    aggregationMode: 'whole'
  });
  assert.equal(result.totalPayout, 2000);   // 1000 + 1000
});

test('percent leaf: ALL applies to uncovered models', () => {
  const result = evaluateRun({
    rule: { type: 'percent', rows: [
      { model: 'S5', percent: 10 }, { model: 'ALL', percent: 2 },
    ]},
    rows: [
      { storeId: 'A', machineSerial: 'M1', model: 'S5',  rentals: 0, revenue: 10000 },
      { storeId: 'A', machineSerial: 'M2', model: 'L20', rentals: 0, revenue:  5000 },
    ],
    aggregationMode: 'whole'
  });
  assert.equal(result.totalPayout, 1100);   // 1000 + 100
});

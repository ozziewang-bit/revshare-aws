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

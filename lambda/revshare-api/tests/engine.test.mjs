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

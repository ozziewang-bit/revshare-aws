import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MACHINE_MODELS, evaluateRun } from '../code/engine.mjs';
import { parseDeviceType } from '../code/routes/import.mjs';

// LL20/LL40 are the PLATFORM's spelling of L20/L40, not Singapore-specific codes: Thailand's
// roster has 152 rows reading "Advertising Player-LL40" while its contracts key per-machine
// terms to L40. They were separate models between 2026-08-26 and 2026-08-27 — long enough to
// establish that splitting them makes evaluateRun reject those rows and drops AOT, BIG-C,
// ICON SIAM and 7-Eleven out of the next Thai run. S10-A is the genuine Singapore-only code:
// it has no Thai equivalent and collides with nothing.
const SG = ['S10-A'];

test('the engine knows S10-A, and does NOT know LL20/LL40', () => {
  for (const m of SG) assert.ok(MACHINE_MODELS.has(m), `${m} missing from MACHINE_MODELS`);
  // Their presence is what would make evaluateRun accept an LL40 row and then find no matching
  // term — every Thai contract keys per-machine terms to L40.
  for (const m of ['LL20', 'LL40']) assert.ok(!MACHINE_MODELS.has(m), `${m} must fold to L${m.slice(2)}, not be a model`);
});

test('M10 is in the engine (CLAUDE.md §11 gap)', () => {
  assert.ok(MACHINE_MODELS.has('M10'));
});

test('the engine evaluates a rule against an SG model', () => {
  const r = evaluateRun({
    rule: { type: 'flat_per_machine', rows: [{ model: 'S10-A', amount: 100 }] },
    rows: [{ storeId: 's1', machineSerial: 's1', model: 'S10-A', rentals: 0, revenue: 0 }],
    aggregationMode: 'whole',
  });
  assert.equal(r.totalPayout, 100);
});

test('LL20/LL40 fold to L20/L40; S10-A does not fold', () => {
  assert.equal(parseDeviceType('Advertising Player-LL20'), 'L20');
  assert.equal(parseDeviceType('Advertising Player-LL40'), 'L40');
  assert.equal(parseDeviceType('Advertising Player-S10-A'), 'S10-A');
});

test('parseDeviceType still returns the Thai models unchanged', () => {
  assert.equal(parseDeviceType('Advertising Player-L20'), 'L20');
  assert.equal(parseDeviceType('Advertising Player-L40'), 'L40');
  assert.equal(parseDeviceType('Advertising Player-S10'), 'S10');
  assert.equal(parseDeviceType('Advertising Player-S8'), 'S8');
});

// The roster parser lives in frontend/app.js, which cannot be imported here (browser globals),
// so extract and evaluate it. It is the LIVE path — parseMerchantList uses it for every roster
// upload — and it is where the accidental endsWith fold lived, so it must be pinned.
test('the frontend roster parser folds LL20/LL40 and keeps S10-A', () => {
  const src = readFileSync(new URL('../../../frontend/app.js', import.meta.url), 'utf8');
  const models = src.match(/^const RS_MODELS = \[.*?\];$/m)[0];
  const fn = src.match(/^function parseDeviceModel\(deviceType\) \{[\s\S]*?\n\}$/m)[0];
  const parse = new Function(`${models}\n${fn}\nreturn parseDeviceModel;`)();

  assert.equal(parse('Advertising Player-LL20'), 'L20');
  assert.equal(parse('Advertising Player-LL40'), 'L40');
  assert.equal(parse('Advertising Player-S10-A'), 'S10-A');
  assert.equal(parse('Advertising Player-L20'), 'L20');
  assert.equal(parse('Advertising Player-S10'), 'S10');
  assert.equal(parse('Advertising Player-S5'), 'S5');
  assert.equal(parse('LL20'), 'L20');
  assert.equal(parse('S8'), 'S8');
});

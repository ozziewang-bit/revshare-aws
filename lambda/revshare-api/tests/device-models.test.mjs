import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MACHINE_MODELS, evaluateRun } from '../code/engine.mjs';
import { parseDeviceType } from '../code/routes/import.mjs';

// Singapore uses its own device codes: LL20, LL40, S10-A. They are separate models from
// Thailand's L20/L40/S10 by explicit decision (2026-08-26) — the hardware differs. Before
// that decision two code paths silently folded them together: import.mjs did
// `.replace('LL','L')`, and the frontend's parseDeviceModel matched on endsWith, so
// "…-LL20" ended with "L20". Either would attach an SG machine to a Thai model's terms.
const SG = ['LL20', 'LL40', 'S10-A'];

test('the engine knows the Singapore models', () => {
  for (const m of SG) assert.ok(MACHINE_MODELS.has(m), `${m} missing from MACHINE_MODELS`);
});

test('M10 is in the engine (CLAUDE.md §11 gap)', () => {
  assert.ok(MACHINE_MODELS.has('M10'));
});

test('the engine evaluates a rule against an SG model', () => {
  const r = evaluateRun({
    rule: { type: 'flat_per_machine', rows: [{ model: 'LL20', amount: 100 }] },
    rows: [{ storeId: 's1', machineSerial: 's1', model: 'LL20', rentals: 0, revenue: 0 }],
    aggregationMode: 'whole',
  });
  assert.equal(r.totalPayout, 100);
});

test('SG models are NOT folded into the Thai ones by parseDeviceType', () => {
  assert.equal(parseDeviceType('Advertising Player-LL20'), 'LL20');
  assert.equal(parseDeviceType('Advertising Player-LL40'), 'LL40');
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
test('the frontend roster parser keeps the SG models distinct', () => {
  const src = readFileSync(new URL('../../../frontend/app.js', import.meta.url), 'utf8');
  const models = src.match(/^const RS_MODELS = \[.*?\];$/m)[0];
  const fn = src.match(/^function parseDeviceModel\(deviceType\) \{[\s\S]*?\n\}$/m)[0];
  const parse = new Function(`${models}\n${fn}\nreturn parseDeviceModel;`)();

  assert.equal(parse('Advertising Player-LL20'), 'LL20');
  assert.equal(parse('Advertising Player-LL40'), 'LL40');
  assert.equal(parse('Advertising Player-S10-A'), 'S10-A');
  assert.equal(parse('Advertising Player-L20'), 'L20');
  assert.equal(parse('Advertising Player-S10'), 'S10');
  assert.equal(parse('Advertising Player-S5'), 'S5');
  assert.equal(parse('LL20'), 'LL20');
  assert.equal(parse('S8'), 'S8');
});

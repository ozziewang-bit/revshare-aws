import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MACHINE_MODELS, evaluateRun } from '../code/engine.mjs';
import { parseDeviceType } from '../code/routes/import.mjs';

// LL20, LL40, L20 and S10-A are all DISTINCT device codes. The Thailand roster proves it:
// 152 rows read "Advertising Player-LL40" and 5 read "Advertising Player-L20" — different
// prefixes, not a systematic LL. There is no plain L40 in either region's roster.
//
// A `.replace('LL','L')` fold lived in parseDeviceType for a long time, and it is why Thai
// contracts stored their large cabinets as L40: the importer collapsed the code on the way in.
// The stored data was wrong, not the codes. Folding also makes parseDeviceModel's LONGEST-match
// essential — "…-LL40" also ends with "L40".
const DISTINCT = ['LL20', 'LL40', 'S10-A', 'L20'];

test('the engine knows every distinct device code', () => {
  for (const m of DISTINCT) assert.ok(MACHINE_MODELS.has(m), `${m} missing from MACHINE_MODELS`);
});

test('M10 is in the engine (CLAUDE.md §11 gap)', () => {
  assert.ok(MACHINE_MODELS.has('M10'));
});

test('the engine evaluates a rule against an SG model', () => {
  const r = evaluateRun({
    rule: { type: 'flat_per_machine', rows: [{ model: 'LL40', amount: 100 }] },
    rows: [{ storeId: 's1', machineSerial: 's1', model: 'LL40', rentals: 0, revenue: 0 }],
    aggregationMode: 'whole',
  });
  assert.equal(r.totalPayout, 100);
});

test('parseDeviceType keeps every code distinct — nothing folds', () => {
  assert.equal(parseDeviceType('Advertising Player-LL20'), 'LL20');
  assert.equal(parseDeviceType('Advertising Player-LL40'), 'LL40');
  assert.equal(parseDeviceType('Advertising Player-L20'), 'L20', 'Thailand really does have L20 machines');
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
test('the frontend roster parser keeps every code distinct', () => {
  const src = readFileSync(new URL('../../../frontend/app.js', import.meta.url), 'utf8');
  const models = src.match(/^const RS_MODELS = \[.*?\];$/m)[0];
  const fn = src.match(/^function parseDeviceModel\(deviceType\) \{[\s\S]*?\n\}$/m)[0];
  const parse = new Function(`${models}\n${fn}\nreturn parseDeviceModel;`)();

  assert.equal(parse('Advertising Player-LL20'), 'LL20');
  assert.equal(parse('Advertising Player-LL40'), 'LL40');
  assert.equal(parse('Advertising Player-S10-A'), 'S10-A');
  assert.equal(parse('Advertising Player-L20'), 'L20', 'longest match must not turn L20 into LL20');
  assert.equal(parse('Advertising Player-S10'), 'S10');
  assert.equal(parse('Advertising Player-S5'), 'S5');
  assert.equal(parse('LL20'), 'LL20');
  assert.equal(parse('S8'), 'S8');
});

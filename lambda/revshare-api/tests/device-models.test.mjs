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

// ════════════════════════════════════════════════════════════════════════════════════════════
// The Merchant view's Units total (2026-09-29)
//
// SEACON Bangkae stores `units: { LL40: 3 }` and showed **Units 0** beside an **LL40 3** column
// on the same row. The per-model columns are built from the region's configured Device Types
// (UNIT_MODELS_FALLBACK's comment records that fix), but `unitsTotal` summed its OWN hardcoded
// list — ['S5','S8','M10','L20','L40'] — which the 2026-08-27 L40→LL40 rekey never updated. It
// named a code that exists in neither region and omitted the three that do.
//
// Measured on live data before the fix: 50 of 304 TH contracts and 114 of 554 SG contracts
// understated their machines — 384 machines invisible in that column.
//
// The total of a row's machines is the sum of the machines on that row. There is no allow-list
// to keep in step, which is the only way this cannot rot again.
// ════════════════════════════════════════════════════════════════════════════════════════════
const appSrc = readFileSync(new URL('../../../frontend/app.js', import.meta.url), 'utf8');
const grabFn = (n) => {
  const i = appSrc.indexOf(`const ${n} =`);
  if (i < 0) throw new Error('missing ' + n);
  return appSrc.slice(i, appSrc.indexOf('\n', i) + 1);
};
const unitsTotal = new Function(grabFn('unitsTotal') + 'return unitsTotal;')();

test('Units totals a contract whose machines are LL40 — the SEACON case', () => {
  assert.equal(unitsTotal({ units: { LL40: 3 } }), 3);
});

test('Units totals every distinct code, not a fixed five', () => {
  for (const m of DISTINCT) {
    assert.equal(unitsTotal({ units: { [m]: 2 } }), 2, `${m} must count toward the total`);
  }
  assert.equal(unitsTotal({ units: { S10: 1, T8: 1, T10: 1, T20: 1, T35: 1 } }), 5);
});

test('Units agrees with the sum of the per-model columns shown beside it', () => {
  // ICON SIAM, live: the grid showed 2 while the row holds 11.
  const c = { units: { S8: 1, S5: 1, LL40: 9 } };
  assert.equal(unitsTotal(c), Object.values(c.units).reduce((a, b) => a + b, 0));
  assert.equal(unitsTotal(c), 11);
});

test('Units is unmoved by the shapes that are not a count', () => {
  assert.equal(unitsTotal({}), 0);
  assert.equal(unitsTotal({ units: {} }), 0);
  assert.equal(unitsTotal({ units: null }), 0);
  assert.equal(unitsTotal({ units: { S5: null, S8: undefined, M10: '', LL40: 'x' } }), 0);
  assert.equal(unitsTotal({ units: { S5: '4' } }), 4, 'a numeric string still counts');
});

// The regression itself: no hardcoded model list may decide the total.
test('unitsTotal reads no fixed model list', () => {
  const src = grabFn('unitsTotal');
  assert.doesNotMatch(src, /UNIT_MODEL_KEYS/,
    'the total must come from the row, not an allow-list that a rekey can outdate');
});

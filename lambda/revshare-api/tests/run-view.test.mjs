import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// These helpers live in frontend/app.js — they read a STORED run, so they belong next to the
// rendering. Extract and evaluate them rather than keeping a second copy here: every run
// already carries `ruleSnapshots` and `engineResult`, and until 2026-08-27 neither was shown,
// so the page reported a payout with no way to ask how it was reached.
const src = readFileSync(new URL('../../../frontend/app.js', import.meta.url), 'utf8');
const grab = (n) => {
  const i = src.indexOf(`function ${n}(`);
  if (i < 0) throw new Error('missing ' + n);
  let d = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
  }
};
const grabConst = (n) => src.match(new RegExp(`^const ${n} = .*$`, 'm'))[0];
const api = new Function(
  grabConst('PAYOUT_METHODS') + '\n' + grab('legacyRole') + '\n' + grab('decompileRule') + '\n'
  + grab('engineComponents') + '\n' + grab('payoutBreakdown') + '\n' + grab('guaranteeInfo')
  + '\nreturn { payoutBreakdown, guaranteeInfo };')();
const { payoutBreakdown, guaranteeInfo } = api;

// BTS, exactly as stored: whole aggregation, MG won, so no percent leaf is recorded at all.
const BTS_ENGINE = { totalPayout: 144000, machineCounts: { S8: 26, L40: 10 },
  byPartner: { payout: 144000, components: [{ leafType: 'flat_per_machine', payout: 144000,
    modelRowsContributed: [
      { model: 'S8', count: 26, amount: 4000, payout: 104000 },
      { model: 'L40', count: 10, amount: 4000, payout: 40000 }] }] } };
const BTS_RULE = { type: 'max', _method: 'hybrid-higher', children: [
  { type: 'percent', _t: 'gp', rows: [{ model: 'ALL', percent: 30 }] },
  { type: 'flat_per_machine', _t: 'mg', rows: [{ model: 'S8', amount: 4000 }, { model: 'L40', amount: 4000 }] }] };

test('breakdown reproduces the arithmetic behind the payout', () => {
  const rows = payoutBreakdown(BTS_ENGINE);
  assert.deepEqual(rows.map(r => [r.model, r.count, r.amount, r.payout]),
    [['S8', 26, 4000, 104000], ['L40', 10, 4000, 40000]]);
  assert.equal(rows.reduce((a, r) => a + r.payout, 0), BTS_ENGINE.totalPayout);
});

test('models priced but not present are dropped from the breakdown', () => {
  // 7-Eleven prices S5/S8/L40 but a given store has only one of them; a row of zeros is noise.
  const rows = payoutBreakdown({ byPartner: { components: [{ leafType: 'flat_per_machine', payout: 150,
    modelRowsContributed: [
      { model: 'S5', count: 1, amount: 150, payout: 150 },
      { model: 'S8', count: 0, amount: 200, payout: 0 }] }] } });
  assert.deepEqual(rows.map(r => r.model), ['S5']);
});

test('per_store runs are summed across stores', () => {
  const rows = payoutBreakdown({ byStore: [
    { storeId: 'a', components: [{ leafType: 'flat_per_machine', payout: 150, modelRowsContributed: [{ model: 'S5', count: 1, amount: 150, payout: 150 }] }] },
    { storeId: 'b', components: [{ leafType: 'flat_per_machine', payout: 300, modelRowsContributed: [{ model: 'S5', count: 2, amount: 150, payout: 300 }] }] },
  ] });
  assert.deepEqual(rows.map(r => [r.model, r.count, r.payout]), [['S5', 3, 450]]);
});

test('a percent leaf has no per-model rows and stays one line', () => {
  const rows = payoutBreakdown({ byPartner: { components: [{ leafType: 'percent', payout: 2000 }] } });
  assert.deepEqual(rows, [{ leafType: 'percent', model: null, count: null, amount: null, payout: 2000 }]);
});

test('BTS is identified as paid on its guarantee, with the gap', () => {
  const info = guaranteeInfo({ revenue: 77025, payout: 144000, engineResult: BTS_ENGINE }, BTS_RULE);
  assert.equal(info.gpPercent, 30);
  assert.equal(info.shareWouldBe, 23107.5);
  assert.equal(info.gap, 144000 - 23107.5);
  assert.equal(info.everyStore, true);
});

test('a merchant whose share beat the guarantee is not flagged', () => {
  // The percent leaf contributed, so the GP branch won.
  const engine = { byPartner: { payout: 5000, components: [{ leafType: 'percent', payout: 5000 }] } };
  assert.equal(guaranteeInfo({ revenue: 25000, payout: 5000, engineResult: engine }, BTS_RULE), null);
});

test('a rule with no guarantee is never flagged', () => {
  const rule = { type: 'percent', _t: 'gp', _method: 'default', rows: [{ model: 'ALL', percent: 20 }] };
  const engine = { byPartner: { payout: 400, components: [{ leafType: 'percent', payout: 400 }] } };
  assert.equal(guaranteeInfo({ revenue: 2000, payout: 400, engineResult: engine }, rule), null);
});

test('per_store reports how many stores sat on the guarantee', () => {
  const engine = { byStore: [
    { storeId: 'a', components: [{ leafType: 'flat_per_machine', payout: 200, modelRowsContributed: [{ model: 'S8', count: 1, amount: 200, payout: 200 }] }] },
    { storeId: 'b', components: [{ leafType: 'percent', payout: 900 }] },
  ] };
  const info = guaranteeInfo({ revenue: 3000, payout: 1100, engineResult: engine }, BTS_RULE);
  assert.equal(info.storesOnMg, 1);
  assert.equal(info.storesTotal, 2);
  assert.equal(info.everyStore, false);
});

// ── Payout composition (Analytics) ────────────────────────────────────────
// A payout figure says nothing about what KIND of thing is being paid for. A revenue share and
// a guarantee behave completely differently as revenue moves, and in July the guarantees were
// the larger half. Classified from the engine's own recorded components — no re-derivation.
const composition = new Function(
  grabConst('PAYOUT_METHODS') + '\n' + grab('legacyRole') + '\n' + grab('decompileRule') + '\n'
  + grab('engineComponents') + '\n' + grab('guaranteeInfo') + '\n' + grab('payoutComposition')
  + '\nreturn payoutComposition;')();

const MG_RULE = { type: 'max', _method: 'hybrid-higher', children: [
  { type: 'percent', _t: 'gp', rows: [{ model: 'ALL', percent: 30 }] },
  { type: 'flat_per_machine', _t: 'mg', rows: [{ model: 'S8', amount: 4000 }] }] };
const PCT_RULE = { type: 'percent', _t: 'gp', _method: 'default', rows: [{ model: 'ALL', percent: 20 }] };

test('a merchant paid on its floor counts as Guarantee, not Placement', () => {
  const run = { ruleSnapshots: { c1: MG_RULE }, results: [
    { contractId: 'c1', revenue: 77025, payout: 144000, engineResult: { byPartner: { components: [
      { leafType: 'flat_per_machine', payout: 144000, modelRowsContributed: [{ model: 'S8', count: 36, amount: 4000, payout: 144000 }] }] } } }] };
  assert.deepEqual(composition(run), { Guarantee: 144000, 'Revenue share': 0, Placement: 0, 'Lump sum': 0 });
});

test('the same leaf type counts as Placement when no guarantee is involved', () => {
  const rule = { type: 'flat_per_machine', _t: 'placement', _method: 'default', rows: [{ model: 'S5', amount: 500 }] };
  const run = { ruleSnapshots: { c1: rule }, results: [
    { contractId: 'c1', revenue: 9000, payout: 1500, engineResult: { byPartner: { components: [
      { leafType: 'flat_per_machine', payout: 1500, modelRowsContributed: [{ model: 'S5', count: 3, amount: 500, payout: 1500 }] }] } } }] };
  assert.deepEqual(composition(run), { Guarantee: 0, 'Revenue share': 0, Placement: 1500, 'Lump sum': 0 });
});

test('percent and lump leaves are split out', () => {
  const run = { ruleSnapshots: { c1: PCT_RULE }, results: [
    { contractId: 'c1', revenue: 10000, payout: 2300, engineResult: { byPartner: { components: [
      { leafType: 'percent', payout: 2000 },
      { leafType: 'flat_per_partner_total', payout: 300 }] } } }] };
  assert.deepEqual(composition(run), { Guarantee: 0, 'Revenue share': 2000, Placement: 0, 'Lump sum': 300 });
});

test('composition sums to the total payout across merchants', () => {
  const run = { ruleSnapshots: { c1: MG_RULE, c2: PCT_RULE }, results: [
    { contractId: 'c1', revenue: 1000, payout: 4000, engineResult: { byPartner: { components: [
      { leafType: 'flat_per_machine', payout: 4000, modelRowsContributed: [{ model: 'S8', count: 1, amount: 4000, payout: 4000 }] }] } } },
    { contractId: 'c2', revenue: 10000, payout: 2000, engineResult: { byPartner: { components: [{ leafType: 'percent', payout: 2000 }] } } }] };
  const c = composition(run);
  assert.equal(Object.values(c).reduce((a, b) => a + b, 0), 6000);
});

test('filtering to one merchant reports only that merchant', () => {
  const run = { ruleSnapshots: { c1: PCT_RULE, c2: PCT_RULE }, results: [
    { contractId: 'c1', revenue: 1, payout: 100, engineResult: { byPartner: { components: [{ leafType: 'percent', payout: 100 }] } } },
    { contractId: 'c2', revenue: 1, payout: 900, engineResult: { byPartner: { components: [{ leafType: 'percent', payout: 900 }] } } }] };
  assert.equal(composition(run, 'c2')['Revenue share'], 900);
});

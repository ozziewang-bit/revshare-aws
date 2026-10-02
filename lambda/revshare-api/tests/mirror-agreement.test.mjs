import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { contractNeedsTerms, ruleHasValue as backendRuleHasValue } from '../code/payout.mjs';

// ── The same question must get the same answer everywhere (2026-10-01) ──────────────────────
// "don't complete part A and miss the linkage with B, or any stupid mistakes."
//
// "Can this brand be paid?" is asked in three places, and only one of them decides:
//   payoutDecision (bulk-runs.mjs)      — what actually happens at calc time
//   contractNeedsTerms (payout.mjs)     — what locks step 4 of the run wizard
//   needsTerms (app.js)                 — the Overview grid's ◆ badge, filter and count
//   fileMismatches().noShareTerms       — the Upload page's "Share terms incomplete" sub-page
// Three of those are mirrors. A mirror that drifts does not fail: it tells someone the brand is
// ready and then the run refuses, with no row anywhere naming the brand.
//
// Two had drifted when this was written, and neither showed on live data — which is the whole
// argument for a differential test over SHAPES rather than over today's 345 contracts:
//   • app.js carried a SECOND copy of ruleHasValue (`ruleHasAnyValue`) that read a
//     `tiered_percent` as `node.tiers`; the engine and the backend read `node.rows[].tiers`.
//     Every tiered rule looked empty to the Upload page and to the adopt picker.
//   • `needsTerms` omitted the aggregationMode clause while its comment claimed it was identical
//     to the gate. 73 contracts hit that same gap on the backend in August (§1b).
const app = readFileSync(new URL('../../../frontend/app.js', import.meta.url), 'utf8');
const grab = (n) => {
  const i = app.indexOf(`function ${n}(`);
  if (i < 0) throw new Error('missing function ' + n);
  let d = 0, k = app.indexOf('(', i);
  for (; k < app.length; k++) { if (app[k] === '(') d++; else if (app[k] === ')') { d--; if (!d) break; } }
  for (let j = app.indexOf('{', k), b = 0; j < app.length; j++) {
    if (app[j] === '{') b++; else if (app[j] === '}') { b--; if (!b) return app.slice(i, j + 1); }
  }
  throw new Error('unterminated ' + n);
};
const constTo = (n, end) => {
  const i = app.indexOf(`const ${n} =`);
  if (i < 0) throw new Error('missing const ' + n);
  return app.slice(i, app.indexOf(end, i) + end.length);
};

const F = new Function(
  constTo('INCOMPLETE_FIELDS', '};')
  + grab('ruleHasValue') + grab('percentCoversAll') + grab('percentModelsOf')
  + grab('isInternalName') + grab('termModelsOf')
  + 'const entityName = c => String(c.counterParty || "");'
  + grab('fileMismatches')
  + constTo('needsTerms', '));') + '\n'
  + 'return { fileMismatches, needsTerms, ruleHasValue };')();

const gp = p => ({ type: 'percent', rows: [{ model: 'ALL', percent: p }], _t: 'gp' });
const mg = (m, a) => ({ type: 'flat_per_machine', rows: [{ model: m, amount: a }], _t: 'mg' });
// The engine's shape, from evalTieredPercent: rows[] each carrying their own tiers[].
const tier = (...pcts) => ({ type: 'tiered_percent', basis: 'revenue',
  rows: [{ model: 'ALL', tiers: pcts.map((p, i) => ({ from: i * 1000, to: (i + 1) * 1000, percent: p })) }] });

// One complete contract, one one-brand file: the rule and the mode are the only variables, so
// no other gap can confuse the comparison.
const base = { contractId: 'X', merchantName: 'Probe', branchCount: 1, units: { S8: 1 },
  counterParty: 'E Ltd', startDate: '2026-01-01', endDate: '2026-12-31',
  terminationNoticeDays: 30, autoRenewal: 'Yes', bankName: 'B', bankAccountName: 'A',
  bankAccountNumber: '1', financeContactName: 'N', financeContactEmail: 'a@b.c' };
const FILE = { probe: { label: 'Probe', branches: 1, units: { S8: 1 }, merchantNames: ['Probe'] } };

const SHAPES = [
  ['no rule at all',                       { rule: null, aggregationMode: 'whole' },            true],
  ['a rule that pays 0%',                  { rule: gp(0), aggregationMode: 'whole' },           true],
  ['a paying rule and NO aggregation mode',{ rule: gp(30) },                                    true],
  ['a paying rule and a bogus mode',       { rule: gp(30), aggregationMode: 'per-store' },      true],
  ['a paying rule and a real mode',        { rule: gp(30), aggregationMode: 'whole' },           false],
  ['a tiered rule with real percentages',  { rule: tier(10, 20), aggregationMode: 'whole' },     false],
  ['a tiered rule of all zeroes',          { rule: tier(0, 0), aggregationMode: 'whole' },       true],
  ['tiered + per-machine, no mode',        { rule: { type: 'sum', children: [tier(10), mg('S8', 100)] } }, true],
  ['noPayout with nothing set',            { rule: null, noPayout: true },                      false],
  ['archived with nothing set',            { rule: null, archived: true },                      false],
];

for (const [name, patch, blocked] of SHAPES) {
  test(`${name}: all three agree, and agree with the gate`, () => {
    const c = { ...base, ...patch };
    const gate = contractNeedsTerms(c);
    assert.equal(gate, blocked, 'the run gate is the authority and must say this');
    assert.equal(F.needsTerms(c), blocked, 'the Overview grid’s ◆ badge');
    // The sub-page only speaks about brands in the file, and skips archived rows entirely —
    // so for the archived shape it is silent rather than agreeing.
    if (!c.archived) {
      assert.equal(F.fileMismatches([c], FILE).noShareTerms.length > 0, blocked,
        'the Upload page’s "Share terms incomplete" sub-page');
    }
  });
}

test('the frontend keeps ONE definition of a rule that pays, not two', () => {
  assert.ok(!/ruleHasAnyValue\s*\(/.test(app),
    'a second copy of ruleHasValue is a second answer to the question the backend already decides');
  // And it reads the same shape the engine evaluates.
  const t = tier(10);
  assert.equal(F.ruleHasValue(t), true, 'a tiered rule with a percentage pays');
  assert.equal(backendRuleHasValue(t), true);
  assert.equal(F.ruleHasValue(tier(0)), false, 'and one with none does not');
  assert.equal(backendRuleHasValue(tier(0)), false);
});

test('needsTerms reads the aggregation mode, not only the rule', () => {
  const i = app.indexOf('const needsTerms =');
  const src = app.slice(i, app.indexOf(';', app.indexOf('aggregationMode', i)));
  assert.match(src, /whole/);
  assert.match(src, /per_store/);
});

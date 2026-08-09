import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { ruleHasValue, contractNeedsTerms, indexContractsByName, resolveLabel } from '../code/payout.mjs';

const pct = p => ({ type: 'percent', rows: [{ model: 'ALL', percent: p }] });
const mg  = a => ({ type: 'flat_per_machine', rows: [{ model: 'S8', amount: a }] });

test('ruleHasValue: a non-zero percent pays', () => {
  assert.equal(ruleHasValue(pct(50)), true);
});

test('ruleHasValue: a bare 0% does NOT pay — this is the 39-partner case', () => {
  assert.equal(ruleHasValue(pct(0)), false);
});

test('ruleHasValue: null and empty shapes do not pay', () => {
  assert.equal(ruleHasValue(null), false);
  assert.equal(ruleHasValue({ type: 'sum', children: [] }), false);
  assert.equal(ruleHasValue({}), false);
});

test('ruleHasValue: flat leaves', () => {
  assert.equal(ruleHasValue(mg(200)), true);
  assert.equal(ruleHasValue(mg(0)), false);
  assert.equal(ruleHasValue({ type: 'flat_per_partner_total', amount: 900 }), true);
  assert.equal(ruleHasValue({ type: 'flat_per_partner_total', amount: 0 }), false);
});

test('ruleHasValue: recurses through combinators', () => {
  assert.equal(ruleHasValue({ type: 'sum', children: [pct(0), mg(200)] }), true);
  assert.equal(ruleHasValue({ type: 'max', children: [pct(0), mg(0)] }), false);
  assert.equal(ruleHasValue({ type: 'sum', children: [{ type: 'max', children: [pct(25)] }] }), true);
});

test('ruleHasValue: tiered_percent', () => {
  assert.equal(ruleHasValue({ type: 'tiered_percent', rows: [{ tiers: [{ percent: 15 }] }] }), true);
  assert.equal(ruleHasValue({ type: 'tiered_percent', rows: [{ tiers: [{ percent: 0 }] }] }), false);
});

test('contractNeedsTerms: noPayout never needs terms', () => {
  assert.equal(contractNeedsTerms({ noPayout: true, rule: null }), false);
  assert.equal(contractNeedsTerms({ noPayout: true, rule: pct(50) }), false);
});

test('contractNeedsTerms: no rule, or a rule that pays nothing, needs terms', () => {
  assert.equal(contractNeedsTerms({ rule: null }), true);
  assert.equal(contractNeedsTerms({ rule: pct(0) }), true);
  assert.equal(contractNeedsTerms({ rule: { type: 'sum', children: [] } }), true);
});

// The readiness gate (contractNeedsTerms) must agree with the run-time gate (payoutDecision
// in bulk-runs.mjs) on aggregationMode, or a contract can clear step 3 and still be skipped
// silently when the run actually executes — the 73-live-contract bug fixed 2026-08-09.
test('contractNeedsTerms: a paying rule with no aggregationMode still needs terms', () => {
  assert.equal(contractNeedsTerms({ rule: pct(50) }), true);
  assert.equal(contractNeedsTerms({ rule: pct(50), aggregationMode: null }), true);
  assert.equal(contractNeedsTerms({ rule: pct(50), aggregationMode: 'bogus' }), true);
});

test('contractNeedsTerms: a paying rule with a valid aggregationMode needs nothing', () => {
  assert.equal(contractNeedsTerms({ rule: pct(50), aggregationMode: 'whole' }), false);
  assert.equal(contractNeedsTerms({ rule: pct(50), aggregationMode: 'per_store' }), false);
});

test('contractNeedsTerms: noPayout never needs terms even with a bogus aggregationMode', () => {
  assert.equal(contractNeedsTerms({ noPayout: true, rule: pct(50), aggregationMode: 'bogus' }), false);
});

test('indexContractsByName / resolveLabel match case- and space-insensitively', () => {
  const idx = indexContractsByName([
    { contractId: 'c1', merchantName: 'BIG-C' },
    { contractId: 'c2', merchantName: '  7-Eleven ' },
  ]);
  assert.equal(resolveLabel(idx, 'big-c').contractId, 'c1');
  assert.equal(resolveLabel(idx, '  7-ELEVEN  ').contractId, 'c2');
  assert.equal(resolveLabel(idx, 'Big C'), null);   // punctuation still matters
  assert.equal(resolveLabel(idx, ''), null);
  assert.equal(resolveLabel(idx, null), null);
});

test('indexContractsByName: later duplicates do not silently win', () => {
  const idx = indexContractsByName([
    { contractId: 'c1', merchantName: 'IMPACT' },
    { contractId: 'c2', merchantName: 'impact' },
  ]);
  assert.equal(resolveLabel(idx, 'IMPACT').contractId, 'c1');   // first wins, deterministically
});

test('indexContractsByName: skips null/undefined holes without throwing', () => {
  const idx = indexContractsByName([
    { contractId: 'c1', merchantName: 'A' },
    null,
    undefined,
    { contractId: 'c2', merchantName: 'B' },
  ]);
  assert.equal(resolveLabel(idx, 'A').contractId, 'c1');
  assert.equal(resolveLabel(idx, 'B').contractId, 'c2');
});

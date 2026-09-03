import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRosterRows, payoutDecision } from '../code/routes/bulk-runs.mjs';
import { evaluateRun } from '../code/engine.mjs';

const roster = [
  { merchantId: 'mA', name: 'Store A', nameLower: 'store a', contractId: 'c1', model: 'S8' },
  { merchantId: 'mB', name: 'Store B', nameLower: 'store b', contractId: 'c1', model: 'S8' },
  { merchantId: 'mC', name: 'Store C', nameLower: 'store c', contractId: 'c2', model: 'S5' },
];
const orders = [
  { merchantName: 'Store A', netAmount: 100 },
  { merchantName: 'Store A', netAmount: 50 },
  { merchantName: 'Ghost Store', netAmount: 9 },
];

test('every roster machine becomes a row; order-less rows are 0; contracts grouped', () => {
  const { groups } = buildRosterRows(roster, orders);
  const a = groups['c1'].find(r => r.merchantId === 'mA');
  const b = groups['c1'].find(r => r.merchantId === 'mB');
  assert.equal(a.rentals, 2); assert.equal(a.revenue, 150);
  assert.equal(b.rentals, 0); assert.equal(b.revenue, 0);   // order-less but present
  assert.equal(groups['c2'][0].merchantId, 'mC');
  assert.equal(groups['c2'][0].rentals, 0);
});

test('orders not in roster are unmatched, not paid', () => {
  const { unmatched, unmatchedOrderCount, unmatchedRevenue } = buildRosterRows(roster, orders);
  assert.deepEqual(unmatched, ['Ghost Store']);
  assert.equal(unmatchedOrderCount, 1);
  assert.equal(unmatchedRevenue, 9);
});

test('order-less machine still earns placement (flat_per_machine) via the engine', () => {
  const rule = { type: 'flat_per_machine', rows: [{ model: 'S8', amount: 100 }] };
  const { groups } = buildRosterRows(
    [ { merchantId: 'mA', name: 'A', nameLower: 'a', contractId: 'c1', model: 'S8' },
      { merchantId: 'mB', name: 'B', nameLower: 'b', contractId: 'c1', model: 'S8' } ],
    [ { merchantName: 'A', netAmount: 100 } ]   // only A has orders
  );
  const rows = groups['c1'].map(m => ({ storeId: m.merchantId, machineSerial: m.merchantId, model: m.model, rentals: m.rentals, revenue: m.revenue }));
  const res = evaluateRun({ rule, rows, aggregationMode: 'per_store', allowedModels: new Set(['S8']) });
  assert.equal(res.totalPayout, 200);   // both machines paid 100 each, incl. order-less B
});

test('buildRosterRows groups by contractId, not partnerId', () => {
  const roster = [
    { merchantId: 'm1', name: 'Store A', nameLower: 'store a', contractId: 'c1', model: 'S8' },
    { merchantId: 'm2', name: 'Store B', nameLower: 'store b', contractId: 'c1', model: 'S5' },
    { merchantId: 'm3', name: 'Store C', nameLower: 'store c', contractId: 'c2', model: 'S8' },
  ];
  const { groups } = buildRosterRows(roster, []);
  assert.deepEqual(Object.keys(groups).sort(), ['c1', 'c2']);
  assert.equal(groups.c1.length, 2);
  assert.equal(groups.c2.length, 1);
});

// This exercises the `if (!m.contractId) continue` guard directly, but that guard is not a
// live path in production: applyMerchantRoster gives every unresolvable roster label a noPayout
// stub contract — in memory only since 2026-09-03, but still assigned, so no real roster row
// reaches buildRosterRows without a
// contractId. It's defence in depth for a caller that skips applyMerchantRoster (e.g. this
// test). It does NOT model "the 436 case" (brands with no CONTRACT before a roster upload) —
// those get a contractId assigned during applyMerchantRoster and are skipped-but-matched at
// payout time instead (see payoutDecision + the `skipped` list in createBulkRunRoute).
test('buildRosterRows: defensive guard drops a contractId-less row without throwing', () => {
  const roster = [
    { merchantId: 'm1', name: 'Store A', nameLower: 'store a', contractId: 'c1', model: 'S8' },
    { merchantId: 'm2', name: 'Orphan',  nameLower: 'orphan',  contractId: null, model: 'S8' },
  ];
  const { groups } = buildRosterRows(roster, []);
  assert.deepEqual(Object.keys(groups), ['c1']);
  assert.equal(groups.c1.length, 1);
});

test('buildRosterRows still overlays orders by store name and reports unmatched', () => {
  const roster = [{ merchantId: 'm1', name: 'Store A', nameLower: 'store a', contractId: 'c1', model: 'S8' }];
  const { groups, unmatched, unmatchedOrderCount } = buildRosterRows(roster, [
    { merchantName: 'Store A', netAmount: 100 },
    { merchantName: 'Store A', netAmount: 50 },
    { merchantName: 'Nowhere', netAmount: 999 },
  ]);
  assert.equal(groups.c1[0].rentals, 2);
  assert.equal(groups.c1[0].revenue, 150);
  assert.deepEqual(unmatched, ['Nowhere']);
  assert.equal(unmatchedOrderCount, 1);
});

// payoutDecision — the pure, testable form of "is this contract paid, and why not if not."
// Ordering matters: missing contract -> warn; noPayout -> skip silently; a rule that pays
// nothing -> skip with warning; an invalid aggregationMode -> skip with warning; else pay.

test('payoutDecision: missing contract is skipped with a warning', () => {
  const d = payoutDecision(null, 'c-missing');
  assert.equal(d.pay, false);
  assert.match(d.warning, /c-missing/);
});

test('payoutDecision: missing contract names the brand when a sample name is available, instead of a bare ULID', () => {
  const d = payoutDecision(null, 'c-missing', 'Ghost Brand');
  assert.equal(d.pay, false);
  assert.match(d.warning, /Ghost Brand/);
});

// Archived is checked before everything except a missing contract: a merchant whose contract
// has ended is not paid whatever its rule still says. It warns (unlike noPayout) because a
// roster that still lists it means machines are live under an ended contract.
test('payoutDecision: an archived merchant is skipped with a warning, even with a paying rule', () => {
  const d = payoutDecision(
    { contractId: 'c1', merchantName: 'Ended Co', archived: true, rule: { type: 'percent', rows: [{ model: 'ALL', percent: 50 }] }, aggregationMode: 'whole' },
    'c1');
  assert.equal(d.pay, false);
  assert.match(d.warning, /Ended Co/);
  assert.match(d.warning, /archived/);
});

test('payoutDecision: noPayout with no rule is skipped silently, no warning', () => {
  const d = payoutDecision({ contractId: 'c1', merchantName: 'A', noPayout: true, rule: null, aggregationMode: 'per_store' }, 'c1');
  assert.equal(d.pay, false);
  assert.equal(d.warning, undefined);
});

test('payoutDecision: a rule that pays nothing is skipped with a warning naming the merchant', () => {
  const d = payoutDecision({ contractId: 'c1', merchantName: 'A', noPayout: false, rule: { type: 'percent', rows: [{ percent: 0 }] }, aggregationMode: 'per_store' }, 'c1');
  assert.equal(d.pay, false);
  assert.match(d.warning, /A/);
});

test('payoutDecision: a paying rule with per_store aggregation is paid', () => {
  const d = payoutDecision({ contractId: 'c1', merchantName: 'A', noPayout: false, rule: { type: 'percent', rows: [{ percent: 50 }] }, aggregationMode: 'per_store' }, 'c1');
  assert.equal(d.pay, true);
});

test('payoutDecision: a paying rule with no aggregationMode is skipped with a warning naming the mode', () => {
  const d = payoutDecision({ contractId: 'c1', merchantName: 'A', noPayout: false, rule: { type: 'percent', rows: [{ percent: 50 }] } }, 'c1');
  assert.equal(d.pay, false);
  assert.match(d.warning, /unset/);
});

test('payoutDecision: a paying rule with whole aggregation is paid', () => {
  const d = payoutDecision({ contractId: 'c1', merchantName: 'A', noPayout: false, rule: { type: 'percent', rows: [{ percent: 50 }] }, aggregationMode: 'whole' }, 'c1');
  assert.equal(d.pay, true);
});

test('payoutDecision: noPayout wins over a 0% rule — no warning', () => {
  const d = payoutDecision({ contractId: 'c1', merchantName: 'A', noPayout: true, rule: { type: 'percent', rows: [{ percent: 0 }] }, aggregationMode: 'per_store' }, 'c1');
  assert.equal(d.pay, false);
  assert.equal(d.warning, undefined);
});

// ── Two-pass order matching (2026-08-24) ───────────────────────────────────
// The order report identifies a store only by its NAME, so when the platform renames a store
// in one export and not the other the join breaks and the revenue is paid to nobody. Real
// case: "รถไฟฟ้ามหานคร สถานีมีนบุรี" in the merchant list vs "รถไฟฟ้ามหานคร สถานีตลาดมีนบุรี"
// in the order report — same store, same Business ID, tagged BTS, 180 THB unmatched.
// The order report DOES carry a machine number, and the Machine List maps machine -> Business
// ID, so pass 2 resolves the leftovers by machine when that file is supplied.
const rosterIds = [
  { merchantId: 'mA', name: 'Store A', nameLower: 'store a', contractId: 'c1', model: 'S8', externalId: 'BIZ-A' },
  { merchantId: 'mB', name: 'Renamed Store', nameLower: 'renamed store', contractId: 'c2', model: 'S8', externalId: 'BIZ-B' },
];
const machineIndex = { '1001': 'BIZ-A', '2002': 'BIZ-B' };

test('pass 1 still matches by name, and takes precedence over the machine index', () => {
  const { groups, unmatched } = buildRosterRows(rosterIds,
    [{ merchantName: 'Store A', netAmount: 100, machineNo: '2002' }], machineIndex);
  assert.deepEqual(unmatched, []);
  assert.equal(groups['c1'][0].revenue, 100);      // name won; the machine hint did not move it
  assert.equal(groups['c2'][0].revenue, 0);
});

test('pass 2 recovers an order whose store was renamed, via machine -> Business ID', () => {
  const { groups, unmatched, unmatchedRevenue } = buildRosterRows(rosterIds,
    [{ merchantName: 'Store Renamed In The Other Export', netAmount: 180, machineNo: '2002' }], machineIndex);
  assert.deepEqual(unmatched, []);
  assert.equal(unmatchedRevenue, 0);
  assert.equal(groups['c2'][0].revenue, 180);
  assert.equal(groups['c2'][0].rentals, 1);
});

test('pass 2 reports what it recovered, so a rename is visible and not silently absorbed', () => {
  const { matchedByMachine } = buildRosterRows(rosterIds,
    [{ merchantName: 'Wrong Name', netAmount: 180, machineNo: '2002' }], machineIndex);
  assert.deepEqual(matchedByMachine, [{ orderName: 'Wrong Name', rosterName: 'Renamed Store', orders: 1, revenue: 180 }]);
});

test('an unknown machine stays unmatched rather than being guessed at', () => {
  const { unmatched, unmatchedRevenue, matchedByMachine } = buildRosterRows(rosterIds,
    [{ merchantName: 'Ghost', netAmount: 9, machineNo: '9999' }], machineIndex);
  assert.deepEqual(unmatched, ['Ghost']);
  assert.equal(unmatchedRevenue, 9);
  assert.deepEqual(matchedByMachine, []);
});

test('with no machine index supplied the behaviour is exactly as before', () => {
  const { unmatched, unmatchedRevenue, matchedByMachine } = buildRosterRows(rosterIds,
    [{ merchantName: 'Wrong Name', netAmount: 180, machineNo: '2002' }]);
  assert.deepEqual(unmatched, ['Wrong Name']);
  assert.equal(unmatchedRevenue, 180);
  assert.deepEqual(matchedByMachine, []);
});

test('a machine whose Business ID is not in the roster does not match', () => {
  const { unmatched } = buildRosterRows(rosterIds,
    [{ merchantName: 'Ghost', netAmount: 9, machineNo: '3003' }], { '3003': 'BIZ-UNKNOWN' });
  assert.deepEqual(unmatched, ['Ghost']);
});

// ── Per-store unmatched detail (2026-08-24) ────────────────────────────────
// A run used to record `unmatched` as a flat list of names plus one revenue total. When the
// July run showed 165 unmatched orders worth 5,590 THB there was no way to tell how much
// belonged to any one store — so "how much is this BTS store losing?" was unanswerable from
// stored data. Keep the per-name breakdown.
test('unmatchedDetail reports orders and revenue per unmatched store name', () => {
  const { unmatchedDetail } = buildRosterRows(roster, [
    { merchantName: 'Ghost Store', netAmount: 10 },
    { merchantName: 'Ghost Store', netAmount: 15 },
    { merchantName: 'Other Ghost', netAmount: 40 },
    { merchantName: 'Store A', netAmount: 99 },
  ]);
  assert.deepEqual(unmatchedDetail, [
    { name: 'Other Ghost', orders: 1, revenue: 40 },
    { name: 'Ghost Store', orders: 2, revenue: 25 },
  ]);
});

test('unmatchedDetail totals agree with the flat unmatched figures', () => {
  const orders = [
    { merchantName: 'G1', netAmount: 10 }, { merchantName: 'G2', netAmount: 15 },
    { merchantName: 'G1', netAmount: 5 },
  ];
  const r = buildRosterRows(roster, orders);
  assert.equal(r.unmatchedDetail.reduce((a, u) => a + u.orders, 0), r.unmatchedOrderCount);
  assert.equal(r.unmatchedDetail.reduce((a, u) => a + u.revenue, 0), r.unmatchedRevenue);
  assert.deepEqual(r.unmatchedDetail.map(u => u.name).sort(), [...r.unmatched].sort());
});

test('unmatchedDetail is empty when everything matches', () => {
  assert.deepEqual(buildRosterRows(roster, [{ merchantName: 'Store A', netAmount: 1 }]).unmatchedDetail, []);
});

// ── Pass 3: explicit aliases ───────────────────────────────────────────────
const aliasIndex = new Map([['orphan store', { contractId: 'c2', machineModel: 'S5' }]]);

test('an assigned name becomes a NEW store row of that merchant', () => {
  const { groups, unmatched } = buildRosterRows(rosterIds,
    [{ merchantName: 'Orphan Store', netAmount: 50 }, { merchantName: 'Orphan Store', netAmount: 30 }],
    null, aliasIndex);
  assert.deepEqual(unmatched, []);
  const added = groups['c2'].find(r => r.merchantName === 'Orphan Store');
  assert.ok(added, 'a store row was added to the assigned contract');
  assert.equal(added.model, 'S5');
  assert.equal(added.rentals, 2);
  assert.equal(added.revenue, 80);
  assert.equal(groups['c2'].length, 2, 'it is an ADDITIONAL store, not merged into an existing one');
});

test('an alias with no matching orders creates no store row at all', () => {
  // Otherwise a merchant on flat_per_machine would be paid placement for a machine that
  // produced nothing, purely because a name was once assigned.
  const { groups } = buildRosterRows(rosterIds, [{ merchantName: 'Store A', netAmount: 1 }], null, aliasIndex);
  assert.equal(groups['c2'].length, 1);
});

test('the machine-number pass wins over an alias, so a store is never counted twice', () => {
  // If the machine proves the store is already in the roster, merge into it rather than
  // inventing a second store row for the same physical machine.
  const idx = new Map([['renamed store elsewhere', { contractId: 'c1', machineModel: 'S5' }]]);
  const { groups } = buildRosterRows(rosterIds,
    [{ merchantName: 'Renamed Store Elsewhere', netAmount: 180, machineNo: '2002' }],
    { '2002': 'BIZ-B' }, idx);
  assert.equal(groups['c2'][0].revenue, 180, 'merged into the real store via machine number');
  assert.equal(groups['c1'].length, 1, 'no synthetic row was added to the aliased contract');
});

test('aliases are reported so the run shows what was assigned', () => {
  const { matchedByAlias } = buildRosterRows(rosterIds,
    [{ merchantName: 'Orphan Store', netAmount: 50 }], null, aliasIndex);
  assert.deepEqual(matchedByAlias, [{ name: 'Orphan Store', contractId: 'c2', orders: 1, revenue: 50 }]);
});

test('an alias works for a contract with no roster stores at all (the "+ Add merchant" case)', () => {
  // A merchant created from the unmatched list has no stores in the roster, so its group does
  // not exist yet. Without this the assignment would silently do nothing.
  const idx = new Map([['brand new place', { contractId: 'cNEW', machineModel: 'T10' }]]);
  const { groups, unmatched } = buildRosterRows(rosterIds,
    [{ merchantName: 'Brand New Place', netAmount: 70 }], null, idx);
  assert.deepEqual(unmatched, []);
  assert.equal(groups['cNEW'].length, 1);
  assert.equal(groups['cNEW'][0].revenue, 70);
  assert.equal(groups['cNEW'][0].model, 'T10');
});

// ── Unit counts from the roster (2026-08-27) ──────────────────────────────
// The Merchant view's machine counts were hand-typed and drifted. The roster says what is
// actually deployed, so a run refreshes them. It counts ROSTER ROWS per model, which is the
// same thing the payout counts: evalFlatPerMachine sums one per roster row, and the user
// confirmed (2026-08-27) that a minimum guarantee is per station, not per cabinet — so a BTS
// station with four machines is one unit here, exactly as it is one unit in the payout.
import { rosterUnitCounts, unitsChanged } from '../code/routes/bulk-runs.mjs';

test('counts roster rows per model, per contract', () => {
  const counts = rosterUnitCounts([
    { contractId: 'c1', model: 'S5' }, { contractId: 'c1', model: 'S5' }, { contractId: 'c1', model: 'S8' },
    { contractId: 'c2', model: 'L20' },
  ]);
  assert.deepEqual(counts.get('c1'), { S5: 2, S8: 1 });
  assert.deepEqual(counts.get('c2'), { L20: 1 });
});

test('rows with no model are counted in the total but not against any model', () => {
  // A roster row whose device type did not parse still represents a deployed store; dropping
  // it would make the Units total disagree with the number of stores in the run.
  const counts = rosterUnitCounts([{ contractId: 'c1', model: null }, { contractId: 'c1', model: 'S5' }]);
  assert.deepEqual(counts.get('c1'), { S5: 1 });
  assert.equal(counts.get('c1')._total, undefined, 'the model map holds models only');
});

test('a contract with no roster rows gets no entry, so its stored units are left alone', () => {
  const counts = rosterUnitCounts([{ contractId: 'c1', model: 'S5' }]);
  assert.equal(counts.has('c2'), false);
});

test('unitsChanged reports only contracts whose counts actually differ', () => {
  const contracts = [
    { contractId: 'c1', units: { S5: 2, S8: 1 }, installedUnits: 3 },   // unchanged
    { contractId: 'c2', units: { S5: 1 }, installedUnits: 1 },          // S5 1 -> 2
    { contractId: 'c3', units: {}, installedUnits: null },              // newly counted
  ];
  const counts = new Map([['c1', { S5: 2, S8: 1 }], ['c2', { S5: 2 }], ['c3', { L20: 4 }]]);
  const changed = unitsChanged(contracts, counts);
  assert.deepEqual(changed.map(c => c.contractId).sort(), ['c2', 'c3']);
  const c2 = changed.find(c => c.contractId === 'c2');
  assert.deepEqual(c2.units, { S5: 2 });
  assert.equal(c2.installedUnits, 2, 'installedUnits follows the counted total');
});

test('unitsChanged ignores key order, so a re-run reports nothing', () => {
  // DynamoDB does not preserve map key order; comparing with JSON.stringify would report a
  // phantom change on every run, exactly as it did for the merchant-sheet importer.
  const contracts = [{ contractId: 'c1', units: { S8: 1, S5: 2 }, installedUnits: 3 }];
  assert.deepEqual(unitsChanged(contracts, new Map([['c1', { S5: 2, S8: 1 }]])), []);
});

// ── "In the roster, but not Approved" (2026-08-27) ────────────────────────
// The roster upload keeps Approved rows only, so a Disapproved store that is still taking
// rentals lands in `unmatched` looking exactly like a store nobody has ever heard of. They are
// very different things: one is an unknown name, the other is a machine the platform knows
// about, earning money, excluded by a review flag. In July that was 6 stores and 910 THB — 17%
// of the run's unmatched revenue — including two live 7-Eleven branches and a Lawson.
import { annotateUnmatched } from '../code/routes/bulk-runs.mjs';

const excluded = [
  { name: '1110 - 7-Eleven Phahon 55', label: '7-Eleven', reviewState: 'Disapproved' },
  { name: 'Novotel Phuket', label: 'Novotel', reviewState: 'Pending' },
];

test('an unmatched name that is a non-approved roster row is labelled as such', () => {
  const out = annotateUnmatched(
    [{ name: '1110 - 7-Eleven Phahon 55', orders: 2, revenue: 100 }, { name: 'Who Knows', orders: 1, revenue: 40 }],
    excluded);
  const [seven, unknown] = out;
  assert.equal(seven.reviewState, 'Disapproved');
  assert.equal(seven.label, '7-Eleven', 'the brand it would have been paid under');
  assert.equal(unknown.reviewState, undefined, 'a genuinely unknown name stays unannotated');
});

test('matching ignores case and surrounding space', () => {
  const [row] = annotateUnmatched([{ name: '  NOVOTEL PHUKET ', orders: 1, revenue: 10 }], excluded);
  assert.equal(row.reviewState, 'Pending');
});

test('no excluded list supplied leaves every row untouched', () => {
  // Older frontends do not send it; the run must still work and simply not classify.
  const rows = [{ name: 'x', orders: 1, revenue: 5 }];
  assert.deepEqual(annotateUnmatched(rows, undefined), rows);
  assert.deepEqual(annotateUnmatched(rows, []), rows);
});

test('the run can total what the review flag is costing', () => {
  const out = annotateUnmatched(
    [{ name: '1110 - 7-Eleven Phahon 55', orders: 2, revenue: 100 },
     { name: 'Novotel Phuket', orders: 3, revenue: 630 },
     { name: 'Who Knows', orders: 1, revenue: 40 }], excluded);
  const flagged = out.filter(r => r.reviewState);
  assert.equal(flagged.length, 2);
  assert.equal(flagged.reduce((a, r) => a + r.revenue, 0), 730);
});

// ── A run does not edit the merchant list (user, 2026-09-03) ──────────────────
// The merchant list is curated from the weekly upload on the Merchant view. The platform's
// roster is a run INPUT: a run reads each merchant's terms and writes nothing back. Two
// write-backs used to break that — a contract stub minted for every unresolvable roster label
// (which is how the table reached 341 rows against a curated ~260), and a machine-count
// refresh that overwrote typed `units` with the platform's numbers on every run.
//
// Pinned at the import line because that is the only place it cannot be reintroduced by
// accident: writing a contract from this module requires importing the writer first.
import { readFileSync } from 'node:fs';
const bulkRunsSrc = readFileSync(new URL('../code/routes/bulk-runs.mjs', import.meta.url), 'utf8');

test('bulk-runs never imports a contract writer', () => {
  const importLine = bulkRunsSrc.slice(0, bulkRunsSrc.indexOf('\n'));
  assert.ok(importLine.includes("from '../db.mjs'"), 'expected the db import on line 1');
  assert.ok(!/\bputContract\b/.test(bulkRunsSrc),
    'a run must not write CONTRACT rows — the merchant list is edited on the Merchant view only');
});

// The counts are still COMPUTED, so step 2 can report that the roster disagrees with what a
// merchant stores. Applying them is a deliberate act: infra/refresh-units-from-roster.mjs.
test('unit counts are reported as a difference, not applied', () => {
  assert.ok(/unitsDiffer/.test(bulkRunsSrc), 'prepare should report unitsDiffer');
  assert.ok(!/unitsUpdated/.test(bulkRunsSrc), 'nothing is updated any more — do not call it that');
});

// No payout depends on the stored counts: flat_per_machine and per-machine MG count ROSTER
// ROWS at run time. This is why dropping the refresh changes no money.
test('the engine never reads a contract\'s stored unit counts', () => {
  const engineSrc = readFileSync(new URL('../code/engine.mjs', import.meta.url), 'utf8');
  assert.ok(!/\bunits\b/.test(engineSrc));
  assert.ok(!/installedUnits/.test(engineSrc));
});

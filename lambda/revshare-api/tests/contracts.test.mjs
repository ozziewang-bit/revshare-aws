import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { normalizeContractRow, matchContracts, buildImportPlan } from '../code/contracts.mjs';

// Sheet order: No, Merchant, Type, CounterParty, Units, S5, S8, M10, LL20, LL40,
//              Start, End, Notice, DeclineRenew, AutoRenewal, COC, Mode, Pct,
//              Fixed, Elec, MinGuarantee, V, Link
const row = (over = {}) => {
  const c = new Array(23).fill(null);
  c[1] = 'BITEC'; c[2] = 'Exhibition Center'; c[3] = 'บริษัท ปรินทร จำกัด';
  c[4] = 8; c[6] = 8;
  c[10] = '2025-08-21T00:00:00.000Z'; c[11] = '2026-08-20T00:00:00.000Z';
  c[12] = 30; c[13] = false; c[14] = 'No (Need to contact)';
  c[16] = 'hybrid'; c[17] = 0.2; c[18] = 8800; c[19] = 0; c[20] = 0;
  c[22] = 'https://drive.google.com/drive/folders/1dz';
  for (const [k, v] of Object.entries(over)) c[Number(k)] = v;
  return c;
};

test('normalizeContractRow maps a full row', () => {
  const c = normalizeContractRow(row());
  assert.equal(c.merchantName, 'BITEC');
  assert.equal(c.merchantType, 'Exhibition Center');
  assert.equal(c.counterParty, 'บริษัท ปรินทร จำกัด');
  assert.equal(c.installedUnits, 8);
  assert.equal(c.units.S8, 8);
  assert.equal(c.startDate, '2025-08-21');
  assert.equal(c.endDate, '2026-08-20');
  assert.equal(c.terminationNoticeDays, 30);
  assert.equal(c.declineToRenew, false);
  assert.equal(c.autoRenewal, 'No');   // sheet's "No (Need to contact)" collapses to a plain No
  assert.equal(c.contractLink, 'https://drive.google.com/drive/folders/1dz');
});

test('normalizeContractRow keeps sheet terms separate and never as a rule', () => {
  const c = normalizeContractRow(row());
  assert.equal(c.sheetTerms.shareMode, 'hybrid');
  assert.equal(c.sheetTerms.revSharePct, 0.2);
  assert.equal(c.sheetTerms.fixedRental, 8800);
  assert.equal(c.rule, undefined);
  assert.equal(c.gpPercent, undefined);
});

test('normalizeContractRow returns null when merchant name is blank', () => {
  assert.equal(normalizeContractRow(row({ 1: null })), null);
  assert.equal(normalizeContractRow(row({ 1: '   ' })), null);
});

test('normalizeContractRow normalises LL20/LL40 to L20/L40', () => {
  const c = normalizeContractRow(row({ 8: 4, 9: 3 }));
  assert.equal(c.units.L20, 4);
  assert.equal(c.units.L40, 3);
});

test('normalizeContractRow treats blank numbers as null, not zero', () => {
  const c = normalizeContractRow(row({ 4: null, 12: null }));
  assert.equal(c.installedUnits, null);
  assert.equal(c.terminationNoticeDays, null);
});

test('normalizeContractRow accepts Excel serial dates', () => {
  // 45890 = 2025-08-21 in the 1900 date system
  const c = normalizeContractRow(row({ 10: 45890 }));
  assert.equal(c.startDate, '2025-08-21');
});

test('normalizeContractRow coerces truthy/falsy declineToRenew', () => {
  assert.equal(normalizeContractRow(row({ 13: true })).declineToRenew, true);
  assert.equal(normalizeContractRow(row({ 13: 'TRUE' })).declineToRenew, true);
  assert.equal(normalizeContractRow(row({ 13: false })).declineToRenew, false);
  assert.equal(normalizeContractRow(row({ 13: 'x' })).declineToRenew, false);
  // A blank cell is "not recorded", not false. It used to return false, which made every
  // import rewrite the flag on rows the sheet is silent about (40 of them on a
  // download/edit/upload round trip) and let a sparse duplicate row contribute a false the
  // intra-batch merge could not distinguish from a real one.
  assert.equal(normalizeContractRow(row({ 13: null })).declineToRenew, null);
  assert.equal(normalizeContractRow(row({ 13: '' })).declineToRenew, null);
});

test('normalizeContractRow ignores the three dead columns', () => {
  const c = normalizeContractRow(row({ 0: '#NAME?', 15: 'x', 21: 0 }));
  assert.equal(c.no, undefined);
  assert.equal(c.cocClause, undefined);
  assert.equal(JSON.stringify(c).includes('#NAME?'), false);
});

test('matchContracts links by case-insensitive trimmed name', () => {
  const rows = [
    normalizeContractRow(row({ 1: 'BITEC' })),
    normalizeContractRow(row({ 1: '  7-Eleven ' })),
    normalizeContractRow(row({ 1: 'Big C' })),
  ];
  const partners = [
    { partnerId: 'p1', name: 'bitec' },
    { partnerId: 'p2', name: '7-Eleven' },
    { partnerId: 'p3', name: 'BIG-C' },
  ];
  const { matched, unmatched } = matchContracts(rows, partners);
  assert.equal(matched.length, 2);
  assert.equal(matched.find(m => m.row.merchantName === 'BITEC').partnerId, 'p1');
  assert.equal(matched.find(m => m.row.merchantName === '7-Eleven').partnerId, 'p2');
  assert.equal(unmatched.length, 1);
  assert.equal(unmatched[0].merchantName, 'Big C');   // 'Big C' != 'BIG-C'
});

test('matchContracts handles an empty partner list', () => {
  const { matched, unmatched } = matchContracts([normalizeContractRow(row())], []);
  assert.equal(matched.length, 0);
  assert.equal(unmatched.length, 1);
});

test('normalizeContractRow takes the date part verbatim from a naive datetime string (no offset)', () => {
  const c = normalizeContractRow(row({ 10: '2025-08-21T00:00:00' }));
  assert.equal(c.startDate, '2025-08-21');
});

test('normalizeContractRow takes the date part verbatim from a Z-suffixed datetime string', () => {
  const c = normalizeContractRow(row({ 10: '2025-08-21T00:00:00.000Z' }));
  assert.equal(c.startDate, '2025-08-21');
});

test('normalizeContractRow takes a date-only string as-is', () => {
  const c = normalizeContractRow(row({ 10: '2025-08-21' }));
  assert.equal(c.startDate, '2025-08-21');
});

test('normalizeContractRow returns null for an unparseable date string', () => {
  const c = normalizeContractRow(row({ 10: 'not a date' }));
  assert.equal(c.startDate, null);
});

const mk = (name, over = {}) => ({
  merchantName: name, merchantType: null, counterParty: null, installedUnits: null,
  units: {}, startDate: null, endDate: null, terminationNoticeDays: null,
  declineToRenew: false, autoRenewal: null, contractLink: null,
  sheetTerms: { shareMode: 'hybrid', revSharePct: 0.5, fixedRental: 0, electricity: 0, minGuarantee: 0 },
  ...over,
});

test('buildImportPlan creates contracts for new merchants', () => {
  const plan = buildImportPlan([mk('BITEC')], [], [{ partnerId: 'p1', name: 'BITEC' }], {});
  assert.equal(plan.creates.length, 1);
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.creates[0].merchantName, 'BITEC');
  assert.equal(plan.creates[0].partnerId, 'p1');
});

test('buildImportPlan updates an existing contract in place, keeping its id', () => {
  const existing = [{ contractId: 'c1', merchantNameLower: 'bitec', merchantName: 'BITEC', notes: 'keep me' }];
  const plan = buildImportPlan([mk('BITEC', { counterParty: 'Prinn Co' })], existing, [], {});
  assert.equal(plan.creates.length, 0);
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].contractId, 'c1');
  assert.equal(plan.updates[0].counterParty, 'Prinn Co');
  assert.equal(plan.updates[0].notes, 'keep me');   // fields not in the sheet survive
});

test('buildImportPlan NEVER emits rule or share-term fields', () => {
  const plan = buildImportPlan([mk('7-Eleven')], [], [{ partnerId: 'p2', name: '7-Eleven' }], {});
  const written = JSON.stringify(plan.creates[0]);
  for (const k of ['rule', 'sheetTerms', 'shareMode', 'revSharePct', 'fixedRental', 'minGuarantee',
                   'gpPercent', 'electricity', 'mgRows', 'aggregationMode']) {
    assert.equal(written.includes(k), false, `import must not write ${k}`);
  }
});

test('buildImportPlan NEVER emits rule or share-term fields on the update path', () => {
  const existing = [{ contractId: 'c2', merchantNameLower: '7-eleven', merchantName: '7-Eleven' }];
  const plan = buildImportPlan([mk('7-Eleven')], existing, [{ partnerId: 'p2', name: '7-Eleven' }], {});
  const written = JSON.stringify(plan.updates[0]);
  for (const k of ['rule', 'sheetTerms', 'shareMode', 'revSharePct', 'fixedRental', 'minGuarantee',
                   'gpPercent', 'electricity', 'mgRows', 'aggregationMode']) {
    assert.equal(written.includes(k), false, `import must not write ${k}`);
  }
});

test('buildImportPlan preserves an existing manual partnerId when the name no longer auto-matches and no override is given', () => {
  // e.g. a contract linked earlier to a partner whose name has since drifted, or whose
  // partner was archived (archived partners are excluded from `partners` entirely) —
  // re-importing must not silently null out the link just because this pass can't
  // independently re-derive it.
  const existing = [{ contractId: 'c9', merchantNameLower: 'big c', merchantName: 'Big C', partnerId: 'p-manual' }];
  const plan = buildImportPlan([mk('Big C')], existing, [], {});
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].partnerId, 'p-manual');
});

test('buildImportPlan lets an explicit override win over a preserved existing partnerId', () => {
  const existing = [{ contractId: 'c9', merchantNameLower: 'big c', merchantName: 'Big C', partnerId: 'p-manual' }];
  const plan = buildImportPlan([mk('Big C')], existing, [{ partnerId: 'p3', name: 'BIG-C' }],
                               { 'big c': 'p3' });
  assert.equal(plan.updates[0].partnerId, 'p3');
});

test('buildImportPlan merges intra-batch duplicate rows into a single create', () => {
  const plan = buildImportPlan(
    [mk('IMPACT', { counterParty: 'First Co' }), mk('IMPACT', { counterParty: 'Second Co' })],
    [], [], {}
  );
  assert.equal(plan.creates.length, 1);
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.creates[0].counterParty, 'Second Co');   // later row in the same batch wins
});

test('buildImportPlan merges intra-batch duplicate rows against an existing contract into a single update', () => {
  const existing = [{ contractId: 'c3', merchantNameLower: 'impact', merchantName: 'IMPACT' }];
  const plan = buildImportPlan(
    [mk('IMPACT', { counterParty: 'First Co' }), mk('IMPACT', { counterParty: 'Second Co' })],
    existing, [], {}
  );
  assert.equal(plan.creates.length, 0);
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].contractId, 'c3');
  assert.equal(plan.updates[0].counterParty, 'Second Co');
});

test('buildImportPlan honours explicit link overrides for unmatched names', () => {
  const plan = buildImportPlan([mk('Big C')], [], [{ partnerId: 'p3', name: 'BIG-C' }],
                               { 'big c': 'p3' });
  assert.equal(plan.creates[0].partnerId, 'p3');
  assert.equal(plan.unmatched.length, 0);
});

test('buildImportPlan reports unmatched names with no override', () => {
  const plan = buildImportPlan([mk('Big C')], [], [{ partnerId: 'p3', name: 'BIG-C' }], {});
  assert.equal(plan.creates[0].partnerId, null);
  assert.deepEqual(plan.unmatched, ['Big C']);
});

test('buildImportPlan skips null rows', () => {
  const plan = buildImportPlan([null, mk('BITEC'), null], [], [], {});
  assert.equal(plan.creates.length, 1);
});

test('normalizeContractRow collapses auto-renewal to a plain Yes/No', () => {
  assert.equal(normalizeContractRow(row({ 14: 'No (Need to contact)' })).autoRenewal, 'No');
  assert.equal(normalizeContractRow(row({ 14: 'Yes' })).autoRenewal, 'Yes');
  assert.equal(normalizeContractRow(row({ 14: '  yes  ' })).autoRenewal, 'Yes');
  assert.equal(normalizeContractRow(row({ 14: null })).autoRenewal, null);
  // An unrecognised value is preserved, not guessed at.
  assert.equal(normalizeContractRow(row({ 14: 'Under review' })).autoRenewal, 'Under review');
});

// A re-import of the merchant sheet must not resurrect an archived merchant or disturb the
// payout fields, none of which the sheet carries. `buildImportPlan` spreads `...existing`
// first, so anything absent from the sheet survives — this pins that, because the sheet is
// re-imported routinely and archiving is the newest of these fields.
test('buildImportPlan preserves archive state and payout fields on re-import', () => {
  const existing = [{
    contractId: 'c1', merchantName: 'BIG-C', merchantNameLower: 'big-c',
    archived: true, archivedAt: '2026-08-10T03:00:00.000Z',
    rule: { type: 'percent', rows: [{ model: 'ALL', percent: 50 }] },
    aggregationMode: 'per_store', noPayout: false, currency: 'THB',
  }];
  const plan = buildImportPlan([mk('BIG-C', { merchantType: 'Shopping Malls', installedUnits: 12 })], existing, [], {});
  assert.equal(plan.creates.length, 0);
  assert.equal(plan.updates.length, 1);
  const u = plan.updates[0];
  assert.equal(u.archived, true);
  assert.equal(u.archivedAt, '2026-08-10T03:00:00.000Z');
  assert.deepEqual(u.rule, { type: 'percent', rows: [{ model: 'ALL', percent: 50 }] });
  assert.equal(u.aggregationMode, 'per_store');
  assert.equal(u.currency, 'THB');
  // ...while the fields the sheet does carry are still applied.
  assert.equal(u.merchantType, 'Shopping Malls');
  assert.equal(u.installedUnits, 12);
  assert.equal('sheetTerms' in u, false);
});

// The workbook contains sparse duplicate rows — a second "Future Rangsit" line carrying only
// the counter party. Before 2026-08-10 the intra-batch merge was a plain Object.assign, so
// those blanks erased the populated row's dates, unit counts and auto-renewal on a real
// import. Later rows may still overwrite, but only where they carry a value.
test('buildImportPlan: a sparse duplicate row does not erase the populated one', () => {
  const full = mk('Future Rangsit', {
    counterParty: 'Rangsit Plaza Company Limited', installedUnits: 5, units: { L40: 5 },
    startDate: '2026-08-01', endDate: '2027-07-31', autoRenewal: 'No', merchantType: 'Shopping Malls',
  });
  const sparse = mk('Future Rangsit', {
    counterParty: 'Future City Leasehold Real Estate Investment Trust',
    installedUnits: null, units: {}, startDate: null, endDate: null, autoRenewal: null,
    merchantType: 'Shopping Malls',
  });
  const plan = buildImportPlan([full, sparse], [], [], {});
  assert.equal(plan.creates.length, 1);
  const c = plan.creates[0];
  // The later row's real value wins...
  assert.equal(c.counterParty, 'Future City Leasehold Real Estate Investment Trust');
  // ...while everything it left blank survives from the populated row.
  assert.equal(c.installedUnits, 5);
  assert.deepEqual(c.units, { L40: 5 });
  assert.equal(c.startDate, '2026-08-01');
  assert.equal(c.endDate, '2027-07-31');
  assert.equal(c.autoRenewal, 'No');
});

// Order still matters when both rows carry a value — this is the IMPACT case, where the two
// sheet lines are both fully populated and the later one is the intended winner.
test('buildImportPlan: a later populated duplicate still wins every field', () => {
  const a = mk('IMPACT', { counterParty: 'Thai name', installedUnits: 6, units: { L40: 6 } });
  const b = mk('IMPACT', { counterParty: 'English name', installedUnits: 1, units: { L40: 1 } });
  const c = buildImportPlan([a, b], [], [], {}).creates[0];
  assert.equal(c.counterParty, 'English name');
  assert.equal(c.installedUnits, 1);
  assert.deepEqual(c.units, { L40: 1 });
});

// The template download puts a filled-in sample row at the top of the sheet so the format is
// visible where you type. Data starts at row 3 and every named row is imported, so there is
// no header trick to hide it — it is skipped by name, and leaving it in place is harmless.
test('normalizeContractRow skips the template example row', () => {
  assert.equal(normalizeContractRow(row({ 1: 'EXAMPLE ROW — safe to leave, it is never imported' })), null);
  assert.equal(normalizeContractRow(row({ 1: 'example row' })), null);
  assert.equal(normalizeContractRow(row({ 1: '  EXAMPLE ROW - anything after  ' })), null);
  // \b keeps the match to the whole first word, so a real merchant is never swallowed.
  assert.equal(normalizeContractRow(row({ 1: 'Example Holdings' })).merchantName, 'Example Holdings');
  assert.equal(normalizeContractRow(row({ 1: 'Examplerow Co' })).merchantName, 'Examplerow Co');
});

test('buildImportPlan ignores the example row entirely', () => {
  const rows = [normalizeContractRow(row({ 1: 'EXAMPLE ROW — delete me' })), mk('Real Merchant')]
    .filter(Boolean);
  const plan = buildImportPlan(rows, [], [], {});
  assert.equal(plan.creates.length, 1);
  assert.equal(plan.creates[0].merchantName, 'Real Merchant');
});

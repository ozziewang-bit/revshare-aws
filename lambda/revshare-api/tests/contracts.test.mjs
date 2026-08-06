import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { CONTRACT_COLUMNS, normalizeContractRow, matchContracts, buildImportPlan } from '../code/contracts.mjs';

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

test('CONTRACT_COLUMNS has 23 entries in sheet order', () => {
  assert.equal(CONTRACT_COLUMNS.length, 23);
  assert.equal(CONTRACT_COLUMNS[1], 'merchantName');
  assert.equal(CONTRACT_COLUMNS[22], 'contractLink');
});

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
  assert.equal(c.autoRenewal, 'No (Need to contact)');
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
  assert.equal(normalizeContractRow(row({ 13: null })).declineToRenew, false);
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
  for (const k of ['rule', 'sheetTerms', 'shareMode', 'revSharePct', 'minGuarantee',
                   'gpPercent', 'electricity', 'mgRows', 'aggregationMode']) {
    assert.equal(written.includes(k), false, `import must not write ${k}`);
  }
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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { brandsFromRoster } from '../code/routes/contracts.mjs';

// ── Branches and machines are what the file says (2026-10-01) ────────────────────────────────
// "please read from the latest file for branch and machine number, if mu files says 5, then it
// is 5."
//
// The grid showed the CONTRACT's stored `branchCount`/`units`, which are only as fresh as the
// last import that happened to touch them. Measured on the 1 Oct upload: the brand `Central` had
// 5 shops in the file and the app said 10 branches / 10 LL40 — a leftover from before that brand
// was split into Central Ladprao, EastVille, Rama 9, World, Chidlom, Pattaya and Pinklao.
//
// Merchant INFORMATION is file-owned and never edited (the user's two-category model, 2026-09-29).
// So the file is the answer wherever it speaks.

// The real shape of a stored roster row, from rosters/01M3TNNWNK…json.
const ROSTER = [
  { name: 'เซ็นทรัลเวสต์เกต ชั้น1', partnerName: 'Central', model: 'LL40', externalId: '1044367414316498944' },
  { name: 'เซ็นทรัลเวสต์เกต ชั้น2', partnerName: 'Central', model: 'LL40', externalId: '1044367662355054592' },
  { name: 'เซ็นทรัลเวสต์เกต ชั้น3', partnerName: 'Central', model: 'LL40', externalId: '1044367901596794880' },
  { name: 'เซ็นทรัลเวสต์เกต ทางเข้าชั้นG', partnerName: 'Central', model: 'LL40', externalId: '1044367107250143232' },
  { name: 'เซ็นทรัลลาดพร้าว ชั้น2 โซนไอที', partnerName: 'Central', model: 'LL40', externalId: '1044058470656983040' },
  { name: 'เซ็นทรัลลาดพร้าว ชั้น 4', partnerName: 'Central Ladprao', model: 'LL40', externalId: 'x1' },
  { name: 'สยาม', partnerName: '7-Eleven', model: 'S8', externalId: 'y1' },
  { name: 'สยาม', partnerName: '7-Eleven', model: 'S5', externalId: 'y2' },  // same shop, 2 stations
];

test('a brand reports the shops the file gives it', () => {
  const b = brandsFromRoster(ROSTER);
  assert.equal(b['central'].branches, 5, 'five shops, which is what the file says');
  assert.deepEqual(b['central'].units, { LL40: 5 });
  assert.equal(b['central'].label, 'Central', 'the label as written, for display');
});

test('the per-mall labels stay their own brands', () => {
  const b = brandsFromRoster(ROSTER);
  assert.equal(b['central ladprao'].branches, 1);
  // Central Ladprao's shop must NOT also be counted under `Central`, or the two double up.
  assert.equal(b['central'].branches + b['central ladprao'].branches, 6);
});

// A roster row is a STATION; a shop can hold several (§1h). Branches count SHOPS, units count
// stations — the unit the payout counts, so the grid and the payout cannot disagree.
test('two stations in one shop is one branch and two units', () => {
  const b = brandsFromRoster(ROSTER);
  assert.equal(b['7-eleven'].branches, 1, 'one shop');
  assert.deepEqual(b['7-eleven'].units, { S8: 1, S5: 1 }, 'two stations');
});

test('a row with no label is skipped, not filed under blank', () => {
  const b = brandsFromRoster([...ROSTER, { name: 'orphan shop', partnerName: '  ', model: 'S8' }]);
  assert.ok(!('' in b) && !(' ' in b));
  assert.equal(Object.keys(b).length, 3);
});

test('cabinets come from the machine list when the upload kept its rows', () => {
  const machines = [
    { store: 'เซ็นทรัลเวสต์เกต ชั้น1', counts: { LL40: 2 } },
    { store: 'เซ็นทรัลเวสต์เกต ชั้น2', counts: { LL40: 1 } },
  ];
  const b = brandsFromRoster(ROSTER, machines);
  // 5 stations, 3 cabinets counted across the 2 shops the machine file covers — different
  // numbers measuring different things, reported separately rather than conflated.
  assert.deepEqual(b['central'].units, { LL40: 5 });
  assert.deepEqual(b['central'].cabinets, { LL40: 3 });
  assert.equal(b['central'].branches, 5);
});

test('with no machine rows, cabinets is null rather than a misleading zero', () => {
  assert.equal(brandsFromRoster(ROSTER).cabinets, undefined);
  assert.equal(brandsFromRoster(ROSTER)['central'].cabinets, null);
  assert.equal(brandsFromRoster(ROSTER, [])['central'].cabinets, null);
});

test('no roster at all is an empty map, not a crash', () => {
  assert.deepEqual(brandsFromRoster(null), {});
  assert.deepEqual(brandsFromRoster(undefined, undefined), {});
});

// ── The grid prefers the file and falls back to what is stored ───────────────────────────────
const app = readFileSync(new URL('../../../frontend/app.js', import.meta.url), 'utf8');
const block = app.slice(app.indexOf('let ROSTER_BRANDS ='),
                        app.indexOf('\n', app.indexOf('const unitsOf =')));
const grid = (brands) => new Function('BRANDS', `
  let ROSTER_BRANDS = { at: '2026-10-01T02:46:13.482Z', brands: BRANDS };
  ${block.replace('let ROSTER_BRANDS = { at: null, by: null, brands: {} };', '')}
  const unitsTotal = c => Object.values(unitsOf(c) || {}).reduce((a, n) => a + (Number(n) || 0), 0);
  return { branchesOf, unitsOf, unitsTotal, fileBrandOf, rosterDateLabel };
`)(brands);

test('the file overrides a stale stored count', () => {
  const g = grid(brandsFromRoster(ROSTER));
  const central = { merchantName: 'Central', branchCount: 10, units: { LL40: 10 }, installedUnits: 10 };
  assert.equal(g.branchesOf(central), 5, 'the file says 5, so it is 5');
  assert.deepEqual(g.unitsOf(central), { LL40: 5 });
  assert.equal(g.unitsTotal(central), 5);
});

test('a brand the file does not mention keeps its stored numbers', () => {
  const g = grid(brandsFromRoster(ROSTER));
  const gone = { merchantName: 'Brand That Left', branchCount: 7, units: { S8: 7 } };
  assert.equal(g.branchesOf(gone), 7, 'nothing is invented, and nothing is blanked');
  assert.deepEqual(g.unitsOf(gone), { S8: 7 });
  assert.equal(g.fileBrandOf(gone), null, 'and it is knowably absent — that row carries ⦿');
});

test('matching ignores case and surrounding space, as the run does', () => {
  const g = grid(brandsFromRoster(ROSTER));
  for (const name of ['central', 'CENTRAL', '  Central  ']) {
    assert.equal(g.branchesOf({ merchantName: name, branchCount: 10 }), 5, name);
  }
});

test('a contract with no name cannot collide with a brand', () => {
  const g = grid(brandsFromRoster(ROSTER));
  assert.equal(g.fileBrandOf({ merchantName: '' }), null);
  assert.equal(g.fileBrandOf({}), null);
  assert.equal(g.fileBrandOf(null), null);
});

test('with no upload on record the grid is exactly as it was', () => {
  const g = grid({});
  const c = { merchantName: 'Central', branchCount: 10, units: { LL40: 10 } };
  assert.equal(g.branchesOf(c), 10);
  assert.deepEqual(g.unitsOf(c), { LL40: 10 });
});

test('the tooltip dates the file the numbers came from', () => {
  assert.equal(grid({}).rosterDateLabel(), '1 Oct');
});

// NOTHING IS WRITTEN. The standing rule: an improvement never overwrites existing data.
test('reading the file does not change a contract', () => {
  const route = readFileSync(new URL('../code/routes/contracts.mjs', import.meta.url), 'utf8');
  const i = route.indexOf('export async function rosterBrandsRoute');
  const fn = route.slice(i, route.indexOf('\n}', i)).replace(/\/\/[^\n]*/g, '');
  assert.ok(!/putContract|putContractsBatch|UpdateCommand|putLastUpload/.test(fn),
            'it is a read');
  const agg = route.slice(route.indexOf('export function brandsFromRoster'),
                          i).replace(/\/\/[^\n]*/g, '');
  assert.ok(!/putContract|UpdateCommand/.test(agg));
});

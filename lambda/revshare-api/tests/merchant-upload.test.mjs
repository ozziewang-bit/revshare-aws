import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// `missingFromUpload` lives in frontend/app.js — it decides which merchants the Merchant view
// marks ⦿ and which the import preview counts under "in your list, not in this file". Extract
// and evaluate it rather than keeping a second copy: an import never deletes, so this function
// is the only thing that makes a merchant dropping off the weekly list visible at all.
const src = readFileSync(new URL('../../../frontend/app.js', import.meta.url), 'utf8');
const grab = (n) => {
  const i = src.indexOf(`function ${n}(`);
  if (i < 0) throw new Error('missing ' + n);
  let d = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
  }
};
const { missingFromUpload } = new Function(
  grab('missingFromUpload') + '\nreturn { missingFromUpload };')();

const CONTRACTS = [
  { contractId: '1', merchantName: '7-Eleven' },
  { contractId: '2', merchantName: 'Baan Ying' },
  { contractId: '3', merchantName: 'BTS' },
  { contractId: '4', merchantName: 'PAKKLONG MARKET', archived: true },
];

test('marks the merchants the file does not mention', () => {
  const out = missingFromUpload(CONTRACTS, ['7-Eleven', 'BTS']);
  assert.deepEqual(out.map(c => c.merchantName), ['Baan Ying']);
});

test('matching ignores case and surrounding space, like the import preview does', () => {
  const out = missingFromUpload(CONTRACTS, ['  7-eleven ', 'bts', 'BAAN YING']);
  assert.deepEqual(out, []);
});

// An ended contract is not expected to appear in a merchant list, and the Merchant view does
// not show it at all — marking it would put a number on that screen with no row behind it.
test('archived contracts are never marked, even when absent', () => {
  const out = missingFromUpload(CONTRACTS, ['7-Eleven']);
  assert.deepEqual(out.map(c => c.merchantName), ['Baan Ying', 'BTS']);
});

// Before the first upload there is no list to be absent from. Marking every merchant then would
// be a screen full of flags that mean nothing.
test('no upload recorded yet marks nothing', () => {
  assert.deepEqual(missingFromUpload(CONTRACTS, null), []);
  assert.deepEqual(missingFromUpload(CONTRACTS, []), []);
});

// A blank cell in the name column must not become a name that everything fails to match.
test('blank names in the file are ignored', () => {
  const out = missingFromUpload(CONTRACTS, ['7-Eleven', '', null, '  ', 'BTS']);
  assert.deepEqual(out.map(c => c.merchantName), ['Baan Ying']);
});

// ── Where the machine list's stores actually land ─────────────────────────────
// The importer maps each store to a merchant through the store registry and writes counts for
// the ones that resolve. It used to `continue` past the rest in silence, so a machine list could
// half-land and look like it fully landed. These are the two distinct ways to miss.
const { matchMachineStores } = new Function(
  grab('matchMachineStores') + '\nreturn { matchMachineStores };')();

const REGISTRY = [
  { name: 'BTS Asok', contractId: 'bts' },
  { name: 'BTS Nana', contractId: 'bts' },
  { name: 'Lawson Silom', contractId: null },   // known shop, belongs to no merchant
];

test('machines are summed per merchant across the stores it owns', () => {
  const byStore = new Map([['BTS Asok', { S8: 2 }], ['BTS Nana', { S8: 1, L40: 3 }]]);
  const { totals, matchedStores, matchedMachines } = matchMachineStores(byStore, REGISTRY);
  assert.deepEqual(totals.get('bts'), { S8: 3, L40: 3 });
  assert.equal(matchedStores, 2);
  assert.equal(matchedMachines, 6);
});

// Two misses that need different fixes: add the shop, versus link the shop to a merchant.
test('an unrecognised store and an unlinked store are reported apart', () => {
  const byStore = new Map([
    ['BTS Asok', { S8: 2 }],
    ['Lawson Silom', { S5: 4 }],        // in the registry, no merchant
    ['Somewhere New', { S5: 1, S8: 1 }],// not in the registry at all
  ]);
  const r = matchMachineStores(byStore, REGISTRY);
  assert.deepEqual(r.unlinked, [{ store: 'Lawson Silom', machines: 4 }]);
  assert.deepEqual(r.unknown, [{ store: 'Somewhere New', machines: 2 }]);
  assert.equal(r.totals.size, 1);
});

// Every store is accounted for exactly once — this is what makes the preview's numbers add up
// to the file's own store count rather than quietly losing some.
test('matched + unknown + unlinked accounts for every store in the file', () => {
  const byStore = new Map([
    ['BTS Asok', { S8: 1 }], ['bts nana', { S8: 1 }],
    ['Lawson Silom', { S5: 1 }], ['Ghost A', { S5: 1 }], ['Ghost B', { S5: 1 }],
  ]);
  const r = matchMachineStores(byStore, REGISTRY);
  assert.equal(r.matchedStores + r.unknown.length + r.unlinked.length, byStore.size);
  assert.equal(r.matchedStores, 2, 'store matching ignores case, as the importer does');
});

test('an empty registry skips everything rather than throwing', () => {
  const r = matchMachineStores(new Map([['A', { S5: 1 }]]), []);
  assert.equal(r.totals.size, 0);
  assert.deepEqual(r.unknown, [{ store: 'A', machines: 1 }]);
});

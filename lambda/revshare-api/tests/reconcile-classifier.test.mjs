import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Fixtures are the real shapes measured on live TH data, 2026-09-18 — not invented ones.
// Central is the case the whole feature exists for: archived AND noPayout AND on the current
// merchant list AND earning, with three live branch rows holding terms no run can reach.
const app = readFileSync(new URL('../../../frontend/app.js', import.meta.url), 'utf8');
const grab = (n) => {
  const i = app.indexOf(`function ${n}(`);
  if (i < 0) throw new Error('missing ' + n);
  let d = 0;
  for (let k = app.indexOf('{', i); k < app.length; k++) {
    if (app[k] === '{') d++; else if (app[k] === '}') { d--; if (!d) return app.slice(i, k + 1); }
  }
};
const { classifyDifferences } = new Function(
  grab('reconcileKey') + '\n' + grab('skippedByName') + '\n' + grab('similarity') + '\n' +
  grab('termSignature') + '\n' +
  grab('classifyDifferences') +
  '\nreturn { classifyDifferences };')();

const { truncatedNameListHtml } = new Function(
  grab('escape') + '\n' + grab('truncatedNameListHtml') +
  '\nreturn { truncatedNameListHtml };')();

const of = (items, type) => items.filter(i => i.type === type);

test('an archived contract still named in the file is the top finding', () => {
  const items = classifyDifferences({
    contracts: [{ contractId: 'c1', merchantName: 'Central', archived: true, noPayout: true }],
    upload: { at: '2026-09-03T07:33:43Z', names: ['Central'] },
    run: { skipped: [{ merchantName: 'Central', revenue: 51495 }] },
    dismissals: [],
  });
  assert.equal(of(items, 'archived-in-file').length, 1);
  assert.equal(of(items, 'archived-in-file')[0].money, 51495);
  assert.deepEqual(of(items, 'archived-in-file')[0].contractIds, ['c1']);
});

test('a file name with no merchant row is reported', () => {
  const items = classifyDifferences({
    contracts: [], upload: { names: ['Jims Burger'] }, run: null, dismissals: [] });
  assert.deepEqual(of(items, 'in-file-no-row').map(i => i.names[0]), ['Jims Burger']);
});

test('a merchant the file does not mention is reported, archived ones are not', () => {
  const items = classifyDifferences({
    contracts: [{ contractId: 'c1', merchantName: 'Somsak' },
                { contractId: 'c2', merchantName: 'PAKKLONG MARKET', archived: true }],
    upload: { names: [] }, run: null, dismissals: [] });
  assert.deepEqual(of(items, 'in-app-not-in-file').map(i => i.names[0]), ['Somsak']);
});

test('names compare the same way the grid marks do, across unicode forms and case', () => {
  const items = classifyDifferences({
    contracts: [{ contractId: 'c1', merchantName: ' GLOW ' }],
    upload: { names: ['glow'] }, run: null, dismissals: [] });
  assert.equal(items.length, 0);
});

test('a dismissal silences exactly its own item', () => {
  const base = { contracts: [{ contractId: 'c1', merchantName: 'Somsak' }],
                 upload: { names: [] }, run: null };
  assert.equal(classifyDifferences({ ...base, dismissals: [] }).length, 1);
  assert.equal(classifyDifferences({ ...base,
    dismissals: [{ type: 'in-app-not-in-file', key: 'somsak' }] }).length, 0);
});

test('a 1:1 near match is proposed as a rename', () => {
  // Real pair: the app has 'Andamanda', the 3 Sep file says 'Andamanda Phuket'.
  const items = classifyDifferences({
    contracts: [{ contractId: 'c1', merchantName: 'Andamanda' }],
    upload: { names: ['Andamanda Phuket'] },
    run: { skipped: [{ merchantName: 'Andamanda Phuket', revenue: 4300 }] }, dismissals: [] });
  const r = items.filter(i => i.type === 'likely-rename');
  assert.equal(r.length, 1);
  assert.deepEqual(r[0].names, ['Andamanda', 'Andamanda Phuket']);
  assert.deepEqual(r[0].contractIds, ['c1']);
  assert.equal(r[0].money, 4300);
});

test('a name matching two merchants is ambiguous, never auto-paired', () => {
  // Two candidates, neither a prefix-with-space of the file name — so this stays a rename
  // question rather than becoming Task 6's brand-with-branches grouping. (The real 'Classic'
  // case, where the app holds 'Classic Camp' AND 'Classic Cafe & Bar Srinakarin', is a BRAND
  // with two branch rows and is classified there instead; see Task 6.)
  const items = classifyDifferences({
    contracts: [{ contractId: 'c1', merchantName: 'DRINK Bar & Restaurant' },
                { contractId: 'c2', merchantName: 'DINK Bar and Restaurant' }],
    upload: { names: ['DINK Bar & Restaurant'] }, run: null, dismissals: [] });
  assert.equal(items.filter(i => i.type === 'likely-rename').length, 0);
  const a = items.filter(i => i.type === 'ambiguous-rename');
  assert.equal(a.length, 1);
  assert.deepEqual(a[0].contractIds.sort(), ['c1', 'c2']);
});

test('a near-identical pair is still only a suggestion', () => {
  // 'DINK Bar & Restaurant' vs 'DRINK Bar & Restaurant' is a TYPO, not a rename — 98% similar.
  // The classifier cannot tell those apart, so it proposes and the human decides. What it must
  // never do is apply it.
  const items = classifyDifferences({
    contracts: [{ contractId: 'c1', merchantName: 'DRINK Bar & Restaurant' }],
    upload: { names: ['DINK Bar & Restaurant'] }, run: null, dismissals: [] });
  const r = items.filter(i => i.type === 'likely-rename');
  assert.equal(r.length, 1, 'one candidate, so it is a suggestion and not an ambiguity');
  assert.ok(!('applied' in r[0]), 'a suggestion is data, never an action already taken');
});

test('unrelated names are not paired', () => {
  const items = classifyDifferences({
    contracts: [{ contractId: 'c1', merchantName: 'Somsak' }],
    upload: { names: ['Jims Burger'] }, run: null, dismissals: [] });
  assert.equal(items.filter(i => i.type.includes('rename')).length, 0);
});

// --- fix round 1: reproductions of the double-report / silent-deletion review finding ---

test('two file names competing for one orphan produce exactly one claim on that contract', () => {
  // Both 'Andamanda Phuket' and 'Andamanda Resort' are, on their own, a confident 1:1 match for
  // the single orphan 'Andamanda'. A first-come-first-served pairing let each become its own
  // likely-rename, reporting contract c1 twice. Only one item may ever carry c1.
  const items = classifyDifferences({
    contracts: [{ contractId: 'c1', merchantName: 'Andamanda' }],
    upload: { names: ['Andamanda Phuket', 'Andamanda Resort'] }, run: null, dismissals: [] });
  assert.equal(items.filter(i => i.type === 'likely-rename').length, 0,
    'neither file name may be auto-paired while the other is an equally good match');
  const claims = items.filter(i => (i.contractIds || []).includes('c1'));
  assert.equal(claims.length, 1, 'contract c1 must be claimed by exactly one item');
  assert.equal(claims[0].type, 'ambiguous-rename');
  assert.deepEqual(claims[0].names.slice(1).sort(), ['Andamanda Phuket', 'Andamanda Resort']);
});

test('resolving a contested orphan does not delete an unrelated finding', () => {
  // Reproduces the second half of the bug: once the contested orphan's `indexOf` went stale
  // (already spliced out for the first claim), the second claim's splice deleted whatever
  // happened to be LAST in `out` — here, an entirely unrelated file name with no candidates at
  // all. That name must still be reported, untouched, no matter how the Andamanda pair resolves.
  const items = classifyDifferences({
    contracts: [{ contractId: 'c1', merchantName: 'Andamanda' }],
    upload: { names: ['Andamanda Phuket', 'Andamanda Resort', 'Jims Burger'] },
    run: null, dismissals: [] });
  const jims = items.find(i => i.type === 'in-file-no-row' && i.names[0] === 'Jims Burger');
  assert.ok(jims, 'an unrelated file name must not vanish while a contested orphan resolves');
});

test('Jharoka clears the rename threshold — pins the tightest real margin', () => {
  // Real pair, 2026-09-18 review: similarity('Jharoka', 'Jharoka by Indus') = 0.571 against
  // RENAME_MIN 0.55 — a margin of only 0.021, the tightest of any pair checked. Nothing else
  // in this file would catch a future reconcileKey/bigram tweak that shaved this one below the
  // line, so it gets its own pin.
  const items = classifyDifferences({
    contracts: [{ contractId: 'c1', merchantName: 'Jharoka' }],
    upload: { names: ['Jharoka by Indus'] }, run: null, dismissals: [] });
  const r = items.filter(i => i.type === 'likely-rename');
  assert.equal(r.length, 1);
  assert.deepEqual(r[0].names, ['Jharoka', 'Jharoka by Indus']);
  assert.deepEqual(r[0].contractIds, ['c1']);
});

// --- Task 6: a file tag that has branch rows, not a rename candidate ---

test('one file tag with several app rows is grouped, and says whether terms agree', () => {
  // Real: the file says 'Citadines'; the app holds three soi rows, all 25% GP.
  const gp = (p) => ({ type: 'percent', _t: 'gp', _method: 'default', rows: [{ model: 'ALL', percent: p }] });
  const items = classifyDifferences({
    contracts: [{ contractId: 'c1', merchantName: 'Citadines Sukhumvit soi 8', rule: gp(25), aggregationMode: 'whole' },
                { contractId: 'c2', merchantName: 'Citadines Sukhumvit soi 11', rule: gp(25), aggregationMode: 'whole' },
                { contractId: 'c3', merchantName: 'Citadines Sukhumvit soi 16', rule: gp(25), aggregationMode: 'whole' }],
    upload: { names: ['Citadines'] }, run: null, dismissals: [] });
  const b = items.filter(i => i.type === 'brand-has-branches');
  assert.equal(b.length, 1);
  assert.equal(b[0].contractIds.length, 3);
  assert.equal(b[0].sameTerms, true);
});

test('differing terms among the branches are flagged, because a merge must then choose', () => {
  // Real: Central Ladprao / Eastville / Westgate carry three different rules.
  const gp = (p) => ({ type: 'percent', _t: 'gp', _method: 'default', rows: [{ model: 'ALL', percent: p }] });
  const items = classifyDifferences({
    contracts: [{ contractId: 'c1', merchantName: 'Central Ladprao', rule: gp(30), aggregationMode: 'whole' },
                { contractId: 'c2', merchantName: 'Central Eastville', rule: gp(35), aggregationMode: 'whole' }],
    upload: { names: ['Central'] }, run: { skipped: [{ merchantName: 'Central', revenue: 51495 }] },
    dismissals: [] });
  const b = items.filter(i => i.type === 'brand-has-branches')[0];
  assert.equal(b.sameTerms, false);
  assert.equal(b.money, 51495);
});

test('a single branch row is a rename question, not a branch group', () => {
  const items = classifyDifferences({
    contracts: [{ contractId: 'c1', merchantName: 'Jharoka' }],
    upload: { names: ['Jharoka by Indus'] }, run: null, dismissals: [] });
  assert.equal(items.filter(i => i.type === 'brand-has-branches').length, 0);
  assert.equal(items.filter(i => i.type === 'likely-rename').length, 1);
});

// --- Task 8: the machine-list misses ---

test('the two machine-list misses stay apart, because they need different fixes', () => {
  // §1l: `unknown` = no registry row with that store name; `unlinked` = in the registry but its
  // row carries no contractId. Merging them into one list would hide which fix each needs.
  const items = classifyDifferences({
    contracts: [], upload: { names: [], machineMisses:
      { unknown: ['Shop A'], unknownTotal: 1, unlinked: ['Shop B'], unlinkedTotal: 9 } },
    run: null, dismissals: [] });
  const m = items.filter(i => i.type === 'machine-list-miss');
  assert.equal(m.length, 2);
  assert.match(m.find(i => i.key === 'unknown').detail, /not in the store registry/i);
  assert.match(m.find(i => i.key === 'unlinked').detail, /no merchant/i);
  assert.equal(m.find(i => i.key === 'unlinked').names.length, 1);
  assert.equal(m.find(i => i.key === 'unlinked').count, 9);   // the total survives the cap
});

// --- Fix round 1: rendering the machine-list-miss shape (not an arrow chain, not silent about
// the 200-name cap) ---

test('a truncated name list says how many were left out, using the exact total', () => {
  const html = truncatedNameListHtml(['A', 'B'], 500);
  assert.match(html, /<li>A<\/li>/);
  assert.match(html, /<li>B<\/li>/);
  assert.match(html, /showing the first 2 of 500/);
});

test('no truncation note when the full list is already shown', () => {
  const html = truncatedNameListHtml(['A', 'B'], 2);
  assert.doesNotMatch(html, /showing the first/);
});

test('a missing count falls back to the length of the list actually shown', () => {
  const html = truncatedNameListHtml(['A', 'B'], null);
  assert.doesNotMatch(html, /showing the first/);
});

test('names are HTML-escaped, because they come from an uploaded spreadsheet', () => {
  const html = truncatedNameListHtml(['<script>alert(1)</script>'], 1);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

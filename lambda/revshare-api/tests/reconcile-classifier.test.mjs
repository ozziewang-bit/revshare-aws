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
  grab('classifyDifferences') +
  '\nreturn { classifyDifferences };')();

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

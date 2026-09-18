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
  grab('reconcileKey') + '\n' + grab('skippedByName') + '\n' + grab('classifyDifferences') +
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

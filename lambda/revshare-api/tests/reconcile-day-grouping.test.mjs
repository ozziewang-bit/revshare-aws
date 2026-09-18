import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// groupByAddedDay (Task 7) is the pure helper behind the Reconcile tab's "in your app, not in
// your file" group: no string metric pairs a Thai-script duplicate with its English original, so
// grouping by the day a contract row was CREATED is the detection mechanism — the app's two known
// seeding batches (7 Aug migration, 9 Aug adoption) each land on one day. Extracted the same way
// tests/reconcile-classifier.test.mjs pulls classifyDifferences out of frontend/app.js.
const app = readFileSync(new URL('../../../frontend/app.js', import.meta.url), 'utf8');
const grab = (n) => {
  const i = app.indexOf(`function ${n}(`);
  if (i < 0) throw new Error('missing ' + n);
  let d = 0;
  for (let k = app.indexOf('{', i); k < app.length; k++) {
    if (app[k] === '{') d++; else if (app[k] === '}') { d--; if (!d) return app.slice(i, k + 1); }
  }
};
const { groupByAddedDay } = new Function(grab('groupByAddedDay') + '\nreturn { groupByAddedDay };')();

test('groups items by the creating contract\'s createdAt day, newest first', () => {
  const contracts = [
    { contractId: 'c1', createdAt: '2026-08-07T03:00:00Z' },
    { contractId: 'c2', createdAt: '2026-08-07T09:00:00Z' },
    { contractId: 'c3', createdAt: '2026-08-09T01:00:00Z' },
  ];
  const items = [
    { contractIds: ['c1'] }, { contractIds: ['c2'] }, { contractIds: ['c3'] },
  ];
  const groups = groupByAddedDay(items, contracts);
  assert.deepEqual(groups.map(([day]) => day), ['2026-08-09', '2026-08-07']);
  assert.equal(groups[0][1].length, 1);
  assert.equal(groups[1][1].length, 2);
});

test('a contract with no createdAt (or none found) falls into "unknown"', () => {
  const contracts = [{ contractId: 'c1' }];
  const items = [{ contractIds: ['c1'] }, { contractIds: ['ghost'] }];
  const groups = groupByAddedDay(items, contracts);
  assert.equal(groups.length, 1);
  assert.equal(groups[0][0], 'unknown');
  assert.equal(groups[0][1].length, 2);
});

test('only the item\'s first contractId is used to find the creating day', () => {
  const contracts = [
    { contractId: 'a', createdAt: '2026-08-01T00:00:00Z' },
    { contractId: 'b', createdAt: '2026-08-20T00:00:00Z' },
  ];
  const items = [{ contractIds: ['a', 'b'] }];
  const groups = groupByAddedDay(items, contracts);
  assert.equal(groups.length, 1);
  assert.equal(groups[0][0], '2026-08-01');
});

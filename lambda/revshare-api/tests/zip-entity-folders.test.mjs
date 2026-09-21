import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The per-merchant download is one .xlsx per brand, but a rev-share file is settled with a
// COMPANY. So when one contract entity covers several brands, their files go in a folder named
// for that entity (user, 2026-09-21: "unzip to see entity folder (if multiple brands)").
//
// A zip has no folders of its own — a "/" in an entry name IS the folder — so this is entirely
// a question of what the entry names are, which makes it testable without building a zip.
const app = readFileSync(new URL('../../../frontend/app.js', import.meta.url), 'utf8');
const grab = (n) => {
  const i = app.indexOf(`function ${n}(`);
  if (i < 0) throw new Error('missing ' + n);
  let d = 0;
  for (let k = app.indexOf('{', i); k < app.length; k++) {
    if (app[k] === '{') d++; else if (app[k] === '}') { d--; if (!d) return app.slice(i, k + 1); }
  }
};
const { zipEntryBases } = new Function(
  grab('sanitizeFilename') + '\n' + grab('entityFolder') + '\n' + grab('zipEntryBases') +
  '\nreturn { zipEntryBases };')();

// Results arrive already sorted by payout, and the rank prefix comes from that order.
const R = (contractId, merchantName) => ({ contractId, merchantName });
const entityMap = (m) => (id) => m[id] ?? null;

test('an entity covering several brands gets a folder', () => {
  const bases = zipEntryBases(
    [R('c1', 'Central Ladprao'), R('c2', 'Central Westgate')],
    entityMap({ c1: 'Central Group Co., Ltd.', c2: 'Central Group Co., Ltd.' }));
  // Note the missing final dot: Windows cannot create a folder whose name ends in "." and
  // silently mangles or rejects one on extract. Almost every entity here ends "Co., Ltd.", and
  // finance opens these on Windows, so the trailing dot is stripped deliberately.
  assert.deepEqual(bases, [
    'Central Group Co., Ltd/1) Central Ladprao',
    'Central Group Co., Ltd/2) Central Westgate',
  ]);
});

test('a folder name never ends in a dot or a space', () => {
  // The Windows rule above, stated as the property rather than as one example.
  for (const name of ['Acme Co., Ltd.', 'Acme  ', 'Acme...', '. Acme .']) {
    const [first] = zipEntryBases([R('c1', 'A'), R('c2', 'B')], () => name);
    const dir = first.split('/')[0];
    assert.ok(!/[. ]$/.test(dir), `folder "${dir}" must not end in a dot or space`);
    assert.ok(dir.length > 0, 'and must not be empty');
  }
});

test('an entity covering ONE brand gets no folder', () => {
  // A folder holding a single file is noise — you open it to find what you already saw.
  const bases = zipEntryBases([R('c1', 'AOT')], entityMap({ c1: 'AOT Public Co., Ltd.' }));
  assert.deepEqual(bases, ['1) AOT']);
});

test('a merchant with no entity recorded stays at the root', () => {
  // There is nothing to group it under, and inventing a folder would assert a company that
  // nobody has typed in.
  const bases = zipEntryBases([R('c1', 'Somsak'), R('c2', 'Jims Burger')], entityMap({}));
  assert.deepEqual(bases, ['1) Somsak', '2) Jims Burger']);
});

test('folders and loose files coexist, and the payout rank survives both', () => {
  const bases = zipEntryBases(
    [R('c1', 'AOT'), R('c2', 'Central Ladprao'), R('c3', 'Somsak'), R('c4', 'Central Westgate')],
    entityMap({ c1: 'AOT Public Co., Ltd.', c2: 'Central Group', c4: 'Central Group' }));
  assert.deepEqual(bases, [
    '1) AOT',
    'Central Group/2) Central Ladprao',
    '3) Somsak',
    'Central Group/4) Central Westgate',
  ]);
});

test('an entity name that would break a zip path is made safe', () => {
  // "/" is the folder separator itself; a raw one would invent nested directories.
  const bases = zipEntryBases(
    [R('c1', 'A'), R('c2', 'B')],
    entityMap({ c1: 'Big C / Casino *Group*', c2: 'Big C / Casino *Group*' }));
  assert.ok(bases.every(b => b.split('/').length === 2), 'exactly one level of folder');
  assert.equal(bases[0], 'Big C _ Casino _Group_/1) A');
});

test('a blank or unusable entity is not turned into a folder', () => {
  const bases = zipEntryBases(
    [R('c1', 'A'), R('c2', 'B')], entityMap({ c1: '   ', c2: '' }));
  assert.deepEqual(bases, ['1) A', '2) B']);
});

test('the same brand twice under one entity is not a portfolio', () => {
  // Several brands means several DISTINCT brands. One brand appearing twice in a run would
  // otherwise bury two files in a folder named after the company.
  const bases = zipEntryBases(
    [R('c1', 'AOT'), R('c1', 'AOT')],
    entityMap({ c1: 'AOT Public Co., Ltd.' }));
  assert.deepEqual(bases, ['1) AOT', '2) AOT']);
});

test('every entry name is unique, so no file can overwrite another in the zip', () => {
  const results = [R('c1', 'Same'), R('c1', 'Same'), R('c2', 'Same'), R('c3', 'Same')];
  const bases = zipEntryBases(results, entityMap({ c1: 'E', c2: 'E', c3: 'E' }));
  assert.equal(new Set(bases).size, bases.length);
});

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

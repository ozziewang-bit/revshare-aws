import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { shopsOfBrand } from '../code/routes/contracts.mjs';

// ── The shops behind a branch count (2026-10-01) ─────────────────────────────────────────────
// "when I click on the branches, I can have a developed view of merchant name both in Thai and
// English, merchant label, machine type." Read from the uploaded file, which is where that
// number already comes from — so the list and the count can never disagree.
const DOC = {
  merchants: [
    { name: 'กูโรตีชาชัก อุดร', nameEn: 'Gu Roti Cha Chak (UDON)', partnerName: 'Udon',
      model: 'S8', externalId: '1253800072590393344' },
    { name: 'เฌอ', nameEn: 'Chr', partnerName: 'Udon', model: 'S8', externalId: '1253799354724859904' },
    // The same shop with a second station: ONE branch, TWO stations.
    { name: 'เฌอ', nameEn: 'Chr', partnerName: 'Udon', model: 'S5', externalId: '999' },
    { name: 'Somewhere else', nameEn: '', partnerName: 'Other Brand', model: 'S8' },
    { name: 'No device', nameEn: 'No device', partnerName: 'Udon', model: null },
  ],
  excluded: [
    { name: 'เซ็นทรัลเวิลด์ ชั้น G', label: 'Udon', reviewState: 'Pending' },
    { name: 'elsewhere', label: 'Other Brand', reviewState: 'Disapproved' },
  ],
};

test('it returns the four things asked for, per shop', () => {
  const { shops } = shopsOfBrand(DOC, 'Udon');
  const one = shops.find(s => s.name === 'กูโรตีชาชัก อุดร');
  assert.equal(one.name, 'กูโรตีชาชัก อุดร', 'Thai name');
  assert.equal(one.nameEn, 'Gu Roti Cha Chak (UDON)', 'English name');
  assert.equal(one.label, 'Udon', 'merchant label');
  assert.equal(one.model, 'S8', 'machine type');
});

// This is the number in the grid, so the list must count the same way it does.
test('a shop with two stations is ONE row, and the stations are stated separately', () => {
  const { shops, stations } = shopsOfBrand(DOC, 'Udon');
  assert.equal(shops.filter(s => s.name === 'เฌอ').length, 1, 'one branch');
  assert.equal(shops.length, 3, 'three shops');
  assert.equal(stations, 4, 'four roster rows behind them');
});

test('only this brand\'s shops come back', () => {
  const { shops } = shopsOfBrand(DOC, 'Udon');
  assert.ok(!shops.some(s => s.name === 'Somewhere else'));
});

test('the label is matched case- and space-insensitively, as everywhere else', () => {
  for (const b of ['udon', 'UDON', '  Udon  ']) {
    assert.equal(shopsOfBrand(DOC, b).shops.length, 3, b);
  }
});

// A branch count is Approved-only, so a held-back shop is missing from the list with no
// explanation unless it is named — and that is the question this view exists to answer.
test('shops held back by their review state are named, apart from the count', () => {
  const { shops, heldBack } = shopsOfBrand(DOC, 'Udon');
  assert.equal(heldBack.length, 1);
  assert.equal(heldBack[0].reviewState, 'Pending');
  assert.ok(!shops.some(s => s.name === heldBack[0].name), 'and not counted as a branch');
});

test('a missing device type is reported, not guessed', () => {
  const { shops } = shopsOfBrand(DOC, 'Udon');
  assert.equal(shops.find(s => s.name === 'No device').model, null);
});

test('an unknown brand, or none, is empty rather than an error', () => {
  assert.deepEqual(shopsOfBrand(DOC, 'Nobody').shops, []);
  assert.deepEqual(shopsOfBrand(DOC, '').shops, []);
  assert.deepEqual(shopsOfBrand(null, 'Udon').shops, []);
  assert.doesNotThrow(() => shopsOfBrand(undefined, undefined));
});

test('the route needs a brand and only reads', () => {
  const src = readFileSync(new URL('../code/routes/contracts.mjs', import.meta.url), 'utf8');
  const i = src.indexOf('export async function rosterShopsRoute');
  const fn = src.slice(i, src.indexOf('\n}', i)).replace(/\/\/[^\n]*/g, '');
  assert.match(fn, /missing_brand/);
  assert.ok(!/putContract|putMerchant|UpdateCommand|Delete/.test(fn));
});

// ── The grid ────────────────────────────────────────────────────────────────────────────────
const app = readFileSync(new URL('../../../frontend/app.js', import.meta.url), 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

test('the Branch number is only clickable when the file can answer', () => {
  const i = app.indexOf("col.key === 'branchCount' && v != null");
  assert.ok(i > 0, 'the branch cell has its own branch');
  const fn = strip(app.slice(i, app.indexOf('else disp =', i)));
  assert.match(fn, /fileBrandOf\(c\)/,
    'a count from the stored column has no shops to show, so it stays plain text');
  assert.match(fn, /class="ct-branch"/);
  assert.match(fn, /data-brand=/);
});

test('it opens through the grid\'s own delegated handler', () => {
  const i = app.indexOf("const branch = ev.target.closest('.ct-branch');");
  assert.ok(i > 0);
  assert.match(app.slice(i, i + 160), /openBranchList\(branch\.dataset\.brand\)/);
});

test('the dialog shows the four columns, and says when a file read fails', () => {
  const i = app.indexOf('async function openBranchList(');
  const fn = app.slice(i, app.indexOf('\n}\n', i));
  for (const h of ['Merchant name \\(Thai\\)', 'Merchant name \\(English\\)',
                   'Merchant label', 'Machine type']) {
    assert.match(fn, new RegExp(h), h);
  }
  assert.match(fn, /Could not read the merchants for this brand/, 'a failure says so');
  assert.match(fn, /no device type/, 'and a shop with no model is marked, not left blank');
  assert.match(fn, /bl-filter/, '1,480 merchants for 7-Eleven, so it filters');
  assert.match(strip(fn), /max-height:52vh;overflow-y:auto/, 'and scrolls inside the dialog');
});

test('the dialog changes nothing', () => {
  const i = app.indexOf('async function openBranchList(');
  const fn = strip(app.slice(i, app.indexOf('\n}\n', i)));
  assert.ok(!/method: 'PUT'|method: 'POST'|method: 'DELETE'/.test(fn));
});

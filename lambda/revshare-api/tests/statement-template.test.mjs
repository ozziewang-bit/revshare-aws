import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The statement, checked against the template finance actually uses
// (~/Downloads/Template_Revenue Share.xlsx, read 2026-09-30).
//
// The template's own numbers are the fixture: PMCU, two rental places, a grand total. If the
// arithmetic here ever stops reproducing them, the file a merchant receives has changed.
//
//   Rental Place                รุ่นเครื่อง  จำนวน  ยอดรายได้  %    ฐานภาษี    ภาษี    ยอดรวม
//   อาคารวิทยกิตติ์              LL-40        37    1420      0.2  265.42    18.58   284
//   ลิโด้ ชั้น 1 …                S-8         104    5240      0.2  979.44    68.56   1048
//   Grand Total                              141    6660      0.2  1244.86   87.14   1332
const app = readFileSync(new URL('../../../frontend/app.js', import.meta.url), 'utf8');
// Skips the PARAMETER list before brace-matching. A destructured parameter — like
// `renderStructuredRuleEditor(..., { readOnly = false })` — otherwise closes the match on the
// parameter's own brace and returns 95 characters of signature. buildMimeMessage carries a
// comment about this exact trap; the extractors elsewhere in this suite still have it.
const grab = (n) => {
  const i = app.indexOf(`function ${n}(`);
  if (i < 0) throw new Error('missing ' + n);
  let depth = 0, k = app.indexOf('(', i);
  for (; k < app.length; k++) {
    if (app[k] === '(') depth++;
    else if (app[k] === ')') { depth--; if (!depth) break; }
  }
  let d = 0;
  for (let j = app.indexOf('{', k); j < app.length; j++) {
    if (app[j] === '{') d++; else if (app[j] === '}') { d--; if (!d) return app.slice(i, j + 1); }
  }
  throw new Error('unbalanced ' + n);
};
const constOf = (n) => app.slice(app.indexOf(`const ${n} =`),
                                 app.indexOf('\n};', app.indexOf(`const ${n} =`)) + 3);

// A minimal SheetJS stand-in: aoa_to_sheet hands back the rows, which is what we assert on.
const XLSXns = { utils: { aoa_to_sheet: (aoa) => aoa } };
const build = (region) => new Function('REGION', 'XLSXns', `
  const round2 = x => Math.round((Number(x) || 0) * 100) / 100;
  const round4 = x => Math.round((Number(x) || 0) * 10000) / 10000;
  const apportion = (total, weights) => {
    const sum = weights.reduce((a, b) => a + b, 0);
    return weights.map(w => sum ? total * w / sum : 0);
  };
  ${constOf('TAX')}
  ${grab('splitTax')}
  ${grab('modelLabel')}
  ${grab('buildPartnerSheet')}
  return (result, orders) => buildPartnerSheet(XLSXns, result, orders, new Map());
`)(region, XLSXns);

const PMCU = {
  merchantName: 'PMCU',
  revenue: 6660,
  payout: 1332,
  merchants: [
    { merchantId: 's1', merchantName: 'อาคารวิทยกิตติ์', model: 'LL40', rentals: 37, revenue: 1420 },
    { merchantId: 's2', merchantName: 'ลิโด้ ชั้น 1 บริเวณข้างห้องน้ำ', model: 'S8', rentals: 104, revenue: 5240 },
  ],
  engineResult: {},
};

test('block 1 reproduces the template exactly', () => {
  const rows = build('th')(PMCU, null);
  assert.deepEqual(rows[0], ['Rental Place', 'รุ่นเครื่อง', 'จำนวนการยืม', 'ยอดรายได้ทั้งหมด',
                             'ส่วนแบ่งรายได้ (%)', 'มูลค่าส่วนแบ่ง (ฐานภาษี)', 'ภาษี', 'ยอดรวม']);
  assert.deepEqual(rows[1], ['อาคารวิทยกิตติ์', 'LL-40', 37, 1420, 0.2, 265.42, 18.58, 284]);
  assert.deepEqual(rows[2], ['ลิโด้ ชั้น 1 บริเวณข้างห้องน้ำ', 'S-8', 104, 5240, 0.2, 979.44, 68.56, 1048]);
  assert.deepEqual(rows[3], ['Grand Total', '', 141, 6660, 0.2, 1244.86, 87.14, 1332]);
});

// The payout ALREADY contains the tax — base is backed out of it, never added to it. Getting
// this backwards overstates every statement by 7%.
test('the payout is treated as VAT-inclusive', () => {
  const rows = build('th')(PMCU, null);
  const [, , , , , base, tax, total] = rows[1];
  assert.equal(total, 284, 'the total is the payout itself');
  assert.equal(round(base + tax), 284, 'base + tax adds back to it');
  assert.ok(base < total, 'the base is SMALLER than the payout');
});
const round = x => Math.round(x * 100) / 100;

test('the grand total is taxed from the total, not by summing rounded parts', () => {
  const fn = grab('buildPartnerSheet');
  assert.match(fn, /const gt = splitTax\(sumShare\)/);
});

// "let's do with VAT, but I might change to without later" — one switch, not a rule spread
// through the sheet.
test('tax is decided in exactly one place', () => {
  const fn = grab('buildPartnerSheet');
  assert.ok(!/1\.07|0\.07/.test(fn), 'no rate is written into the sheet builder');
  assert.match(fn, /splitTax\(/);
  const tax = constOf('TAX');
  assert.match(tax, /th: \{ rate: 0\.07, mode: 'inclusive' \}/);
});

test('switching to exclusive changes what the total means, not the sheet', () => {
  const split = new Function('REGION', `${constOf('TAX')}
    const round2 = x => Math.round((Number(x) || 0) * 100) / 100;
    TAX.th.mode = 'exclusive';
    ${grab('splitTax')}
    return splitTax;`)('th');
  const r = split(1000);
  assert.equal(r.base, 1000, 'ex-tax: the payout IS the base');
  assert.equal(r.tax, 70);
});

test('a region with no tax reports the payout whole', () => {
  const rows = build('sg')(PMCU, null);
  assert.deepEqual(rows[1].slice(5), [284, 0, 284]);
});

test('the device code is hyphenated for display only', () => {
  const label = new Function(`${grab('modelLabel')} return modelLabel;`)();
  assert.equal(label('S8'), 'S-8');
  assert.equal(label('LL40'), 'LL-40');
  assert.equal(label('S10-A'), 'S-10-A');
  assert.equal(label(''), '');
  assert.equal(label(null), '');
});

test('block 2 is the merchant name, then the rentals', () => {
  const rows = build('th')(PMCU, [
    { orderNo: '701301750798645444608', rentalTime: '2026-09-27 23:54:03',
      merchantName: 'ลิโด้ ชั้น 1 บริเวณข้างห้องน้ำ', returnTime: '2026-09-28 00:54:00',
      returnMerchant: 'อาคารวิทยกิตติ์', duration: 60, netAmount: 20, orderStatus: 'Complete' },
  ]);
  assert.deepEqual(rows[4], []);
  assert.deepEqual(rows[5], ['PMCU']);
  assert.deepEqual(rows[6], ['Order No.', 'Rental Time', 'Rental Merchant', 'Rental KA Name',
                             'Return Time', 'Return Merchant', 'Rental Duration', 'Net Amount',
                             'Order Status']);
  assert.deepEqual(rows[7], ['701301750798645444608', '2026-09-27 23:54:03',
                             'ลิโด้ ชั้น 1 บริเวณข้างห้องน้ำ', 'PMCU', '2026-09-28 00:54:00',
                             'อาคารวิทยกิตติ์', 60, 20, 'Complete']);
});

// Runs before 2026-09-30 have no order numbers, and before 2026-09-01 no order detail at all.
test('a run with no order detail says so instead of printing an empty block', () => {
  const rows = build('th')(PMCU, null);
  assert.match(String(rows[6][0]), /predates the stored order detail/);
});

test('a missing order number is blank, not undefined', () => {
  const rows = build('th')(PMCU, [{ rentalTime: 't', merchantName: 'm', netAmount: 20 }]);
  assert.equal(rows[7][0], '');
});

test('the order number is kept by the parser, from the report header', () => {
  const fn = grab('parseOrderReport');
  assert.match(fn, /orderNo: String\(pick\(r, 'Order No\.'\) \?\? ''\)\.trim\(\)/);
});

// A per_store merchant can carry a lump sum that belongs to no single shop.
test('a merchant-level lump sum is taxed like any other share', () => {
  const rows = build('th')({ ...PMCU,
    engineResult: { byStore: [{ storeId: 's1', payout: 284 }, { storeId: 's2', payout: 1048 }],
                    topLevel: { payout: 107 } } }, null);
  const lump = rows.find(r => r[0] === '(merchant-level lump sum)');
  assert.deepEqual(lump.slice(5), [100, 7, 107]);
  const gt = rows.find(r => r[0] === 'Grand Total');
  assert.equal(gt[7], 1439, 'and it is inside the grand total');
});

// ── A term must never be thrown away in silence (2026-09-30) ───────────────────────────────
// PMCU: someone entered a minimum guarantee, pressed Save, the request returned 200 and the
// stored rule was unchanged — `updatedAt` moved 07:29 → 07:57 with no MG in the result.
//
// compileRule is RIGHT: an MG is a floor, so it is only consulted by `higher` and
// `hybrid-higher`. `default` and `hybrid` add the terms up, and adding a floor to a share would
// pay the guarantee on top of it. The screen was wrong — it accepted a value it discarded.
const compile = new Function(
  app.slice(app.indexOf('const PAYOUT_METHODS'), app.indexOf('\n}', app.indexOf('function compileRule')) + 2)
  + '\nreturn compileRule;')();

const withMG = (method) => compile({
  method, gpPercent: 20, electricity: 0, others: 0, placementRows: [],
  mgRows: [{ model: 'S8', amount: 500 }],
});

test('hybrid and default genuinely ignore a minimum guarantee', () => {
  for (const m of ['hybrid', 'default']) {
    assert.ok(!JSON.stringify(withMG(m)).includes("\"_t\":\"mg\""), `${m} drops it — by design`);
  }
});

test('higher and hybrid-higher use it', () => {
  for (const m of ['higher', 'hybrid-higher']) {
    assert.match(JSON.stringify(withMG(m)), /"_t":"mg"/, `${m} keeps it`);
    assert.match(JSON.stringify(withMG(m)), /"type":"max"/, 'as a floor, not a sum');
  }
});

test('the editor reports what a save would drop', () => {
  const fn = grab('renderStructuredRuleEditor');
  assert.match(fn, /droppedTerms\(\)/);
  assert.match(fn, /form\.method === 'higher' \|\| form\.method === 'hybrid-higher'/);
  assert.match(fn, /the minimum guarantee \(/, 'and names the values at stake');
});

test('the MG inputs go dead when the method ignores them', () => {
  const fn = grab('renderStructuredRuleEditor');
  assert.match(fn, /const mgUsed = method === 'higher' \|\| method === 'hybrid-higher';/);
  assert.match(fn, /class="mg-amt"[^`]*\$\{d\(rawMode \|\| !mgUsed\)\}/);
  assert.match(fn, /not used and will not be saved/, 'and it says so in plain words');
});

test('the save refuses before discarding a term', () => {
  const fn = grab('openTermsEditor');
  assert.match(fn, /editor\.droppedTerms\?\.\(\) \|\| \[\]/);
  assert.match(fn, /This would save WITHOUT/);
  assert.match(fn, /return;\n      \}/, 'and cancelling stops the save');
});

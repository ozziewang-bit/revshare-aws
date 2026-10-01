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
//
// REVISED 2026-09-30: column E no longer holds that 0.2. "you don't have to do % calculation,
// just show as the term is, but of course, the share amount you need to show after calculation."
// It now carries the contracted TERM; every other column is unchanged, so the template's own
// numbers still pin the arithmetic below.
import { pageOrders } from '../code/routes/bulk-runs.mjs';

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
// Comments in this codebase describe the bug they prevent, so they contain the very strings the
// assertions look for. Three tests have passed on prose before. Strip it first.
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

// A minimal SheetJS stand-in: aoa_to_sheet hands back the rows, which is what we assert on.
const XLSXns = { utils: { aoa_to_sheet: (aoa) => aoa } };
// THE REAL `apportion`, not a stand-in (2026-10-01). It used to be re-implemented here in two
// lines, and the copy was wrong in the one case that matters: with every weight zero it returned
// zero, while the real function splits evenly. Reading the copy's output I reported that a
// merchant with no rentals would receive a statement showing 0 against an email saying 250. The
// app had always been right. A test that fakes the function it is testing can invent a bug.
const build = (region) => new Function('REGION', 'XLSXns', `
  const round2 = x => Math.round((Number(x) || 0) * 100) / 100;
  ${grab('apportion')}
  const modelCode = v => String(v ?? '').trim();
  ${constOf('TAX')}
  ${grab('splitTax')}
  ${grab('modelLabel')}
  ${grab('termText')}
  ${grab('buildPartnerSheet')}
  return (result, orders, rule, gone) => buildPartnerSheet(XLSXns, result, orders, new Map(), null, rule, gone);
`)(region, XLSXns);
// The fixture's rule, chosen to reproduce the template's own 0.2 column. PMCU's LIVE rule is
// `max( GP 20% , MG L40 800 + MG S8 250 )` — the template predates that, and the arithmetic
// below is what is being pinned, not PMCU's terms.
const GP20 = { type: 'percent', rows: [{ percent: 20, model: 'ALL' }], _t: 'gp' };

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
  const rows = build('th')(PMCU, null, GP20);
  assert.deepEqual(rows[0], ['Rental Place', 'รุ่นเครื่อง', 'จำนวนการยืม', 'ยอดรายได้ทั้งหมด',
                             'ส่วนแบ่งรายได้', 'มูลค่าส่วนแบ่ง (ฐานภาษี)', 'ภาษี', 'ยอดรวม']);
  assert.deepEqual(rows[1], ['อาคารวิทยกิตติ์', 'LL-40', 37, 1420, 'GP 20%', 265.42, 18.58, 284]);
  assert.deepEqual(rows[2], ['ลิโด้ ชั้น 1 บริเวณข้างห้องน้ำ', 'S-8', 104, 5240, 'GP 20%', 979.44, 68.56, 1048]);
  assert.deepEqual(rows[3], ['Grand Total', '', 141, 6660, 'GP 20%', 1244.86, 87.14, 1332]);
});

// ── Column E states the TERM, not a rate (2026-09-30) ──────────────────────────────────────
// Turtle Shop's statement went out reading **3.4436** in a column headed "ส่วนแบ่งรายได้ (%)" —
// 344%. Nothing was miscalculated: its share is a 76,000 guarantee against 22,070 of revenue,
// and payout ÷ revenue is genuinely 3.44. The column was answering a question no merchant asks.
// Worse, in `whole` mode the share is apportioned BY revenue, so the same ratio printed on every
// row — it distinguished nothing per store either.
test('an MG-dominated merchant quotes its guarantee, not a 344% rate', () => {
  const turtle = {
    merchantName: 'Turtle Shop', revenue: 22070, payout: 76000, engineResult: {},
    merchants: [{ merchantId: 's1', merchantName: 'Turtle Shop Thonglor', model: 'S8',
                  rentals: 500, revenue: 22070 }],
  };
  // Exactly the rule the September run froze for it.
  const rows = build('th')(turtle, null, {
    type: 'max', _method: 'hybrid-higher', children: [
      { type: 'percent', rows: [{ percent: 30, model: 'ALL' }], _t: 'gp' },
      { type: 'flat_per_machine', rows: [{ model: 'S8', amount: 4000 }], _t: 'mg' },
    ],
  });
  assert.equal(rows[1][4], 'max( GP 30% , MG S8 4,000 )');
  assert.ok(!String(rows[1][4]).includes('3.44'), 'the effective rate is gone');
  assert.equal(rows[1][7], 76000, 'and the share amount is still the computed payout');
  assert.equal(rows[0][4], 'ส่วนแบ่งรายได้', 'the heading no longer claims a percentage');
});

test('every term type reads as it was agreed', () => {
  const term = new Function(`const modelCode = v => String(v ?? '').trim();
    ${grab('termText')} return termText;`)();
  assert.equal(term({ type: 'percent', rows: [{ percent: 30, model: 'ALL' }], _t: 'gp' }), 'GP 30%');
  assert.equal(term({ type: 'flat_per_machine', rows: [{ model: 'S8', amount: 4000 }], _t: 'mg' }),
               'MG S8 4,000');
  assert.equal(term({ type: 'flat_per_machine', rows: [{ model: 'LL40', amount: 500 }], _t: 'placement' }),
               'Placement LL40 500');
  assert.equal(term({ type: 'flat_per_partner_total', amount: 1200, _t: 'elec' }), 'Electricity 1,200');
  assert.equal(term({ type: 'flat_per_partner_total', amount: 800, _t: 'others' }), 'Others 800');
  // `hybrid` — the terms are added, so the text adds them.
  assert.equal(term({ type: 'sum', children: [
    { type: 'percent', rows: [{ percent: 25, model: 'ALL' }], _t: 'gp' },
    { type: 'flat_per_partner_total', amount: 1000, _t: 'elec' },
  ] }), 'GP 25% + Electricity 1,000');
  // Electricity never competes (§1b): it sits OUTSIDE the max, and the text shows that.
  assert.equal(term({ type: 'sum', children: [
    { type: 'max', children: [
      { type: 'percent', rows: [{ percent: 30, model: 'ALL' }], _t: 'gp' },
      { type: 'flat_per_machine', rows: [{ model: 'S8', amount: 4000 }], _t: 'mg' },
    ] },
    { type: 'flat_per_partner_total', amount: 500, _t: 'elec' },
  ] }), 'max( GP 30% , MG S8 4,000 ) + Electricity 500');
});

test('a per-model term names every model, so nobody has to guess the rest', () => {
  const term = new Function(`const modelCode = v => String(v ?? '').trim();
    ${grab('termText')} return termText;`)();
  assert.equal(term({ type: 'flat_per_machine', _t: 'mg',
    rows: [{ model: 'S8', amount: 4000 }, { model: 'LL40', amount: 1500 }] }),
    'MG S8 4,000 + MG LL40 1,500');
});

test('a zero term is not printed as a term', () => {
  const term = new Function(`const modelCode = v => String(v ?? '').trim();
    ${grab('termText')} return termText;`)();
  // A rule commonly carries an empty leaf for a term nobody set; quoting "GP 0%" to a merchant
  // states a condition that is not in their contract.
  assert.equal(term({ type: 'percent', rows: [{ percent: 0, model: 'ALL' }], _t: 'gp' }), '');
  assert.equal(term({ type: 'sum', children: [
    { type: 'percent', rows: [{ percent: 0, model: 'ALL' }], _t: 'gp' },
    { type: 'flat_per_machine', rows: [{ model: 'S8', amount: 4000 }], _t: 'mg' },
  ] }), 'MG S8 4,000', 'and a one-term comparison drops the wrapper too');
});

// A statement must not invent a term it cannot read.
test('an unreadable or missing rule leaves the cell blank rather than guessing', () => {
  const term = new Function(`const modelCode = v => String(v ?? '').trim();
    ${grab('termText')} return termText;`)();
  for (const r of [undefined, null, {}, 'nonsense', { type: 'weird' }]) assert.equal(term(r), '');
  const rows = build('th')(PMCU, null, undefined);
  assert.equal(rows[1][4], '', 'and the sheet still builds');
  assert.equal(rows[1][7], 284, 'with the share amount intact');
});

// §10.5. A merchant renegotiating in October must not change what September's statement says
// they were on.
test('the term comes from the run\'s frozen snapshot, never the current rule', () => {
  const src = readFileSync(new URL('../../../frontend/app.js', import.meta.url), 'utf8');
  const i = src.indexOf('async function runOrderIndex(');
  const fn = src.slice(i, src.indexOf('ruleSnapshots: run.ruleSnapshots') + 40);
  assert.match(fn, /ruleSnapshots: run\.ruleSnapshots \|\| \{\}/);
  const wb = src.slice(src.indexOf('function statementWorkbook('));
  assert.match(wb.slice(0, wb.indexOf('\n}')),
               /\(index\.ruleSnapshots \|\| \{\}\)\[result\.contractId\]/,
               'keyed by contractId, out of the run');
  const sheet = grab('buildPartnerSheet');
  assert.ok(!/CONTRACT|contracts\b|\.rule\b/.test(sheet.replace(/\/\/[^\n]*/g, '')),
            'the sheet builder reaches for no current rule');
});

// The payout ALREADY contains the tax — base is backed out of it, never added to it. Getting
// this backwards overstates every statement by 7%.
test('the payout is treated as VAT-inclusive', () => {
  const rows = build('th')(PMCU, null, GP20);
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
  assert.match(String(rows[6][0]), /individual rentals were not kept/);
});

// ── The message has to answer the question it provokes (2026-09-30) ─────────────────────────
// "This run predates the stored order detail, so the rentals cannot be listed." — "wtf does it
// mean? if you dont have rental detail, how do you calculate". A fair question, and the sentence
// invited it: it named our storage history and left the reader to assume the money was guessed.
// It was not. The payout is computed from the order report AT RUN TIME and frozen in the run's
// results — which is exactly the pivot block above the message. Only the line-by-line list is
// absent, and only on the July and August runs, whose `parseOrderReport` dropped rentalTime.
test('it says the totals are still complete, and why', () => {
  const rows = build('th')(PMCU, null);
  const msg = String(rows[6][0]);
  assert.match(msg, /individual rentals were not kept/, 'what is missing');
  assert.match(msg, /calculated from the order report uploaded at the time of the run/, 'and how the numbers got here');
  assert.match(msg, /only the line-by-line list is missing/, 'and that nothing else is');
  assert.ok(!/predates/.test(msg), 'no internal vocabulary');
});

// A failure, by contrast, must still read as a failure and stop the file being sent.
test('a failure is not softened into a fact about storage', () => {
  const rows = build('th')(PMCU, null, undefined);
  const withErr = new Function('XLSXns', `
    const round2 = x => Math.round((Number(x) || 0) * 100) / 100;
    const apportion = (t, w) => { const s = w.reduce((a, b) => a + b, 0); return w.map(x => s ? t * x / s : 0); };
    const REGION = 'th';
    const modelCode = v => String(v ?? '').trim();
    ${constOf('TAX')} ${grab('splitTax')} ${grab('modelLabel')} ${grab('termText')}
    ${grab('buildPartnerSheet')}
    return (r) => buildPartnerSheet(XLSXns, r, null, new Map(), 'HTTP 500: boom');
  `)(XLSXns)(PMCU);
  const msg = String(withErr[withErr.length - 1][0]);
  assert.match(msg, /could not be loaded/);
  assert.match(msg, /do not send it until that is fixed/);
});

// ── A transient failure must not be cached (2026-09-30) ─────────────────────────────────────
// RUN_ORDER_INDEX is keyed by runId for the life of the page. The first failed fetch therefore
// answered every subsequent download without going back to the server — so after the gzip fix
// went live, the same tab kept producing the same wrong statement and no request appeared in the
// Lambda log at all. "Only the totals were kept" is permanent and worth caching. "It broke" is not.
test('only a successful or permanent result is cached', () => {
  const src = readFileSync(new URL('../../../frontend/app.js', import.meta.url), 'utf8');
  const fn = strip(src.slice(src.indexOf('async function runOrderIndex('),
                             src.indexOf('return index;', src.indexOf('async function runOrderIndex('))));
  assert.match(fn, /if \(!ordersError \|\| ordersError === 'predates'\) RUN_ORDER_INDEX\.set/);
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

// ── A month of orders outgrew the response limit (2026-09-30) ──────────────────────────────
// September's stored inputs are 10.40 MB against API Gateway's hard 10 MB response ceiling —
// orders alone are 9.92 MB of it. A gzip+base64 body was tried first and is gone: `isBase64Encoded`
// is honoured only when the content-type is in the API's `binaryMediaTypes`, and NEITHER REGION HAS
// ONE. Pages of plain JSON now — the transport every working route in this app already uses, with
// no ceiling to grow back into.
//
//   2026-08-27  4.6 MB      2026-09-01  5.2 MB      2026-09-30  10.4 MB
test('a page carries the total, so a short read is detectable', () => {
  const all = Array.from({ length: 12345 }, (_, i) => ({ orderNo: String(i) }));
  const p1 = pageOrders(all, {});
  assert.equal(p1.total, 12345, 'every page states the whole size');
  assert.equal(p1.orders.length, 5000, 'default page');
  assert.equal(p1.offset, 0);
  const last = pageOrders(all, { offset: '10000' });
  assert.equal(last.orders.length, 2345, 'the last page is short, and total proves it is the last');
  assert.deepEqual(pageOrders(all, { offset: '12345' }).orders, [], 'past the end is empty, not an error');
});

test('every page fits inside the response ceiling', () => {
  // 397 bytes per order, measured on the September file.
  const bytes = 397 * pageOrders(Array.from({ length: 30000 }, () => ({})), {}).limit;
  assert.ok(bytes < 4 * 1024 * 1024, `a full page is ${(bytes / 1048576).toFixed(1)} MB`);
  // And a caller cannot ask for one that does not fit.
  assert.equal(pageOrders(Array.from({ length: 99999 }, () => ({})), { limit: '99999' }).limit, 10000);
});

test('a junk offset or limit cannot break the loop', () => {
  const all = Array.from({ length: 10 }, (_, i) => ({ i }));
  for (const q of [{ offset: '-5' }, { offset: 'abc' }, { limit: '0' }, { limit: '-1' }, { limit: 'x' }]) {
    const r = pageOrders(all, q);
    assert.ok(r.offset >= 0 && r.limit >= 1, JSON.stringify(q));
    assert.ok(r.orders.length > 0, 'a page always makes progress, or the client loops forever');
  }
});

test('the route sends no binary and asks API Gateway for no decoding', () => {
  const route = readFileSync(new URL('../code/routes/bulk-runs.mjs', import.meta.url), 'utf8');
  const body = strip(route.slice(route.indexOf('export async function getBulkRunInputsRoute')).split('\n}')[0]);
  assert.ok(!/isBase64Encoded|gzipSync|x-mcrm-encoding/.test(body));
  assert.match(body, /pageOrders\(inputs\.orders, event\.queryStringParameters\)/);
});

test('the client walks the pages and refuses a partial read', () => {
  const src = readFileSync(new URL('../../../frontend/app.js', import.meta.url), 'utf8');
  const fn = strip(src.slice(src.indexOf('async function runOrderIndex('),
                             src.indexOf('ruleSnapshots: run.ruleSnapshots')));
  assert.match(fn, /offset=\$\{offset\}&limit=\$\{PAGE\}/);
  assert.match(fn, /got\.length < total/, 'a short read is an error');
  assert.match(fn, /only \$\{got\.length\} of \$\{total\} rentals could be loaded/);
  assert.match(fn, /if \(!rows\.length \|\| got\.length >= total\) break;/, 'and it always terminates');
});

test('an old run is settled from the FIRST page, not by downloading all of it', () => {
  const src = readFileSync(new URL('../../../frontend/app.js', import.meta.url), 'utf8');
  const fn = strip(src.slice(src.indexOf('async function runOrderIndex('),
                             src.indexOf('ruleSnapshots: run.ruleSnapshots')));
  // July stored 28,159 orders with no rental times at all. Six pages to learn that is waste.
  assert.match(fn, /if \(!offset && total && !rows\.some\(o => o\.rentalTime != null\)\)/);
});

test('the compressed-response path is gone from the client', () => {
  const src = readFileSync(new URL('../../../frontend/app.js', import.meta.url), 'utf8');
  assert.ok(!/ungzipJson|unbase64|x-mcrm-encoding/.test(src),
            'nothing produces it, and its empty-message failure cost a day');
});

// ── A failure must always be able to say something (2026-09-30) ─────────────────────────────

test('ordersError is never an empty string', () => {
  const src = readFileSync(new URL('../../../frontend/app.js', import.meta.url), 'utf8');
  const fn = strip(src.slice(src.indexOf('async function runOrderIndex('),
                             src.indexOf('ruleSnapshots: run.ruleSnapshots')));
  assert.match(fn, /e\.message \|\| e\.name \|\| 'unknown error'/);
  // Because every consumer of it is written as `ordersError && ordersError !== 'predates'`.
  assert.ok(src.includes("ordersError && ordersError !== 'predates'"));
  assert.ok(src.includes("index.ordersError && index.ordersError !== 'predates'"));
});

test('only a genuinely absent object may report a run as too old', () => {
  const db = readFileSync(new URL('../code/db.mjs', import.meta.url), 'utf8');
  const fn = strip(db.slice(db.indexOf('export async function getBulkRunInputs('),
                            db.indexOf('\n}', db.indexOf('export async function getBulkRunInputs('))));
  assert.ok(!/catch \{ return null; \}/.test(fn), 'no bare catch — it meant "this run is old"');
  assert.match(fn, /NoSuchKey/);
  assert.match(fn, /throw e;/, 'anything else is re-raised so the client hears it');
});

// db.mjs is NEVER synced between regions (§8), and this one carries a correctness rule now.
test('the SG copy of db.mjs carries the same rule', () => {
  let sg;
  try {
    sg = readFileSync('/Users/ozziewang/revshare_sg/lambda/revshare-api/code/db.mjs', 'utf8');
  } catch { return; }   // not a checkout that has the SG repo beside it
  const fn = strip(sg.slice(sg.indexOf('export async function getBulkRunInputs('),
                            sg.indexOf('\n}', sg.indexOf('export async function getBulkRunInputs('))));
  assert.ok(!/catch \{ return null; \}/.test(fn));
  assert.match(fn, /throw e;/);
});

// "A silent catch is a lie in the user's own words" — §1q's own lesson, reintroduced here.
test('a failure to load the rentals is told apart from an old run', () => {
  const src = readFileSync(new URL('../../../frontend/app.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('async function runOrderIndex('),
                       src.indexOf('\n}', src.indexOf('const index = { orders, ordersError')));
  assert.match(fn, /ordersError = 'predates'/, 'an old run says so');
  assert.match(fn, /ordersError = \/409\|no_stored_inputs\//, 'and a failure carries its reason');
  assert.ok(!/\} catch \{ \/\*/.test(fn), 'no bare catch');
});

test('an incomplete statement cannot be sent, not merely warned about', () => {
  const src = readFileSync(new URL('../../../frontend/app.js', import.meta.url), 'utf8');
  assert.match(src, /blockers\.push\(`The rentals could not be loaded for this run/);
  assert.match(src, /so the file would go out with no rental detail/);
});

test('the sheet says which of the two happened', () => {
  const rows = build('th')({ merchantName: 'X', merchants: [], engineResult: {} }, null);
  assert.match(String(rows[rows.length - 1][0]), /individual rentals were not kept/);
});

// ── A fixed fee is paid whether or not anything was rented (2026-10-01) ──────────────────────
// The user's rule, stated plainly: "even with no revenue, we still pay any fixed fee setting,
// including electricity." The engine already does this, and the statement already shows it —
// these pin it so neither can drift.
//
// Live case: Hacco Labo by Marukome, September. One shop, zero rentals, zero revenue, rule
// `GP 30% + Electricity 250`. Paid 250, and the file says 250.
const HACCO = {
  merchantName: 'Hacco Labo by Marukome',
  revenue: 0,
  payout: 250,
  merchants: [{ merchantId: 's1', merchantName: 'ฮัคโคะ ลาโบะ โดย มารุโคเมะ อาคาร E88 ชั้น G',
                model: 'S5', rentals: 0, revenue: 0 }],
  engineResult: { totalPayout: 250 },
};
const ELEC_RULE = { type: 'sum', _method: 'hybrid', children: [
  { type: 'percent', rows: [{ percent: 30, model: 'ALL' }], _t: 'gp' },
  { type: 'flat_per_partner_total', _t: 'elec', amount: 250 },
] };

test('no rentals, no revenue — the fixed fee is still on the statement', () => {
  const rows = build('th')(HACCO, null, ELEC_RULE);
  assert.equal(rows[1][2], 0, 'no rentals');
  assert.equal(rows[1][3], 0, 'no revenue');
  assert.equal(rows[1][7], 250, 'and the fee is still paid, on the shop row');
  assert.equal(rows[2][7], 250, 'and in the Grand Total');
  assert.equal(round(rows[1][5] + rows[1][6]), 250, 'tax splits out of it like any other payment');
});

test('the statement says WHY, so a merchant with no rentals can read it', () => {
  const rows = build('th')(HACCO, null, ELEC_RULE);
  assert.equal(rows[1][4], 'GP 30% + Electricity 250');
});

// This is the line the fake copy got wrong. With nothing to weight by, the payment must still
// land somewhere — never vanish.
test('a payout with no revenue to apportion by is split evenly, not dropped', () => {
  const apportion = new Function(grab('apportion') + 'return apportion;')();
  assert.deepEqual(apportion(250, [0]), [250], 'one shop takes all of it');
  assert.deepEqual(apportion(300, [0, 0, 0]), [100, 100, 100], 'three shops share it');
  assert.equal(apportion(100, [0, 0, 0]).reduce((a, b) => a + b, 0), 100, 'and nothing is lost');
  // The ordinary case is unchanged: weighted by revenue.
  assert.deepEqual(apportion(100, [75, 25]), [75, 25]);
});

test('several shops, no revenue anywhere — every row carries its share', () => {
  const rows = build('th')({
    merchantName: 'Quiet Month', revenue: 0, payout: 900, engineResult: {},
    merchants: [1, 2, 3].map(i => ({ merchantId: 's' + i, merchantName: 'Shop ' + i,
                                     model: 'S8', rentals: 0, revenue: 0 })),
  }, null, { type: 'flat_per_machine', rows: [{ model: 'S8', amount: 300 }], _t: 'placement' });
  assert.deepEqual(rows.slice(1, 4).map(r => r[7]), [300, 300, 300]);
  assert.equal(rows[4][7], 900, 'and they add up to what was paid');
});

// A guarantee behaves the same way: it is a floor, not a share of something.
test('a minimum guarantee with no rentals still reaches the statement', () => {
  const rows = build('th')({
    merchantName: 'MG Only', revenue: 0, payout: 4000, engineResult: {},
    merchants: [{ merchantId: 's1', merchantName: 'Shop', model: 'S8', rentals: 0, revenue: 0 }],
  }, null, { type: 'max', _method: 'hybrid-higher', children: [
      { type: 'percent', rows: [{ percent: 30, model: 'ALL' }], _t: 'gp' },
      { type: 'flat_per_machine', rows: [{ model: 'S8', amount: 4000 }], _t: 'mg' }] });
  assert.equal(rows[1][7], 4000);
  assert.equal(rows[1][4], 'max( GP 30% , MG S8 4,000 )');
});

// Whatever the shape, the document must never disagree with what was paid.
test('the Grand Total always equals the payout, revenue or not', () => {
  for (const [payout, n] of [[250, 1], [900, 3], [0, 2], [4000, 1], [1234.56, 7]]) {
    const rows = build('th')({
      merchantName: 'X', revenue: 0, payout, engineResult: {},
      merchants: Array.from({ length: n }, (_, i) => ({ merchantId: 's' + i, merchantName: 'S' + i,
                                                        model: 'S8', rentals: 0, revenue: 0 })),
    }, null, null);
    const gt = rows.find(r => r[0] === 'Grand Total');
    assert.equal(gt[7], round(payout), `payout ${payout} over ${n} shop(s)`);
  }
});

// ── C5: a merchant that has gone is marked in the file, not dropped (2026-10-01) ─────────────
// "there will be brands or merchants that is not registered anymore, it's ok, because they come
// and go, and we still need to calculate to pay... highlight 'gone' merchants when I click for a
// developed view and in download file."
//
// The line stays and the money stays — a run states what happened in the period. The mark is what
// stops a partner reading it as a mistake.
test('a merchant the latest file no longer carries is marked in the statement', () => {
  const rows = build('th')(PMCU, null, GP20, new Set(['อาคารวิทยกิตติ์']));
  assert.match(String(rows[1][0]), /อาคารวิทยกิตติ์ \(no longer in our list\)/);
  assert.equal(rows[1][7], 284, 'and it is still paid');
  assert.ok(!/no longer/.test(String(rows[2][0])), 'the merchant still carried is untouched');
});

test('with nothing gone, the names are exactly as before', () => {
  const rows = build('th')(PMCU, null, GP20);
  assert.equal(rows[1][0], 'อาคารวิทยกิตติ์');
  assert.equal(rows[2][0], 'ลิโด้ ชั้น 1 บริเวณข้างห้องน้ำ');
});

test('the Grand Total is unchanged by marking', () => {
  const plain = build('th')(PMCU, null, GP20);
  const marked = build('th')(PMCU, null, GP20, new Set(['อาคารวิทยกิตติ์']));
  const gt = (r) => r.find(x => String(x[0]).startsWith('Grand Total'));
  assert.deepEqual(gt(marked).slice(1), gt(plain).slice(1));
});

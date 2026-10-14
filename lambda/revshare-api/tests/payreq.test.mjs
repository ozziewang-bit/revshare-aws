import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mapBank, taxBase, monthWords, buildDraft, draftWarnings } from '../code/payreq.mjs';

const r2 = (v) => Math.round(v * 100) / 100;

test('every live TH bank name maps (values read from RevsharePartner 2026-10-13)', () => {
  const live = { 'ธนาคารกสิกรไทย': 'Kasikorn Bank', 'ธนาคารกสิกร': 'Kasikorn Bank', 'ธนาคารกสิกรำทย': 'Kasikorn Bank',
    'ธนาคารไทยพาณิชย์': 'Siam Commercial Bank', 'ธนาคารกรุงเทพ': 'Bangkok Bank', 'ธนาคารกรุงไทย': 'Krung Thai Bank',
    'ธนาคารกรุงศรี': 'Krungsri Bank', 'ธนาคารทหารไทย': 'TTB Bank', 'ธนาคารอาคารสงเคราะห์': 'Government Housing Bank', 'KBank': 'Kasikorn Bank', 'SCB': 'Siam Commercial Bank' };
  for (const [raw, want] of Object.entries(live)) assert.equal(mapBank(raw, 'th').value, want, raw);
});
test('banks with no dropdown option are unmapped, not guessed', () => {
  for (const raw of ['ธนาคารยูโอบี']) {
    const m = mapBank(raw, 'th'); assert.equal(m.value, null); assert.equal(m.unmapped, true); assert.equal(m.raw, raw);
  }
});
test('"-" and blank are no bank at all', () => {
  for (const raw of ['-', '', '  ', null, undefined]) assert.deepEqual(mapBank(raw, 'th'), { value: null, raw: '', unmapped: false });
});
test('Government Housing Bank by its English names too', () => {
  for (const raw of ['Government Housing Bank', 'GH Bank', 'GHB']) assert.equal(mapBank(raw, 'th').value, 'Government Housing Bank', raw);
});
test('SG banks', () => {
  assert.equal(mapBank('DBS Bank', 'sg').value, 'DBS / POSB');
  assert.equal(mapBank('OVERSEA-CHINESE BANKING CORPORATION LIMITED', 'sg').value, 'OCBC');
  assert.equal(mapBank('UOB', 'sg').value, 'UOB');
});

test('tax base is the statement\'s own base', () => assert.equal(taxBase(1420, 0.07), 1327.10));

// Payment Request totals a line as amount + round2(amount × VAT). About 1 payout in 15 cannot be
// reached by any single amount (0.08: 0.07 → 0.07, 0.08 → 0.09), so the line keeps the
// STATEMENT's base and a VAT-free rounding line of a satang closes the gap.
// Payment Request's arithmetic (calc.mjs, before-VAT discount): base = amount − discount.
const lineBase = (l) => r2((l.amount || 0) - (l.discount || 0));
const pvTotal = (lines) => r2(lines.reduce((s, l) => s + lineBase(l) + r2(lineBase(l) * (l.vatRate || 0)), 0));
test('PV lines total the payout to the satang for every payout 0.01..20,000.00', () => {
  for (let c = 1; c <= 2_000_000; c++) {
    const t = c / 100;
    const { lineItems } = buildDraft({ region: 'th', brand: 'B', payTo: 'B', payout: t, period: '2026-09' });
    if (pvTotal(lineItems) !== t) assert.fail(`payout ${t}: lines total ${pvTotal(lineItems)}`);
    if (lineItems[0].amount !== r2(t / 1.07)) assert.fail(`payout ${t}: base ${lineItems[0].amount} is not the statement's`);
    if (lineItems.some((l) => (l.amount || 0) < 0)) assert.fail(`payout ${t}: negative amount — Payment Request refuses it on submit`);
    if (lineItems.length > 1 && (lineItems.length !== 2 || Math.abs(lineBase(lineItems[1])) !== 0.01 || lineItems[1].vatRate !== 0)) {
      assert.fail(`payout ${t}: unexpected lines ${JSON.stringify(lineItems)}`);
    }
  }
});
test('a payout that needs it gets one rounding line', () => {
  const { lineItems } = buildDraft({ region: 'th', brand: 'B', payTo: 'B', payout: 0.08, period: '2026-09' });
  assert.deepEqual(lineItems.map((l) => [l.amount, l.vatRate]), [[0.07, 0.07], [0.01, 0]]);
  assert.equal(lineItems[1].details, 'Rounding adjustment');
});
test('a satang too many is a discount row, never a negative amount', () => {
  // find a payout whose statement base overshoots by a satang
  let t = 0;
  for (let c = 1; c < 100000 && !t; c++) { const b = r2(c / 100 / 1.07); if (r2(b + r2(b * 0.07)) > c / 100) t = c / 100; }
  assert.ok(t, 'an overshooting payout exists');
  const { lineItems } = buildDraft({ region: 'th', brand: 'B', payTo: 'B', payout: t, period: '2026-09' });
  assert.equal(lineItems[1].amount, undefined);
  assert.equal(lineItems[1].discount, 0.01);
  assert.equal(pvTotal(lineItems), t);
});

test('month words', () => {
  assert.deepEqual(monthWords('2026-09'), { long: 'Sep 2026', short: 'Sep26', lastDay: '2026-09-30' });
  assert.equal(monthWords('2028-02').lastDay, '2028-02-29');
});

test('TH draft is a PV whose total is the payout', () => {
  const d = buildDraft({ region: 'th', brand: 'AOT', payTo: 'Airports of Thailand',
    bank: { name: 'ธนาคารกรุงไทย', number: '123-4-56789-0', accountName: 'AOT PLC' }, payout: 1420, period: '2026-09' });
  assert.equal(d.form, 'PV');
  assert.deepEqual(d.header, { payTo: 'Airports of Thailand', payBank: 'Krung Thai Bank', payAccount: '123-4-56789-0',
    payAccountName: 'AOT PLC', currency: 'THB', details: 'Revenue share — AOT — Sep 2026' });
  assert.deepEqual(d.lineItems, [{ date: '2026-09-30', ref: 'MCRM', details: 'Revenue share Sep 2026', amount: 1327.10, vatRate: 0.07 }]);
});
test('TH unmapped bank keeps the raw name in details and sets no bank', () => {
  const d = buildDraft({ region: 'th', brand: 'X', payTo: 'X', bank: { name: 'ธนาคารยูโอบี' }, payout: 100, period: '2026-09' });
  assert.equal(d.header.payBank, undefined);
  assert.match(d.header.details, /bank: ธนาคารยูโอบี/);
});
test('SG draft is a PES following the licence-fee pattern', () => {
  const d = buildDraft({ region: 'sg', brand: 'Cheers', payTo: 'Cheers', bank: {}, payout: 812.5, period: '2026-09' });
  assert.equal(d.form, 'PES');
  assert.equal(d.header.subject, 'Cheers - ChargeSPOT Revenue Share_Sep26');
  assert.equal(d.header.competenceNo, 'II - 7 - (10) - 5');
  assert.equal(d.header.frequency, 'Monthly');
  assert.equal(d.header.payTo, 'Cheers');
  assert.equal(d.header.currency, 'SGD');
  assert.deepEqual(d.lineItems, [{ description: 'Revenue Share_Sep26', amount: 812.5, vatRate: 0 }]);
});
test('warnings', () => {
  assert.deepEqual(draftWarnings({ region: 'th', entityName: '', bank: {} }),
    ['No contract entity — Pay to uses the Brand name', 'No bank on file']);
  assert.deepEqual(draftWarnings({ region: 'th', entityName: 'E', bank: { name: 'ธนาคารยูโอบี' } }),
    ['Bank "ธนาคารยูโอบี" is not in Payment Request\'s list — finance picks it']);
  assert.deepEqual(draftWarnings({ region: 'th', entityName: 'E', bank: { name: 'ธนาคารกรุงไทย' } }), []);
});
test('TH tax rate agrees with the statement (frontend TAX)', () => {
  const app = readFileSync(new URL('../../../frontend/app.js', import.meta.url), 'utf8');
  assert.match(app, /th: \{ rate: 0\.07, mode: 'inclusive' \}/);
});

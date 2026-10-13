// payreq.mjs — what a Payment Request draft for one Brand and one month contains. Pure.
//
// Thailand files a Payment Voucher (PV); Singapore a Payment Expense & Settlement (PES), worded
// like the mall licence fees Singapore already files there (spec 2026-10-13, §3).

export const PR_FORM = { th: 'PV', sg: 'PES' };
// The statement's TAX.th (frontend/app.js): the payout is VAT-INCLUSIVE at 7%. A test reads
// app.js so the two cannot drift apart.
const TH_VAT = 0.07;
const SG_COMPETENCE_NO = 'II - 7 - (10) - 5';
const round2 = (v) => Math.round(Number(v) * 100) / 100;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Payment Request's bank dropdown values, and the ways MCRM's free-text Finance Information
// names them (mostly Thai, one live misspelling: กสิกรำทย). A name that matches nothing is
// reported as unmapped — never guessed at.
const TH_BANKS = [
  [/กสิกร|kasikorn|kbank/i, 'Kasikorn Bank'],
  [/ไทยพาณิชย์|siam commercial|\bscb\b/i, 'Siam Commercial Bank'],
  [/กรุงเทพ|bangkok bank|\bbbl\b/i, 'Bangkok Bank'],
  [/กรุงไทย|krung ?thai|\bktb\b/i, 'Krung Thai Bank'],
  [/กรุงศรี|krungsri|ayudhya|\bbay\b/i, 'Krungsri Bank'],
  [/ทหารไทย|ธนชาต|\bttb\b|\btmb\b/i, 'TTB Bank'],
  [/พร้อมเพย์|prompt ?pay/i, 'Prompt Pay'],
];
const SG_BANKS = [
  [/\bdbs\b|posb/i, 'DBS / POSB'], [/ocbc|oversea-chinese/i, 'OCBC'], [/\buob\b|united overseas/i, 'UOB'],
  [/standard chartered/i, 'Standard Chartered'], [/hsbc/i, 'HSBC'], [/maybank/i, 'Maybank'],
  [/citi/i, 'Citibank'], [/paynow/i, 'PayNow'],
];

export function mapBank(raw, region) {
  const s = String(raw ?? '').trim();
  if (!s || s === '-') return { value: null, raw: '', unmapped: false };
  for (const [re, value] of (region === 'sg' ? SG_BANKS : TH_BANKS)) if (re.test(s)) return { value, raw: s, unmapped: false };
  return { value: null, raw: s, unmapped: true };
}

// The statement's own tax base: payout ÷ (1 + rate), exactly as splitTax computes it. Kept
// identical so the PV and the statement show the same base.
export function taxBase(total, rate) {
  return round2(round2(total) / (1 + rate));
}

// Payment Request totals a line as amount + round2(amount × VAT), and about 1 payout in 15 is
// a total no single amount can reach (0.08: 0.07 → 0.07, 0.08 → 0.09). Rather than move the base
// off the statement's, a VAT-free line carries the satang, so the request totals the payout.
function thLines(payout, w) {
  const t = round2(payout);
  const base = taxBase(t, TH_VAT);
  const lines = [{ date: w.lastDay, ref: 'MCRM', details: `Revenue share ${w.long}`, amount: base, vatRate: TH_VAT }];
  const gap = round2(t - round2(base + round2(base * TH_VAT)));
  // A satang short is an amount; a satang over is a DISCOUNT row — Payment Request refuses a
  // negative amount on submit, and a discount row is how its vouchers show a reduction.
  if (gap > 0) lines.push({ date: w.lastDay, ref: 'MCRM', details: 'Rounding adjustment', amount: gap, vatRate: 0 });
  if (gap < 0) lines.push({ date: w.lastDay, ref: 'MCRM', details: 'Rounding adjustment', discount: -gap, vatRate: 0 });
  return lines;
}

export function monthWords(period) {
  const [y, m] = String(period).split('-').map(Number);
  const mon = MONTHS[m - 1];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { long: `${mon} ${y}`, short: `${mon}${String(y).slice(2)}`, lastDay: `${period}-${String(last).padStart(2, '0')}` };
}

export function buildDraft({ region, brand, payTo, bank = {}, payout, period }) {
  const w = monthWords(period);
  const b = mapBank(bank.name, region);
  const bankHeader = {
    ...(b.value ? { payBank: b.value } : {}),
    ...(bank.number ? { payAccount: String(bank.number).trim() } : {}),
    ...(bank.accountName ? { payAccountName: String(bank.accountName).trim() } : {}),
  };
  if (region === 'sg') {
    return {
      form: 'PES',
      header: { subject: `${brand} - ChargeSPOT Revenue Share_${w.short}`, competenceNo: SG_COMPETENCE_NO,
        frequency: 'Monthly', payTo, ...bankHeader, currency: 'SGD',
        ...(b.unmapped ? { remarks: `Bank on file: ${b.raw}` } : {}) },
      lineItems: [{ description: `Revenue Share_${w.short}`, amount: round2(payout), vatRate: 0 }],
    };
  }
  return {
    form: 'PV',
    header: { payTo, ...bankHeader, currency: 'THB',
      details: `Revenue share — ${brand} — ${w.long}${b.unmapped ? ` · bank: ${b.raw}` : ''}` },
    lineItems: thLines(payout, w),
  };
}

// What the run page says about a Brand before you create its request. None of these block it:
// the bank fields are optional on both forms, and finance completes what is missing.
export function draftWarnings({ region, entityName, bank = {} }) {
  const out = [];
  if (!String(entityName || '').trim()) out.push('No contract entity — Pay to uses the Brand name');
  const b = mapBank(bank.name, region);
  if (b.unmapped) out.push(`Bank "${b.raw}" is not in Payment Request's list — finance picks it`);
  else if (!b.value) out.push('No bank on file');
  return out;
}

// Pure contract-sheet normalizer + partner matcher. No AWS imports — unit-tested.
// Source: the `All_Merchant` sheet of the merchant workbook. Two header rows; data
// starts at row 3. The browser sends raw positional cell arrays; every coercion is here.

// Sheet order. `_dead` marks columns that are empty or broken in all 208 rows and are
// deliberately not carried: A (No — #NAME?), P (COC Clause), V (unlabeled).
export const CONTRACT_COLUMNS = Object.freeze([
  '_dead', 'merchantName', 'merchantType', 'counterParty', 'installedUnits',
  'S5', 'S8', 'M10', 'LL20', 'LL40',
  'startDate', 'endDate', 'terminationNoticeDays', 'declineToRenew', 'autoRenewal',
  '_dead', 'shareMode', 'revSharePct', 'fixedRental', 'electricity', 'minGuarantee',
  '_dead', 'contractLink',
]);

const str = v => {
  const s = v == null ? '' : String(v).trim();
  return s === '' ? null : s;
};
const num = v => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const bool = v => v === true || String(v).trim().toLowerCase() === 'true';

// Excel's 1900 date system, with its deliberate leap-year bug: serial 60 is the
// non-existent 1900-02-29, so serials above it are one day ahead of the true count.
const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);
function toDate(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) {
    return new Date(EXCEL_EPOCH_UTC + Math.round(v) * 86400000).toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];          // date-only or ISO datetime — take the date part as written
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export function normalizeContractRow(cells) {
  const at = i => (Array.isArray(cells) ? cells[i] : undefined);
  const merchantName = str(at(1));
  if (!merchantName) return null;   // blank name => not a merchant row

  const units = {};
  for (const [i, model] of [[5, 'S5'], [6, 'S8'], [7, 'M10'], [8, 'L20'], [9, 'L40']]) {
    const n = num(at(i));
    if (n != null) units[model] = n;
  }

  return {
    merchantName,
    merchantType: str(at(2)),
    counterParty: str(at(3)),
    installedUnits: num(at(4)),
    units,
    startDate: toDate(at(10)),
    endDate: toDate(at(11)),
    terminationNoticeDays: num(at(12)),
    declineToRenew: bool(at(13)),
    autoRenewal: str(at(14)),
    contractLink: str(at(22)),
    // Preview only. Never written to a partner rule — see the plan's Global Constraints.
    sheetTerms: {
      shareMode: str(at(16)),
      revSharePct: num(at(17)),
      fixedRental: num(at(18)),
      electricity: num(at(19)),
      minGuarantee: num(at(20)),
    },
  };
}

const key = s => String(s || '').toLowerCase().trim();

export function matchContracts(rows, partners) {
  const byName = new Map((partners || []).map(p => [key(p.name), p]));
  const matched = [], unmatched = [];
  for (const row of rows || []) {
    if (!row) continue;
    const p = byName.get(key(row.merchantName));
    if (p) matched.push({ row, partnerId: p.partnerId, partnerName: p.name });
    else unmatched.push(row);
  }
  return { matched, unmatched };
}

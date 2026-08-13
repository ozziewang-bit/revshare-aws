// Pure contract-sheet normalizer + partner matcher. No AWS imports — unit-tested.
// Source: the `All_Merchant` sheet of the merchant workbook. Two header rows; data
// starts at row 3. The browser sends raw positional cell arrays; every coercion is here.
//
// Column layout (sheet order; A=0). `normalizeContractRow` below reads these indices
// directly via `at(i)` — there is deliberately no separate column-name table: a constant
// that merely lists field names in order pins nothing (nothing reads it, so editing the
// normalizer's indices silently desyncs it from a name list no test can catch), so it was
// removed rather than kept as decoration. The frontend's `parseAllMerchantSheet` checks
// two header anchors (col 1 = "Merchant", col 22 = "Link Contract") before parsing, which
// is the actual defense against a shifted column layout.
//   A=_dead(No/#NAME?) B=merchantName C=merchantType D=counterParty E=installedUnits
//   F-J=S5,S8,M10,LL20,LL40  K=startDate L=endDate M=terminationNoticeDays
//   N=declineToRenew O=autoRenewal P=_dead(COC Clause) Q=shareMode R=revSharePct
//   S=fixedRental T=electricity U=minGuarantee V=_dead(unlabeled) W=contractLink

const str = v => {
  const s = v == null ? '' : String(v).trim();
  return s === '' ? null : s;
};
const num = v => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
// A blank cell means "not recorded", not "false". Mapping it to `false` made every import
// rewrite the flag on rows the sheet says nothing about — a download/edit/upload round trip
// churned 40 rows to no effect — and let a sparse duplicate row contribute a `false` the
// intra-batch merge could not tell from a real one. An explicit FALSE still reads as false.
const bool = v => {
  if (v == null || v === '') return null;
  return v === true || String(v).trim().toLowerCase() === 'true';
};

// The sheet writes auto-renewal as "Yes" or "No (Need to contact)". The app treats this as
// a plain yes/no — the parenthetical is an instruction, not a third state — so collapse it
// to 'Yes' / 'No' on the way in. Anything unrecognised is preserved verbatim rather than
// guessed at, so a new vocabulary shows up as itself instead of being silently mapped.
const autoRenewal = v => {
  const s = str(v);
  if (!s) return null;
  if (/^y/i.test(s)) return 'Yes';
  if (/^n/i.test(s)) return 'No';
  return s;
};

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

// The template download writes a filled-in sample row so the expected format is visible
// where you type, rather than on a sheet nobody opens. Data starts at row 3 and every row
// with a name is imported, so there is no header trick that would hide it — the sample is
// skipped by name instead. Without this, uploading a template you forgot to clean leaves a
// junk merchant in production. Keep in step with EXAMPLE_ROW in frontend/app.js.
const EXAMPLE_ROW_NAME = /^example row\b/i;

export function normalizeContractRow(cells) {
  const at = i => (Array.isArray(cells) ? cells[i] : undefined);
  const merchantName = str(at(1));
  if (!merchantName) return null;   // blank name => not a merchant row
  if (EXAMPLE_ROW_NAME.test(merchantName)) return null;

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
    autoRenewal: autoRenewal(at(14)),
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

// Turn normalized sheet rows into create/update sets. Pure — no IO, so it is unit-tested.
// `links` maps a lowercased sheet merchant name to a partnerId the user picked in the
// review step, for names that did not match automatically.
// Share terms are deliberately absent from everything this returns.
export function buildImportPlan(rows, existingContracts, partners, links = {}) {
  const byName = new Map((partners || []).map(p => [key(p.name), p]));
  const byContract = new Map((existingContracts || []).map(c => [c.merchantNameLower, c]));
  const creates = [], updates = [], unmatched = [];
  // Tracks entries already planned in *this* call, keyed the same way as byContract, so
  // that two sheet rows for the same merchant (e.g. the real sheet's duplicate "IMPACT"
  // rows) merge into one planned row instead of racing to create two DB rows.
  const planned = new Map();

  for (const row of rows || []) {
    if (!row) continue;
    const k = key(row.merchantName);
    const override = Object.prototype.hasOwnProperty.call(links, k) ? links[k] : undefined;
    const auto = byName.get(k);
    const existing = byContract.get(k);   // hoisted so a previously-linked row isn't unlinked below
    // Precedence: an explicit review-step override always wins; failing that, a fresh
    // name match; failing that, keep whatever partnerId this contract already had (e.g.
    // a manually-linked row whose sheet name no longer auto-matches, or whose partner was
    // since archived and so no longer appears in `partners`) — never fall through to null
    // just because this re-import didn't independently re-derive the link.
    const partnerId = override !== undefined ? override
      : (auto ? auto.partnerId : (existing ? (existing.partnerId ?? null) : null));
    if (partnerId == null && override === undefined && !auto) unmatched.push(row.merchantName);

    const { sheetTerms, ...contractFields } = row;   // drop preview-only terms

    const already = planned.get(k);
    if (already) {
      // Later row in the batch wins per field — but only where it actually carries a value.
      // The real sheet holds SPARSE duplicates: a second "Future Rangsit" line with nothing
      // but the counter party filled in. A blind Object.assign let those blanks erase the
      // populated row's dates, unit counts and auto-renewal (it did, on the 2026-08-10
      // import). Blank is null/undefined/'', and for `units` an object with no entries,
      // since normalizeContractRow emits {} for a row with no model counts.
      // Caveat: `declineToRenew` comes from `bool()`, which maps a blank cell to `false`
      // rather than null, so a sparse row still contributes false there. Distinguishing the
      // two needs a change in the normalizer, not here.
      for (const [f, v] of Object.entries(contractFields)) {
        if (v === null || v === undefined || v === '') continue;
        if (f === 'units' && Object.keys(v).length === 0) continue;
        already[f] = v;
      }
      already.partnerId = partnerId;
      continue;
    }

    const entry = existing
      ? { ...existing, ...contractFields, partnerId }
      : { ...contractFields, partnerId, notes: '' };
    (existing ? updates : creates).push(entry);
    planned.set(k, entry);
  }
  return { creates, updates, unmatched };
}

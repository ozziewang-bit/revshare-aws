import { compileRule } from './rules.mjs';
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
//   N=_dead(declineToRenew) O=autoRenewal P=_dead(COC Clause) Q=shareMode R=revSharePct
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

// Columns 23+ are addressed by HEADER NAME, not position (2026-08-27). Positions 0-22 stay
// index-addressed so every existing workbook keeps importing unchanged, but the appended block
// carries per-model Placement/MG/Units columns whose NUMBER varies by region — Thailand has no
// S10-A, Singapore has no T35 — and a per-region column count cannot live at a fixed index.
// `header` is header row 2. Omit it and the function behaves exactly as it did before.
const hkey = s => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
function headerReader(cells, header) {
  const idx = new Map();
  (header || []).forEach((h, i) => { const k = hkey(h); if (k && i >= 23 && !idx.has(k)) idx.set(k, i); });
  const get = name => { const i = idx.get(hkey(name)); return i == null ? undefined : (Array.isArray(cells) ? cells[i] : undefined); };
  // Every appended column whose header starts with `prefix ` — e.g. "Placement S8" -> S8.
  const byPrefix = prefix => {
    const out = [];
    const want = hkey(prefix) + ' ';        // idx keys are normalised, so the prefix must be too
    for (const [k, i] of idx) {
      if (!k.startsWith(want)) continue;
      const model = String(header[i]).trim().slice(prefix.length).trim();
      const amount = num(cells?.[i]);
      if (model && amount != null) out.push({ model, amount });
    }
    return out;
  };
  return { get, byPrefix, present: idx.size > 0 };
}

// Grid-shaped sheets (2026-08-27) mirror the Merchant view: same column order, row 1 carrying
// the grid's category names, and every column addressed BY NAME. Machine columns are blank
// slots under the "Machines" category — whatever model code the user types in row 2 is the
// model, which is what lets one sheet serve both regions without the app dictating the list.
//
// The old 23-column layout is positional, so it is kept as a fallback: files already in
// circulation must keep importing. `Link Contract` in column 22 is what tells them apart.
const GRID_FIELDS = {
  // Both the old and current header wording, so a sheet exported before the 2026-09-03 rename
  // still imports. Headers are matched by name, which is exactly what makes that cheap.
  'merchant': 'merchantName', 'merchant/brand': 'merchantName',
  'type': 'merchantType', 'merchant type': 'merchantType',
  'counter party': 'counterParty', 'contract entity': 'counterParty',
  'contact': 'contactName', 'phone': 'contactPhone', 'email': 'contactEmail',
  'sales person': 'salesPerson', 'salesperson': 'salesPerson', 'branch': 'branchCount',
  'units': 'installedUnits', 'start': 'startDate', 'end': 'endDate',
  'notice': 'terminationNoticeDays', 'auto-renewal': 'autoRenewal', 'contract': 'contractLink',
};
const isLegacySheet = header => /link/i.test(String((header || [])[22] ?? ''));

function normalizeGridRow(cells, header, groups) {
  const at = i => (Array.isArray(cells) ? cells[i] : undefined);
  const g = i => hkey((groups || [])[i]);
  const out = { units: {} };
  let mode = null, noPayout = null;
  const termCells = { gp: null, electricity: null, others: null, placementRows: [], mgRows: [] };

  for (let i = 0; i < header.length; i++) {
    const name = hkey(header[i]);
    if (!name) continue;
    // A machine column is identified by its CATEGORY, not its header — the header is the model
    // code the user chose. Without this, "Units" (the total) would become units.Units.
    if (g(i) === 'machines' && name !== 'units') {
      const n = num(at(i));
      if (n != null) out.units[String(header[i]).trim().toUpperCase()] = n;
      continue;
    }
    if (name === 'mode') { mode = at(i); continue; }
    if (name === 'no payout') { noPayout = at(i); continue; }
    // Share terms are structured columns, one per term and per machine model — a single text
    // column proved too coarse to edit. Placement/MG name their model in the header.
    if (name === 'gp %' || name === 'gp%') { termCells.gp = num(at(i)); continue; }
    if (name === 'electricity') { termCells.electricity = num(at(i)); continue; }
    if (name === 'others' || name === 'other') { termCells.others = num(at(i)); continue; }
    if (name.startsWith('placement ')) {
      const amt = num(at(i));
      if (amt != null) termCells.placementRows.push({ model: String(header[i]).trim().slice('Placement'.length).trim().toUpperCase(), amount: amt });
      continue;
    }
    if (name.startsWith('mg ')) {
      const amt = num(at(i));
      if (amt != null) termCells.mgRows.push({ model: String(header[i]).trim().slice('MG'.length).trim().toUpperCase(), amount: amt });
      continue;
    }
    const field = GRID_FIELDS[name];
    if (!field) continue;
    const v = field === 'installedUnits' || field === 'terminationNoticeDays' || field === 'branchCount' ? num(at(i))
            : field === 'startDate' || field === 'endDate' ? toDate(at(i))
            : field === 'autoRenewal' ? autoRenewal(at(i))
            : str(at(i));
    if (v != null) out[field] = v;
  }

  if (!out.merchantName) return null;
  if (EXAMPLE_ROW_NAME.test(out.merchantName)) return null;
  Object.assign(out, termsFields(mode, noPayout, termCells));
  return out;
}

export function normalizeContractRow(cells, header, groups) {
  if (Array.isArray(header) && !isLegacySheet(header)) return normalizeGridRow(cells, header, groups);
  return normalizeLegacyRow(cells);
}

// The pre-2026-08-27 sheet: 23 columns read by POSITION, with revenue-share terms present but
// never imported. Files in circulation still use it, so it keeps working exactly as it did —
// including not touching terms. Nothing here reads a header; the grid shape is where names are.
function normalizeLegacyRow(cells) {
  const at = i => (Array.isArray(cells) ? cells[i] : undefined);
  const merchantName = str(at(1));
  if (!merchantName) return null;   // blank name => not a merchant row
  if (EXAMPLE_ROW_NAME.test(merchantName)) return null;

  const units = {};
  for (const [i, model] of [[5, 'S5'], [6, 'S8'], [7, 'M10'], [8, 'L20'], [9, 'L40']]) {
    const n = num(at(i));
    if (n != null) units[model] = n;
  }
  // Models with no fixed column arrive through the header-named "Units <model>" block.


  return {
    merchantName,
    merchantType: str(at(2)),
    counterParty: str(at(3)),
    installedUnits: num(at(4)),
    units,
    startDate: toDate(at(10)),
    endDate: toDate(at(11)),
    terminationNoticeDays: num(at(12)),
    autoRenewal: autoRenewal(at(14)),
    contractLink: str(at(22)),
    // Preview only. Never written to a partner rule — see the plan's Global Constraints.
    // These are the ORIGINAL columns 16-20, which the importer has always ignored; the
    // importable terms are the appended, header-named ones below.
    sheetTerms: {
      shareMode: str(at(16)),
      revSharePct: num(at(17)),
      fixedRental: num(at(18)),
      electricity: num(at(19)),
      minGuarantee: num(at(20)),
    },
  };
}

const AGG_MODES = new Set(['whole', 'per_store']);
const METHODS = new Set(['default', 'hybrid', 'higher', 'hybrid-higher']);
const METHOD_CODES = { d: 'default', h: 'hybrid', wh: 'higher', hh: 'hybrid-higher' };
// The Mode column is written with the same human label the grid shows, so the sheet must read
// those back. Keep in step with PAYOUT_METHOD_META in frontend/app.js.
const METHOD_NAMES = { 'default': 'default', 'hybrid': 'hybrid', 'whichever is higher': 'higher', 'hybrid-higher': 'hybrid-higher' };

// The Share terms block -> rule / noPayout.
function termsFields(modeCell, noPayoutCell, t) {
  const out = {};
  const rawMethod = String(str(modeCell) ?? '').toLowerCase();
  const method = METHODS.has(rawMethod) ? rawMethod : METHOD_CODES[rawMethod] || METHOD_NAMES[rawMethod];

  const noPay = String(str(noPayoutCell) ?? '').toLowerCase();
  if (['y', 'yes', 'true', '1'].includes(noPay)) { out.noPayout = true; return out; }
  if (noPay) out.noPayout = false;

  // A rule is built ONLY when the sheet actually states a term. Every term cell blank leaves
  // `rule` absent, so an upload can never clear terms by omission — the single most dangerous
  // thing an importer that can write rules could do.
  const said = [t.gp, t.electricity, t.others].some(v => v != null) || t.placementRows.length || t.mgRows.length;
  if (said) {
    out.rule = compileRule({ gpPercent: t.gp, electricity: t.electricity, others: t.others,
                             placementRows: t.placementRows, mgRows: t.mgRows, method });
    out.noPayout = false;
  }
  return out;
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

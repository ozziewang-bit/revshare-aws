# Bulk Run & Merchant Registry — Design Spec

Date: 2026-05-29

## 1. Problem

Finance currently uploads a CSV per partner (50+ partners) and runs calculations one at a time. The real operational data export (order report from ChargeSpot system) contains all merchants across all partners in one file. The goal is to upload once, route each merchant to its partner's rule, and get a full payout breakdown for all partners in a single run.

## 2. Scope

- **Merchant registry** — new first-class entity: a merchant belongs to one partner, has a machine model
- **Structured rule editor** — replace the current leaf-card editor with a form that covers all real contract shapes
- **Excel import** — bootstrap partners + merchants from the KA cost rate Excel (Rev Share sheet)
- **Bulk run** — upload one order report Excel, get per-partner payouts in one shot
- **UI** — merchant management tab, import screen, bulk run screens

Out of scope: multi-currency bulk runs, automated scheduling, CloudFront/custom domain.

## 3. Source Data

### Order report (transaction input)
Exported from ChargeSpot system. Columns used:

| Column | Use |
|---|---|
| `Rental Merchant` | Merchant name (Thai) — match key to registry |
| `Net Amount` | Revenue per order (THB) |
| `Payment Status` | Filter: keep `Paid` only |

Rentals = count of matching rows per merchant. Revenue = sum of `Net Amount`.

### KA cost rate Excel (import source)
Sheet: **Rev Share**. Columns used:

| Column | Maps to |
|---|---|
| `ID` | Stored as `externalId` on merchant record (reference only — not used as match key) |
| `merchant name.` | Merchant name (match key for order report lookup) |
| `Merchant label (TAG)` | Partner name (group) |
| `Device Type` | Machine model (parse: "Advertising Player-S5" → S5, "ChargeSpot Station-S8" → S8, "Advertising Player-L20" → L20, "Advertising Player-L40" → L40) |
| `Rev share %` | GP% for percent leaf |
| `Trigger Type` | A = GP only, B = MAX(GP, MG) |
| `Placement (monthly)` | For Type B: this value is the minimum guarantee (flat_per_machine). For Type A: it is a fixed monthly placement fee (flat_per_partner_total). Import infers usage from Trigger Type. |
| `Electricity (monthly)` | Monthly electricity fee (flat_per_partner_total, always additive) |

## 4. Data Model

Single DynamoDB table `RevsharePartner`. New row family:

| pk | sk | Fields |
|---|---|---|
| `MERCHANT` | `MERCHANT#<merchantId>` | `merchantId` (ulid), `name` (original Thai string), `nameLower` (normalized for matching), `partnerId`, `machineModel` (S5/S8/S10/T8/T10/T20/T35/L20/L40), `notes?`, `createdAt`, `updatedAt` |

New bulk run row family:

| pk | sk | Fields |
|---|---|---|
| `BULKRUN` | `BULKRUN#<runId>` | `runId`, `periodStart`, `periodEnd`, `uploadedAt`, `orderCount`, `merchantCount`, `partnerCount`, `results` (array of per-partner result), `unmatched` (array of unrecognized merchant names), `ruleSnapshots` (map of partnerId → rule at calc time) |

Partner rows (`PARTNER` / `META#<partnerId>`) are unchanged.

## 5. Rule Structure

All partner rules compile to a rule tree understood by the existing engine. The structured form maps to:

```
SUM [
  MAX [                               ← only if minimum guarantee is enabled
    { type: "percent", rate: 0.25 },
    { type: "flat_per_machine", amount: 200 }
  ],
  { type: "percent", rate: 0.25 },    ← replaces the MAX block if no MG
  { type: "flat_per_partner_total", amount: 600 },   ← electricity, only if > 0
  { type: "flat_per_partner_total", amount: 3300 },  ← placement, only if > 0
  { type: "flat_per_partner_total", amount: 500 },   ← others, only if > 0
]
```
Zero-amount leaves are omitted from the tree entirely.

The rule form fields:

| Field | Type | Notes |
|---|---|---|
| GP% | number 0–100 | Required. Becomes `percent` leaf |
| Minimum guarantee | toggle + THB amount | If on, wraps GP% leaf in `max` with `flat_per_machine` |
| Monthly electricity | THB (0 = off) | `flat_per_partner_total` |
| Monthly placement | THB (0 = off) | `flat_per_partner_total` |
| Monthly others | THB (0 = off) | `flat_per_partner_total` |
| Aggregation mode | whole / per_store | Existing field, unchanged |

Raw JSON escape hatch remains available for unusual cases not covered by the form.

## 6. API Routes

New routes added to the existing Lambda:

| Method | Path | Purpose |
|---|---|---|
| GET | `/merchants` | List all merchants (with partnerId, model) |
| POST | `/merchants` | Create merchant |
| GET | `/merchants/:id` | Get merchant |
| PUT | `/merchants/:id` | Update merchant (name, model, partnerId, notes) |
| DELETE | `/merchants/:id` | Delete merchant |
| POST | `/import/rev-share` | Import KA Excel → create partners + merchants. Body: `{ excelBase64, periodStart?, periodEnd? }`. Returns: `{ created, skipped, warnings }` |
| POST | `/bulk-runs` | Create bulk run. Body: `{ excelBase64, periodStart, periodEnd }` (order report Excel). Returns bulk run record. |
| GET | `/bulk-runs` | List bulk runs (summary only, no full results) |
| GET | `/bulk-runs/:runId` | Get one bulk run (full results + unmatched) |

## 7. Import Logic

`POST /import/rev-share`:

1. Parse Rev Share sheet row by row
2. For each unique TAG → look up or create partner:
   - If partner with same name exists: **skip** (do not overwrite rule), add to `skipped` list
   - If new: create partner with rule compiled from GP%, trigger type, electricity, placement
3. For each merchant row → upsert merchant record:
   - Match by `nameLower` (normalized name); if exists, update model + partnerId
   - If new: create with ulid
4. Return summary: partners created, partners skipped, merchants upserted, warnings (rows with missing TAG or unparseable device type)

Machine model parsing from Device Type string:
- "Advertising Player-S5" → S5
- "ChargeSpot Station-S8" → S8
- "Advertising Player-L20" → L20 (note: Excel may use "LL20" — normalize both)
- "Advertising Player-L40" → L40 (normalize "LL40")
- Unrecognized → warning, merchant created without model

## 8. Bulk Run Logic

`POST /bulk-runs` (order report Excel):

1. Parse order report: filter `Payment Status = 'Paid'`, skip header
2. Normalize each `Rental Merchant` name (lowercase, trim)
3. Aggregate: `{ [nameLower]: { name, rentals: count, revenue: sum(Net Amount) } }`
4. For each merchant name: look up `MERCHANT#` record by `nameLower`
   - Match found: attach partnerId + machineModel
   - No match: add to `unmatched[]`
5. Group matched merchants by partnerId
6. For each partner: fetch partner record (rule + aggregationMode); build CSV rows (one row per merchant: storeId=merchantId, machineSerial=merchantId, model=machineModel, rentals, revenue); run `evaluateRun` from existing engine
7. Store bulk run record with all per-partner results + ruleSnapshots + unmatched
8. Return full bulk run record

If a partner has merchants but no rule configured: add to warnings, skip that partner's calculation.

## 9. Frontend Screens

### Partners list (existing — minor change)
- Add merchant count badge next to each partner name

### Partner detail (existing — add tab)
- New "Merchants" tab alongside existing "Runs" tab
- Lists merchants belonging to this partner: name, machine model, edit/delete actions
- "Add merchant" button → opens add merchant form

### Add / edit merchant form
- Fields: Name (text), Machine model (dropdown: S5/S8/S10/T8/T10/T20/T35/L20/L40), Partner (dropdown of existing partners), Notes (optional)

### Rule editor (replace existing leaf-card editor)
- Structured form as described in §5
- "Advanced (raw JSON)" toggle for escape hatch
- Import pre-fills this form; user can edit freely after

### Import screen (new — top-level nav)
- File upload for KA cost rate Excel (.xlsx)
- On upload: show preview table (partners to create, merchants to upsert, warnings)
- Confirm button → runs import → shows result summary

### Bulk runs list (new — top-level nav)
- Table: date, period, partner count, total payout, unmatched count
- Click row → bulk run detail

### Bulk run detail (new)
- Header: period, uploaded at, order count
- Per-partner table: partner name, merchant count, rentals, revenue, payout
- Unmatched merchants warning panel (if any): list of names with "Add to registry" shortcut
- Download PDF button (reuses existing PDF logic per partner)

## 10. Critical Rules

1. **Rule snapshots per bulk run** — same discipline as per-partner runs. Each bulk run stores the rule used for each partner at calc time. Editing a partner's rule later does not change old bulk run results.
2. **Unmatched merchants are never silently dropped** — always surfaced in the result so finance knows what was excluded.
3. **Import never overwrites existing partner rules** — only creates new partners. Merchant records are upserted (safe to re-import).
4. **Machine model on merchant record is the source of truth** — the order report does not contain machine model; it must come from the registry.
5. **Normalization for name matching** — always lowercase + trim before comparing merchant names. Store `nameLower` field on merchant records for efficient lookup.

## 11. DynamoDB Merchant Lookup

Merchants are stored under `pk=MERCHANT`. To look up a merchant by `nameLower` during bulk run, the backend scans all `MERCHANT` rows once at the start of the run and builds an in-memory map `{ nameLower → merchant }`. This is efficient enough given the expected scale (~1,000–2,000 merchants). A GSI is not needed at this scale.

## 12. Lambda Timeout

The existing Lambda timeout is 30 seconds. A bulk run with 1,000+ orders and 50+ partners involves one full-table scan + 50+ DynamoDB reads + engine evaluations. If this approaches the limit in practice, the timeout should be raised to 60 seconds (still within API Gateway's 29-second limit for synchronous responses — consider async pattern if needed). Flag during implementation if benchmarks show it's a risk.

## 13. Known Limitations

- Name matching is fuzzy by necessity (Thai strings). If the order report uses a slightly different spelling, the merchant will appear as unmatched. The unmatched panel + "Add to registry" shortcut is the mitigation.
- Bulk run PDF is per-partner only (no single consolidated PDF across all partners).
- Import parses only the Rev Share sheet; Agreement sheet data (contract dates, bank accounts) is not imported.

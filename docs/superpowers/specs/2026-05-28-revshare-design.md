# Revenue-Share Calculator — Design Spec

**Date:** 2026-05-28
**Status:** Approved for implementation planning
**Project:** `~/Projects/revshare-aws` (greenfield)

## 1. Purpose

A platform for ChargeSpot's finance team to calculate per-partner revenue
shares from CSV exports of per-machine rental and revenue data. Each partner
has a unique revenue-share rule (configured in the platform once, edited as
contracts change); the platform applies that rule to an uploaded CSV and
produces an auditable payout breakdown plus a printable per-partner
statement.

## 2. Stack

House style, matching `expense` and `portfolio-aws`:

- **Frontend:** static SPA served from S3 behind CloudFront. Vanilla JS +
  HTML + CSS; no build step for v1 (precompile via esbuild if it grows
  large later, per the portfolio precedent).
- **Backend:** single Node.js 22.x Lambda (`revshare-api`) behind API
  Gateway HTTP API. All routes in one handler.
- **Storage:** DynamoDB single-table (`RevsharePartner`), partition key
  `pk` / sort key `sk`. Same modeling pattern as the portfolio app's
  `PortfolioTable`.
- **CSV ingestion:** parsed directly in Lambda from the POST body. CSVs are
  small (a few hundred rows × ~80 chars ≈ 50 KB). No separate S3 upload
  step.
- **Auth:** single shared password, scrypt-hashed in SSM SecureString at
  `/revshare/auth-hash`. `x-app-password` header on every request. 30-day
  session in `localStorage`. 5 failed attempts/minute IP rate limit (same
  pattern as `expense`).
- **PDF statements:** generated client-side via `html2canvas` + `jsPDF`
  (CDN-loaded), same approach as the `portfolio-aws` Summary one-pager.
  Server stays simple — no Puppeteer.
- **Deploy:** direct AWS CLI (no CDK for v1). One-shot deploy script
  per artifact type, matching `expense`.
- **PWA shell:** service worker for offline-shell + cache busting on
  every shell change (same `CACHE_VERSION` discipline as `expense`).

Domain TBD — `revshare.example.com` is the natural choice.

## 3. Data model — DynamoDB single-table

Three row families. Composite key `(pk, sk)`.

### 3.1 Partners

```
pk = "PARTNER"
sk = "META#<partnerId>"

{
  partnerId: ULID,                         // immutable
  name: string,
  currency: "TWD" | "USD" | "HKD" | "IDR" | ...,  // ISO-4217, partner-fixed
  aggregationMode: "whole" | "per_store",
  rule: RuleNode,                          // see §4
  notes?: string,
  archived: boolean,
  createdAt: ISO-8601,
  updatedAt: ISO-8601
}
```

### 3.2 Calculation runs

```
pk = "RUN#<partnerId>"
sk = "RUN#<runId>"                         // runId = ULID, chronological by sk

{
  runId, partnerId,
  periodStart, periodEnd,                  // ISO dates, declared at upload time
  uploadedAt: ISO-8601,
  csvRaw: string,                          // base64 of original CSV bytes
  csvParsed: Array<{
    storeId: string,
    machineSerial: string,
    model: MachineModel,
    rentals: number,
    revenue: number
  }>,
  ruleSnapshot: RuleNode,                  // partner.rule at calc time (frozen)
  result: {
    totalPayout: number,
    byStore: Array<{                       // present when aggregationMode = per_store
      storeId: string,
      payout: number,
      components: Array<ComponentBreakdown>
    }>,
    byPartner?: {                          // present when aggregationMode = whole
      payout: number,
      components: Array<ComponentBreakdown>
    },
    topLevel?: {                           // present when rule contains any flat_per_partner_total leaves
      payout: number,
      components: Array<ComponentBreakdown>
    },
    machineCounts: Record<MachineModel, number>
  }
}
```

`ComponentBreakdown` (per leaf, per evaluation unit):

```
{
  nodePath: string,                        // e.g. "root.sum[0]" or "root.max[1].percent"
  leafType: string,                        // e.g. "tiered_percent"
  modelRowsContributed: Array<{
    model: MachineModel | "ALL",
    machinesCount: number,
    rentalsSum: number,
    revenueSum: number,
    tiersHit?: Array<{ from, to, percent, basisUsed, payoutPart }>,
    payoutPart: number
  }>,
  payout: number
}
```

### 3.3 Auth-failure log (rate-limit support)

```
pk = "AUTHFAIL#<ip>"
sk = "TS#<epoch_ms>"
{ ttl: epoch_seconds + 60 }                // DDB TTL auto-purges
```

### 3.4 Three architectural decisions worth calling out

1. **Rule snapshot per run.** Each run stores a copy of `partner.rule` at
   the moment of calculation. Editing the rule later doesn't change historical
   statements; old PDFs reproduce exactly.
2. **Raw + parsed CSV both stored.** Raw bytes are the source of truth for
   re-import (if the parser evolves). Parsed form is what the engine reads.
3. **No `STORES` table.** `store_id` is just an opaque string flowing through
   CSV rows. Stores exist only as appearances inside upload data. Avoids a
   separate setup step.

## 4. Rule shape

A rule is a small tree of two kinds of nodes: **leaves** (compute a number)
and **combinators** (combine child results).

### 4.1 Leaves

Every model-aware leaf (`flat_per_machine`, `percent`, `tiered_percent`) is
a **table keyed by machine model**, with an optional `ALL` catch-all row.

#### `flat_per_machine`

Pay a fixed amount per deployed machine, varying by model.

```ts
{
  type: "flat_per_machine",
  rows: Array<{
    model: MachineModel | "ALL",
    amount: number
  }>
}
```

For each model row in this leaf's table: count machines of that model in
the unit being evaluated, multiply by `amount`, sum across rows. ALL covers
any model not explicitly listed.

#### `flat_per_partner_total`

A single lump sum for the period; doesn't scale with anything. Used for
admin fees or minimum guarantees.

```ts
{
  type: "flat_per_partner_total",
  amount: number
}
```

**Placement constraint:** this leaf must sit at the **top level** of the
rule — either as the root itself or as a direct child of a root-level
`sum`. Nesting it inside `max` / `min` or under any combinator deeper than
the root is rejected at save time. Reason: in `per_store` mode the
per-store evaluation loop would otherwise multiply the lump sum across
stores, which is never the intent for a partner-level admin fee.

**Consequence:** if a partner needs a minimum-guarantee floor like
`MAX(15% of revenue, NT$ 10,000)`, they must use `aggregationMode = "whole"`
for that partner. A per-store floor is a v2 concept (would need a new
leaf like `flat_per_store_per_period` to express cleanly).

**Engine behavior:** evaluated once per calculation run, regardless of
how many stores. Contribution is recorded in a `result.topLevel` field
(see §3.2 revision) so the drill-down can show it separately from
per-store contributions.

#### `percent`

Flat percentage of revenue, per model.

```ts
{
  type: "percent",
  rows: Array<{
    model: MachineModel | "ALL",
    percent: number                        // e.g. 12 = 12%
  }>
}
```

Sum revenue from machines of each model, multiply by row's `percent`, sum
across rows.

#### `tiered_percent`

Marginal-bracket percentage of either rentals or revenue, with **independent
tier ladders per model**.

```ts
{
  type: "tiered_percent",
  basis: "rentals" | "revenue",            // shared across all rows in this leaf
  rows: Array<{
    model: MachineModel | "ALL",
    tiers: Array<{
      from: number,                        // inclusive
      to?: number,                         // exclusive; absent means +∞
      percent: number
    }>
  }>
}
```

For each model row: sum the basis (rentals or revenue) from machines of
that model in the unit. Apply marginal brackets from the row's tier ladder.
Each row uses its own ladder. Brackets must be contiguous and ascending.

### 4.2 Combinators

```ts
{
  type: "sum" | "max" | "min",
  children: RuleNode[]                     // at least 1 child
}
```

- **`sum`**: add all child outputs.
- **`max`** / **`min`**: return the largest / smallest child output. Used
  for minimum guarantees ("higher of 15% revenue OR NT$ 10,000 floor") and
  caps.

### 4.3 Worked examples

**The simple one:**
```
flat_per_machine: { rows: [{ model: "ALL", amount: 500 }] }
```

**Per-model fixed fee:**
```
flat_per_machine: { rows: [
  { model: "S5",  amount: 300 },
  { model: "S10", amount: 500 },
  { model: "T35", amount: 800 }
]}
```

**Base + tiered bonus:**
```
sum: [
  flat_per_machine { rows: [{ model: "ALL", amount: 1000 }] },
  tiered_percent { basis: "revenue", rows: [
    { model: "ALL", tiers: [
      { from: 0, to: 50000, percent: 0 },
      { from: 50000, to: 100000, percent: 10 },
      { from: 100000, percent: 15 }
    ]}
  ]}
]
```

**Minimum guarantee** (partner must be `aggregationMode = "whole"` — see
the `flat_per_partner_total` placement constraint above):
```
max: [
  percent { rows: [{ model: "ALL", percent: 15 }] },
  flat_per_partner_total { amount: 10000 }
]
```

**Complex (nested):**
```
sum: [
  max: [
    percent { rows: [{ model: "S5", percent: 8 }] },
    flat_per_machine { rows: [{ model: "S5", amount: 200 }] }
  ],
  tiered_percent { basis: "rentals", rows: [
    { model: "T35", tiers: [
      { from: 0, to: 100, percent: 5 },
      { from: 100, percent: 12 }
    ]}
  ]},
  flat_per_partner_total { amount: 5000 }
]
```

### 4.4 Machine model enum

```
S5, S8, S10, T8, T10, T20, T35, L20, L40
```

`ALL` is a sentinel within rule rows only (never a CSV value).

## 5. Calculation engine

Pure function. Input: `(parsedCsv, partner.rule, partner.aggregationMode)`.
Output: result object stored in §3.2.

### 5.1 Pipeline

1. **Validate CSV.** Reject if any row's `model` isn't in the enum, if
   `rentals` isn't a non-negative integer, or if `revenue` isn't a finite
   number. Report all errors at once; abort calculation if any.
2. **Group rows into aggregation units.**
   - `per_store`: group by `storeId`, one unit per store.
   - `whole`: one unit containing every row.
3. **Pre-compute summary per unit:** rentals total, revenue total, machine
   counts per model.
4. **Evaluate the rule tree recursively on each unit.**
   - Leaf: compute its value from the unit's rows, recording per-model row
     contributions and (for tiered_percent) per-tier hits.
   - SUM: evaluate children, return sum.
   - MAX/MIN: evaluate children, return extreme. Breakdown records which
     child was selected.
5. **Apply `flat_per_partner_total` leaves once at the top level** —
   outside the per-store loop in `per_store` mode, recorded in
   `result.topLevel` rather than in any single store's breakdown. (Placement
   constraint in §4.1 guarantees these leaves are root-level.)
6. **Sum across units → `totalPayout`.** Persist the result.

### 5.2 Tier mechanics (recap)

Marginal brackets — like income tax. If a tier table is
`{0-100: 0%, 100-500: 10%, 500+: 15%}` and basis is 600, the leaf earns
`100×0% + 400×10% + 100×15% = 40 + 15 = 55`.

In `per_store` mode, **tier brackets reset for each store.** This is a
direct consequence of the aggregation flag being one-per-partner (decided
during brainstorming) — store-level evaluation means store-level totals
hit the tiers independently.

### 5.3 Edge cases

- **Model in CSV not in rule's table, no ALL row** → that model contributes
  0 to that leaf.
- **Model in rule's table not in CSV** → that row contributes 0 (no
  machines to count, no revenue to apply percent to).
- **Negative revenue (refund)** → calculator accepts and propagates.
  Result can in extreme cases be negative; the UI shows it without
  silently clamping.
- **Empty CSV** → totalPayout = `flat_per_partner_total` contributions
  only (if any); otherwise 0.

## 6. UI surfaces

Five screens.

### 6.1 Login

Single-input password gate. Same shape as `expense`:
- scrypt hash in SSM
- `x-app-password` header on every API call
- 30-day session in `localStorage`
- 5 attempts/minute IP rate limit via `AUTHFAIL#` rows
- pre-paint script blocks the app shell until session is verified

### 6.2 Partners list

Table: Name · Currency · Aggregation mode · Last calc date · Last payout.
Click a row → Partner detail. "+ New partner" opens a small form (name,
currency, aggregation mode).

### 6.3 Partner detail (rule editor)

The core authoring surface. Two modes:

**Basic mode (default):**
- Vertical list of leaf "cards". Implicit SUM around them (no UI for SUM —
  it's understood).
- Each card has its own editor:
  - `flat_per_machine`, `percent`: table of model rows with one numeric
    field per row + "Add model row" / Remove buttons.
  - `tiered_percent`: same table layout, plus a `basis` selector at the
    top and per-row tier brackets (with "Add bracket" buttons).
  - `flat_per_partner_total`: single amount field.
- Reorder cards (↑ ↓), duplicate, remove.
- "+ Add component" picker at the bottom.
- Live "Rule preview" line: `SUM(flat_per_machine, tiered_percent on revenue)`.

**Advanced mode (toggle):**
- Same leaves, but wrapped in a draggable tree view exposing the combinators
  above them.
- Drop leaves under MAX or MIN nodes; nest combinators.
- Switching back to Basic flattens lossily only if the tree exceeds
  "implicit SUM at root" — show a warning if so.

Also on this page:
- Header: partner name, currency, aggregation mode (editable).
- Side panel or below the editor: list of recent calculation runs with
  links to their result pages, "+ Run new calculation" button.

### 6.4 New calculation

Sheet pops from Partner detail. Fields:
- Period range picker (start/end dates).
- CSV file picker / drag-drop zone.
- Client-side pre-validation: column shape, model whitelist, numeric
  values. Show errors inline before allowing submit.
- Submit → POST to `/runs` → server parses + validates server-side + computes
  + stores → redirect to Run result.

### 6.5 Run result

- Headline: total payout (in partner's currency), partner name, period range.
- Tabular drill-down:
  - **By store** (if `per_store`): each store's payout, expandable to
    show per-component breakdown.
  - **By rule component** (if `whole`): each leaf's contribution and
    per-model row detail.
- Actions:
  - **Download PDF statement** — html2canvas + jsPDF, single A4 page,
    brokerage-statement aesthetic (similar to portfolio-aws's Summary
    page).
  - **Re-run** — re-applies the current partner rule to the stored raw
    CSV, producing a new run (the old one stays for audit). Useful after
    editing the rule.

## 7. AWS resources

| Resource | Purpose |
|---|---|
| S3 bucket `revshare-frontend` | Hosts SPA static files + service worker + manifest |
| CloudFront distribution | TLS termination, SPA fallback (`403/404 → /index.html`), aliases `revshare.example.com` |
| ACM cert (us-east-1) | TLS for CloudFront alias |
| API Gateway HTTP API | Routes requests to Lambda |
| Lambda `revshare-api` | All backend logic (Node.js 22.x) |
| DynamoDB table `RevsharePartner` | Single-table store (partners + runs + auth-fail) |
| SSM `/revshare/auth-hash` | Scrypt password hash |
| (Optional) SSM `/revshare/admin-email` | For future email-of-statement |

Routes on the Lambda:

```
POST   /login                      → probe; verifies password
GET    /partners                   → list
POST   /partners                   → create
GET    /partners/:id               → detail (incl. rule)
PUT    /partners/:id               → update (name, currency, aggregationMode, rule)
DELETE /partners/:id               → soft-archive
POST   /partners/:id/runs          → create run from uploaded CSV (multipart or base64 body)
GET    /partners/:id/runs          → list runs for partner
GET    /runs/:runId                → run detail (incl. csvRaw, csvParsed, result)
POST   /runs/:runId/rerun          → re-apply current rule to stored csvRaw
GET    /healthz                    → liveness probe
```

## 8. Out of scope for v1 (explicit YAGNI)

- Multi-currency conversion / cross-partner USD reporting.
- Per-partner cadence (monthly/quarterly). Period is per-upload arbitrary.
- Statement workflow (locked periods, issued/paid tracking, A/P ledger).
- Multi-user auth, per-user roles, audit logs of edits.
- Rule template library (reusable across partners). v1 has per-partner
  rules; templates can come later.
- Partner-facing portal (partners viewing their own statements).
- Date-based rule variations (e.g., a rule that changes mid-period).
- Automated upstream CSV pull from ChargeSpot's operational system.

## 9. Out of scope (probably ever)

- Anything requiring real-time data: this is a periodic batch tool.
- Tax handling: partners are responsible for their own jurisdiction's tax
  treatment of the payout. Statements show gross amounts.

## 10. Open questions resolved during brainstorming

| Question | Decision |
|---|---|
| Data input | CSV upload, one row per machine |
| Period | Declared per-upload (arbitrary date range) |
| Currency | Per-partner fixed currency, no FX, no cross-partner aggregation |
| Tier mechanics | Marginal brackets |
| Tier basis | Configurable per `tiered_percent` leaf — rentals or revenue |
| Aggregation level | One flag per partner (`whole` vs `per_store`) — applies to the whole rule tree |
| Per-model variation | All model-aware leaves are tables keyed by model with optional ALL catch-all |
| Rule combinability | Yes — SUM/MAX/MIN combinators |
| Rule editor UX | Hybrid: vertical leaf list (implicit SUM) by default, Advanced mode for tree-based MAX/MIN nesting |
| Partner→Store mapping | None stored; operator selects partner first, then any CSV is interpreted as that partner's data |
| Output | Per-partner totals + drill-down + PDF statement |
| flat_per_partner_total in per_store mode | Applied once at top level (placement-constrained to root) |
| Repo / hosting | GitHub (created during scaffolding) |

## 11. Naming and conventions

- Project root: `~/Projects/revshare-aws`
- Repo: a new GitHub repo (to be created)
- AWS region: `ap-northeast-1` (matches other projects)
- Account: `<YOUR_AWS_ACCOUNT_ID>`
- Resource prefix: `revshare-` for Lambda/SSM, `RevsharePartner` for DDB
- Domain: `revshare.example.com` (proposed)
- CloudFront distribution: TBD (created at deploy time)

---

## Notes for the implementation plan

- TDD applies to the calculation engine especially — write tests for each
  leaf type, each combinator, marginal tier math, and the `per_store` /
  `whole` split before writing the engine code.
- Keep the calculation engine as a pure function exported from one file;
  no AWS SDK calls inside it. Makes it trivial to unit-test in Node without
  mocking DynamoDB.
- Start with Basic-mode rule editor (no Advanced tree view) and ship; the
  tree editor is the largest unknown UX effort and can land in a follow-up
  release once the v1 calculation pipeline is proven.
- Service-worker `CACHE_VERSION` discipline applies from day 1 to avoid
  the cache-staleness bugs from earlier projects.

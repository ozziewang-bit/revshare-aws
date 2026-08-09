# revshare-aws — handoff

Last updated: 2026-08-07 (merchant view is the payout entity; Partners page removed; `PARTNER` rows kept but dormant).
Service-worker `CACHE_VERSION` is at `revshare-v104` (bump on every shell change).

This document is the authoritative starting point for the next session. Read it
end-to-end before touching anything. The codebase is the ultimate source of
truth — when this doc and the code disagree, the code wins.

## 1. What this is

A ChargeSpot revenue-share calculator. Finance uploads a merchant roster + an
order report for a period; the calculator resolves each roster brand (by its
`Merchant label`) to a **Merchant view row** — a `CONTRACT` DDB row, which is
now the payout entity — and evaluates that row's stored rule (a small tree of
leaves + combinators) to produce an auditable per-merchant payout breakdown.
There is no per-partner UI or PDF statement any more; see §1b and §5.

Full design spec: [`docs/superpowers/specs/2026-05-28-revshare-design.md`](docs/superpowers/specs/2026-05-28-revshare-design.md).
Initial implementation plan (33 tasks): [`docs/superpowers/plans/2026-05-28-revshare.md`](docs/superpowers/plans/2026-05-28-revshare.md).
Run-flow redesign spec + plan: [`docs/superpowers/specs/2026-06-17-revshare-run-flow-redesign-design.md`](docs/superpowers/specs/2026-06-17-revshare-run-flow-redesign-design.md) + [`docs/superpowers/plans/2026-06-17-revshare-run-flow-redesign.md`](docs/superpowers/plans/2026-06-17-revshare-run-flow-redesign.md).
Electricity-outside-comparison spec + plan: [`docs/superpowers/specs/2026-08-06-electricity-outside-comparison-design.md`](docs/superpowers/specs/2026-08-06-electricity-outside-comparison-design.md) + [`docs/superpowers/plans/2026-08-06-electricity-outside-comparison.md`](docs/superpowers/plans/2026-08-06-electricity-outside-comparison.md).
Merchant-view-as-source-of-truth spec + plan (Partners page removed, `CONTRACT` becomes
the payout entity): [`docs/superpowers/specs/2026-08-07-merchant-view-as-source-of-truth-design.md`](docs/superpowers/specs/2026-08-07-merchant-view-as-source-of-truth-design.md) + [`docs/superpowers/plans/2026-08-07-merchant-view-as-source-of-truth.md`](docs/superpowers/plans/2026-08-07-merchant-view-as-source-of-truth.md).

## 1b. CURRENT STATE (2026-08-07) — read this, the sections below are partly stale

Branding: app is **"RevShare SEA"** with a topbar **Thailand/Singapore** switcher
(`REGIONS` config in `app.js`; choice persists in `localStorage('rs_region')`,
default `th`, full `location.reload()` on switch so no TH↔SG state bleeds). TH →
API `7z269nmx74` / DDB `RevsharePartner`; SG → API `4qcyojfg79` / DDB
`RevsharePartnerSG` (the separate `revshare_sg` repo is the SG backend source —
keep its Lambda in parity with TH). Currency follows region via `CCY`/`SYM`
(THB/฿ · SGD/S$) across the chart axis and rule-editor labels; each `CONTRACT`
row's own stored `currency` drives that merchant's display in runs (this field
moved off `PARTNER` onto `CONTRACT` on 2026-08-07 — see §5). The SG standalone
CloudFront (`E1ALROWEFJOG3Q`) is deprecated — the unified site lives on
`d2t76jfby056ul`.

**UI tabs (frontend/app.js):**
- **Merchant view** (`nav-contracts`) — the landing screen and, as of 2026-08-07, the only
  place a payout record is edited. One flat, editable grid of every `CONTRACT` row: the
  contact/machines/contract/share-terms column groups from the old Contracts tab
  (toggleable), search + type filter, inline cell editing, **+ New merchant**, **Upload
  sheet** (imports the `All_Merchant` sheet via `POST /contracts/import` — contract
  fields only, never touches `rule`), and an **Edit terms…** dialog per row for the
  share-terms rule itself (GP%/Electricity/Placement/Others/MG + payout method +
  `aggregationMode` + the `noPayout` checkbox — all gated `manageMerchants`). The grid's
  share-term editor still round-trips through the same `compileRule`/`decompileRule` and
  has the same read-only fallback for shapes it can't faithfully represent — see "Rule
  model" below. `rule`, `aggregationMode`, `noPayout`, and `currency` all live on this
  `CONTRACT` row now — it **is** the payout entity (see §5).
- **Run share** (`nav-bulk-runs`, gated `runCalcs`) — roster-driven 4-step wizard for bulk
  monthly calc:
  1. **Period** — pick period start/end.
  2. **Merchant list** — upload the ChargeSpot "Businessmen list" `.xlsx` (Approved-only
     roster). Brand name comes from the **`Merchant label`** column; machine model is
     parsed from **`device type.`**. Calls `POST /bulk-runs/prepare`, which resolves each
     label to a Merchant view (`CONTRACT`) row by name — auto-creating one, flagged
     `noPayout: true`, for any label with no existing row (a brand absent from the
     merchant sheet is not paid, by the user's 2026-08-07 decision, but stays visible) —
     and returns rule-readiness.
  3. **Review rules** — any resolved merchant whose rule doesn't actually pay anything is
     listed inline, opening the Merchant view's own terms dialog for immediate editing.
     Step 4 is locked until every one has a paying rule (or is `noPayout`). The readiness
     test is `ruleHasValue` (`lambda/revshare-api/code/payout.mjs`) — it walks the rule
     tree for a non-zero leaf, replacing the old `!rule || !rule.type` check, which passed
     a bare `percent ALL 0%`. That is why **39 partners** could reach a run and be paid
     zero with no warning before 2026-08-07.
  4. **Order list** — upload the order report (`.xlsx`); orders are overlaid onto the roster.
     Submits `POST /bulk-runs` with `merchants[]` + `orders[]`.
  - **Roster-authoritative:** every roster machine with a resolved `contractId` becomes an
    engine row (rentals/revenue 0); orders are overlaid by merchant name. Order-less
    merchants are still paid their fixed fees (MG/placement) per rule. Orders whose
    merchant is not in the roster are **unmatched** (not paid) — surfaced in a banner. A
    roster machine whose brand has **no `CONTRACT` at all** is a separate, permanent case
    — see "Deliberately unpaid" below.
  - Run detail: per-merchant table w/ revenue-share %, unmatched-orders banner,
    per-merchant CSV zip download (`<year>_<month>_revshare.zip`), per-run Delete, and
    **Archive** button (visible to `runCalcs` users). Archived runs show **🔒 Locked** —
    Delete is blocked (409) and an **Unarchive** button appears for admins only.
- **Analytics** (`nav-revshare-path`) — monthly combo chart (Revenue/Payout bars +
  Revenue-share % line, data labels), keyed by merchant name across stored bulk-run
  results. Defaults to Total (all merchants) with a search/filter over individual merchants.
- **Device Types** — machine-model CRUD.

**Partners page — removed (2026-08-07).** The partner list + detail (Merchants / Rule /
Analytics tabs), the new-partner form, and the per-partner single-run flow with its
printable PDF statement are gone from the UI (937 lines removed from `app.js`;
`frontend/lib/html2canvas.min.js` + `jspdf.umd.min.js` are still loaded by `index.html`
and cached by the service worker but are now dead weight — nothing calls them). `PARTNER`
rows and the `/partners`, `/partners/:id/runs*` routes are **retained but dormant** —
nothing in the frontend reads or calls them any more. They exist by explicit user
decision, so a migrated `CONTRACT` row's rule can still be checked against the original
`PARTNER` rule it was copied from (see `infra/compare-pipelines.mjs`, §5). Don't read
"dormant" as "safe to delete" without asking first.

**Update** tab — already removed (2026-06-17). `POST /import/rule-batch` no longer exists
in the backend at all (no route registered). `parseKaExcel` is dead code in
`frontend/app.js` — defined, never called. `POST /import/rev-share`
(`routes/import.mjs`) is still registered in the backend but has no frontend caller.

**Deliberately unpaid (2026-08-07):** 65 brands (436 store-registry `MERCHANT` rows) exist
in the store registry with no matching `CONTRACT` row — they never appeared in the
`All_Merchant` merchant-sheet import that seeded `CONTRACT`. They are **not paid**, by the
user's 2026-08-07 decision that the merchant sheet is authoritative. They are **not
deleted**: `buildRosterRows` (`bulk-runs.mjs`) drops a roster machine with no `contractId`
before grouping, so it can never acquire a payout, and any order against it lands in the
run's unmatched list instead of being silently attributed. If the same brand later
appears in an uploaded roster, `applyMerchantRoster` auto-creates a `CONTRACT` for it
(flagged `noPayout: true`) — visible in the Merchant view from then on, still unpaid until
someone flips the flag there.

**Rule model (NEW — replaces the old leaf-tree editor UX):** a merchant's (`CONTRACT`
row's) rule is built from **share terms** + a **payout method**. Terms: GP% (percent of revenue),
Electricity (lump), Placement (**per machine type**), Others (lump), and MG
(Minimum Guarantee, **per machine type**). `compileRule`/`decompileRule` (frontend `app.js` + backend `routes/import.mjs`)
tag leaves with `_t` (term) and the root with `_method` so decompile is exact;
legacy untagged rules fall back to heuristics. Four payout methods (`form.method`):
- `default` (code **D**) — single term, just pay it.
- `hybrid` (code **H**) — sum of all terms.
- `higher` (code **WH**) — `max(each comparable term…, MG) + Electricity`.
- `hybrid-higher` (code **HH**) — `max(sum of comparable terms, MG) + Electricity`.

**Electricity never competes (2026-08-06):** the electricity fee is a reimbursement of a
cost the partner actually incurs, so it is excluded from the WH/HH comparison and added
to whatever the comparison settles on. Compiled as `sum( max(…) , elecLeaf )`. `Others`
*does* still compete. `default`/`hybrid` are unchanged (they already sum every term).
Side effect: the electricity leaf is now a legal root-`sum` child, so a `per_store`
partner with electricity no longer throws in `validatePerStoreTree` and is charged the
lump once per partner rather than once per store. No stored rule was affected — verified
that none of the 6 max-root partners carried an electricity term. **Engine is
unchanged** — it still just evaluates `sum`/`max`/`percent`/`flat_per_machine`/
`flat_per_partner_total`.

**No-payout merchants (2026-06-11; moved to `CONTRACT` 2026-08-07):** a merchant can carry
`noPayout: true`, set via the Merchant view's **Edit terms…** dialog checkbox "No revenue
share — not paid". Such rows show a calm neutral **"None"** in the terms column and are
**skipped in bulk runs regardless of any rule** (`payoutDecision` in `bulk-runs.mjs` checks
`noPayout` before it checks whether the rule pays anything). A row with no rule at all (and
not `noPayout`) shows **"not set"** in the same column instead — there is no separate
danger-badge list view any more; both states are visible only per-row in the Merchant view
grid. Persisted via the `CONTRACT` PUT merge (`WRITABLE` in `routes/contracts.mjs`); the
roster's auto-create path (`applyMerchantRoster`) sets `noPayout: true` on every new stub.
No engine/DDB-schema change.

**Business rule (load-bearing):** KA "Placement (monthly)" is charged **per
machine / per store** (`flat_per_machine`), NOT a lump per merchant. MG is also
per machine, varying by device type. (The old import wrongly treated placement
as a lump and MG as a single flat amount — fixed 2026-05-31.)

**Bulk runs are stored in S3** (see §5), not inline in DDB.

**Immutability:** a run is a frozen snapshot (results + `ruleSnapshots` in S3).
Batch-updating rules NEVER alters past runs — only the merchant's (`CONTRACT`'s)
current rule, affecting future runs only. There is no in-place recompute for bulk runs by
design (user requirement: keep historical periods as-is).

**Current data (live baseline verified 2026-08-07):** 207 `CONTRACT` rows (134 still
linked to the `PARTNER` row they were migrated from; 73 unlinked — created directly on the
Merchant view or by roster auto-create), 4,066 `MERCHANT` store-registry rows (3,630
carrying a `contractId`; 436 with none — see "Deliberately unpaid" above), 199 brands in
use, 0 bulk runs of any kind against this data as of that date. The pre-migration
**"Current data"** note this replaced (112 partners, KA regenerated 2026-05-31, canonical
2026-05 run total 680,172.65) describes the old `PARTNER`-only world and is now historical.

**Aggregation mode + MG floors (2026-06-08; field moved to `CONTRACT` 2026-08-07):** a
`higher`/`hybrid-higher` rule's MG floor only applies **per merchant** when the contract is
`aggregationMode: per_store`. In `whole` mode the `max(GP, MG)` collapses to the merchant's
aggregate, so small stores get only their GP slice (no floor). **7-Eleven** was switched to
`per_store` on 2026-06-08 for this reason (per-store guarantee; total
244,527.50 → 333,252.50 on 2026-05 — pending a re-upload of more accurate raw
data). **กะทู้** has the same `max(50% GP, S8=200)` shape and is still `whole`
(should be flipped; no current impact). BIG-C/BTS/AOT/Turtle Shop are MG-dominated
at every store, so whole == per_store — no change needed. The engine + per-merchant
CSV already handle per_store correctly; this was a config issue, not a code bug.
`createBulkRunRoute` now also rejects a `CONTRACT` whose `aggregationMode` is neither
`whole` nor `per_store` (skips with a warning) rather than letting `evaluateRun` silently
default to the lower-paying `whole` branch, which is exactly how 7-Eleven's original
under-payment happened.

Tests: `npm test` → **118/118** pass (incl. `payout.test.mjs` — `ruleHasValue` /
`contractNeedsTerms` / label resolution; `bulk-runs.test.mjs` — roster-to-contract
resolution + order-less fixed-fee; `contracts.test.mjs` — sheet-row normalisation, name
matching, and import-plan diffing, all contract-fields-only/no-rule-touch).

## 2. Live URLs and resources

- **Site:** https://d2t76jfby056ul.cloudfront.net
- **API:** https://7z269nmx74.execute-api.ap-southeast-7.amazonaws.com/prod (no auth — see §9)
- **Lambda:** `revshare-api` (Node 22.x, ap-southeast-7)
- **DDB table:** `RevsharePartner` (single-table, pk/sk)
- **CloudFront:** distribution `E3JLOVJXN5DI24` (ap-southeast-7, HTTP→HTTPS redirect)

Account `<YOUR_AWS_ACCOUNT_ID>`, region `ap-northeast-1`. IAM user `<your-iam-user>`.

## 3. File map

| Path | What |
|---|---|
| `lambda/revshare-api/code/engine.mjs` | Pure calculation engine. No AWS SDK. Tested via `node:test`. |
| `lambda/revshare-api/code/csv.mjs` | CSV parser + validation. |
| `lambda/revshare-api/code/db.mjs` | DynamoDB + S3 wrappers for every row family: Partner, Merchant (store registry), Contract, Run, BulkRun, machine-model Config. |
| `lambda/revshare-api/code/payout.mjs` | Pure payout-decision module (2026-08-07). No AWS imports. Exports `ruleHasValue` (does a rule tree pay anything?), `contractNeedsTerms`, `indexContractsByName`/`resolveLabel` (name-based roster resolution). |
| `lambda/revshare-api/code/routes/` | partners.mjs, runs.mjs |
| `lambda/revshare-api/code/index.mjs` | Lambda entry: auth gate + route dispatch. |
| `lambda/revshare-api/code/routes/merchants.mjs` | Store-registry (`MERCHANT`) CRUD routes. |
| `lambda/revshare-api/code/routes/import.mjs` | POST /import/rev-share — parses KA Excel JSON into partners + merchants. Exports `compileRule`, `parseDeviceType`. Dormant: no frontend caller (see §1b). |
| `lambda/revshare-api/code/routes/bulk-runs.mjs` | Bulk run routes. Exports `buildRosterRows` (roster-authoritative row seeding, keyed by `contractId`), `applyMerchantRoster` (resolves roster labels to `CONTRACT` rows, auto-creating a `noPayout: true` stub for any unmatched label), `payoutDecision` (why a contract is/isn't paid), `groupOrders` (legacy, order-only grouping, unused in the live route). |
| `lambda/revshare-api/code/contracts.mjs` | Contract sheet-row normalisation, name matching (`matchContracts`), import diffing (`buildImportPlan`). Contract fields only — never touches `rule`. |
| `lambda/revshare-api/code/routes/contracts.mjs` | Contract (`CONTRACT`) CRUD + import routes. `WRITABLE` includes `rule`/`aggregationMode`/`noPayout`/`currency` for direct PUT edits — `CONTRACT` is the payout entity now (§5). |
| `lambda/revshare-api/tests/` | `engine.test.mjs`, `csv.test.mjs`, `contracts.test.mjs`, `payout.test.mjs`, `bulk-runs.test.mjs`, others — `npm test` → 118 total. |
| `frontend/index.html` | SPA shell + pre-paint auth gate. |
| `frontend/style.css` | All styles (tokenized). |
| `frontend/app.js` | All app JS: auth, screens, Merchant view grid + terms editor, run flow. |
| `frontend/service-worker.js` | PWA shell cache. **Bump `CACHE_VERSION` on every shell change.** |
| `frontend/lib/` | Self-hosted html2canvas + jsPDF + xlsx + zip.js. html2canvas/jsPDF are loaded but **unused** since the PDF-statement flow was removed with the Partners page (2026-08-07) — dead weight, not yet pruned. xlsx/zip.js are still used (roster/order upload, CSV-zip download). |
| `infra/setup-once.md` | One-time AWS resource walkthrough + live IDs. |
| `infra/deploy-lambda.sh` | Zip + `update-function-code`. |
| `infra/deploy-frontend.sh` | `aws s3 cp` per file. Injects API URL into `app.js` via sed. |
| `infra/trust-lambda.json`, `infra/role-policy.json` | IAM templates. |
| `infra/migrate-to-contracts.mjs` | One-off, idempotent migration (2026-08-07): copies `rule`/`aggregationMode`/`noPayout`/`currency` from each linked `PARTNER` onto its `CONTRACT`, then points every `MERCHANT` store row at a `contractId`. Conditional writes only ever set an absent field — safe to re-run. Already applied to production; not part of any deploy script. |
| `infra/compare-pipelines.mjs` | Read-only validation companion to the migration above — diffs migrated `CONTRACT` fields against the source `PARTNER` directly. Last run: 134/134 comparable contracts matched, 0 mismatches. |
| `docs/superpowers/specs/` | Design specs (frozen at spec time). |
| `docs/superpowers/plans/` | Implementation plans. |

## 4. Calculation engine (pure module)

`lambda/revshare-api/code/engine.mjs` exports:

- `MACHINE_MODELS` — `Set<string>` of the nine model codes (S5, S8, S10, T8, T10, T20, T35, L20, L40)
- `evaluateRun({ rule, rows, aggregationMode })` → result object

The engine is a **pure function**. No AWS SDK imports. Anything that adds AWS
to `engine.mjs` is a regression.

**Leaf types:** `flat_per_machine`, `flat_per_partner_total`, `percent`, `tiered_percent`.
**Combinators:** `sum`, `max`, `min`.
**Aggregation:** one flag per partner — `whole` (one eval over all rows) or `per_store` (one eval per store, summed).
**Tiers:** marginal brackets (income-tax style). `basis` is either `rentals` or `revenue`.
**`flat_per_partner_total`** must sit at the top level of the rule in `per_store` mode; the
engine validates and throws otherwise. In `per_store` mode it's evaluated once
across the whole run and recorded in `result.topLevel` separately from per-store payouts.

Run all tests:
```bash
npm test    # from repo root
```
118/118 should pass.

## 5. Data model

Single DDB table `RevsharePartner`. Five row families:

| pk | sk | What |
|---|---|---|
| `CONTRACT` | `CONTRACT#<contractId>` | **The payout entity (since 2026-08-07).** Merchant contract terms (type, counter party, unit counts, start/end, etc.) **plus** `rule`, `aggregationMode`, `noPayout`, `currency` — the fields a bulk run actually evaluates. Optional `partnerId` back-link to the `PARTNER` row it was migrated from. Edited entirely from the Merchant view screen. |
| `MERCHANT` | `MERCHANT#<merchantId>` | Store-registry row — one per physical machine/location, seeded from the roster upload. Carries `contractId` pointing at the `CONTRACT` (payout) row for its brand; 3,630 of 4,066 rows have one (see §1b "Deliberately unpaid" for the other 436). |
| `PARTNER` | `META#<partnerId>` | **Retained but dormant.** The pre-2026-08-07 config + rule row. Nothing reads these any more — the Partners UI and its routes are gone (see §1b) — but the rows are kept on purpose so a migrated `CONTRACT`'s rule can be checked against the original it was copied from (`infra/compare-pipelines.mjs`). Do not delete without asking; do not treat as canonical for anything current. |
| `RUN#<partnerId>` | `RUN#<runId>` | Legacy single-partner run row (one CSV upload + computed result, `ruleSnapshot` + `csvRaw` + `csvParsed` + `result`). The routes that write/read these (`/partners/:id/runs*`) still exist but have no frontend caller and no dedicated test file (`tests/` has no `runs.test.mjs`) — dormant alongside `PARTNER`. |
| `BULKRUN` | `BULKRUN#<runId>` | **Slim summary index only** (counts, totals, `s3Key`). Full payload (results, unmatched names, ruleSnapshots) lives in S3 — see below. This is the live run type; everything in §1b's Run share wizard writes here. |

**Bulk-run payloads live in S3, not DynamoDB.** A bulk run over a full month
(20k+ orders → ~1.5k merchants) exceeds DynamoDB's hard 400 KB item limit.
So `putBulkRun` writes the full JSON to S3 (`s3://revshare-runs-812751451548-sea7/runs/<runId>.json`)
and stores only a slim summary row in DDB. `getBulkRun` reads the slim row,
then fetches the full payload from S3 via `s3Key` (legacy pre-S3 runs without
`s3Key` are returned inline for backward compat). The Lambda role has
`s3:GetObject`/`s3:PutObject` on that bucket only (see `infra/role-policy.json`).

**Rule snapshot per run** is load-bearing: editing a merchant's (`CONTRACT`'s) rule does
NOT retroactively change old run results. Each bulk run's stored `ruleSnapshots`
reproduce exactly what was evaluated at the time.

**Why `PARTNER` survives:** the 2026-08-07 migration (`infra/migrate-to-contracts.mjs`)
copied `rule`/`aggregationMode`/`noPayout`/`currency` from each linked `PARTNER` onto its
`CONTRACT` — additively, only ever setting an absent field — and pointed every `MERCHANT`
store row at a `contractId`. It never deleted a `PARTNER` row. That was a deliberate user
decision, not an oversight: keeping the originals lets anyone re-verify a migrated rule by
diffing it against where it came from. `infra/compare-pipelines.mjs` is that diff, read-only,
and last reported 134/134 comparable contracts matching their source partner with 0
mismatches.

## 6. Backend routes

**Auth required** — Google Sign-In token (see §9). All routes except `GET /healthz` require a valid Bearer token from an `@inforich.com` / `@inforichjapan.com` account. Writes require specific permissions; reads are open to any authenticated user except `/users` (admin only).

All `/partners*` routes below are **dormant** — no frontend caller since the Partners page
was removed 2026-08-07 (see §1b, §5). They still work if called directly; kept so a
migrated `CONTRACT` rule can be checked against its `PARTNER` source.

| Method | Path | Purpose |
|---|---|---|
| GET | `/healthz` | Liveness probe |
| GET | `/partners` | List non-archived partners *(dormant)* |
| POST | `/partners` | Create partner *(dormant)* |
| GET | `/partners/:id` | Get partner (incl. rule) *(dormant)* |
| PUT | `/partners/:id` | Update partner (name/currency/aggregationMode/rule/notes) *(dormant)* |
| DELETE | `/partners/:id` | Soft-archive *(dormant)* |
| POST | `/partners/:id/runs` | Create run from uploaded CSV (`{periodStart, periodEnd, csvBase64}`) *(dormant)* |
| GET | `/partners/:id/runs` | List partner's runs *(dormant)* |
| GET | `/partners/:id/runs/:runId` | Get one run (incl. csvRaw, csvParsed, result) *(dormant)* |
| POST | `/partners/:id/runs/:runId/rerun` | Re-apply current rule to stored CSV *(dormant)* |
| POST | `/bulk-runs/prepare` | Resolve an uploaded roster's `Merchant label`s to `CONTRACT` rows by name, auto-creating a `noPayout: true` stub for any label with no match. Returns `{rosterCount, merchantBrandCount, newMerchants, unassigned, merchantsNeedingTerms}`. Requires `runCalcs`. |
| POST | `/bulk-runs` | Create bulk run. Body: `{periodStart, periodEnd, merchants[], orders[]}`. Re-applies roster idempotently, evaluates each resolved contract's rule via the engine. Requires `runCalcs`. |
| GET | `/bulk-runs` | List bulk run summaries. |
| GET | `/bulk-runs/:id` | Get full bulk run (from S3). |
| POST | `/bulk-runs/:id/archive` | Lock run (sets `archived: true`). Requires `runCalcs`. Locked runs block DELETE (409). |
| POST | `/bulk-runs/:id/unarchive` | Remove lock. Requires `admin`. |
| DELETE | `/bulk-runs/:id` | Delete run. Returns 409 if archived. Requires `deleteRuns`. |
| GET | `/contracts` | List all contracts |
| POST | `/contracts` | Create contract. Requires `manageMerchants`. |
| PUT | `/contracts/:id` | Update contract fields (partial merge). Requires `manageMerchants`. |
| DELETE | `/contracts/:id` | Delete contract. Requires `manageMerchants`. |
| POST | `/contracts/import` | Bulk upsert from the parsed `All_Merchant` sheet, contract fields only. Requires `manageMerchants`. |

CORS configured on the API Gateway to allow `*` origin with headers
`content-type, authorization`. Adjust the `AllowOrigins` once a custom
domain exists.

## 7. Working conventions

1. **Patch → deploy → validate → commit → push → doc.** Don't commit before
   the deployed app is confirmed working. The user is the source of truth
   for "this works."
2. **Service worker `CACHE_VERSION` bumps on every shell change.** Without
   the bump, old caches keep serving stale JS/CSS for users who already
   loaded the page once.
3. **Don't include `Co-Authored-By:` trailers in commit messages** — this
   project's commits don't have them.
4. **The calculation engine stays pure.** Tests in `node:test`. No DDB / no
   SSM / no fetch / no fs in `engine.mjs`. If you need IO, do it at the
   route layer and pass plain data into the engine.

## 8. Deploy commands

Backend (Lambda code) — Thailand only:
```bash
./infra/deploy-lambda.sh
```

Backend — **BOTH regions in one command** (revshare-aws is the source of truth;
syncs shared code TH→SG except `db.mjs`, then deploys `revshare-api` + `revshare-api-sg`):
```bash
./infra/deploy-lambda-all.sh        # set REVSHARE_SG_ROOT if the SG repo isn't at ~/revshare_sg
```
If it reports SG code changed, commit it in the `revshare_sg` repo. (`db.mjs` is
never synced — it holds each region's table/bucket; mirror db.mjs logic changes
by hand.) The frontend is a single shared site (one deploy serves both regions).

Frontend (SPA):
```bash
./infra/deploy-frontend.sh
```

If/when CloudFront is provisioned:
```bash
REVSHARE_CLOUDFRONT_DIST_ID=EXXXXXX ./infra/deploy-frontend.sh
```

## 9. Auth (Google Sign-In + per-feature access control — 2026-06-11)

**Google Sign-In, read-only baseline, admin-granted permissions.** Spec/plan:
`docs/superpowers/specs/2026-06-11-google-auth-access-control-design.md` +
`docs/superpowers/plans/2026-06-11-google-auth-access-control.md`.

- **AuthN:** Google Identity Services (client-side ID token / JWT). Frontend login gate
  (`#login-gate` in index.html + `boot()`/`initGsi()`/`onCredential()` in app.js); token
  stored in `localStorage('rs_idtoken')`, sent as `Authorization: Bearer` by `api()`; 401 →
  clear + re-prompt. `GOOGLE_CLIENT_ID` is a public constant in app.js (set at deploy).
- **Backend gate** (`index.mjs`, after the OPTIONS/`/healthz` short-circuits): `auth.mjs`
  `verifyGoogleToken` checks RS256 sig vs Google's cached JWKS (Node `crypto.subtle`, **no
  npm dep**), `aud === GOOGLE_CLIENT_ID`, issuer, exp (60s skew), `email_verified`, and
  `hd ∈ ALLOWED_DOMAINS`. Then `resolvePermissions(email, row, ADMIN_EMAILS)` →
  `requiredPermission(method, path)` → 401/403. `/healthz` is the only public route.
- **AuthZ:** 7 permissions `editPartners, runCalcs, deleteRuns, manageMerchants,
  manageDeviceTypes, applyRuleBatch, admin` (`admin` ⇒ all). admin email (env) ⇒ all; else
  a **`RevshareUsers`** DDB row (`{email, permissions, updatedAt, updatedBy}`); else
  read-only. Frontend gates controls with `can(perm)`; admin **Users** screen
  (`renderUsersScreen`) edits grants via `/users`. **`editPartners` is still a grantable
  permission on that screen but has had no frontend effect since 2026-08-07** — its two
  `can('editPartners')` call sites both lived in the now-deleted Partners page. It still
  gates the dormant backend `/partners` routes (`requiredPermission` in `auth.mjs`); it
  just has nothing left to unlock in the UI. Not a bug — left as-is rather than rediscovered
  as one in a future session.
- **Shared users table:** one `RevshareUsers` table (ap-southeast-7) read by **both**
  Lambdas via `users-db.mjs` (own DDB client, table name a shared constant — NOT in the
  region-specific `db.mjs`). IAM `revshare-users-access` inline policy on both roles.
- **Config (Lambda env, both functions):** `GOOGLE_CLIENT_ID`, `ALLOWED_DOMAINS`
  (`inforich.com,inforichjapan.com`), `ADMIN_EMAILS` (`ozzie.wang@inforich.com`).
- **Routes added:** `GET /me`, `GET/PUT/DELETE /users` (admin-only). Tests:
  `tests/auth.test.mjs` (resolver + route map). CORS now allows `authorization`.
- **deploy-lambda-all.sh fix:** it now syncs ALL top-level `*.mjs`/`*.json` except `db.mjs`
  (was a hardcoded list that missed new modules like `auth.mjs`/`users-db.mjs`).

## 10. Critical rules — don't break these

1. **Always set `aggregationMode` when calling `evaluateRun`** — the engine
   throws on invalid values. Same for `rule` shape.
2. **`flat_per_partner_total` is constrained to root or root-sum-child in
   `per_store` mode.** The engine validates and throws. Don't try to work
   around this — see spec §4.1 for the reasoning.
3. **CSV rows must use the machine-model enum** (S5/S8/S10/T8/T10/T20/T35/L20/L40).
   The engine throws on unknown models. Don't add a new model without also
   adding rule-editor UX for it in `frontend/app.js`.
4. **Bump `CACHE_VERSION` in `frontend/service-worker.js`** on every shell
   deploy. Same discipline as `expense`.
5. **Per-run `ruleSnapshot` is load-bearing.** Don't try to read the current
   `CONTRACT.rule` (or, in a legacy single-partner run, `partner.rule`) to
   display an old run — the run row already has the rule it was computed
   with frozen inside it.

## 11. Known limitations / v2 candidates

- **No CloudFront / no custom domain** — site is HTTP-only via S3 static
  website. Provisioning CloudFront + ACM cert is a 30-minute Console job;
  set `REVSHARE_CLOUDFRONT_DIST_ID` in env after that and the deploy
  script will invalidate on every push.
- **No advanced tree editor** — the basic rule editor (vertical leaf cards
  under implicit SUM) covers ~80% of contract shapes. Rules requiring
  MAX/MIN nesting must be edited via the raw rule JSON in DynamoDB, or
  via the API directly (`PUT /contracts/:id` with the rule body — `CONTRACT`
  is the payout entity now, see §5; the equivalent `PUT /partners/:id` still
  exists but is dormant).
- **No multi-currency / FX** — each partner stands alone in their fixed
  currency. By design.
- **No partner-facing portal** — only finance staff log in.
- **CORS is `*`** on the API Gateway. Tighten once a stable domain is
  picked.
- **Icons are minimal placeholders** (solid blue squares). Replace with
  real artwork when the brand identity is set.
- **No automated tests on the routes or frontend** — engine has 31 tests
  but the HTTP layer is verified by manual smoke testing only.
- **`Others` still sits inside the WH/HH comparison** (by design — 2026-08-06 only pulled
  Electricity out, see §1b). `Others` is a `flat_per_partner_total` lump, so a `per_store`
  partner configured with `Others` on `higher`/`hybrid-higher` will throw
  `flat_per_partner_total is not allowed in per_store mode…` from `validatePerStoreTree`.
  `bulk-runs.mjs` catches this per-partner and drops that partner from the run with a
  warning rather than failing the whole run. No partner has this configuration today
  (verified against all 206 TH partners on 2026-08-06).

## 12. Starting fresh in a future session

1. Read this CLAUDE.md end-to-end.
2. Skim recent commits: `git log --oneline -10`.
3. Verify the deployed app still works:
   ```bash
   curl -sS https://<YOUR_API_ID>.execute-api.<YOUR_REGION>.amazonaws.com/healthz
   # → {"ok":true}
   curl -sS http://<YOUR_S3_BUCKET>.s3-website-ap-northeast-1.amazonaws.com/ | head -5
   # → starts with <!doctype html>
   ```
4. Then propose the work for this session.

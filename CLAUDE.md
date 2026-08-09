# revshare-aws — handoff

Last updated: 2026-08-09 (manual merchant archive + Archived tab; merchant-view header-click column sections, status filter).
Service-worker `CACHE_VERSION` is at `revshare-v110` (bump on every shell change).

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
  contact/machines/contract/share-terms column groups from the old Contracts tab — each
  collapsed/spread by **clicking its header in the group row above the column labels**
  (2026-08-09; replaced the four toolbar checkboxes, and a collapsed group keeps one narrow
  column so the header that reopens it never disappears with the data) — a **status filter**
  (All / ◆ Needs terms / ⚠ Contract due or overdue, counts in the option labels; it replaced
  the merchant-type filter and the sort dropdown, both dropped 2026-08-09 as unused),
  search, inline cell editing, per-row **Archive** (see below), **+ New merchant**, **Upload
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
     test is `contractNeedsTerms` (`lambda/revshare-api/code/payout.mjs`), which itself
     calls `ruleHasValue` — it walks the rule tree for a non-zero leaf, replacing the old
     `!rule || !rule.type` check, which passed a bare `percent ALL 0%`. That is why **39
     partners** could reach a run and be paid zero with no warning before 2026-08-07.
     `contractNeedsTerms` also requires a valid `aggregationMode` (`whole`/`per_store`) as of
     2026-08-09 — it used to check only the rule, so a contract with a paying rule and no
     `aggregationMode` could clear this step and then get silently skipped at run time by
     `payoutDecision` (which does check it). **73 live contracts** hit that gap before the fix.
  4. **Order list** — upload the order report (`.xlsx`); orders are overlaid onto the roster.
     Submits `POST /bulk-runs` with `merchants[]` + `orders[]`.
  - **Roster-authoritative:** every roster machine with a resolved `contractId` becomes an
    engine row (rentals/revenue 0); orders are overlaid by merchant name. Order-less
    merchants are still paid their fixed fees (MG/placement) per rule. Orders whose
    merchant is not in the roster are **unmatched** (not paid) — surfaced in a banner. A
    roster machine whose brand has **no `CONTRACT` at all** is a separate, permanent case
    — see "Deliberately unpaid" below. A brand that *does* have a `CONTRACT` but isn't paid
    this run (`noPayout`, no usable terms, or a calc error) still matches its orders — its
    revenue does not disappear, it goes into the run's **`skipped`** list (2026-08-09, see
    below) rather than `unmatched`.
  - Run detail: per-merchant table w/ revenue-share %, a **Skipped** section (brands that
    matched orders but weren't paid, with store count/rentals/revenue/reason per brand), an
    unmatched-orders banner, and an explicit reconciliation line — `paid + skipped +
    unmatched` must equal the order report's total revenue, shown as ✓/✗ rather than assumed
    — plus per-merchant CSV zip download (`<year>_<month>_revshare.zip`), per-run Delete, and
    **Archive** button (visible to `runCalcs` users). Archived runs show **🔒 Locked** —
    Delete is blocked (409) and an **Unarchive** button appears for admins only.
- **Analytics** (`nav-revshare-path`) — monthly combo chart (Revenue/Payout bars +
  Revenue-share % line, data labels), keyed by merchant name across stored bulk-run
  results. Defaults to Total (all merchants) with a search/filter over individual merchants.
- **Archived** (`nav-archived`) — read-only list of archived merchants (merchant, type,
  counter party, contract start/end, archived date) with per-row **Unarchive** gated
  `manageMerchants`. See "Archived merchants" below.
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
deleted**. On 2026-08-09 review, 41 of these 65 turned out to be payable partners (a rule
that pays something, not `noPayout`), covering 235 stores — see `infra/adopt-payable-brands.mjs`.
The user ruled: bring those 41 in, carrying their existing rule/aggregation; the other 24
(no paying rule) stay unpaid as originally decided.

**Corrected 2026-08-09 — the paragraph below used to claim orders against these brands land
in `unmatched`. That was wrong; here's what actually happens.** `applyMerchantRoster`
auto-creates a `CONTRACT` stub (flagged `noPayout: true`) for **every** roster label that
doesn't already resolve to one — not just when the same brand happens to reappear later. So
by the time a roster reaches `buildRosterRows`, every row already carries a `contractId`;
the `if (!m.contractId) continue` guard in `buildRosterRows` is dead code in production (kept
as defence in depth — see the comment at that line). Orders against one of these brands
**do match** their roster row — they are not unmatched — and accrue revenue exactly like any
other brand; the brand itself is skipped at payout time by `payoutDecision` because it's
`noPayout`. That revenue now surfaces in the run's **`skipped`** list (added 2026-08-09,
Finding 1 of the 2026-08-09 review) instead of silently vanishing from every total on the
page while still counting inside `orderCount`. The Merchant view still shows the brand as
visible-but-unpaid from the first roster upload onward; flipping `noPayout` off there (with
a paying rule) makes it get paid from the next run.

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

**Archived merchants (2026-08-09):** a `CONTRACT` can carry `archived: true` + `archivedAt`,
set manually from the Merchant view's per-row **Archive** button when the contract ends and
cleared from the **Archived** tab's **Unarchive**. Both go through the ordinary
`PUT /contracts/:id` merge (`archived` is in `WRITABLE`); `archivedAt` is stamped
**server-side** in `updateContractRoute`, only on the false→true transition, and deleted on
unarchive — a client clock never sets it. Archiving is **not** a delete: the row, its rule and
its `MERCHANT` store links all stay. What changes:
- `payoutDecision` (`bulk-runs.mjs`) skips an archived contract **before it looks at any rule**
  — second only to the missing-contract check, ahead of `noPayout`. Unlike `noPayout` it
  **warns**, because a roster still listing the brand means machines are live and earning under
  a contract you ended.
- The contract deliberately **stays in the roster name index**, so a roster label still resolves
  to it instead of minting a duplicate `noPayout` stub. Its stores keep matching orders, and
  that revenue lands in the run's **`skipped`** list, so `paid + skipped + unmatched` still
  reconciles.
- `contractNeedsTerms` (`payout.mjs`) returns `false` for archived, so an ended contract can
  never block step 4 of the run wizard with terms nobody intends to set. The frontend's
  `needsTerms` mirror carries the same clause — change one, change the other.
- The Merchant view filters archived rows out entirely, and **every count on that screen is
  over live rows only**.
No engine or DDB-schema change. Tests: `payout.test.mjs` + `bulk-runs.test.mjs` (123 total).

**Business rule (load-bearing):** KA "Placement (monthly)" is charged **per
machine / per store** (`flat_per_machine`), NOT a lump per merchant. MG is also
per machine, varying by device type. (The old import wrongly treated placement
as a lump and MG as a single flat amount — fixed 2026-05-31.)

**Bulk runs are stored in S3** (see §5), not inline in DDB.

**Immutability:** a run is a frozen snapshot (results + `ruleSnapshots` in S3).
Batch-updating rules NEVER alters past runs — only the merchant's (`CONTRACT`'s)
current rule, affecting future runs only. There is no in-place recompute for bulk runs by
design (user requirement: keep historical periods as-is).

**Current data (live, verified 2026-08-09 after the adoption):** 248 `CONTRACT` rows —
175 linked to the `PARTNER` row they were migrated or adopted from (134 from the first
migration + 41 from the adoption), 73 unlinked (created directly on the Merchant view or
by roster auto-create). 4,066 `MERCHANT` store-registry rows, 3,865 carrying a
`contractId`; **201 with none** — see "Deliberately unpaid" above. 199 brands in use.
**0 bulk runs of any kind have ever been performed against this data**, which is why the
first real run is also the first end-to-end test of the pipeline. The pre-migration
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

Tests: `npm test` → **123/123** pass (incl. `payout.test.mjs` — `ruleHasValue` /
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
| `lambda/revshare-api/code/db.mjs` | DynamoDB + S3 wrappers for every row family: Partner, Merchant (store registry), Contract, Run, BulkRun, machine-model Config. Also exports `DEFAULT_CURRENCY` (2026-08-09) — the region's default currency for auto-created contract stubs, `process.env.REVSHARE_CURRENCY` overridable, `'THB'` here. This file is **never synced between regions**, so the Singapore `db.mjs` must define its own `DEFAULT_CURRENCY` (default `'SGD'`) by hand — see §5/§8. `bulk-runs.mjs` reads it via a namespace import (`import * as dbModule from '../db.mjs'`), not a named one — a named import of a symbol the target `db.mjs` doesn't export is a static ESM error that fails the whole module load, which is exactly what took SG down for ~2 minutes during this fix before the import was changed. Until SG's `db.mjs` gets the mirror, SG silently falls back to `'THB'` (wrong, but non-fatal) rather than crashing. |
| `lambda/revshare-api/code/payout.mjs` | Pure payout-decision module (2026-08-07). No AWS imports. Exports `ruleHasValue` (does a rule tree pay anything?), `contractNeedsTerms` (also requires a valid `aggregationMode` as of 2026-08-09, to agree with `payoutDecision`), `indexContractsByName`/`resolveLabel` (name-based roster resolution). |
| `lambda/revshare-api/code/routes/` | partners.mjs, runs.mjs |
| `lambda/revshare-api/code/index.mjs` | Lambda entry: auth gate + route dispatch. |
| `lambda/revshare-api/code/routes/merchants.mjs` | Store-registry (`MERCHANT`) CRUD routes. |
| `lambda/revshare-api/code/routes/import.mjs` | POST /import/rev-share — parses KA Excel JSON into partners + merchants. Exports `compileRule`, `parseDeviceType`. Dormant: no frontend caller (see §1b). |
| `lambda/revshare-api/code/routes/bulk-runs.mjs` | Bulk run routes. Exports `buildRosterRows` (roster-authoritative row seeding, keyed by `contractId`; its `if (!m.contractId) continue` guard is defence in depth, not a live path — `applyMerchantRoster` always assigns a `contractId` first), `applyMerchantRoster` (resolves roster labels to `CONTRACT` rows, auto-creating a `noPayout: true` stub for any unmatched label; currency comes from `db.mjs`'s `DEFAULT_CURRENCY`, not a literal), `payoutDecision` (why a contract is/isn't paid; names the merchant in its warning when a sample name is available), `groupOrders` (legacy, order-only grouping, unused in the live route). `createBulkRunRoute` also builds a **`skipped`** list (2026-08-09) — brands that matched roster/order rows but weren't paid — with `skippedCount`/`skippedRevenue`/`totalOrderRevenue` on the run, so revenue never disappears from every total silently; see §1b and Finding 1 of the 2026-08-09 review. `paidBrandCount`/`rosterBrandCount` replace the old overloaded `merchantBrandCount` on the run payload (the `/bulk-runs/prepare` response still uses `merchantBrandCount` for its own, unambiguous meaning: distinct contracts in the roster). |
| `lambda/revshare-api/code/contracts.mjs` | Contract sheet-row normalisation, name matching (`matchContracts`), import diffing (`buildImportPlan`). Contract fields only — never touches `rule`. |
| `lambda/revshare-api/code/routes/contracts.mjs` | Contract (`CONTRACT`) CRUD + import routes. `WRITABLE` includes `rule`/`aggregationMode`/`noPayout`/`currency` for direct PUT edits — `CONTRACT` is the payout entity now (§5). |
| `lambda/revshare-api/tests/` | `engine.test.mjs`, `csv.test.mjs`, `contracts.test.mjs`, `payout.test.mjs`, `bulk-runs.test.mjs`, others — `npm test` → 123 total. |
| `frontend/index.html` | SPA shell + pre-paint auth gate. |
| `frontend/style.css` | All styles (tokenized). |
| `frontend/app.js` | All app JS: auth, screens, Merchant view grid + terms editor, run flow. |
| `frontend/service-worker.js` | PWA shell cache. **Bump `CACHE_VERSION` on every shell change.** |
| `frontend/lib/` | Self-hosted html2canvas + jsPDF + xlsx + zip.js. html2canvas/jsPDF are loaded but **unused** since the PDF-statement flow was removed with the Partners page (2026-08-07) — dead weight, not yet pruned. xlsx/zip.js are still used (roster/order upload, CSV-zip download). |
| `infra/setup-once.md` | One-time AWS resource walkthrough + live IDs. |
| `infra/deploy-lambda.sh` | Zip + `update-function-code`. |
| `infra/deploy-frontend.sh` | `aws s3 cp` per file. Injects API URL into `app.js` via sed. |
| `infra/trust-lambda.json`, `infra/role-policy.json` | IAM templates. |
| `infra/migrate-to-contracts.mjs` | One-off, idempotent migration (2026-08-07): copies `rule`/`aggregationMode`/`noPayout`/`currency` from each linked `PARTNER` onto its `CONTRACT`, then points every `MERCHANT` store row at a `contractId`. Conditional writes only ever set an absent field — safe to re-run. Already applied to production; not part of any deploy script. Needs the repo-root `package.json` deps below to resolve at all. |
| `infra/adopt-payable-brands.mjs` | One-off, idempotent (2026-08-09): brings the 41 of the 65 "deliberately unpaid" brands that are actually payable (paying rule, not `noPayout`) into the Merchant view — creates a `CONTRACT` per candidate `PARTNER` and points its store rows at it. Skips a partner that already has a contract (by `partnerId`). `--dry-run` reports counts + the brand list without writing. **Applied 2026-08-09 after explicit user approval** — 41 contracts created, 235 store rows pointed, 0 raced; a second dry run adopts nothing. Do not re-run casually. Needs the repo-root `package.json` deps (now including `ulid`, added 2026-08-09) to resolve. |
| `infra/compare-pipelines.mjs` | Read-only validation companion to the migration above — diffs migrated `CONTRACT` fields against the source `PARTNER` directly. Last run: 134/134 comparable contracts matched, 0 mismatches. Same dependency requirement as the migration script. |
| `package.json` (repo root) | Declares `@aws-sdk/client-dynamodb` + `@aws-sdk/lib-dynamodb` as devDependencies (added 2026-08-07, commit `52028d0`) plus `ulid` (added 2026-08-09, for `infra/adopt-payable-brands.mjs`'s new `CONTRACT` rows) purely so the `infra/` scripts above can resolve them. `node_modules` previously existed only under `lambda/revshare-api/code`; ESM resolves a bare specifier by walking up from the **importing file**, so no `cd` fixes this — a script in `infra/` needs a `node_modules` reachable from `infra/`, hence root-level deps + `npm install` at repo root. Also holds the `npm test` script. **Does not affect deploys** — `infra/deploy-lambda.sh` zips `lambda/revshare-api/code` only, which has its own `node_modules`/`package.json` for the AWS SDK version actually shipped to Lambda. |
| `docs/superpowers/specs/` | Design specs (frozen at spec time). |
| `docs/superpowers/plans/` | Implementation plans. |

## 4. Calculation engine (pure module)

`lambda/revshare-api/code/engine.mjs` exports:

- `MACHINE_MODELS` — `Set<string>` of the ten model codes (S5, S8, S10, T8, T10, T20, T35, L20, L40, M10)
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
123/123 should pass.

## 5. Data model

Single DDB table `RevsharePartner`. Five row families:

| pk | sk | What |
|---|---|---|
| `CONTRACT` | `CONTRACT#<contractId>` | **The payout entity (since 2026-08-07).** Merchant contract terms (type, counter party, unit counts, start/end, etc.) **plus** `rule`, `aggregationMode`, `noPayout`, `currency` — the fields a bulk run actually evaluates. Optional `partnerId` back-link to the `PARTNER` row it was migrated from. Edited entirely from the Merchant view screen. |
| `MERCHANT` | `MERCHANT#<merchantId>` | Store-registry row — one per physical machine/location, seeded from the roster upload. Carries `contractId` pointing at the `CONTRACT` (payout) row for its brand; 3,865 of 4,066 rows have one (3,630 from the first migration, +235 from the adoption) (see §1b "Deliberately unpaid" for the other 201). |
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

**Outstanding manual mirror (2026-08-09, not yet done — flagged by this session, needs to be
applied by hand in `~/revshare_sg`):** TH's `db.mjs` now exports `DEFAULT_CURRENCY =
process.env.REVSHARE_CURRENCY || 'THB'`, and `bulk-runs.mjs` (synced verbatim to SG) reads it
instead of hardcoding `'THB'` when auto-creating a contract stub. SG's `db.mjs` needs the same
export, with `'SGD'` as its hardcoded default:
```js
export const DEFAULT_CURRENCY = process.env.REVSHARE_CURRENCY || 'SGD';
```
**What actually happened when this shipped (2026-08-09):** the first cut of this fix used a
named import (`import { DEFAULT_CURRENCY } from '../db.mjs'`), which is a static ESM binding
— importing a name the target module doesn't export fails the whole module load. Deploying
that to SG ahead of the SG `db.mjs` mirror took `revshare-api-sg`'s `/healthz` down
(`Internal server error`) for about two minutes before it was caught and fixed in the same
session by switching to a namespace import (`import * as dbModule from '../db.mjs'; const
DEFAULT_CURRENCY = dbModule.DEFAULT_CURRENCY || 'THB';` — a plain property read, not a static
binding, so a missing export degrades to the `'THB'` fallback instead of crashing the module).
**That fallback is still wrong for Singapore** — new SG contract stubs will carry `'THB'`
until the mirror above is applied — it's just no longer fatal. Apply the mirror to stop the
silent-wrong-currency case, not to prevent a crash (that risk is already closed). This is the
same class of incident that took Singapore down for three hours earlier in this project — a
`db.mjs`-shaped omission — caught fast this time because deploys were healthz-checked
immediately.

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
3. **CSV rows must use the machine-model enum** (S5/S8/S10/T8/T10/T20/T35/L20/L40/M10).
   The engine throws on unknown models. Don't add a new model without also
   adding rule-editor UX for it in `frontend/app.js`. (`M10` is already in the engine's
   `MACHINE_MODELS` but missing from two frontend/backend allow-lists — see §11.)
4. **Bump `CACHE_VERSION` in `frontend/service-worker.js`** on every shell
   deploy. Same discipline as `expense`.
5. **Per-run `ruleSnapshot` is load-bearing.** Don't try to read the current
   `CONTRACT.rule` (or, in a legacy single-partner run, `partner.rule`) to
   display an old run — the run row already has the rule it was computed
   with frozen inside it.

## 11. Known limitations / v2 candidates

- **Duplicate store names concentrate revenue on one row — verified 2026-08-09, unfixed.**
  `buildRosterRows` indexes roster rows by `nameLower` with last-write-wins, so **every order
  for a duplicated store name lands on a single row and its siblings stay at 0 revenue**. The
  live registry has **1,043 duplicate name groups covering 2,831 of 4,066 store rows**, and
  **14 names span more than one `contractId`** — for those, revenue moves between brands.
  Under `whole` aggregation the partner total is unaffected. Under **`per_store` it is not**:
  it changes `max(GP, MG)` store by store, and 7-Eleven is `per_store` with 2,162 stores.
  Total revenue is conserved, so the run page's reconciliation banner shows OK and **will not
  catch this**. Predates the merchant-view migration. Fixing it needs a stable per-store key
  (the roster's `externalId`, or name+machine model) instead of the name alone — check what
  the order report actually joins on before changing it.

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
- **`M10` is a valid machine model in the engine but missing from two allow-lists.**
  `engine.mjs`'s `MACHINE_MODELS` has ten codes, including `M10` (confirmed
  2026-08-09) — but `frontend/app.js`'s `RS_MODELS` and
  `lambda/revshare-api/code/routes/merchants.mjs`'s `VALID_MODELS` both list only the
  other nine and omit it. A merchant row saved with `machineModel: 'M10'` via the
  `/merchants` route would be rejected by `VALID_MODELS`, and the frontend's
  device-type parser (`RS_MODELS`) can't recognise `M10` in free text either, even
  though the Merchant view's own unit-count columns include an `M10` column
  (`contracts.mjs` column F). Not fixed here — documented so it isn't rediscovered
  as a surprise.
- **`Others` still sits inside the WH/HH comparison** (pre-migration note, 2026-08-06 —
  written when `PARTNER` was still the payout entity; the mechanism described is
  unchanged post-migration, just re-read every "partner" below as the `CONTRACT` that
  inherited it). By design — 2026-08-06 only pulled Electricity out, see §1b. `Others` is
  a `flat_per_partner_total` lump, so a `per_store` partner configured with `Others` on
  `higher`/`hybrid-higher` will throw `flat_per_partner_total is not allowed in per_store
  mode…` from `validatePerStoreTree`. `bulk-runs.mjs` catches this per-partner and drops
  that partner from the run with a warning rather than failing the whole run. No partner
  had this configuration as of the last check (verified against all 206 TH partners on
  2026-08-06).

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

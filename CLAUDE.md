# revshare-aws — handoff

Last updated: 2026-08-26 (Singapore seeded: 554 contracts from the rev-share record; LL20/LL40/S10-A are real models; deploy preflight guards the SG db.mjs mirror).
Service-worker `CACHE_VERSION` is at `revshare-v124` (bump on every shell change).

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
  search, inline cell editing, per-row **Archive** (see below), **+ New merchant** (a full form dialog covering every typeable grid column, generated from `CONTRACT_GRID_COLUMNS` so it cannot drift from the grid; terms are set afterwards), **Upload
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

**Sparse duplicate rows in the merchant sheet (2026-08-10, fixed):** `buildImportPlan`'s
intra-batch merge used to be a plain `Object.assign`, documented as "later row in the batch wins
per field". The real workbook contains **sparse** duplicates — a second `Future Rangsit` line
carrying only the counter party — so those blanks erased the populated row's `installedUnits`,
`units`, `startDate`, `endDate` and `autoRenewal`. It did exactly that on the 2026-08-10 import
before being caught and repaired. The merge now copies a later row's field only when it carries
a value (blank = `null`/`undefined`/`''`, and for `units` an object with no entries). `IMPACT`,
whose two lines are both fully populated, still resolves later-row-wins as before. Two tests in
`contracts.test.mjs` pin both halves. The `declineToRenew` half of this was closed on
2026-08-13 by dropping that column entirely (see below), which also removed `bool()` — it had
no other caller.

**Merchant-sheet template download (2026-08-13):** the Merchant view's **Download sheet**
button writes the current (non-archived) merchant list as `.xlsx` in the exact shape **Upload
sheet** reads — sheet `All_Merchant`, two header rows, data from row 3, the same 23 fixed
column positions. `TEMPLATE_COLUMNS` in `frontend/app.js` is the writer's half of that
contract and must stay in lockstep with `normalizeContractRow`'s `at(i)` reads in
`lambda/revshare-api/code/contracts.mjs` — the importer reads by POSITION, not header name, so
a column added on one side and not the other silently shifts every field after it. The two
header-row-2 anchors it emits (col 1 `Merchant`, col 22 `Link Contract`) are the ones
`parseAllMerchantSheet` checks, so a downloaded file always passes the importer's own layout
guard. Columns 16-20 (share terms) are emitted blank and labelled "NOT imported" — they land
in `sheetTerms`, which `buildImportPlan` strips; terms live on the row and are set with **Edit
terms**. Every column carries a `desc` in `TEMPLATE_COLUMNS`, surfaced twice from that single source: as an Excel **cell comment on the header cell** (hover it) and as a **Field guide sheet**, placed first so the workbook opens on the instructions. `All_Merchant` is located by NAME, so extra sheets are invisible to the import. Import status per column comes from an explicit `imp` field, not from parsing the prose — inferring it from a "NOT USED" prefix silently mislabelled column A, whose description says "ignored" in different words. The sheet also opens with a filled-in **example row** showing the expected format where you type. Data starts at row 3 and every named row is imported, so there is no header trick that could hide it — it is skipped by name instead: `EXAMPLE_ROW_NAME` (`/^example row\b/i`) in `normalizeContractRow` drops it exactly like a blank name, so leaving it in place on upload is harmless rather than a junk merchant. `EXAMPLE_ROW` in `frontend/app.js` must keep matching it. **Verified lossless:** generating the file from all 249 live rows and feeding it back
through `parseAllMerchantSheet` + `normalizeContractRow` + `buildImportPlan` plans 0 creates
and 0 changed rows. Getting there required the `bool()` fix above and writing the *stored*
`installedUnits` rather than recomputing it (`unitsTotal(c) || null` turned a real 0 into a
blank). If either regresses, that round trip is the test to re-run.

**Decline-to-renew column dropped (2026-08-13):** the grid's `Decline` column
(`declineToRenew`, sheet column N) is gone — from the Merchant view grid, the **+ New
merchant** form, `normalizeContractRow`, and `WRITABLE`. It was set on **1 of 249** live
contracts (PAKKLONG MARKET, whose contract had already ended). **The stored field was NOT
deleted from DynamoDB** — nothing reads it, but the value survives on every row, so restoring
the column is a UI change rather than a data-recovery job. Column N **keeps its slot** in the
template and in the sheet layout: the importer reads by INDEX, so removing the position would
shift every field after it. It is now a fourth dead column alongside A, P and V.

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

Tests: `npm test` → **169/169** pass (incl. `ddb-util.test.mjs` — Query pagination +
BatchWriteItem chunking, §1c; `payout.test.mjs` — `merchantRowChanged` / `ruleHasValue` /
`contractNeedsTerms` / label resolution; `bulk-runs.test.mjs` — roster-to-contract
resolution + order-less fixed-fee; `contracts.test.mjs` — sheet-row normalisation, name
matching, and import-plan diffing, all contract-fields-only/no-rule-touch).

## 1c. The prepare timeout + registry duplication (2026-08-24) — READ BEFORE TOUCHING db.mjs

`POST /bulk-runs/prepare` timed out on every attempt from **2026-07-27** onward, and the
browser showed only **"Failed to fetch"**. Three defects in a chain, all now fixed:

1. **No pagination.** Every list function in `db.mjs` read `out.Items` from a single
   `QueryCommand`. A DynamoDB Query returns at most **1MB** per call and signals more via
   `LastEvaluatedKey`. `listMerchants()` therefore returned **2,289 of 6,142** `MERCHANT`
   rows and silently dropped the rest. This was never a theoretical limit — it had been
   live since the table passed 1MB.
2. **So the roster duplicated the registry.** `applyMerchantRoster` built `merchantByName`
   from that truncated list, so ~3,800 existing stores looked new: each got a fresh `ulid()`
   and a **duplicate row**. Every prepare ever run left its fingerprint in `createdAt`:
   1,844 rows on 2026-05-29, 1,197 on 2026-06-08, 741 on 2026-07-27, **2,595 on 2026-08-20**.
   The registry reached **6,661 rows for 2,431 distinct store names**.
3. **~4,000 individual `PutItem`s.** One write per roster row, unconditionally, at 256MB
   (≈1/6 vCPU, so request signing serialises on CPU): 25s in May, past the 30s Lambda
   timeout as the roster grew to 4,088 rows. **A killed Lambda still commits what it already
   wrote**, so each failed attempt added another batch of duplicates — the failure fed itself.

**Why it looked like a network error:** API Gateway's `DEFAULT_5XX` gateway response carried
no `Access-Control-Allow-Origin`, so the browser blocked the 504 body and `fetch` rejected
with a bare `TypeError`. `DEFAULT_4XX`/`DEFAULT_5XX` now carry CORS headers (deployment
`h7i8fg`) — a REST API needs an explicit **stage deployment** for a gateway-response change
to take effect. Note this is a **REST** API: the integration is hard-capped at **29s**, so
raising the Lambda timeout past it would have achieved nothing.

**Rules that follow from this:**
- **Never call `ddb.send(new QueryCommand(...))` directly for a list.** Use the `query()`
  helper in `db.mjs`, which wraps `queryAll` from `ddb-util.mjs`. Adding a row family means
  adding its list function the same way. `listContracts` (338 rows) still fits in one page
  today — that is luck, not safety, and silently truncating it would stop paying merchants.
- **`BatchWriteItem` rejects a whole batch containing two requests for the same key.**
  Same-name roster rows resolve to the same `merchantId`, so batches go through
  `chunkUnique`, which collapses repeats last-value-wins — exactly what the old
  one-PutItem-per-row code did by overwriting.
- **`BatchWriteItem` returns `UnprocessedItems` instead of failing** when DynamoDB declines
  part of a batch. `putMerchantsBatch` retries with backoff; dropping them loses rows silently.
- **It needs its own IAM action.** `dynamodb:BatchWriteItem` is not implied by `PutItem`.
  Added to `revshare-api-role`, `revshare-api-sg-role`, and `infra/role-policy.json` — the
  first deploy without it 500'd (and that error was visible only because of the CORS fix).

Lambda memory is now **1769MB** (1 full vCPU), up from 256MB.

**Still outstanding:** the **~4,230 excess registry rows** are untouched. 432 duplicate groups
are byte-identical; 825 differ (`externalId` in 523, `partnerId` in 366, `contractId` in 63,
`machineModel` in 5). The 2026-05-29 originals generally carry `externalId` and the later
clones are blank, but in **28 groups** the oldest row is blank where a newer sibling has one,
so a plain keep-oldest delete loses data. Agreed rule, not yet written: keep the oldest row's
`merchantId`; take `notes`/`partnerId`/`externalId` as first-non-empty; take
`contractId`/`machineModel` from the newest row; let the next prepare self-correct the rest.

## 1d. Order matching is THREE passes (2026-08-24) — and why

**The order report stamps each order with the merchant's name AT EXPORT TIME, not at rental
time.** This is the load-bearing fact. A store renamed on the platform changes name underneath
past periods: the same July orders appear as `รถไฟฟ้ามหานคร สถานีมีนบุรี` in an Aug 8 export
(matched, paid) and as `รถไฟฟ้ามหานคร สถานีตลาดมีนบุรี` in an Aug 24 one (unmatched, unpaid).
So **re-exporting a past period can change which stores match**, and nothing catches it: total
revenue is conserved, the revenue just moves into `unmatched`, and the run page's reconciliation
banner still shows OK. The order report has **no merchant/store ID column at all** — 42 columns,
and the only store identifier is the name string.

`buildRosterRows` therefore matches each order in three passes:

1. **Store name** — unchanged, and still the primary join.
2. **Machine number** — `Rental Machine No.` → the Machine List's `Business ID` → the roster
   row's `externalId`. Needs the **optional Machine List upload** (step 4 of the wizard); with
   no `machineIndex` the behaviour is byte-identical to before. Measured on 2026-08 data: 100%
   of orders carry a machine number, 100% of those machines are in the Machine List, 98.1%
   resolve to a roster ID. **Name wins when both resolve** — across 7,103 orders the two passes
   never disagreed (0 conflicts), so pass 2 can only ever recover an order, never move revenue
   between brands.
3. **Explicit alias** — `orderAliases` on the `CONTRACT`, set from a run's unmatched list with
   the **Assign→** / **+ Add merchant** buttons. See below.

**Aliases add a store, and that is not free.** By the user's 2026-08-24 decision an alias
**ADDS a store row** to the target contract rather than merging into an existing one — so it
counts as a store for `per_store` and **as a machine for `flat_per_machine` / per-machine MG**.
The assign dialog reads the per-machine amount off the actual rule tree and states the cost
before you confirm. Three rules follow, each pinned by a test:
- **Pass 3 runs LAST.** When the machine number proves the store is already in the roster,
  merging into the real row is correct; a second row for the same machine would overpay.
- **An alias with no matching orders creates NO row** (created lazily on first matching order),
  or a `flat_per_machine` merchant would collect placement for a machine that never existed.
- **Archived contracts are excluded** from the alias index, matching `payoutDecision` — an
  ended contract must not reacquire revenue through an alias set months ago.

## 1e. Runs store their inputs and can be recomputed (2026-08-24)

`putBulkRun` writes a **second** S3 object, `runs/<runId>.inputs.json` (parsed roster, orders,
machine list), kept separate from the payload so the run-detail page never downloads several MB
it does not render. `deleteBulkRun` removes both. Before this, a run's payload held only
aggregates, so "how would this run look under corrected matching?" could only be answered by
asking the user to re-upload files that existed solely in their Downloads folder and a browser
tab. **Runs created before 2026-08-24 have no inputs and cannot be recomputed** — that is a fact
about the data, not a bug; both the route and the CLI say so explicitly.

- `computeBulkRun` is split out of `createBulkRunRoute`: the HTTP route is a thin wrapper, so
  there is exactly one definition of what a run means and a CLI re-run cannot drift from one.
- `applyMerchantRoster(merchants, { persist: false })` resolves identically (new labels get
  **in-memory** stubs) but writes nothing. Without it, previewing a re-run would mutate the
  registry while claiming to write nothing. Verified live: 6,677 `MERCHANT` / 341 `CONTRACT`
  rows before and after.
- `POST /bulk-runs/:id/recompute` (`runCalcs`) rebuilds from stored inputs and **REPLACES** the
  run, stamping `recomputedFrom`/`recomputedAt`. Replacing rather than versioning is the user's
  explicit decision. **409 on an archived run** — archiving is the lock that makes a payout you
  have acted on immutable — and 409 with a clear message for runs predating stored inputs.
- `infra/rerun-bulk-run.mjs <runId> [--apply] [--replace]` does the same from the CLI, **dry run
  by default**, printing a before/after table, per-merchant payout deltas, what each pass
  recovered, and a reconciliation check.

A run also records **`unmatchedDetail`** — orders and revenue per unmatched name. The flat
`unmatched` name list is kept because the CSV download and every stored run depend on it; runs
predating this render in the same table with `—` in the numeric columns.

## 1f. Singapore (2026-08-26) — seeded from a TERMS sheet, not a roster

SG's table was empty until 2026-08-26. Its source, `Inforich ChargeSPOT Rev Share Record`, is a
**terms record, not a roster**, so the TH importer cannot read it — that one reads `All_Merchant`
by column POSITION. Sheets: `Key Account Payment` (19 brand-level rows), `Small Merchants Lists`
(1,223 stores, terms as free text), `Copy` (the same stores plus `merchant type.`).

`infra/import-sg-revshare.mjs` created **554 contracts**; `infra/backfill-sg-contract-fields.mjs`
then filled `merchantType` / per-model `units` / `installedUnits` on 540 of them. Both dry-run by
default. What to know before touching SG data:

- **Grouping is a judgement call.** Stores share a contract when `merchant type.` names a BRAND
  (`7 Eleven` 488 stores, `Cheers` 123, `Maxim` 32, `RE&S Group` 20, …) and stand alone when it
  is a category (`F&B` 248, `Retail` 105, `Health Care` 72, `默认` 30). The brand list is
  `BRAND_TYPES` in the import script; the dry run prints the whole grouping.
- **456 contracts are `noPayout`** — 451 had `-` in the sheet, 1 is a one-off payment, 4 key
  accounts carry neither fee nor RS%. `noPayout` rather than "unset" is deliberate: unset would
  block every SG run at the wizard's terms step, and a merchant without terms is a normal state
  (user, 2026-08-24).
- **3 multi-year escalators have no rule.** `1st year: S$410+5% … 2nd year: S$440+10% …` cannot
  be expressed — the model has no contract-year concept. Raw text is in their notes.
- **The sheet's `S10` column means `S10-A`** (user decision). SG runs no plain S10, so reading it
  literally would have paid Cheers nothing on its S10-A machines.
- **7-Eleven's rental fee sits under `S5` only.** Its notes carry a ⚠ saying so. Real exposure is
  **12 S10-A machines against 439 S5**, not the whole brand — confirm the rate and fix in Merchant view.
- **No roster yet.** These names come from the terms sheet, so they are not guaranteed to match the
  `Merchant label` values SG's platform export uses. Until a Businessmen list confirms them, a run
  may fail to resolve some and mint `noPayout` stubs. The unmatched-list Assign / + Add merchant
  buttons (§1d) are the intended cleanup path.
- Columns left blank on purpose: counter party, contacts, contract dates, notice, auto-renewal,
  contract link. The workbook's `PIC` is an internal owner, not a merchant contact, and
  `entry time.` is store registration, not a contract start.

**Grid unit columns are per-region now.** They are built from the region's Device Types
(`buildContractGridColumns` / `refreshContractGridColumns` in `app.js`), not a hardcoded
`S5/S8/M10/L20/L40` — that list matched neither region.

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
| `lambda/revshare-api/code/db.mjs` | DynamoDB + S3 wrappers for every row family: Partner, Merchant (store registry), Contract, Run, BulkRun, machine-model Config. Also exports `DEFAULT_CURRENCY` (2026-08-09) — the region's default currency for auto-created contract stubs, `process.env.REVSHARE_CURRENCY` overridable, `'THB'` here. Every list function paginates via `ddb-util.mjs`'s `queryAll` as of 2026-08-24 — do not add one that doesn't (§1c). Also exports `putMerchantsBatch` (BatchWriteItem + `UnprocessedItems` retry) and `merchantItem`, the item builder it shares with `putMerchant`. This file is **never synced between regions**, so the Singapore `db.mjs` must define its own `DEFAULT_CURRENCY` (default `'SGD'`) by hand — see §5/§8. `bulk-runs.mjs` reads it via a namespace import (`import * as dbModule from '../db.mjs'`), not a named one — a named import of a symbol the target `db.mjs` doesn't export is a static ESM error that fails the whole module load, which is exactly what took SG down for ~2 minutes during this fix before the import was changed. Until SG's `db.mjs` gets the mirror, SG silently falls back to `'THB'` (wrong, but non-fatal) rather than crashing. |
| `infra/import-sg-revshare.mjs` | Load SG's rev-share workbook into `RevsharePartnerSG` as contracts + terms (2026-08-26, §1f). Dry run by default. Holds `BRAND_TYPES` (which `merchant type.` values group stores) and `parseTerms` (the free-text term shapes). |
| `infra/backfill-sg-contract-fields.mjs` | Fill `merchantType` / `units` / `installedUnits` on SG contracts from the same workbook (2026-08-26). Dry run by default; never touches rule/aggregationMode/noPayout/currency. |
| `infra/check-db-exports.mjs` | Deploy preflight (2026-08-26): every name the synced code imports from `db.mjs` must exist in BOTH regions' `db.mjs`. `deploy-lambda-all.sh` aborts if not. See §8. |
| `infra/rerun-bulk-run.mjs` | Recompute a bulk run from its stored inputs (2026-08-24) — no browser token, no re-upload. Dry run by default; `--apply` writes a new run, `--replace` also deletes the original. Calls the same `computeBulkRun` the HTTP route uses, with `persist: false` on a dry run so a preview cannot mutate the registry. Sets `AWS_REGION` before importing `db.mjs` (which otherwise falls back to the wrong region) — hence its dynamic imports. |
| `lambda/revshare-api/code/ddb-util.mjs` | Pure DynamoDB helpers (2026-08-24), no AWS imports — the caller injects `send`. `queryAll` follows `LastEvaluatedKey` (every list in `db.mjs` goes through it; see §1c); `chunkUnique` builds duplicate-free `BatchWriteItem` batches. |
| `lambda/revshare-api/code/payout.mjs` | Pure payout-decision module (2026-08-07). No AWS imports. Exports `merchantRowChanged` (2026-08-24 — is a roster row worth writing back? see §1c), `ruleHasValue` (does a rule tree pay anything?), `contractNeedsTerms` (also requires a valid `aggregationMode` as of 2026-08-09, to agree with `payoutDecision`), `indexContractsByName`/`resolveLabel` (name-based roster resolution). |
| `lambda/revshare-api/code/routes/` | partners.mjs, runs.mjs |
| `lambda/revshare-api/code/index.mjs` | Lambda entry: auth gate + route dispatch. |
| `lambda/revshare-api/code/routes/merchants.mjs` | Store-registry (`MERCHANT`) CRUD routes. |
| `lambda/revshare-api/code/routes/import.mjs` | POST /import/rev-share — parses KA Excel JSON into partners + merchants. Exports `compileRule`, `parseDeviceType`. Dormant: no frontend caller (see §1b). |
| `lambda/revshare-api/code/routes/bulk-runs.mjs` | Bulk run routes. Exports `buildRosterRows` (roster-authoritative row seeding, keyed by `contractId`; its `if (!m.contractId) continue` guard is defence in depth, not a live path — `applyMerchantRoster` always assigns a `contractId` first), `applyMerchantRoster` (resolves roster labels to `CONTRACT` rows, auto-creating a `noPayout: true` stub for any unmatched label; currency comes from `db.mjs`'s `DEFAULT_CURRENCY`, not a literal), `payoutDecision` (why a contract is/isn't paid; names the merchant in its warning when a sample name is available), `groupOrders` (legacy, order-only grouping, unused in the live route). `createBulkRunRoute` also builds a **`skipped`** list (2026-08-09) — brands that matched roster/order rows but weren't paid — with `skippedCount`/`skippedRevenue`/`totalOrderRevenue` on the run, so revenue never disappears from every total silently; see §1b and Finding 1 of the 2026-08-09 review. `paidBrandCount`/`rosterBrandCount` replace the old overloaded `merchantBrandCount` on the run payload (the `/bulk-runs/prepare` response still uses `merchantBrandCount` for its own, unambiguous meaning: distinct contracts in the roster). |
| `lambda/revshare-api/code/contracts.mjs` | Contract sheet-row normalisation, name matching (`matchContracts`), import diffing (`buildImportPlan`). Contract fields only — never touches `rule`. |
| `lambda/revshare-api/code/routes/contracts.mjs` | Contract (`CONTRACT`) CRUD + import routes. `WRITABLE` includes `rule`/`aggregationMode`/`noPayout`/`currency` for direct PUT edits — `CONTRACT` is the payout entity now (§5). |
| `lambda/revshare-api/tests/` | `engine.test.mjs`, `csv.test.mjs`, `contracts.test.mjs`, `payout.test.mjs`, `bulk-runs.test.mjs`, `ddb-util.test.mjs`, `device-models.test.mjs`, others — `npm test` → 169 total. |
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
| `infra/import-merchant-sheet.mjs` | Applies an updated `All_Merchant` workbook to the live `CONTRACT` rows — the CLI form of the Merchant view's **Upload sheet** button, reusing `normalizeContractRow`/`buildImportPlan` and writing `putContract`'s exact shape (the HTTP route needs a browser Google token). Dry run by default, `--apply` to write. Verifies the two header anchors first, ABORTS if any planned update would change `rule`/`aggregationMode`/`noPayout`/`currency`/`archived`, never deletes a merchant absent from the sheet, and canonicalises the sheet's stale `Big C`/`Baan Ying`/`Future Rangsit` spellings onto the live rows. Comparisons are key-order-insensitive — DynamoDB does not preserve map key order, so a plain `JSON.stringify` diff reports phantom `units` changes on every re-run. Idempotent: a second dry run reports 0 changes. Applied 2026-08-10. |
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
169/169 should pass.

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
| POST | `/bulk-runs/:id/recompute` | Rebuild a run from its stored inputs and replace it (§1e). Requires `runCalcs`. 409 if archived, or if the run predates stored inputs. |
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

**Deploy preflight (2026-08-26).** `deploy-lambda-all.sh` now runs `infra/check-db-exports.mjs`
before deploying and **aborts** unless every name the synced code imports from `db.mjs` exists in
BOTH regions' `db.mjs`, then health-checks both afterwards. A named ESM import of a missing export
fails the whole module load, so this exact omission has taken SG down three times — most recently
on 2026-08-26, when `db.mjs` had been mirrored before `getBulkRunInputs` existed and never
re-mirrored (~2 min outage). A module that fails to load still deploys "successfully", which is
why the health check matters as much as the preflight.

Backend — **BOTH regions in one command** (revshare-aws is the source of truth;
syncs shared code TH→SG except `db.mjs`, then deploys `revshare-api` + `revshare-api-sg`):
```bash
./infra/deploy-lambda-all.sh        # set REVSHARE_SG_ROOT if the SG repo isn't at ~/revshare_sg
```
If it reports SG code changed, commit it in the `revshare_sg` repo. (`db.mjs` is
never synced — it holds each region's table/bucket; mirror db.mjs logic changes
by hand.) The frontend is a single shared site (one deploy serves both regions).

**Manual mirror — APPLIED (verified 2026-08-10 at `~/revshare_sg/lambda/revshare-api/code/db.mjs:17`).**
TH's `db.mjs` exports `DEFAULT_CURRENCY = process.env.REVSHARE_CURRENCY || 'THB'`, and
`bulk-runs.mjs` (synced verbatim to SG) reads it instead of hardcoding `'THB'` when
auto-creating a contract stub. SG's `db.mjs` carries the matching export with `'SGD'`:
```js
export const DEFAULT_CURRENCY = process.env.REVSHARE_CURRENCY || 'SGD';
```
Nothing to do here — the paragraphs below are the incident record for why this class of
omission matters, kept because `db.mjs` is still never synced and the next field added to it
will need the same hand-mirror.
**What actually happened when this shipped (2026-08-09):** the first cut of this fix used a
named import (`import { DEFAULT_CURRENCY } from '../db.mjs'`), which is a static ESM binding
— importing a name the target module doesn't export fails the whole module load. Deploying
that to SG ahead of the SG `db.mjs` mirror took `revshare-api-sg`'s `/healthz` down
(`Internal server error`) for about two minutes before it was caught and fixed in the same
session by switching to a namespace import (`import * as dbModule from '../db.mjs'; const
DEFAULT_CURRENCY = dbModule.DEFAULT_CURRENCY || 'THB';` — a plain property read, not a static
binding, so a missing export degrades to the `'THB'` fallback instead of crashing the module).
That fallback would have been wrong for Singapore — new SG contract stubs carrying `'THB'` —
but the mirror is in place, so SG reads its own `'SGD'` and the fallback is now unreachable.
Both the crash risk and the silent-wrong-currency risk are closed. This is the
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
  live registry had **1,043 duplicate name groups covering 2,831 of 4,066 store rows** when
  this was written; as of 2026-08-24 it is **1,257 groups over 6,661 rows**, and **63 names
  span more than one `contractId`** — for those, revenue moves between brands. Most of that
  growth is not genuine: it is the registry duplication of §1c, so the pending dedupe should
  shrink these numbers rather than being blocked by them. Re-measure after it runs; the
  underlying last-write-wins defect is separate and survives the dedupe.
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
- **~~`M10` missing from two allow-lists~~ — FIXED 2026-08-26.** `M10` is now in `RS_MODELS` and
  `VALID_MODELS` alongside the engine's `MACHINE_MODELS`. Singapore's `LL20`/`LL40`/`S10-A` were
  added to all three at the same time, as **separate models, not aliases** of `L20`/`L40`/`S10`:
  `import.mjs` used to end with `.replace('LL','L')`, and the frontend parser matched on
  `endsWith`, so `…-LL20` silently became `L20`. Per-model terms key off the code, so either fold
  pays an SG machine at a Thai rate — or nothing. `parseDeviceModel` now picks the LONGEST match;
  ordering alone would not save it, since `…-LL20` also ends with `L20`. `CONFIG#MODEL` rows for
  the three exist in `RevsharePartnerSG` only. Pinned by `tests/device-models.test.mjs`.
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

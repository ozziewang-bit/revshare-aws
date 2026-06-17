# revshare run-flow redesign — design spec

Date: 2026-06-17
Status: approved (brainstorming), pending implementation plan.

## 1. Goal

Redefine the bulk-run flow so that:

1. **Order-less merchants get paid.** Today a run only processes partners that have
   orders, so merchants with no rentals never receive fixed fees (Min Guarantee,
   placement). The redesign feeds the run a **merchant roster** so every roster
   machine is evaluated by its partner's rule — fixed fees are paid even with 0 orders.
2. **New runs follow a strict wizard:** pick period → upload merchant list → review/fix
   partner rules → upload order list → run.
3. **Historical runs can be archived (locked).**

The pure calculation `engine.mjs` is **unchanged** — the fix is purely about which rows
it receives. `aggregationMode` and the rule model are untouched.

## 2. New-run wizard (Run share → "+ New run")

A 4-step wizard; each step unlocks the next.

1. **Period** — pick the month (sets `periodStart`/`periodEnd`). → Next.
2. **Merchant list** — upload the "Businessmen list" `.xlsx` (see §3). On upload the app
   **applies it immediately** (`POST /bulk-runs/prepare`): upserts merchants into the
   registry and **creates any missing partners** (keyed by Merchant label = partner name)
   with an empty rule. Shows a preview: # approved merchants, # partners, # new partners,
   # merchants with no partner label. → Next.
3. **Review partner rules** *(gate)* — lists every partner in the roster with rule status:
   **✓ has rule · ⚠ no rule · "no-payout"**. Partners with **no usable rule** are editable
   **inline** (reuse the existing rule editor; save via `PUT /partners/:id`). The order-list
   step stays **locked while any roster partner has no usable rule** (block only on missing
   rules; partners that already have rules don't block — updating them is optional). → unlocks → Next.
4. **Order list** — upload the order report `.xlsx`; preview (# orders, # unmatched-to-roster).
   **"Run"** → `POST /bulk-runs` → computes and stores the run, then shows the run detail.

State (period, parsed roster, parsed orders) is held client-side through the wizard. The
merchant list is applied at step 2 (so step 3 can see new partners); the final run is
created at step 4.

## 3. Merchant-list template ("Businessmen list")

The exact upload/download template is the ChargeSpot "Businessmen list" export — 40 columns.
The parser reads only these; the rest are ignored on upload:

| Role | Column |
|---|---|
| Merchant name | `merchant name.` |
| Merchant name (EN) | `merchant name (English)` |
| **Partner name** | **`Merchant label`** |
| Machine type | `device type.` (e.g. `Advertising Player-S5` → model **S5**) |
| Approved filter | `Merchant Review State` (= `Approved`) |
| Merchant id (external) | `ID` |

- **Roster = Approved merchants only** (`Merchant Review State === 'Approved'`).
- **Partner = `Merchant label`.** A blank/`-` label = **no partner** → merchant is listed as
  "unassigned" (not paid; surfaced in the step-2 preview so it can be fixed in Partners → Merchants).
- **Machine model** is parsed from `device type.` by the trailing model code (S5/S8/S10/T8/T10/T20/T35/L20/L40);
  unknown → flagged. (A device cell may carry one model; comma-joined handled like elsewhere.)
- **↓ Sample / template download** mirrors these 40 columns in file order (with one example row).

## 4. Run computation

`POST /bulk-runs` body: `{ periodStart, periodEnd, merchants[], orders[] }` where
`merchants[]` = the parsed roster `[{ name, nameEn, partnerName, machineModel, externalId }]`
(Approved only) and `orders[]` = parsed order rows `[{ merchantName, netAmount }]`.

Backend (`createBulkRunRoute`, both regions):

1. **(Already applied at step 2 / re-applied idempotently here)** upsert roster merchants into
   the registry by `nameLower` (set partner via label, machine model, approved); create missing
   partners by label name (empty rule).
2. **Build the roster per partner** from `merchants[]` — every Approved merchant with a partner label.
3. **Seed engine rows for every roster machine** with `rentals = 0, revenue = 0`, then **overlay
   order data**: for each order, find its merchant in the roster (by name), add rentals (+1) and
   revenue (`netAmount`). Orders whose merchant is **not in the roster** → **unmatched** (counted,
   flagged in the result banner, **not paid**).
4. **Run each partner's rule** via the unchanged `evaluateRun({ rule, rows, aggregationMode, allowedModels })`.
   Because every machine is a row: per-machine terms (placement) pay on all machines; in `per_store`
   mode the `max(GP, MG)` floor applies per merchant — so order-less merchants get their fixed fees,
   summed per merchant, exactly as the partner's rule defines.
5. **Store the run** as a frozen S3 snapshot: full per-partner roster (incl. order-less merchants with
   their rentals/revenue), results, unmatched names, `ruleSnapshots`, plus `archived: false`.

Net change vs today: the run's row set is **roster ∪ orders (roster-authoritative)** instead of
**orders-only**. Per-partner CSV zip + run detail now reflect all paid merchants.

**Partners with no rule** should have been resolved in step 3; if one still slips through (e.g. created
but unset), it's recorded in the result with a zero/explanatory line and surfaced, never silently dropped.

## 5. Archive (lock)

- A bulk-run record gains `archived` (bool), `archivedAt`, `archivedBy`.
- **Run list & detail:** an **Archive** button on unlocked runs (visible to `runCalcs` users). An
  archived run shows a **🔒 Locked** badge, **Delete disabled**, no re-run. An **Unarchive** button
  shows **for admins only**.
- **Backend:** `POST /bulk-runs/:id/archive` (sets archived, requires `runCalcs`/`deleteRuns`),
  `POST /bulk-runs/:id/unarchive` (clears it, **admin only**). `DELETE /bulk-runs/:id` is **rejected
  with 409 when archived** (must unarchive first).

## 6. Data model & routes

- **Bulk-run record** adds `archived`/`archivedAt`/`archivedBy`; its per-partner `merchants` now
  include order-less roster machines.
- **New / changed routes:**
  - `POST /bulk-runs/prepare` — apply merchant list (registry upsert + create missing partners),
    return `{ rosterSummary, partnersNeedingRules[], unassignedMerchants[] }`.
  - `POST /bulk-runs` — now takes `merchants[]` + `orders[]` (was orders-only).
  - `POST /bulk-runs/:id/archive`, `POST /bulk-runs/:id/unarchive`.
  - `DELETE /bulk-runs/:id` — rejects when archived.
- **Permissions** (`auth.mjs`): prepare + archive ⇒ `runCalcs`; unarchive ⇒ `admin`.
- **Both backends** (`revshare-api` + `revshare-api-sg`) kept in parity; SG synced via
  `deploy-lambda-all.sh` and committed in `revshare_sg`.

## 7. Conventions / non-changes

- `engine.mjs` stays pure — no signature change; existing 55 tests stay green. New tests cover the
  **roster-seeding** (order-less machine → fixed fee) and the **roster-authoritative grouping** in the
  route/grouping layer.
- Service-worker `CACHE_VERSION` bumped on the shell change.
- No `Co-Authored-By:` trailers.
- Patch → deploy → validate → commit → push → doc.

## 8. Build order

1. Backend: `prepare` route (merchant upsert + partner create + rule-readiness) + new `createBulkRunRoute`
   roster seeding + archive/unarchive + delete guard. Tests.
2. Backend deploy both regions.
3. Frontend: merchant-list parser (Businessmen list columns) + ↓ Sample; the 4-step wizard; inline
   rule editor in step 3; archive/unarchive buttons + locked UI. SW bump.
4. Frontend deploy; validate end-to-end with a real merchant list + order report.
5. Docs (CLAUDE.md) + commit both repos.

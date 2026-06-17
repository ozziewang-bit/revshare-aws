# revshare-aws — handoff

Last updated: 2026-06-17 (roster-driven 4-step run wizard; merchant-list roster; archive lock on bulk runs).
Service-worker `CACHE_VERSION` is at `revshare-v70` (bump on every shell change).

This document is the authoritative starting point for the next session. Read it
end-to-end before touching anything. The codebase is the ultimate source of
truth — when this doc and the code disagree, the code wins.

## 1. What this is

A ChargeSpot partner revenue-share calculator. Finance picks a partner, uploads
a CSV of per-machine rental + revenue numbers for some period, and the
calculator applies that partner's stored rule (a small tree of leaves + combinators)
to produce an auditable payout breakdown plus a printable PDF statement.

Full design spec: [`docs/superpowers/specs/2026-05-28-revshare-design.md`](docs/superpowers/specs/2026-05-28-revshare-design.md).
Initial implementation plan (33 tasks): [`docs/superpowers/plans/2026-05-28-revshare.md`](docs/superpowers/plans/2026-05-28-revshare.md).
Run-flow redesign spec + plan: [`docs/superpowers/specs/2026-06-17-revshare-run-flow-redesign-design.md`](docs/superpowers/specs/2026-06-17-revshare-run-flow-redesign-design.md) + [`docs/superpowers/plans/2026-06-17-revshare-run-flow-redesign.md`](docs/superpowers/plans/2026-06-17-revshare-run-flow-redesign.md).

## 1b. CURRENT STATE (2026-06-17) — read this, the sections below are partly stale

Branding: app is **"RevShare SEA"** with a topbar **Thailand/Singapore** switcher
(`REGIONS` config in `app.js`; choice persists in `localStorage('rs_region')`,
default `th`, full `location.reload()` on switch so no TH↔SG state bleeds). TH →
API `7z269nmx74` / DDB `RevsharePartner`; SG → API `4qcyojfg79` / DDB
`RevsharePartnerSG` (the separate `revshare_sg` repo is the SG backend source —
keep its Lambda in parity with TH). Currency follows region via `CCY`/`SYM`
(THB/฿ · SGD/S$) across the chart axis, rule-editor labels, batch-CSV header,
PDF footer, and the new-partner default; per-partner stored `currency` still
drives each partner's own display. The SG standalone CloudFront (`E1ALROWEFJOG3Q`)
is deprecated — the unified site lives on `d2t76jfby056ul`.

**UI tabs (frontend/app.js):**
- **Partners** — partner list + detail (Merchants / Rule / Analytics tabs).
- **Run share** — roster-driven 4-step wizard for bulk monthly calc:
  1. **Period** — pick period start/end.
  2. **Merchant list** — upload the ChargeSpot "Businessmen list" `.xlsx` (Approved-only
     roster). Partner name comes from the **`Merchant label`** column; machine model is
     parsed from **`device type.`**. Calls `POST /bulk-runs/prepare`: upserts the merchant
     registry, creates missing partners (empty rule), and returns rule-readiness.
  3. **Review rules** — any roster partner with no usable rule is listed inline for immediate
     editing. Step 4 is locked until every roster partner has a rule (or is `noPayout`).
  4. **Order list** — upload the order report (`.xlsx`); orders are overlaid onto the roster.
     Submits `POST /bulk-runs` with `merchants[]` + `orders[]`.
  - **Roster-authoritative:** every roster machine becomes an engine row (rentals/revenue 0);
    orders are overlaid by merchant name. Order-less merchants are still paid their fixed fees
    (MG/placement) per rule. Orders whose merchant is not in the roster are **unmatched** (not
    paid) — surfaced in a banner.
  - Run detail: per-partner table w/ revenue-share %, unmatched-orders banner,
    per-partner CSV zip download (`<year>_<month>_revshare.zip`), per-run Delete, and
    **Archive** button (visible to `runCalcs` users). Archived runs show **🔒 Locked** —
    Delete is blocked (409) and an **Unarchive** button appears for admins only.
- **Analytics** (global + per-partner tab) — monthly combo chart (Revenue/Payout
  bars + Revenue-share % line, data labels). Global tab defaults to Total (all
  partners) with a partner search/filter. Built from stored run results.
- **Device Types** — machine-model CRUD.
- **Update** tab — **removed** (2026-06-17). Rule-batch CSV upload is no longer in the UI;
  `POST /import/rule-batch` and `parseKaExcel` / `/import/rev-share` code still exist in
  the backend but are unreachable from the frontend.

**Rule model (NEW — replaces the old leaf-tree editor UX):** a partner's rule is
built from **share terms** + a **payout method**. Terms: GP% (percent of revenue),
Electricity (lump), Placement (**per machine type**), Others (lump), and MG
(Minimum Guarantee, **per machine type**). Four payout methods (`form.method`):
- `default` (code **D**) — single term, just pay it.
- `hybrid` (code **H**) — sum of all terms.
- `higher` (code **WH**) — `max(each term…, MG)`.
- `hybrid-higher` (code **HH**) — `max(sum of terms, MG)`.
`compileRule`/`decompileRule` (frontend `app.js` + backend `routes/import.mjs`)
tag leaves with `_t` (term) and the root with `_method` so decompile is exact;
legacy untagged rules fall back to heuristics. **Engine is unchanged** — it still
just evaluates `sum`/`max`/`percent`/`flat_per_machine`/`flat_per_partner_total`.

**No-payout partners (2026-06-11):** a partner can carry `noPayout: true` (set via the Rule
tab / new-partner form checkbox "No revenue share — not paid"). Such partners show a calm
neutral **"No payout"** badge (normal row) in the partner list and are **skipped in bulk runs
regardless of any rule** (`bulk-runs.mjs` skips them before the no-rule check). The red
**"No rule"** danger badge + warning banner now flag **only** partners that are empty **and
not** `noPayout` (genuinely missing). Persisted via the partner PUT merge; create route sets
`noPayout: !!body.noPayout`. No engine/DDB-schema change.

**Business rule (load-bearing):** KA "Placement (monthly)" is charged **per
machine / per store** (`flat_per_machine`), NOT a partner lump. MG is also
per machine, varying by device type. (The old import wrongly treated placement
as a lump and MG as a single flat amount — fixed 2026-05-31.)

**Bulk runs are stored in S3** (see §5), not inline in DDB.

**Immutability:** a run is a frozen snapshot (results + `ruleSnapshots` in S3).
Batch-updating rules NEVER alters past runs — only the partner's current rule,
affecting future runs only. There is no in-place recompute for bulk runs by
design (user requirement: keep historical periods as-is).

**Current data:** 112 partners, all rules regenerated into the new shape from
the KA file on 2026-05-31. The canonical 2026-05 run total is **680,172.65**
(per-machine placement); an earlier 528,383.32 run is superseded but still stored.

**Aggregation mode + MG floors (2026-06-08):** a `higher`/`hybrid-higher` rule's
MG floor only applies **per merchant** when the partner is `aggregationMode:
per_store`. In `whole` mode the `max(GP, MG)` collapses to the partner aggregate,
so small stores get only their GP slice (no floor). **7-Eleven** was switched to
`per_store` on 2026-06-08 for this reason (per-store guarantee; partner total
244,527.50 → 333,252.50 on 2026-05 — pending a re-upload of more accurate raw
data). **กะทู้** has the same `max(50% GP, S8=200)` shape and is still `whole`
(should be flipped; no current impact). BIG-C/BTS/AOT/Turtle Shop are MG-dominated
at every store, so whole == per_store — no change needed. The engine + per-merchant
CSV already handle per_store correctly; this was a config issue, not a code bug.

Tests: `npm test` → **58/58** pass (incl. `bulk-runs.test.mjs` — roster seeding + order-less fixed-fee).

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
| `lambda/revshare-api/code/db.mjs` | DynamoDB wrappers (Partner / Run rows). |
| `lambda/revshare-api/code/routes/` | partners.mjs, runs.mjs |
| `lambda/revshare-api/code/index.mjs` | Lambda entry: auth gate + route dispatch. |
| `lambda/revshare-api/code/routes/merchants.mjs` | Merchant CRUD routes. |
| `lambda/revshare-api/code/routes/import.mjs` | POST /import/rev-share — parses KA Excel JSON into partners + merchants. Exports `compileRule`, `parseDeviceType`. |
| `lambda/revshare-api/code/routes/bulk-runs.mjs` | Bulk run routes. Exports `buildRosterRows` (roster-authoritative row seeding), `applyMerchantRoster` (upsert registry + create partners), `groupOrders` (legacy, order-only grouping). |
| `lambda/revshare-api/tests/` | `engine.test.mjs` (25 tests), `csv.test.mjs` (6 tests). |
| `frontend/index.html` | SPA shell + pre-paint auth gate. |
| `frontend/style.css` | All styles (tokenized). |
| `frontend/app.js` | All app JS: auth, screens, rule editor, run flow, PDF. |
| `frontend/service-worker.js` | PWA shell cache. **Bump `CACHE_VERSION` on every shell change.** |
| `frontend/lib/` | Self-hosted html2canvas + jsPDF (used by client-side PDF generation). |
| `infra/setup-once.md` | One-time AWS resource walkthrough + live IDs. |
| `infra/deploy-lambda.sh` | Zip + `update-function-code`. |
| `infra/deploy-frontend.sh` | `aws s3 cp` per file. Injects API URL into `app.js` via sed. |
| `infra/trust-lambda.json`, `infra/role-policy.json` | IAM templates. |
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
31/31 should pass.

## 5. Data model

Single DDB table `RevsharePartner`. Three row families:

| pk | sk | What |
|---|---|---|
| `PARTNER` | `META#<partnerId>` | Partner config + frozen rule tree. |
| `RUN#<partnerId>` | `RUN#<runId>` | One run = one CSV upload + computed result. Includes `ruleSnapshot` (rule frozen at calc time) + `csvRaw` (base64) + `csvParsed` + `result`. |
| `BULKRUN` | `BULKRUN#<runId>` | **Slim summary index only** (counts, totals, `s3Key`). Full payload (results, unmatched names, ruleSnapshots) lives in S3 — see below. |

**Bulk-run payloads live in S3, not DynamoDB.** A bulk run over a full month
(20k+ orders → ~1.5k merchants) exceeds DynamoDB's hard 400 KB item limit.
So `putBulkRun` writes the full JSON to S3 (`s3://revshare-runs-812751451548-sea7/runs/<runId>.json`)
and stores only a slim summary row in DDB. `getBulkRun` reads the slim row,
then fetches the full payload from S3 via `s3Key` (legacy pre-S3 runs without
`s3Key` are returned inline for backward compat). The Lambda role has
`s3:GetObject`/`s3:PutObject` on that bucket only (see `infra/role-policy.json`).

**Rule snapshot per run** is load-bearing: editing a partner's rule does NOT
retroactively change old run results. Each run's PDF/statement reproduces
exactly what was computed at the time.

## 6. Backend routes

**Auth required** — Google Sign-In token (see §9). All routes except `GET /healthz` require a valid Bearer token from an `@inforich.com` / `@inforichjapan.com` account. Writes require specific permissions; reads are open to any authenticated user except `/users` (admin only).

| Method | Path | Purpose |
|---|---|---|
| GET | `/healthz` | Liveness probe |
| GET | `/partners` | List non-archived partners |
| POST | `/partners` | Create partner |
| GET | `/partners/:id` | Get partner (incl. rule) |
| PUT | `/partners/:id` | Update partner (name/currency/aggregationMode/rule/notes) |
| DELETE | `/partners/:id` | Soft-archive |
| POST | `/partners/:id/runs` | Create run from uploaded CSV (`{periodStart, periodEnd, csvBase64}`) |
| GET | `/partners/:id/runs` | List partner's runs |
| GET | `/partners/:id/runs/:runId` | Get one run (incl. csvRaw, csvParsed, result) |
| POST | `/partners/:id/runs/:runId/rerun` | Re-apply current rule to stored CSV |
| POST | `/import/rule-batch` | Apply a whole rule-batch upload (Update tab — now removed from UI) in ONE invocation — overwrites/creates partners, upserts merchants by `nameLower` with bounded concurrency (`mapPool`). |
| POST | `/bulk-runs/prepare` | Apply uploaded merchant list: upsert registry, create missing partners (empty rule). Returns `{rosterCount, partnerCount, newPartners, unassigned, partnersNeedingRules}`. Requires `runCalcs`. |
| POST | `/bulk-runs` | Create bulk run. Body: `{periodStart, periodEnd, merchants[], orders[]}`. Re-applies roster idempotently, runs engine. Requires `runCalcs`. |
| GET | `/bulk-runs` | List bulk run summaries. |
| GET | `/bulk-runs/:id` | Get full bulk run (from S3). |
| POST | `/bulk-runs/:id/archive` | Lock run (sets `archived: true`). Requires `runCalcs`. Locked runs block DELETE (409). |
| POST | `/bulk-runs/:id/unarchive` | Remove lock. Requires `admin`. |
| DELETE | `/bulk-runs/:id` | Delete run. Returns 409 if archived. Requires `deleteRuns`. |

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
  (`renderUsersScreen`) edits grants via `/users`.
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
5. **Per-run `ruleSnapshot` is load-bearing.** Don't try to read
   `partner.rule` to display old runs — the run row already has the rule it
   was computed with frozen inside it.

## 11. Known limitations / v2 candidates

- **No CloudFront / no custom domain** — site is HTTP-only via S3 static
  website. Provisioning CloudFront + ACM cert is a 30-minute Console job;
  set `REVSHARE_CLOUDFRONT_DIST_ID` in env after that and the deploy
  script will invalidate on every push.
- **No advanced tree editor** — the basic rule editor (vertical leaf cards
  under implicit SUM) covers ~80% of contract shapes. Rules requiring
  MAX/MIN nesting must be edited via the raw rule JSON in DynamoDB, or
  via the API directly (`PUT /partners/:id` with the rule body).
- **No multi-currency / FX** — each partner stands alone in their fixed
  currency. By design.
- **No partner-facing portal** — only finance staff log in.
- **CORS is `*`** on the API Gateway. Tighten once a stable domain is
  picked.
- **Icons are minimal placeholders** (solid blue squares). Replace with
  real artwork when the brand identity is set.
- **No automated tests on the routes or frontend** — engine has 31 tests
  but the HTTP layer is verified by manual smoke testing only.

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

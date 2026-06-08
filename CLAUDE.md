# revshare-aws — handoff

Last updated: 2026-06-08 (server-side rule-batch endpoint; rule model overhaul, S3 runs, Analytics/Update tabs, Thailand branding).
Service-worker `CACHE_VERSION` is at `revshare-v59` (bump on every shell change).

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

## 1b. CURRENT STATE (2026-05-31) — read this, the sections below are partly stale

Branding: app is **"RevShare CHARGESPOT Thailand"** (title/manifest/topbar). Topbar
shows the ChargeSpot logo (`frontend/logo.png`) + "RevShare Thailand". Per-region;
swap name in index.html/manifest.json + `logo.png` for other regions.

**UI tabs (frontend/app.js):**
- **Partners** — partner list + detail (Merchants / Rule / Analytics tabs).
- **Run share** (was "Share Calculation") — bulk monthly calc. Upload an order
  report (xlsx), it parses orders (excludes only `unpaid`; refunded kept),
  groups by partner via merchant registry, runs each partner's rule, stores a run.
  Run detail has: per-partner table w/ revenue-share %, unmatched-orders banner,
  per-partner CSV zip download (`<year>_<month>_revshare.zip`), and per-run Delete.
- **Analytics** (global + per-partner tab) — monthly combo chart (Revenue/Payout
  bars + Revenue-share % line, data labels). Global tab defaults to Total (all
  partners) with a partner search/filter. Built from stored run results.
- **Device Types** — machine-model CRUD.
- **Update** (was "Import") — **global rule batch update from CSV**. One file
  updates many partners: columns `Partner Name, Merchant Name, Device Type,
  GP (%), Electricity, Placement, Others, Min Guarantee, Payout Method`. Rows
  group by Partner Name → existing partners' rules overwritten, new partners
  created, merchants upserted. (KA Excel import was removed from the UI;
  `parseKaExcel` + `/import/rev-share` code still exist but are unreachable.)

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

Tests: `npm test` → **50/50** pass.

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
| `lambda/revshare-api/code/routes/bulk-runs.mjs` | Bulk run routes. Exports `groupOrders` (pure). |
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

**No authentication.** Removed 2026-05-28 — single-user app, the operator
controls who can reach the API URL by other means (custom domain + IP
allowlist on CloudFront, or just sharing the URL only with the finance
team). If auth becomes necessary, see §11.

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
| POST | `/import/rule-batch` | Apply a whole rule-batch upload (Update tab) in ONE invocation — overwrites/creates partners, upserts merchants by `nameLower` with bounded concurrency (`mapPool`). Replaces the old browser-side per-partner/per-merchant fan-out that got throttled. |

CORS configured on the API Gateway to allow `*` origin with headers
`content-type, x-app-password`. Adjust the `AllowOrigins` once a custom
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

Backend (Lambda code):
```bash
./infra/deploy-lambda.sh
```

Frontend (SPA):
```bash
./infra/deploy-frontend.sh
```

If/when CloudFront is provisioned:
```bash
REVSHARE_CLOUDFRONT_DIST_ID=EXXXXXX ./infra/deploy-frontend.sh
```

## 9. Auth

**No auth.** Removed 2026-05-28. If you ever want to add it back:
- The auth-fail rate-limit row family already existed in DDB design — you
  can resurrect it without a schema change.
- The pattern from `expense` (scrypt hash in SSM, `x-app-password` header,
  in-memory cache, IP rate limit) is the right template; check the
  `expense` project's `lambda/expense-data-api/code/index.mjs` for the
  current shape.
- Reapply SSM read to the Lambda IAM role (currently removed —
  `infra/role-policy.json`).

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

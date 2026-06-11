# No-payout partner status — design

Date: 2026-06-11
Repo: `revshare-aws` (RevShare SEA). Frontend (`frontend/app.js`, `frontend/style.css`) +
backend (`lambda/revshare-api/code/`). Shared backend code deploys to **both** regions
(TH + SG) via `./infra/deploy-lambda-all.sh`.

## Problem
A partner whose rule has no revshare term currently shows a **red "No rule" danger badge**
+ a warning banner ("N partner(s) have no rule set — they are skipped in bulk runs"),
framing it as a mistake (someone forgot to fill the terms). But some partners are
**intentionally not paid** — no revenue share by design. They should read as a deliberate,
calm status, not an error — while genuinely-missing rules keep their warning.

## Approach (chosen: A)
Add an explicit **`noPayout`** boolean on the partner, decoupled from the rule tree. The
partner's intent is stored independently of whether the rule happens to be empty, so we can
tell "intentionally unpaid" apart from "forgot to set terms".

Rejected: a fifth payout method `_method:'none'` (conflates *how* to pay with *whether* to
pay; an empty rule may carry no `_method`); a partner `status` enum (over-built — YAGNI).

## Data model
- New field on the partner item: `noPayout: boolean` (default `false`/absent).
- **Persistence:** `updatePartnerRoute` already merges `{ ...existing, ...body }`, so a
  `noPayout` sent in a `PUT /partners/:id` body persists with no change. Add
  `noPayout: !!body.noPayout` to `createPartnerRoute`'s partner object for completeness.
- No DDB schema change (single-table, schemaless attributes).
- No `engine.mjs` change — the engine stays pure; `noPayout` is a partner-config concern
  handled at the route/UI layer.

## Three partner-list states (`frontend/app.js`, `renderPartnersList`/`renderTable`)
The existing `noRule(p)` helper detects an empty/all-zero rule. Layer `noPayout` on top:
- **`p.noPayout === true`** → a **neutral** badge `No payout` (reuse `.badge .badge-neutral`),
  **normal row** (no `.row-norule` tint). Excluded from the warning banner count.
- **empty rule AND not `noPayout`** → unchanged: red `.badge-danger` "No rule" + `.row-norule`
  tint; counted in the banner. (Genuinely missing.)
- **has terms** → no badge.
- Banner count becomes `partners.filter(p => noRule(p) && !p.noPayout).length` so intentional
  no-payout partners no longer inflate the "needs attention" number.

## Partner form (Rule tab, `frontend/app.js`)
- Add a checkbox: **"No revenue share — this partner is not paid."**
- When checked: the rule editor is visually dimmed/optional (terms not required); on save the
  partner is written with `noPayout: true` (the rule may stay empty).
- When unchecked: `noPayout: false`; existing rule-editor behaviour unchanged.
- Save path includes `noPayout` in the `PUT`/`POST` body.

## Bulk runs (`lambda/revshare-api/code/routes/bulk-runs.mjs`)
- A `noPayout` partner is **skipped** (zero payout) in a bulk run **regardless of its rule** —
  so a stale non-zero rule can never accidentally pay a partner marked no-payout. This sits
  alongside the existing skip of partners whose rule pays nothing.
- Past runs are immutable snapshots — unchanged. Only future runs honour the flag.

## Edge cases
- A partner marked `noPayout` that still has a non-zero rule → not paid (flag wins in runs);
  the list shows the neutral "No payout" badge (no red), since `noPayout` takes precedence.
- Toggling `noPayout` off on an empty-rule partner → reverts to the red "No rule" warning.
- Legacy partners without the field → `noPayout` absent → treated as `false` (current
  behaviour preserved).

## Testing
- Engine tests unaffected (no engine change) — `npm test` stays green.
- Manual: create/edit a partner, tick "No revenue share" → neutral "No payout" badge, normal
  row, not in banner count; untick on an empty rule → red "No rule" returns; a bulk run skips
  a `noPayout` partner even if it has a leftover rule.

## Out of scope
- A dedicated "not paid (by design)" section in the bulk-run report (could be a follow-up; the
  run already simply skips them).
- Bulk-editing `noPayout` across many partners (one at a time via the form for now).
- Any change to the rule/term model or the four payout methods.

## Deploy
Backend: `./infra/deploy-lambda-all.sh` (TH + SG; `routes/partners.mjs` + `routes/bulk-runs.mjs`
are shared, synced TH→SG). Frontend: `./infra/deploy-frontend.sh`. Bump service-worker
`CACHE_VERSION` on the shell change.

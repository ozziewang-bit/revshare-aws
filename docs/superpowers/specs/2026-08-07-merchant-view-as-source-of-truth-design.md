# Merchant view as the source of truth

**Date:** 2026-08-07
**Status:** Approved, pending implementation plan
**Supersedes:** the partner-centric data model that has held since the app was built

## 1. What changes and why

Today a payout is defined by a **partner**: the partner owns the rule and the aggregation
mode, the store registry points at partners, and the Partners page is the only place to
edit any of it. The Merchant view — added this week from the `All_Merchant` sheet — is a
parallel register of 207 brand-level rows that the run pipeline never reads.

Two registers describing the same merchants is the problem. The user's decision:
**the Merchant view is the truth, and every other feature develops from it.**

So the Merchant view row becomes the payout entity, the run pipeline reads it, and the
Partners page is removed.

## 2. The conditions that make this feasible now

Verified against the live Thailand table on 2026-08-07:

| | |
|---|---|
| Bulk runs stored | **0** |
| Per-partner runs stored | **0** |
| Run payload objects in S3 | **0** |
| Contract rows | 207 |
| Store-registry rows | 4,066 |
| Distinct brands the registry uses | 199 |
| …that have a contract row | **134** |
| …with **no** contract row | **65** (436 store rows) |
| Contract rows with no partner | 73 |
| Overlap between those 73 and those 65, by name | **0** |

**There is no run history.** Nothing references the old keys, so no result payload, chart
or statement has to be migrated. That window closes the first time a period is run, which
is why this is worth doing now rather than later.

## 3. Decisions taken

**The 65 uncovered brands are not paid.** The sheet is authoritative; brands it does not
list have no payout record. Their 436 store rows are **not deleted** — deleting data to
express "we don't pay them" is the wrong trade. They resolve to nothing and appear in the
run's unmatched list, the same way unmatched orders already surface. Silent is the failure
mode to avoid; visible and reversible is the goal.

**Partner records are kept, dormant.** The Partners page is removed from the UI and
nothing reads `PARTNER` rows, but the rows and the `/partners` routes stay. If a migrated
rule turns out wrong, the original is still there to compare against. Deleting them buys
nothing and forecloses that check.

**The per-partner single-run flow goes.** `POST /partners/:id/runs`, its CSV upload and
PDF statement live only on the Partners page. Zero such runs exist, so nothing is lost.
If that workflow is wanted again it gets rebuilt from the Merchant view.

## 4. Data model

`CONTRACT` rows gain the four fields that made a partner a payout entity:

| Field | Meaning |
|---|---|
| `rule` | The payout rule tree, exactly as `PARTNER.rule` held it |
| `aggregationMode` | `whole` or `per_store` |
| `noPayout` | Not paid at all; skipped by runs |
| `currency` | `THB` / `SGD`, region-scoped as today |

`partnerId` is retained on the contract as a record of where the rule came from. Nothing
reads it after migration.

`MERCHANT` (store-registry) rows gain **`contractId`**, keeping `partnerId` for
traceability. A store with no `contractId` is unmatched and unpaid.

No new tables, no new row families, no change to the DynamoDB key design.

## 5. Migration

One idempotent script, run once per region.

**Step 1 — rules onto contracts.** For each contract with a `partnerId`, copy `rule`,
`aggregationMode`, `noPayout` and `currency` from that partner. Covers 134 rows.

**Step 2 — stores onto contracts.** For each store row, follow `partnerId` to the contract
that references it and set `contractId`. Reaches **3,630 of 4,066**. The remaining 436 are
left without one, deliberately.

This assumes **one contract per partner**, which holds today: the 134 linked contracts
reference 134 distinct partners. The script must assert it rather than trust it — if two
contracts ever share a partner there is no single answer for that partner's stores, and the
script must stop and name the collision instead of picking one.

**Safety property:** the script only writes a field that is currently absent on the
target. Re-running it cannot overwrite a rule edited in the app after the first run. It
reports what it changed, what it skipped, and the final coverage counts.

## 6. Run pipeline

**Roster upload (`applyMerchantRoster`).** Resolves each roster row's `Merchant label` to a
**contract row** by `merchantNameLower`, rather than to a partner by name. A label with no
contract row creates one, with an empty rule — the same onboarding behaviour partners have
today, so a new merchant still appears from a roster upload.

**Readiness gate.** `partnersNeedingRules` becomes `merchantsNeedingTerms`: contract rows
that are neither `noPayout` nor carrying a rule that pays something.

"Pays something" must be tested by walking the rule for a non-zero value — a `percent` leaf
with a non-zero percent, a `flat_*` leaf with a non-zero amount, a `tiered_percent` with a
non-zero tier — not by the current check `!p.rule || !p.rule.type`. That check passes a bare
`percent ALL 0%`, which is exactly why **39 partners can reach a run today and be paid zero
with no warning**. The Partners list already applies the stricter test (`ruleHasValue`,
currently nested inside `renderPartnersList`); the run pipeline does not, and the two must
agree. Lift that helper somewhere both can use rather than writing a second copy.

**Evaluation.** Rows group by `contractId`; each group is evaluated with that contract's
own `rule` and `aggregationMode`; `noPayout` contracts are skipped. **The engine does not
change** — it still takes a rule, rows and an aggregation mode. Only the source changes.

**Results.** Keyed by `contractId` and merchant name instead of `partnerId`. Since no runs
exist, there is no historical shape to stay compatible with.

## 7. UI

- **Partners tab and all its screens removed:** list, detail, Merchants tab, Rule tab,
  per-partner Analytics, and the new-partner form.
- **Merchant view Edit dialog** writes `rule`, `aggregationMode` and `noPayout` directly to
  the contract row. No partner is created or touched.
- **Run share wizard** step 3 lists merchants needing terms and links to the Merchant view.
- **Global Analytics** keys off merchant name rather than partner.

## 8. Validation

There is no run history, so nothing proves the new pipeline agrees with the old one — the
old one has never produced a number. That gap has to be closed deliberately rather than
discovered during a month-end.

The plan must include a **dual-run comparison**: evaluate the same roster and order report
through both the partner-keyed and contract-keyed paths, and diff total payout per
merchant. A non-zero diff on any merchant is a migration defect, not a rounding artefact.
This runs before the Partners page is removed, while both paths still exist.

Beyond that: unit tests on the new resolution and readiness logic in the same pure-module
style as `contracts.mjs`, and the existing 96 tests must stay green.

## 9. Out of scope

- **Deleting `PARTNER` rows or the `/partners` routes.** Kept dormant by decision.
- **Reconciling the 65 uncovered brands.** They are not paid; that is the decision.
- **`BTS + Super Turtle`.** The user will split it into two merchant rows by hand.
- **A tiered-percent (Sliding Scale) editor.** Still unbuilt; four merchants in the sheet
  would need it.
- **Singapore.** Its partner table is empty; the same migration runs there and does nothing.

# Electricity fee sits outside the payout comparison

**Date:** 2026-08-06
**Status:** Approved, pending implementation
**Scope:** Rule compilation / decompilation only. No engine change, no data migration.

## 1. Problem

A partner's rule is built from share terms (GP %, Electricity, Placement, Others)
plus an optional per-device-type Minimum Guarantee, combined by one of four payout
methods. Two of those methods compare terms against each other:

| Method | Code | Today |
|---|---|---|
| `higher` | WH | `max( GP , Elec , Placement , Others , MG )` |
| `hybrid-higher` | HH | `max( GP + Elec + Placement + Others , MG )` |

Both are wrong for Electricity. The electricity fee is a **reimbursement of a cost the
partner actually incurs**, not an alternative basis for the revenue share. It must
always be paid on top of whatever the comparison settles on:

- In **WH**, electricity competes as a candidate and — being a small lump — essentially
  always loses, so the partner is never reimbursed.
- In **HH**, electricity is folded into the summed side, so whenever the MG floor wins
  the reimbursement is silently swallowed.

## 2. Target semantics

Electricity is removed from the comparison and added to the result.

| Method | Code | After |
|---|---|---|
| `default` | D | single term — **unchanged** |
| `hybrid` | H | `GP + Elec + Placement + Others` — **unchanged** |
| `higher` | WH | `max( GP , Placement , Others , MG ) + Elec` |
| `hybrid-higher` | HH | `max( GP + Placement + Others , MG ) + Elec` |

`Others` **stays inside** the comparison (confirmed with the user). Electricity is the
only always-added term. `default` and `hybrid` already sum every term, so the change is
a no-op there.

Edge cases follow from the formula and need no special casing:

| Situation (WH) | Result |
|---|---|
| Electricity + MG, nothing else | `MG + Elec` |
| Electricity only, no MG, no other terms | `Elec` |
| No terms at all | `0` |

Same for HH.

## 3. Approach

Three options were considered.

**A. Encode it in the rule tree — chosen.** `compileRule` emits
`sum( max(…) , elecLeaf )` instead of placing the electricity leaf inside the `max`.
The engine already evaluates `sum` and `max`, so **the engine is not touched**. The
stored rule remains fully self-describing, which keeps per-run `ruleSnapshot`
reproducibility intact (CLAUDE.md §10.5).

**B. Add an "always-add" flag to leaves and teach the engine about it.** Rejected —
pushes payout-method policy into the evaluator and breaks the invariant that the engine
is a dumb tree evaluator (CLAUDE.md §7.4, §10).

**C. Strip the electricity leaf at evaluation time in the route layer and add it back
after.** Rejected — splits the meaning of a rule across two files, and a stored
`ruleSnapshot` would no longer describe its own arithmetic.

## 4. Rule tree shapes

Let `cmpTerms` be the comparable terms in editor order — GP, Placement, Others — and
`elecLeaf` be `{ type: 'flat_per_partner_total', _t: 'elec', amount }`.

```
higher (WH)
  core = max( ...cmpTerms , mgLeaf )      // null when there are no candidates at all
  rule = elecLeaf ? sum( core , elecLeaf ) : core

hybrid-higher (HH)
  s    = sum( ...cmpTerms )               // null when cmpTerms is empty
  core = mgLeaf ? ( s ? max( s , mgLeaf ) : mgLeaf ) : s
  rule = elecLeaf ? sum( core , elecLeaf ) : core

default | hybrid
  rule = sum( GP , Elec , Placement , Others )   // unchanged; original ordering preserved
```

Degenerate collapses stay as they are today: a one-element `max` or `sum` is emitted as
the bare leaf, and an empty rule is emitted as the zero-percent GP leaf. When `core` is
absent and electricity is present, the rule is the electricity leaf alone.

The root keeps its `_method` tag and every leaf keeps its `_t` tag, so `decompileRule`
round-trips exactly.

## 5. Side effect: fixes a `per_store` crash

`validatePerStoreTree` (`engine.mjs:120`) throws when a `flat_per_partner_total` leaf
appears anywhere except the root or as a direct child of a root `sum`. Today a
`per_store` partner on WH or HH with an electricity fee puts that leaf under a `max`,
so the run **throws outright**.

Under the new shape the electricity leaf becomes a direct child of a root `sum`, which
is the allowed position. The engine's `splitTopLevel` then evaluates it **once for the
whole partner** rather than once per store — the correct reading of a monthly lump.

No partner hits this today, but 7-Eleven is `per_store` and would have.

## 6. Existing data — no migration

Verified against the live tables on 2026-08-06:

- `RevsharePartner` (TH): 206 partner rows. 12 carry an electricity term; every one of
  them is `hybrid` or `default`, where the change is a no-op.
- Only 6 partners have a `max`-root rule — 7-Eleven, BIG-C, BTS, กะทู้, AOT, Turtle
  Shop — and **none** carries an electricity or any other `flat_per_partner_total` lump.
  This was checked for untagged legacy rules too, not just `_t: 'elec'`-tagged ones.
- `RevsharePartnerSG` (SG): no partner rows.

Therefore **no stored rule changes and no past run is affected**. Rules re-saved through
the editor pick up the new shape automatically. No backfill script is needed.

## 7. Code changes

| File | Change |
|---|---|
| `frontend/app.js:29` `compileRule` | Split `elecLeaf` out of the term list; build WH/HH per §4. `default`/`hybrid` keep summing all four terms in editor order. |
| `frontend/app.js:64` `decompileRule` | Already tag-driven, so the new shape round-trips as-is. Add a defensive fallback for an untagged root `sum` whose children are one `max` plus only `flat_per_partner_total` leaves — read the method from the inner `max`. |
| `frontend/app.js:131` `payoutFormula` | Render `max( … ) + Electricity`; handle the electricity-only and MG-only collapses so the label never reads `0 + Electricity`. |
| `lambda/revshare-api/code/routes/import.mjs:14` `compileRule` | Same split, for backend parity. This route is unreachable from the UI today but must not drift from the frontend compiler. |
| `frontend/service-worker.js` | Bump `CACHE_VERSION` to `revshare-v71` (CLAUDE.md §10.4). |

## 8. Testing

`tests/import.test.mjs:12` currently **re-declares its own private copy** of
`compileRule` rather than importing the real one, so it cannot catch drift between the
test's expectations and shipped behaviour. Fix that first — import the exported
`compileRule` from `routes/import.mjs` — then extend coverage.

New cases:

- WH with GP + Electricity + MG → `sum( max( GP , MG ) , Elec )`
- HH with GP + Placement + Electricity + MG → `sum( max( sum( GP , Placement ) , MG ) , Elec )`
- WH with Electricity only, no MG → bare electricity leaf
- WH with Electricity + MG only → `sum( MG , Elec )`
- `hybrid` and `default` with electricity → byte-identical to the pre-change output
- Compile → decompile round-trip preserves method and every term amount

Engine (`tests/engine.test.mjs`): one new test that
`sum( max(…) , flat_per_partner_total )` validates and evaluates under
`aggregationMode: 'per_store'`, charging the lump once for the partner rather than once
per store. This is the §5 regression guard.

The frontend `compileRule`/`payoutFormula` have no test harness; they are verified by
manual smoke test in the rule editor — compile a WH rule with electricity, reload the
partner, confirm the formula line and every field survive the round-trip.

## 9. Out of scope

- Making `Others` (or any other term) configurable as always-added. Electricity is the
  only such term; a per-term toggle was considered and rejected as speculative.
- Re-running or recomputing any historical period. Bulk runs are frozen snapshots by
  design.
- Reviewing whether existing partners have an electricity cost mis-entered under
  `Others`. That is data cleanup, tracked separately if wanted.

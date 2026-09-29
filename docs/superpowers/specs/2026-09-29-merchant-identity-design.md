# Merchant identity — one key, not four names

**Status:** design, 2026-09-29
**Supersedes the identity half of:** [`2026-09-18-merchant-reconciliation-design.md`](2026-09-18-merchant-reconciliation-design.md)
(Reconcile stays; most of what it currently reports stops existing)

## 1. The problem, stated as a rule

For a contract to be paid, `CONTRACT.merchantName` must string-match the `Merchant label`
the platform stamps on a shop. That one rule produces every symptom we have:

| Measured 2026-09-29, live TH | |
|---|---|
| Live contracts **no roster label can reach** | **54 of 304** |
| Roster labels with no contract | 12 |
| Store names spanning >1 contract | 41 |
| Registry rows for 2,511 distinct shops | 6,768 |
| Brands skipped in the Sept run | 143 (215,470 THB) |
| …of those, **archived but still earning** | 6 (52,920 THB; `Central` alone 51,495 over 10 stores) |

`Journeyhub pattaya Central` is the whole disease in one row. It has a contract, a legal
entity (`Boutique Mid Tier 2 Co., Ltd.`), terms, and a machine. The platform labels its shop
`Journeyhub`. So the contract is unreachable, and the only way to pay it is to rename
something. Reconcile therefore fills with rename/merge suggestions — it is not finding
mistakes, it is finding the cost of joining on names.

**The app has three identities for one thing and no key between them:**

- the **brand label** the platform groups shops under (`Merchant label`)
- the **shop name** a human typed (`merchant name.`), restated at every export (§1d)
- the **legal entity** the money is settled with (`counterParty`, free text)

## 2. The key already exists

`MERCHANT_LIST_COLUMNS` (`frontend/app.js`) is the shape of BOTH the run's roster and the
weekly merchant file. **Column 1 is `ID`** — the platform's own shop id.

Measured on the September roster:

```
2,360 shops → 2,360 IDs present · 2,360 distinct · 0 duplicates
0 IDs carrying more than one brand
```

It is a perfect key, and the app already half-uses it: `buildRosterRows` pass 2 resolves
orders by machine number → `Business ID` → `externalId` (§1d), measured at 98.1%. But it is
a **fallback after name matching**, and `WEEKLY_ALIASES` has no alias for `ID` at all — so
the merchant list, the thing the whole app is curated from, is built entirely from typed
names while the key sits unread in the first column of the same file.

The registry shows the cost of not keying on it: 6,384 rows carry an `externalId` but only
**2,526 are distinct**, and **78 ids now point at more than one contract** — worse than the
41 by name. That is §1c's duplication damage, not a fault in the key.

## 3. The design

**A contract covers a set of shops, identified by platform shop id. Names stop being join
keys and become labels for humans.**

```
CONTRACT 01KZD96E…   name: "Journeyhub pattaya Central"   (display only)
                     entity: Boutique Mid Tier 2 Co., Ltd.
                     shopIds: ["1282388541634330624"]

CONTRACT 01M0EHBE…   name: "Journeyhub"
                     entity: Boutique Bangkok Sukhumvit 26-2 Company Limited
                     shopIds: ["1278000435811975168"]
```

A run resolves **shop → contract** by id. No label lookup, no rename, no ambiguity.
Pattaya is payable because its contract *contains that shop*.

### What each concept becomes

| Concept | Today | After |
|---|---|---|
| Shop identity | typed name | `shopId` (platform `ID`) |
| Contract reachability | name == `Merchant label` | contract lists the shop |
| `Merchant label` | the join key | a **suggestion** for which contract should claim a new shop |
| `merchantName` | join key + display | display only |
| Branch count | folded row count per label | `shopIds.length` — derived, never stored |
| Registry `MERCHANT` | keyed by ulid, joined by name | keyed by `shopId` |

### Membership must not become data entry

2,360 shops cannot be claimed by hand. The weekly upload proposes:

- shop id already claimed → nothing to do
- unclaimed, and its `Merchant label` matches exactly one contract's existing shops →
  **suggest** that contract, pre-ticked
- unclaimed and ambiguous → listed as a question, nothing pre-ticked
- a claimed shop that has left the file → reported, never auto-released

Claiming stays an explicit act with a diff, exactly like §1m's import. The label does the
work it is good at (grouping) without being load-bearing for payment.

## 4. Component changes

- **`parseWeeklyRows` / `WEEKLY_ALIASES`** — read `ID` as `shopId`. Keep `_branch` names,
  which §1o notes are currently thrown away; they become the shop records.
- **`parseMerchantList`** (roster) — unchanged; it already reads `ID`.
- **`CONTRACT`** — gains `shopIds: string[]`. `branchCount` is **removed** as a stored field
  and derived from `shopIds.length`, closing the class of bug that produced the blank
  BRANCH column on 56 TH contracts and all 554 SG ones.
- **`MERCHANT` registry** — re-keyed on `shopId`; the ~4,240 duplicate rows of §1c collapse
  because the key is now the thing that was always unique. This is the dedupe that has been
  outstanding since 2026-08-24, done as a consequence rather than as its own project.
- **`applyMerchantRoster` / `resolveLabel`** — resolution becomes a `shopId → contractId`
  map. `indexContractsByName` is retired. The in-memory stub for an unclaimed shop stays
  (§1m) so a run still computes and reports its revenue under `skipped`.
- **`matchMachineStores`** — joins on `shopId` instead of store name. The 50 unplaceable
  shops of §1o become placeable, and the machine list stops being able to attribute a
  machine to the wrong contract.
- **Reconcile** — its rename/merge/ambiguity categories largely disappear. What remains is
  one honest question: *these shops are in your file and no contract claims them.*

### Singapore

SG has **no roster and no weekly upload** (§1f) — its 554 contracts were seeded from a terms
sheet, which is why every SG contract has a blank branch count. SG therefore gets the schema
and the code, and `shopIds` stays empty until a Businessmen list exists. **SG payouts must be
byte-identical after this work**, which is easy to assert because nothing there resolves by
roster today.

## 5. Migration

Staged, each stage shippable and reversible on its own.

1. **Read the key.** Weekly upload reads `ID`; shop ids are recorded on registry rows.
   Nothing resolves by id yet. No behaviour change — pure data capture.
2. **Backfill `shopIds`.** A dry-run-by-default CLI derives each contract's shop set from
   today's resolution (roster label → contract) and writes it. Prints the whole mapping;
   writes only with `--apply`. Contracts that resolve to nothing are listed — those are the
   54, and they get their shops assigned deliberately.
3. **Resolve by id, label as fallback.** The run prefers `shopId`; where no contract claims
   a shop it falls back to today's label match and **logs the disagreement**. This is the
   stage that proves the design on real data without betting anything on it.
4. **Retire name matching.** Only after stage 3 reports zero disagreements across a full
   period. `indexContractsByName` is deleted; `merchantName` becomes display-only.
5. **Dedupe the registry** on `shopId`, per §1c's agreed merge rule (oldest row's id;
   `notes`/`partnerId`/`externalId` first-non-empty; `contractId`/`machineModel` newest).

## 6. The safety property

**The September run, recomputed under id resolution, must produce identical per-merchant
payouts.** `infra/rerun-bulk-run.mjs` already does this from stored inputs, dry-run by
default (§1e), and the 2026-09-01 run has inputs. That is the acceptance test for stage 3,
and it is not a judgement call: same inputs, same rules, same numbers, or the stage does not
ship.

Two properties this must not break, both load-bearing:

- **Frozen runs stay frozen** (§10.5). Runs store `ruleSnapshots`; nothing here recomputes a
  past run or changes what it paid.
- **The engine keeps reading roster rows, not stored counts** (§1m). `engine.mjs` contains no
  reference to `units`/`installedUnits` and a test asserts it. Nothing in this design changes
  that, so no payout can move because a count changed.

## 7. Deliberately not doing

- **A real entity layer.** `counterParty` stays free text. It is the obvious next step — the
  statement zip already folders by entity (§1j) and Mailing now picks recipients by it — but
  it is a separate change with its own migration, and doing both at once would make the
  September-identical check unreadable. Noted, not scoped.
- **Auto-claiming shops.** Every membership change is proposed and confirmed, per §1m's rule
  that the merchant list is curated, not inferred.
- **Touching the 143 `noPayout` brands.** Measured: 132 have terms that deliberately pay
  zero and none contradict their flag. That is a business decision, not an identity problem.
  The 6 archived-but-earning are a separate, immediate fix.

## 8. Testing

- Pure functions, extracted and tested as the suite already does: `shopIdsFrom(file)`,
  `resolveShop(shopId, contracts)`, `claimSuggestions(file, contracts)`, `branchCount(c)`.
- **Invariants:** a shop id belongs to at most one contract; a contract never claims a shop
  twice; an unclaimed shop is reported, never silently dropped; a claimed shop absent from a
  file is never auto-released.
- **Regression:** `unitsTotal` reads no fixed model list (added 2026-09-29); the engine reads
  no stored units; SG resolves nothing by roster.
- **The September recompute**, as above.

## 9. Risks

- **`ID` might be absent from an older weekly file.** Stage 1 degrades to today's behaviour
  when the column is missing and says so in the preview, exactly as §1l does for a missing
  label column.
- **The 78 ids pointing at two contracts** are duplication artefacts, not genuine conflicts;
  stage 2's dry run must print every one for a human decision before stage 5 collapses them.
- **Stage 4 is the irreversible one.** It is gated on stage 3 reporting zero disagreements
  over a full period, not on a date.

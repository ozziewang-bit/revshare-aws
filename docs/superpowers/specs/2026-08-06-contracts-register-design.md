# Contracts register — design

**Date:** 2026-08-06
**Status:** Approved, pending implementation plan
**Source data:** `1) New_Merchant (60%).xlsx`, sheet `All_Merchant` (208 merchants, 23 columns)

## 1. Problem

Merchant contract terms — who the counter party is, when the contract starts and
ends, how much notice termination needs, whether it auto-renews, where the signed
document lives — are tracked in a spreadsheet. None of it exists in the app. The app
knows only a partner's name, currency, aggregation mode and payout rule.

That leaves the two halves of a merchant relationship in different places, and the
contract half has no expiry visibility at all: of 208 merchants, 74 have no recorded
dates and the rest are only as current as the last person to open the file.

## 2. What we are building

A **Contracts** tab: one flat, fully editable table of every merchant. Not a
per-merchant view — a single grid you scan and edit in place, the way the spreadsheet
works today.

- One row per merchant, horizontally scrollable, **Merchant column frozen left**.
- **Every column is editable.** Click a cell, change it, it saves.
- Seeded by uploading the source `.xlsx`; maintained in-app afterwards.
- Search by merchant name, filter by type and by link status, sort by any column —
  contract end date being the one that matters most.

At 208 rows and ~20 columns the whole table renders at once; no virtualisation, no
pagination. Saves are per cell, debounced, with the failed cell marked if a write
loses.

## 3. Columns

Derived from `All_Merchant`'s two-row header (row 1 group, row 2 sub-header; data
starts at row 3).

| Sheet col | Field | Editor |
|---|---|---|
| B | Merchant | Text. Doubles as the display name and the key the partner link is matched on |
| C | Merchant Type | Dropdown seeded with the sheet's eight values — F&B, Hospitality, Lifestyle, Shopping Malls, Nightlife, Exhibition Center, Convenience Store, other — and accepting a typed value not in the list |
| D | Counter party | Text (Thai legal entity name) |
| E | Installed units | Number |
| F–J | S5, S8, M10, L20, L40 | Number each. Sheet's `LL20`/`LL40` normalise to `L20`/`L40` |
| K | Contract start | Date |
| L | Contract end | Date |
| M | Termination notice (days) | Number |
| N | Decline to renew | Checkbox |
| O | Auto-renewal | Dropdown: `Yes`, `No (Need to contact)`, blank |
| W | Contract link | URL |
| Q | Share mode | Dropdown — see §5 |
| R | Rev-share % | Number → writes the rule |
| S | Fixed monthly rental (Placement) | Number **or** per-model popover — see §5 |
| T | Electricity | Number → writes the rule |
| U | Minimum guarantee | Number **or** per-model popover — see §5 |

**Dropped, with reason:**

- **`A` (No)** — `#NAME?` in all 208 rows, a broken formula. Row identity is the merchant.
- **`P` (COC Clause)** — empty in all 208 rows.
- **`V` (unlabeled)** — empty or `0` in all 208 rows.

## 4. Import

Typing 208 rows is not a plan, so the tab has an upload control that accepts the
source workbook and reads `All_Merchant`.

**The importer writes contract fields only.** The sheet's `Share mode`, `Rev-share %`,
`Fixed monthly rental`, `Electricity` and `Minimum guarantee` are parsed for display
in the preview but **never written**. Existing partner rules are left exactly as they
are. Mapping sheet terms onto app rules is deliberately deferred to separate work.

This is what protects the tuned rules. 7-Eleven's sheet row says `MG 0`; the app has
it on per-machine MG (S8=200, S5=150) with `per_store` aggregation. An importer that
wrote terms would take the `0`.

**Name matching.** 131 of 208 sheet merchants match an app partner exactly
(case-insensitive, trimmed). The remaining 77 are shown for review before anything is
written — each row gets a dropdown of existing partners plus "keep unlinked". Known
drift to resolve there: `big c`/`big-c`, `baan ying`/`baanying`, `future rangsit`/
`future park rangsit`, `getfresh`/`get fresh`, `andamanda`/`andamanda phuket`, the
app's typo'd `dink bar & restaurant`, and `bts + super turtle` which is one sheet row
against two app partners (`bts`, `turtle shop`).

**Re-import is idempotent** on contract fields, matched by merchant name: it updates
what changed and leaves rules alone. It never deletes rows.

## 5. Editing share terms from the grid

Share-term cells write the partner's rule through **the same `compileRule` the Rule
tab uses** — one code path, so the two editors cannot drift.

**Mode** offers the app's four payout methods (Default, Hybrid, Whichever higher,
Hybrid-higher). The sheet's fifth value, **Sliding Scale**, is listed but **disabled**:
the engine supports `tiered_percent` but no editor exists for it. Four merchants use
it — Nysa Hotel Bangkok Sukhumvit 11, Hanuman World Phuket, Totonoi Sauna&Onsen,
Solitaire Bangkok Sukhumvit 11 — all on the same ladder, 15/20/25/30/35% at
99/199/299/399/400+. Building that editor is separate work.

**MG and Placement are not plain number cells.** Both are per machine model in the
data model. When a partner has per-model values the cell reads `per-machine (2) ▾`
and opens a popover with one row per model; single-value partners get a number box.
A flat cell would silently collapse 7-Eleven's `S8=200, S5=150` into one number.

**Unlinked rows have no rule to write to.** Their share-term cells are disabled until
the row is linked to a partner, offered inline in the cell as "link to existing…" or
"create partner".

## 6. Storage

A new row family in the existing region table — no migration, no change to partner
rows, no change to the engine.

| pk | sk | Contents |
|---|---|---|
| `CONTRACT` | `CONTRACT#<contractId>` | Contract fields + optional `partnerId` |

`partnerId` is optional by design: 77 rows have no partner today, and a contract is
worth recording before its rule exists. Contracts are region-scoped like everything
else — this sheet is Thailand; Singapore starts empty.

## 7. Backend routes

| Method | Path | Purpose |
|---|---|---|
| GET | `/contracts` | List all contracts |
| POST | `/contracts` | Create one |
| PUT | `/contracts/:id` | Update fields (partial merge) |
| DELETE | `/contracts/:id` | Delete |
| POST | `/contracts/import` | Bulk upsert from the parsed sheet, contract fields only |

Writes require the existing **`manageMerchants`** permission rather than a new one —
contracts sit alongside the merchant registry and a dedicated permission can be added
later as a one-line change if the split turns out to matter. Reads follow the existing
rule: open to any authenticated user.

## 8. Out of scope

- **Mapping sheet share terms onto app rules.** Explicitly deferred by the user.
- **A tiered-percent (Sliding Scale) rule editor.** Needed by 4 merchants; separate work.
- **The `RevShare_Report`, `Resign-contract` and `Business List` sheets.** Only
  `All_Merchant` is in scope.
- **Expiry alerting / notifications.** The grid sorts and filters by end date; pushing
  alerts is a later question.
- **Engine changes.** None. Nothing here touches calculation.

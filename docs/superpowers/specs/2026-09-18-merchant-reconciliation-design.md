# Merchant reconciliation

Date: 2026-09-18
Status: approved in brainstorming, not yet planned

A standing **Reconcile** tab on the Merchant view that compares the app's merchant list
against the last weekly upload, explains every difference in terms of the money at stake,
and offers the specific correction each difference needs.

## 1. What changes and why

The weekly upload (§1l) and the app now own different columns (§1l, 2026-09-18), so neither
can overwrite the other. What neither can do is tell you the two lists have **drifted**: an
import never deletes, a merchant that dropped off the file is marked ⦿ and nothing more, and
a brand the file names but the app lacks is created silently as a new row.

Measured on live TH data, 2026-09-18, against the 3 Sep upload (260 brands vs 314 live
contracts):

| Difference | Count | Money, August run |
|---|---|---|
| Archived contract, still in the file, still earning | 4 | **52,820 THB** skipped |
| In the file, no merchant row | 11 | 4,640 THB skipped |
| — of which look renamed (near-name, 1:1) | 2 | (the same 4,640: Andamanda Phuket 4,300 + Jharoka by Indus 340) |
| One file tag, several app rows (brand vs branch) | ~12 | counted under the brand's own row above |
| In the app, not in the file | 65 | — |
| Duplicate rows inside the app (cross-script) | ~7 | — |

The categories overlap by design — a brand can be both "not in the app" and "looks renamed",
which is exactly the pairing the page exists to propose. The **skipped total is 215,470 THB over
143 brands**; most of that is legitimate no-revenue-share (`CDS & RBS`, `EMSPHERE`,
`Siam Square One`), and the figures above are only the part the reconciler can explain.

The worst case is concrete: `Central` is archived **and** `noPayout`, is on the current
merchant list, and its machines took **51,495 THB** in August that paid nothing — while
`Central Ladprao`, `Central Eastville` and `Central Westgate` sit live with real negotiated
terms that no run can ever reach, because the roster labels every one of those machines
`Central`. Nothing in the app shows this today: §1m deliberately never marks an archived row
⦿, on the reasoning that an ended contract is not expected in a merchant list.

## 2. Decisions taken

1. **A Merchant view tab, not a fifth nav item.** §1b folded the nav to four deliberately;
   this screen is about the merchant list. `subTabsHtml`/`wireSubTabs`, as Run share and
   Settings already use. Badge counts unresolved items, so it trends to zero.
2. **Stored, not recomputed in a dialog.** The corrections outlive one sitting and may be
   done by someone else. One S3 object per upload; the diff recomputes live against current
   contracts, so the page stays truthful as items are fixed.
3. **Never auto-apply.** On this data a top-1 name match is wrong at least 3 times in 5
   (`Classic` matches two live rows; `Central` is a chain; `DINK`/`DRINK` is a typo, not a
   rename). The page proposes; a person decides.
4. **Merge archives, never deletes.** Recoverable by construction, consistent with how the
   app already treats "gone".
5. **Terms are never merged silently.** Identical term sets merge unasked; differing ones
   force an explicit side-by-side choice.
6. **Past runs are never rewritten.** Frozen snapshots are load-bearing (§10.5). Continuity
   comes from Analytics stitching names, not from mutating history.
7. **Both regions**, deployed backend-first, guard-then-release as the finance columns
   established (§1n).

## 3. Data model

**New S3 object per recorded upload**, written by `POST /contracts/import` under the existing
explicit `recordUpload: true` (the sheet importer and `infra/import-merchant-sheet.mjs` carry
partial lists and must still never record):

```
s3://revshare-runs-812751451548-sea7/uploads/<ulid>.json
{
  at, by,
  brands: [ { name, merchantType, counterParty, salesPerson,
              contactName, contactPhone, contactEmail, branchCount } ],
  machineMisses: { unknown: [names…], unlinked: [names…] }    // capped at 200 each
}
```

The **folded brand rows**, not the raw file: it is the normalized shape the import already
posts, it is already computed at that moment, and it keeps an .xlsx parser out of the backend.

`CONFIG/UPLOAD#LATEST` gains `s3Key` and the counts. **`names[]` stays** — §1m's grid marks
read it, and that working feature must not be coupled to a new object.

**New contract fields** (both added to `WRITABLE`):

- `previousNames: string[]` — names this contract used to have. Written by rename and merge.
- `mergedInto: contractId` — set on a loser, alongside `archived: true`.
- `mergedStoreIds: string[]` — on the loser, the exact store rows a merge moved, so an undo
  re-points those and only those.

**New `CONFIG/RECONCILE#DISMISSED`** — one row, `{ items: [{type, key, at, by}] }`. A dismissal
is keyed by difference type + name and **resurfaces automatically when the underlying fact
changes** (a dismissed archived contract that is unarchived, or starts earning again, returns).

## 4. Routes

| Method | Path | Purpose | Permission |
|---|---|---|---|
| GET | `/contracts/last-upload/rows` | The stored brand rows for the latest upload | any signed-in |
| POST | `/contracts/:id/merge` | `{from: [contractId…], terms?: {rule, aggregationMode, noPayout}}` — archive losers, re-point their store rows, absorb names | `manageMerchants` |
| POST | `/contracts/:id/unmerge` | Undo one merge using `mergedStoreIds` | `manageMerchants` |
| GET/PUT | `/contracts/dismissals` | Read/patch the dismissal list | read: any; write: `manageMerchants` |

Rename, adopt-terms, unarchive and create all go through the existing `PUT`/`POST /contracts`
routes — they are ordinary field writes and need no new endpoint.

**The terms gate is enforced by the SERVER, not the dialog.** If the survivor's and every
loser's term set are identical, `terms` may be omitted. If they differ and `terms` is absent, the
route returns **409** naming the conflicting contracts. A UI that forgets the choice therefore
cannot silently keep the survivor's rule — which on `Central` would be a 51,495 THB/month
decision made by omission.

**Merge is server-side on purpose.** Re-pointing can touch hundreds of `MERCHANT` rows; done as
N calls from the browser, a closed tab leaves a half-merged merchant. It writes through
`putMerchantsBatch` (BatchWriteItem + `UnprocessedItems` retry, §1c).

## 5. The classifier

A pure function in `frontend/app.js`, extracted and tested the way `missingFromUpload` and
`payoutBreakdown` already are:

```
classifyDifferences({ contracts, upload, latestRun, dismissals }) -> [
  { type, brands[], contracts[], money, suggestion, actions[] }
]
```

Types, in the order the page shows them (by money, not count):

1. `archived-in-file` — contract archived, name in the upload. Money from the run's `skipped`.
2. `likely-rename` — a file name with no contract, near-matching exactly one contract that is
   itself absent from the file. Similarity on NFKC-normalized casefolded strings; **1:1 only**
   — a name that matches two contracts is reported as ambiguous, never auto-paired.
3. `brand-has-branches` — one file tag, ≥2 contracts whose names begin with it. Carries whether
   the members' term sets are identical.
4. `in-file-no-row` — create, or resolve as a rename.
5. `in-app-not-in-file` — grouped **by `createdAt` day**, because that is the axis along which
   this app's duplicates were created (38 on 7 Aug from the migration, 21 on 9 Aug from the
   adoption). Each row carries a free **merge into…** search.
6. `machine-list-misses` — `unknown` vs `unlinked`, already distinguished by §1l.

**A stated limitation.** Near-name matching cannot pair `UDON Cher` with `เฌอ`, or
`UDON Mavin Coffee Roaster` with `โรงคั่วกาแฟมาวิน` — those are the same merchants across two
scripts, found by reading Thai, and no string metric recovers them. The page does not pretend
otherwise: it groups the orphans by the day they were added and gives every row a manual merge.

**Money at stake** is read from the latest run's frozen `skipped` and `unmatchedDetail`. Nothing
recomputes a payout; an un-run period simply shows no figure.

## 6. Name resolution after a rename

`indexContractsByName` (`payout.mjs`) also indexes `previousNames`, so a roster or order report
exported before a rename still resolves — the export-time-name problem of §1d. Precedence:

1. an exact match on a contract's **current** name always wins;
2. a previous name resolves only if no current name matches;
3. a previous name **may never shadow another contract's current name** — if it collides, the
   current name wins and the stale alias is ignored.

Archived contracts stay out of the previous-name index, matching the alias rule of §1d.

Analytics groups run results by resolving each frozen `merchantName` through `previousNames` to
the contract's current name, so a renamed brand stays **one line** instead of splitting. Frontend
only; no stored run changes.

## 7. Validation

- Classifier fixtures built from the real shapes found on 2026-09-18: `Central` (archived +
  noPayout + 3 differently-termed branches), `Glow` (4 identical branches + the unrelated
  `Glow Fish`), `Citadines` (3 identical), `Andamanda`/`Jharoka` (renames), `DINK`/`DRINK`
  (typo, must NOT be auto-applied), `Classic` (ambiguous, must be reported as such).
- `previousNames` precedence in `payout.test.mjs`, including the shadowing rule.
- Merge route: losers archived not deleted, store rows re-pointed, `mergedStoreIds` exact, and
  an unmerge restoring precisely those rows.
- Terms-conflict gate: a merge of rows with differing rules cannot proceed without a choice.
- Dismissal resurfacing when the underlying fact changes.

## 8. Out of scope

- **No bulk "fix all".** Every one of these needs a human look — that is the lesson of the 65.
- **No merchant-field editing here**; that is the grid's job.
- **No history beyond the latest upload** — the same trade §1m made.
- **No restating of past runs.** `POST /bulk-runs/:id/recompute` (§1e) remains the deliberate,
  separate act.
- **Field-level diffs are empty until the next upload.** The 3 Sep record stored only names, so
  name-level differences work immediately and field-level ones light up after the next file.

## 9. Build order

Three phases, each shippable and each useful alone:

1. **Store the upload** — the S3 object, the `CONFIG/UPLOAD#LATEST` pointer fields, and
   `GET /contracts/last-upload/rows`. No UI. Nothing is visible until the next weekly upload
   runs, so this phase is what starts the clock on field-level diffs.
2. **The page, read-only** — the tab, the classifier, the money figures, and every difference
   explained, with NO actions. This alone would have surfaced the `Central` case, and it writes
   nothing, so it cannot be wrong in a way that costs anything.
3. **The actions** — rename, merge/unmerge, adopt terms, dismissals, and the `previousNames`
   resolution + Analytics stitching that make a rename safe.

Phase 2 is the value; phase 3 is the convenience. If phase 3 is deferred, the corrections are
still all doable by hand on the existing screens.

## 10. Open business question, not a code question

`Central` has three branch contracts with three genuinely different deals, and the roster labels
every one of their machines `Central`. Only one set of terms can ever be paid under that label.
The page can surface this and let one be adopted, but the correct resolution may be to have the
platform label those rosters per branch. **A merge does not resolve it; it only picks a winner.**
The same shape applies to `SEACON` (3 rows, 3 term sets, one with no terms at all).

# Payment requests from a locked run — design

Date: 2026-10-13 · Status: approved in conversation, awaiting written-spec review
Repos: `~/revshare-aws` (MCRM) and `~/CSTH_payment` (Payment Request). Both regions.

## 1. Goal

From a locked month's run in MCRM, finance ticks the Brands to pay and gets **one draft payment
request per Brand per month** in Payment Request, pre-filled and with the Brand's statement
attached. A person still opens each draft, checks it and presses Submit; normal approval routing
applies. MCRM never submits, approves or pays anything.

### Decisions (user, 2026-10-12/13)

| # | Decision |
|---|---|
| D1 | Brands are **ticked per run** — no standing flag on the Brand. |
| D2 | **One request per Brand per month.** |
| D3 | **Both regions.** TH files a PV, SG files a PES. |
| D4 | **Server-to-server drafts** (MCRM backend → Payment Request backend), not a link handoff. |
| D5 | **Pay to = contract entity**, falling back to the Brand name when no entity is linked. |
| D6 | **TH line = tax base + VAT 7%**, so the PV total equals the payout and matches the statement. |
| D7 | Requests are created **only from an archived (🔒 Locked) run.** |

## 2. Architecture

```
MCRM run detail (browser)
  tick Brands → Create payment requests
  per Brand, in sequence: statementWorkbook(result, index) → .xlsx bytes
      │ POST /bulk-runs/:id/payment-requests  { contractId, statement (base64) }
      ▼
revshare-api / revshare-api-sg
  guard → build draft → Lambda Invoke (IAM) ─────────────┐
                                                          ▼
                                     csth-api / cssg-api: internal action
                                       createDraftFromMcrm
                                       → DRAFT owned by the clicking user
                                       → statement under attachments/<id>/
                                       → tagged source = {app:'mcrm', runId, contractId, period}
                                     ← { requestId, docNumber: null }
  record PAYREQ row  ◄────────────────────────────────────┘
```

| Region | MCRM function | Payment Request function | Form |
|---|---|---|---|
| TH | `revshare-api` | `csth-api` | PV |
| SG | `revshare-api-sg` | `cssg-api` | PES |

### 2.1 Trust boundary

- `csth-api`'s handler today assumes an API Gateway v2 event and verifies a Google ID token whose
  `aud` is Payment Request's own OAuth client. MCRM's token has a different `aud`, so it is
  rejected — by design, and this design does not change that.
- The new entry point is recognised **only on a direct-invoke event shape**
  (`{ internal: 'mcrm.createDraft', ... }` with **no `requestContext`**). API Gateway always sends
  `requestContext`, so the public URL cannot reach it. A test pins this.
- Who may invoke: a **resource-based policy** on `csth-api` / `cssg-api` granting
  `lambda:InvokeFunction` to `revshare-api-role` / `revshare-api-sg-role` respectively, and an
  identity policy on each MCRM role allowing exactly that one function. Nothing else gains access.
- The **owner email** in the payload is the identity MCRM has already verified from its own Google
  token. Payment Request trusts it because only MCRM's role can invoke; it still requires that email
  to resolve to a linked employee record (`requireEmployee`), exactly like a normal create.

### 2.2 Internal actions on Payment Request

Three, all in a new `routes/mcrm.mjs` (IO through injected `deps`, like every other route).
A **marker item** `pk = MCRM#<contractId>#<period>` (each region has its own table), `sk = META`, `{ requestId }` is the
lookup key for "this Brand + month already has a request" — a single `GetItem`, no scan, and
written with `attribute_not_exists(pk)` so two concurrent creates cannot both succeed.

- `mcrm.findDraft { source }` → the marker's request (if the request still exists), or `null`.
  `runId` is ignored: Brand + period is the identity. Used to recover a lost MCRM record (§4).
- `mcrm.createDraft { ownerEmail, form, header, lineItems, source, statement: {bucket, key, filename} }`
  - `form` must be `PV` on TH, `PES` on SG (the stack's `CSTH_COUNTRY`); anything else is refused.
  - Goes through the **same `createRequest`** as the UI — applicant/department are stamped from the
    registry, `financeOnly` fields stripped, totals computed by `calc.mjs`. No parallel create path.
  - Refuses if `findDraft` already returns a request for this source (second line of defence
    against a double request).
  - The statement is NOT in the invoke payload (6 MB invoke limit): MCRM writes it to its own runs
    bucket under `payreq/<period>/<contractId>.xlsx`, and Payment Request's role is granted
    `s3:GetObject` on that prefix only. It copies the file into its own bucket.
  - Writes the attachment with the existing attachment key scheme so the request page, PDF and
    Send-to-accountant zip all pick it up unchanged.
  - Writes an event `{ stage: 'create', action: 'createdFromMcrm', actorEmail: ownerEmail }`.
- `mcrm.statuses { requestIds }` → per id `{ status, label, docNumber, paymentDate }`, or
  `{ missing: true }` for a request that no longer exists. `label` is derived HERE, by the app that
  owns the rule, never re-derived in MCRM:

  | Request state | `label` |
  |---|---|
  | `DRAFT` | Draft |
  | `PENDING_*` | Submitted — awaiting <stage> (ack / finance / COO / CEO) |
  | `CHANGES_REQUESTED` | Sent back |
  | `REJECTED` | Rejected |
  | `APPROVED`, payment date in the future or absent | Approved — ready to pay |
  | `APPROVED`, payment date today or earlier (Bangkok date, `bangkokToday`) | Paid <date> |
  | legacy `PAID` | Paid <paid.paidDate> |

  It reuses `payments.mjs`'s existing Ready-to-pay / Paid rule rather than restating it.
  Deleting a request (only possible while DRAFT) also deletes its marker, so the Brand can be
  requested again.

## 3. Draft content

### 3.1 Thailand — PV

| PV field | Value |
|---|---|
| `payTo` | `entityNameOf(contract)`; Brand name if blank |
| `payBank` | mapped bank (§3.3) or blank |
| `payAccount`, `payAccountName` | `bankAccountNumber`, `bankAccountName` |
| `currency` | `THB` |
| `details` | `Revenue share — <Brand> — <Mon YYYY>` (+ ` · bank: <raw>` when unmapped) |
| line | `date` = last day of period · `ref` = `MCRM` · `details` = `Revenue share <Mon YYYY>` · `amount` = tax base · `vatRate` = 0.07 |
| `whtRate`, `paymentDate` | not set — finance's fields |

**Tax base comes from MCRM's own `splitTax`** (the statement's function, `TAX.th` inclusive 7%), so
the PV and the statement cannot round differently. Check: base + `r2(base × 0.07)` in `calc.mjs`
must equal the payout; if rounding leaves a 0.01 gap, the base is adjusted by that satang and a
test pins it against the template's figures (1,420 → 1,327.10 + 92.90).

### 3.2 Singapore — PES

| PES field | Value |
|---|---|
| `subject` | `<Brand> - ChargeSPOT Revenue Share_<MonYY>` |
| `competenceNo` | `II - 7 - (10) - 5` (the licence-fee templates' value) |
| `frequency` | `Monthly` |
| `payTo` | entity or Brand name, as TH |
| bank fields | Finance Information, mapped to `SG_BANKS` |
| `currency` | `SGD` |
| line | `description` = `Revenue Share_<MonYY>` · `amount` = payout · `vatRate` = 0 |

`subject` is a `payTemplate` field in the UI, which accepts free text by design ("a one-off
payment with no stored template just fills its own fields in") — confirmed, no form change needed.

### 3.3 Bank-name mapping

Pure function `mapBank(raw, region)` in MCRM, tested against every live value:

| Stored (TH) | Count | → Payment Request |
|---|---|---|
| ธนาคารกสิกรไทย / ธนาคารกสิกร / ธนาคารกสิกรำทย | 52 | Kasikorn Bank |
| ธนาคารไทยพาณิชย์ | 31 | Siam Commercial Bank |
| ธนาคารกรุงเทพ | 9 | Bangkok Bank |
| ธนาคารกรุงไทย | 7 | Krung Thai Bank |
| ธนาคารกรุงศรี | 3 | Krungsri Bank |
| ธนาคารทหารไทย | 1 | TTB Bank |
| ธนาคารยูโอบี | 3 | — (no option; raw kept in details) |
| ธนาคารอาคารสงเคราะห์ | 2 | — (no option; raw kept in details) |
| `-` / blank | 7 + unset | — (treated as no bank) |

English names (`KBank`, `SCB`, `Kasikorn`…) map too. SG: no Brand has bank details today, so every
SG draft starts with blank bank fields — stated in the pre-confirm warnings.

A missing or unmapped bank **never blocks** a draft: the fields are optional on both forms.

## 4. MCRM side

### 4.1 Record

New row family per region table: `pk = PAYREQ#<period YYYY-MM>`, `sk = <contractId>`, fields
`{ requestId, region, amount, currency, runId, createdBy, createdAt }`. Keyed on **Brand + month,
not run**, so a recompute or a second run of the same month cannot create a second request.
Written with `attribute_not_exists(sk)`.

### 4.2 Route

`POST /bulk-runs/:id/payment-requests` (`runCalcs`), one Brand per call. Refuses (409) when the
run is not archived, the Brand is not in the run's results, payout ≤ 0, or a `PAYREQ` row exists.
Sequence: `findDraft` → if found, record it and return `recovered` → else `createDraft` → record.
`GET /bulk-runs/:id/payment-requests` returns the period's `PAYREQ` rows **joined with live
status** from one `mcrm.statuses` invoke. If that invoke fails, the rows still return with
status `unknown` — the table never blanks because Payment Request is unreachable.
A `missing` request (draft deleted in Payment Request) deletes its `PAYREQ` row on read, after
the invoke has confirmed it is gone, so the Brand becomes tickable again.

An **owner-not-linked** refusal from Payment Request is returned as a distinct error code so the
browser can stop before the first Brand and say so once.

### 4.3 Run detail UI (locked runs only)

- Tick column + selection bar: `N Brands · total ฿X · Create payment requests`.
- Untickable, with the reason on hover: payout 0 · request already exists · run not locked.
- **Payment request** column: `—`, or the live `label` from §2.2 (`Draft`, `Submitted — awaiting
  finance`, `Approved — ready to pay`, `Paid 25 Oct`, …) with the doc number once it has one,
  linking to `<Payment Request site>/#request/<id>` for the run's region. Hover shows who created
  it and when. Status is read each time the run page opens — no polling, no stored copy to go stale.
- The selection bar gains a one-line summary for the month: `12 requested · 3 paid · 8 in approval · 1 draft`.
- Before confirming, per-Brand warnings: no bank on file · bank not in dropdown · no contract
  entity (Pay to = Brand name). Confirm names count, month, total, "drafts owned by you".
- Runs in sequence; a failure stops the batch: "created 7 of 12; stopped at <Brand>: <reason>".
  Pressing again resumes (already-recorded Brands are skipped).
- **Unarchive** of a run with recorded requests warns and names them; the requests are untouched.

## 5. Out of scope (v1)

- Auto-submit, multi-Brand requests, a standing "pay through Payment Request" flag.
- Filling SG bank details.

## 6. Testing

Payment Request: `mcrm.statuses` label for every row of the §2.2 table, including the Bangkok
date boundary · deleting a draft frees its marker · internal action unreachable through an API Gateway event · owner must be a
linked employee · PV/PES content and totals as §3 · duplicate source refused · `findDraft` finds
by Brand + period · wrong form for the stack refused · attachment readable via the existing route.

MCRM: `mapBank` over every live value · tax base reconciles with `splitTax` to the satang ·
route guards (not locked / not in run / zero / duplicate) · recovery path records without
creating · batch resume skips recorded Brands.

Live: one small Brand per region end to end; open the draft in Payment Request, check fields and
attachment, then delete the draft and its `PAYREQ` row.

## 7. Deploy

`csth-api` + `cssg-api` (Payment Request, lambda only), `revshare-api` + `revshare-api-sg` and the
shared MCRM site, plus the IAM grant per region (§2.1). Payment Request ships first: until it
does, the MCRM button would have nothing to call.

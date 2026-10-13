# Payment requests from a locked run — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From a locked MCRM run, tick Brands and get one draft payment request per Brand per month in Payment Request (TH PV / SG PES), statement attached, with live status shown back in MCRM.

**Architecture:** MCRM's backend invokes Payment Request's Lambda directly (IAM, not a login) with three internal actions — `findDraft`, `createDraft`, `statuses`. Payment Request owns the request, its status label and a Brand+month marker; MCRM owns a `PAYREQ` record per Brand+month and the draft content.

**Tech Stack:** Node 22 Lambdas (ESM, `node:test`), DynamoDB, S3, vanilla JS frontend.

**Spec:** `docs/superpowers/specs/2026-10-13-payment-requests-from-runs-design.md`

## Global Constraints

- Two repos: **Payment Request** = `~/CSTH_payment` (branch `main` = production); **MCRM** = `~/revshare-aws/.claude/worktrees/finance-info-columns` (branch `worktree-finance-info-columns` = production). Never edit `~/revshare-aws` root or `~/revshare_sg` by hand — `infra/deploy-lambda-all.sh` syncs TH→SG.
- **Do not add functions to MCRM `db.mjs`** (it is not synced to SG; three SG outages). New MCRM data access goes in a new module `payreq-db.mjs`.
- No `git commit` until Ozzie says "save progress". Steps below say "run tests", not "commit".
- Every AWS CLI call: `AWS_DEFAULT_OUTPUT=json`, region `ap-southeast-7`.
- `git status --short` (never piped to `head`) before every deploy; name anything else that ships.
- MCRM user-facing words: **Brand** (CONTRACT row), never branch/shop/store. "Lock", not "Archive", on screen.
- One request per Brand per month; requests only from a locked (`run.archived === true`) run.
- TH line amount = tax base, `vatRate: 0.07`, so `base + round2(base*0.07) === payout`. SG: amount = payout, `vatRate: 0`.
- SG PES: subject `<Brand> - ChargeSPOT Revenue Share_<MonYY>`, competenceNo `II - 7 - (10) - 5`, frequency `Monthly`.
- Internal actions are reachable **only** from an event with no `requestContext`.

## Review Focus

1. A run recomputed/unlocked after requests exist → no second request for the same Brand+month (marker + PAYREQ both keyed Brand+month). Pinned in Task 2 and Task 6.
2. Payment Request unreachable when the run page opens → table still renders, status `unknown`, nothing deleted. Pinned in Task 6.
3. A `statuses` reply that omits an id (not `missing: true`) must NOT delete that PAYREQ row — only an explicit `missing` frees a Brand. Pinned in Task 6.
4. Payout whose 7%-inclusive split does not round back exactly (e.g. 0.01-off cases) → base nudged so PV total equals payout to the satang. Pinned in Task 4 by brute force over 0.01…20,000.00.
5. Owner not linked to an employee → first Brand fails with `owner_not_linked`, the browser stops before creating anything else. Pinned in Task 6 and Task 7.

---

## Part A — Payment Request (`~/CSTH_payment`)

### Task 1: Marker key, conditional put, cross-bucket read

**Files:**
- Modify: `lambda/csth-api/code/keys.mjs` (append)
- Modify: `lambda/csth-api/code/db.mjs` (append `putIfAbsent`)
- Modify: `lambda/csth-api/code/s3.mjs` (append `getObjectFrom`)
- Modify: `lambda/csth-api/code/index.mjs` (`dbDeps` gains `putIfAbsent`, `getObjectFrom`)
- Test: `lambda/csth-api/tests/keys-request.test.mjs` (append)

**Interfaces:**
- Produces: `mcrmMarkerKey(contractId, period) → { pk: 'MCRM#<contractId>#<period>', sk: 'META' }`; `deps.putIfAbsent(item) → true | false` (false = already existed); `deps.getObjectFrom(bucket, key) → Buffer`.

- [ ] **Step 1: Failing test** (append to `keys-request.test.mjs`)

```js
import { mcrmMarkerKey } from '../code/keys.mjs';
test('mcrmMarkerKey is Brand + month, independent of run', () => {
  assert.deepEqual(mcrmMarkerKey('01JABC', '2026-09'), { pk: 'MCRM#01JABC#2026-09', sk: 'META' });
});
```

- [ ] **Step 2:** `npm test` → FAIL (`mcrmMarkerKey` not exported).

- [ ] **Step 3: Implement**

`keys.mjs`:
```js
// One payment request per MCRM Brand per month. Keyed on Brand + month, NOT on the run, so a
// recomputed or second run of the same month cannot create a second request.
export function mcrmMarkerKey(contractId, period) {
  return { pk: `MCRM#${String(contractId).trim()}#${String(period).trim()}`, sk: 'META' };
}
```

`db.mjs` (reuse its existing `ddb` client, `TABLE`, `PutCommand` import):
```js
// Write only if no item has this key. Returns false instead of throwing when one exists, so
// "someone else got there first" is an answer, not an error.
export async function putIfAbsent(item) {
  try {
    await ddb.send(new PutCommand({ TableName: TABLE, Item: item, ConditionExpression: 'attribute_not_exists(pk)' }));
    return true;
  } catch (e) {
    if (e && e.name === 'ConditionalCheckFailedException') return false;
    throw e;
  }
}
```
(Match the file's actual client/table identifiers — read the top of `db.mjs` first.)

`s3.mjs`:
```js
// Read an object from ANOTHER bucket this role was granted (MCRM's statement files).
export async function getObjectFrom(bucket, key) {
  const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return Buffer.from(await out.Body.transformToByteArray());
}
```

`index.mjs` `dbDeps()` add:
```js
    async putIfAbsent(item) { return (await import('./db.mjs')).putIfAbsent(item); },
    async getObjectFrom(b, k) { return (await import('./s3.mjs')).getObjectFrom(b, k); },
```

- [ ] **Step 4:** `npm test` → all pass.

### Task 2: `routes/mcrm.mjs` — createDraft, findDraft, statuses; delete frees the marker

**Files:**
- Create: `lambda/csth-api/code/routes/mcrm.mjs`
- Modify: `lambda/csth-api/code/routes/requests.mjs` (`deleteRequest` deletes marker)
- Modify: `lambda/csth-api/code/routes/index.mjs` (re-export)
- Test: `lambda/csth-api/tests/mcrm.test.mjs`

**Interfaces:**
- Consumes: Task 1 (`mcrmMarkerKey`, `deps.putIfAbsent`, `deps.getObjectFrom`); existing `createRequest`, `bangkokToday`, `attachmentKey`, `requestKey`.
- Produces:
  - `MCRM_FORM = { th: 'PV', sg: 'PES' }`
  - `mcrmStatusLabel(request, today) → { status, label, docNumber, paymentDate }`
  - `findDraftFromMcrm({ contractId, period }, deps) → { requestId } | null`
  - `createDraftFromMcrm(payload, nowIso, deps) → { requestId }` — throws `Error` with `.code` ∈ `wrong_form | exists | owner_not_linked`
  - `requestStatuses(requestIds, nowIso, deps) → { [id]: label-object | { missing: true } }`

- [ ] **Step 1: Failing tests** — `tests/mcrm.test.mjs`. Reuse the in-memory `makeDeps` shape from `requests.test.mjs` (copy it in; add `putIfAbsent`, `getObjectFrom`, `putObject`, `country`).

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDraftFromMcrm, findDraftFromMcrm, requestStatuses, mcrmStatusLabel } from '../code/routes/mcrm.mjs';
import { deleteRequest } from '../code/routes/requests.mjs';

function makeDeps(country = 'th') {
  const store = new Map(); const objects = new Map(); let n = 0;
  return {
    store, objects, country,
    putItem: async (i) => { store.set(`${i.pk}|${i.sk}`, i); return i; },
    getItem: async (pk, sk) => store.get(`${pk}|${sk}`) || null,
    deleteItem: async (pk, sk) => { store.delete(`${pk}|${sk}`); },
    putIfAbsent: async (i) => { const k = `${i.pk}|${i.sk}`; if (store.has(k)) return false; store.set(k, i); return true; },
    getObjectFrom: async (b, k) => Buffer.from(`xlsx:${b}/${k}`),
    putObject: async (k, buf) => { objects.set(k, buf); return k; },
    deleteObject: async (k) => { objects.delete(k); },
    putEvent: async () => {},
    uuid: () => `id-${++n}`,
    query: async (pk) => (pk === 'REF' ? [
      { pk: 'REF', sk: 'EMP#1', type: 'employee', code: '1', name: 'Ozzie', department: 'Operation', email: 'ozzie.wang@inforich.com' },
    ] : []),
  };
}
const PV_PAYLOAD = {
  ownerEmail: 'ozzie.wang@inforich.com', form: 'PV',
  source: { contractId: 'C1', period: '2026-09', runId: 'R1', brand: 'AOT' },
  header: { payTo: 'Airports of Thailand', currency: 'THB', details: 'Revenue share — AOT — Sep 2026' },
  lineItems: [{ date: '2026-09-30', ref: 'MCRM', details: 'Revenue share Sep 2026', amount: 1327.10, vatRate: 0.07 }],
  statement: { bucket: 'revshare-runs-x', key: 'payreq/2026-09/C1.xlsx', filename: 'AOT 2026-09.xlsx' },
};
const NOW = '2026-10-13T03:00:00.000Z';

test('creates a DRAFT owned by the caller, tagged, with the statement attached', async () => {
  const d = makeDeps();
  const { requestId } = await createDraftFromMcrm(PV_PAYLOAD, NOW, d);
  const r = d.store.get(`REQUEST#${requestId}|META`);
  assert.equal(r.status, 'DRAFT');
  assert.equal(r.requestorEmail, 'ozzie.wang@inforich.com');
  assert.equal(r.header.employee, 'Ozzie');
  assert.deepEqual(r.mcrmSource, PV_PAYLOAD.source);
  assert.equal(r.totals.totalInclVat, 1420);
  assert.equal(r.attachments.length, 1);
  assert.match(r.attachments[0].contentType, /spreadsheetml/);
  assert.ok(d.objects.has(r.attachments[0].key));
  assert.deepEqual(await findDraftFromMcrm({ contractId: 'C1', period: '2026-09' }, d), { requestId });
});

test('a second create for the same Brand + month is refused, even from another run', async () => {
  const d = makeDeps();
  await createDraftFromMcrm(PV_PAYLOAD, NOW, d);
  await assert.rejects(createDraftFromMcrm({ ...PV_PAYLOAD, source: { ...PV_PAYLOAD.source, runId: 'R2' } }, NOW, d),
    (e) => e.code === 'exists');
});

test('wrong form for the stack is refused', async () => {
  await assert.rejects(createDraftFromMcrm({ ...PV_PAYLOAD, form: 'PES' }, NOW, makeDeps('th')), (e) => e.code === 'wrong_form');
});

test('an owner with no employee record is refused with owner_not_linked and nothing is written', async () => {
  const d = makeDeps();
  await assert.rejects(createDraftFromMcrm({ ...PV_PAYLOAD, ownerEmail: 'nobody@inforich.com' }, NOW, d),
    (e) => e.code === 'owner_not_linked');
  assert.equal(d.store.size, 0);
});

test('deleting the draft frees the Brand + month', async () => {
  const d = makeDeps();
  const { requestId } = await createDraftFromMcrm(PV_PAYLOAD, NOW, d);
  await deleteRequest(requestId, 'ozzie.wang@inforich.com', d);
  assert.equal(await findDraftFromMcrm({ contractId: 'C1', period: '2026-09' }, d), null);
});

test('status labels', () => {
  const today = '2026-10-13';
  const L = (r) => mcrmStatusLabel(r, today).label;
  assert.equal(L({ status: 'DRAFT' }), 'Draft');
  assert.equal(L({ status: 'PENDING_FINANCE' }), 'Submitted — awaiting finance');
  assert.equal(L({ status: 'PENDING_ACK' }), 'Submitted — awaiting acknowledgement');
  assert.equal(L({ status: 'CHANGES_REQUESTED' }), 'Sent back');
  assert.equal(L({ status: 'REJECTED' }), 'Rejected');
  assert.equal(L({ status: 'APPROVED', header: {} }), 'Approved — ready to pay');
  assert.equal(L({ status: 'APPROVED', header: { paymentDate: '2026-10-14' } }), 'Approved — paying 2026-10-14');
  assert.equal(L({ status: 'APPROVED', header: { paymentDate: '2026-10-13' } }), 'Paid 2026-10-13');
  assert.equal(L({ status: 'PAID', paid: { paidDate: '2026-09-01' } }), 'Paid 2026-09-01');
});

test('statuses: missing only for a request that is really gone', async () => {
  const d = makeDeps();
  const { requestId } = await createDraftFromMcrm(PV_PAYLOAD, NOW, d);
  const out = await requestStatuses([requestId, 'gone-id'], NOW, d);
  assert.equal(out[requestId].label, 'Draft');
  assert.deepEqual(out['gone-id'], { missing: true });
});
```

- [ ] **Step 2:** `npm test` → FAIL (module missing).

- [ ] **Step 3: Implement** `routes/mcrm.mjs`:

```js
// routes/mcrm.mjs — draft payment requests created by MCRM (the rev-share app), and their
// status read back. Reached ONLY through a direct Lambda invoke (see index.mjs), never the
// public API. IO via injected deps.
import { createRequest } from './requests.mjs';
import { bangkokToday } from './payments.mjs';
import { mcrmMarkerKey, requestKey, attachmentKey, safeName } from '../keys.mjs';

export const MCRM_FORM = { th: 'PV', sg: 'PES' };
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const STAGE_WORD = { PENDING_ACK: 'acknowledgement', PENDING_FINANCE: 'finance', PENDING_COO: 'COO', PENDING_CEO: 'CEO' };

const fail = (code, message) => Object.assign(new Error(message), { code });

// The ONE place a status is put into words for MCRM. The Paid rule is payments.mjs's: a payment
// date today-or-earlier (Bangkok) is Paid; none, or a future one, is still to pay.
export function mcrmStatusLabel(r, today) {
  const docNumber = r.docNumber || null;
  const paymentDate = r.header?.paymentDate || r.paid?.paidDate || '';
  const out = (label) => ({ status: r.status, label, docNumber, paymentDate: paymentDate || null });
  if (r.status === 'DRAFT') return out('Draft');
  if (String(r.status).startsWith('PENDING_')) return out(`Submitted — awaiting ${STAGE_WORD[r.status] || 'approval'}`);
  if (r.status === 'CHANGES_REQUESTED') return out('Sent back');
  if (r.status === 'REJECTED') return out('Rejected');
  if (r.status === 'PAID') return out(`Paid ${paymentDate}`.trim());
  if (r.status === 'APPROVED') {
    if (!paymentDate) return out('Approved — ready to pay');
    return paymentDate <= today ? out(`Paid ${paymentDate}`) : out(`Approved — paying ${paymentDate}`);
  }
  return out(r.status);
}

export async function findDraftFromMcrm({ contractId, period }, deps) {
  const m = mcrmMarkerKey(contractId, period);
  const marker = await deps.getItem(m.pk, m.sk);
  if (!marker) return null;
  const { pk, sk } = requestKey(marker.requestId);
  return (await deps.getItem(pk, sk)) ? { requestId: marker.requestId } : null;
}

export async function createDraftFromMcrm(p, nowIso, deps) {
  const form = MCRM_FORM[deps.country || 'th'];
  if (p.form !== form) throw fail('wrong_form', `this stack files ${form}, not ${p.form}`);
  const { contractId, period } = p.source || {};
  if (!contractId || !period) throw fail('bad_source', 'source.contractId and source.period are required');
  if (await findDraftFromMcrm({ contractId, period }, deps)) throw fail('exists', 'a request already exists for this Brand and month');

  let item;
  try {
    item = await createRequest({ type: form, header: p.header, lineItems: p.lineItems, subBlocks: {} }, p.ownerEmail, nowIso, deps);
  } catch (e) {
    if (/not linked to an employee/i.test(e.message)) throw fail('owner_not_linked', e.message);
    throw e;
  }
  item.mcrmSource = p.source;
  if (p.statement?.bucket && p.statement?.key) {
    const bytes = await deps.getObjectFrom(p.statement.bucket, p.statement.key);
    const key = attachmentKey(item.id, deps.uuid(), p.statement.filename || 'statement.xlsx');
    await deps.putObject(key, bytes, XLSX_TYPE);
    item.attachments = [{ key, filename: safeName(p.statement.filename || 'statement.xlsx'), contentType: XLSX_TYPE, ts: nowIso }];
  }
  await deps.putItem(item);

  // The marker is written LAST and conditionally: if a concurrent create won, undo ours.
  const won = await deps.putIfAbsent({ ...mcrmMarkerKey(contractId, period), requestId: item.id, createdAt: nowIso });
  if (!won) {
    for (const a of item.attachments || []) await deps.deleteObject(a.key);
    const { pk, sk } = requestKey(item.id);
    await deps.deleteItem(pk, sk);
    throw fail('exists', 'a request already exists for this Brand and month');
  }
  await deps.putEvent(item.id, { stage: 'create', action: 'createdFromMcrm', actorEmail: p.ownerEmail, ts: nowIso });
  return { requestId: item.id };
}

export async function requestStatuses(ids, nowIso, deps) {
  const today = bangkokToday(nowIso);
  const out = {};
  for (const id of ids || []) {
    const { pk, sk } = requestKey(id);
    const r = await deps.getItem(pk, sk);
    out[id] = r ? mcrmStatusLabel(r, today) : { missing: true };
  }
  return out;
}
```

`requests.mjs` `deleteRequest` — after `deps.deleteItem(pk, sk)`:
```js
  // A draft MCRM created holds its Brand + month; deleting it lets that Brand be requested again.
  if (item.mcrmSource?.contractId && item.mcrmSource?.period) {
    const m = mcrmMarkerKey(item.mcrmSource.contractId, item.mcrmSource.period);
    await deps.deleteItem(m.pk, m.sk);
  }
```
(add `mcrmMarkerKey` to its `keys.mjs` import.)

`routes/index.mjs` append:
```js
export { createDraftFromMcrm, findDraftFromMcrm, requestStatuses } from './mcrm.mjs';
```

- [ ] **Step 4:** `npm test` → all pass (incl. `routes-barrel.test.mjs`).

### Task 3: Internal entry point in `index.mjs`

**Files:**
- Modify: `lambda/csth-api/code/index.mjs` (top of `handler`, before `method`/OPTIONS)
- Test: `lambda/csth-api/tests/index.test.mjs` (append)

**Interfaces:**
- Consumes: Task 2 exports via `routes`.
- Produces: invoke contract — request `{ internal: 'mcrm', action: 'createDraft' | 'findDraft' | 'statuses', payload }`; response `{ ok: true, result }` or `{ ok: false, code, error }`.

- [ ] **Step 1: Failing tests** (follow `index.test.mjs`'s existing injected-deps style)

```js
test('internal mcrm action runs on a direct-invoke event', async () => {
  const routes = { findDraftFromMcrm: async () => ({ requestId: 'r1' }) };
  const out = await handler({ internal: 'mcrm', action: 'findDraft', payload: { contractId: 'C', period: '2026-09' } },
    { routes, cfg: { country: 'th' }, db: {} });
  assert.deepEqual(out, { ok: true, result: { requestId: 'r1' } });
});

test('the same body arriving through API Gateway is NOT an internal call', async () => {
  const routes = { findDraftFromMcrm: async () => { throw new Error('must not run'); } };
  const out = await handler({ internal: 'mcrm', action: 'findDraft', requestContext: { http: { method: 'POST' } }, rawPath: '/x', headers: {} },
    { routes, cfg: { country: 'th' } });
  assert.equal(out.statusCode, 401);
});

test('internal failure carries the code', async () => {
  const routes = { createDraftFromMcrm: async () => { throw Object.assign(new Error('nope'), { code: 'owner_not_linked' }); } };
  const out = await handler({ internal: 'mcrm', action: 'createDraft', payload: {} }, { routes, cfg: { country: 'th' } });
  assert.deepEqual(out, { ok: false, code: 'owner_not_linked', error: 'nope' });
});
```

- [ ] **Step 2:** `npm test` → FAIL.

- [ ] **Step 3: Implement** — insert right after `dbDeps` is defined, before `const method = …`:

```js
  // MCRM (the rev-share app) calls this function DIRECTLY through Lambda Invoke, authorised by
  // IAM — only its role may invoke. API Gateway always sends `requestContext`, so a body that
  // merely contains `internal` from the public URL never reaches this branch.
  if (event && event.internal === 'mcrm' && !event.requestContext) {
    const routes = deps.routes || (await import('./routes/index.mjs'));
    const d = { ...dbDeps(), country: cfg.country };
    const now = new Date().toISOString();
    try {
      const p = event.payload || {};
      let result;
      if (event.action === 'createDraft') result = await routes.createDraftFromMcrm(p, now, d);
      else if (event.action === 'findDraft') result = await routes.findDraftFromMcrm(p, d);
      else if (event.action === 'statuses') result = await routes.requestStatuses(p.requestIds, now, d);
      else return { ok: false, code: 'unknown_action', error: String(event.action) };
      return { ok: true, result };
    } catch (e) {
      return { ok: false, code: e.code || 'error', error: e.message };
    }
  }
```

- [ ] **Step 4:** `npm test` → all pass.

---

## Part B — MCRM (`~/revshare-aws/.claude/worktrees/finance-info-columns`)

### Task 4: `payreq.mjs` — pure draft builder

**Files:**
- Create: `lambda/revshare-api/code/payreq.mjs`
- Test: `lambda/revshare-api/tests/payreq.test.mjs`

**Interfaces:**
- Produces:
  - `PR_FORM = { th: 'PV', sg: 'PES' }`
  - `mapBank(raw, region) → { value: string | null, raw: string, unmapped: boolean }`
  - `taxBase(total, rate) → number` with `base + round2(base*rate) === round2(total)` whenever reachable
  - `monthWords(period) → { long: 'Sep 2026', short: 'Sep26', lastDay: '2026-09-30' }`
  - `buildDraft({ region, brand, payTo, bank, payout, period }) → { form, header, lineItems }`
  - `draftWarnings({ region, entityName, bank }) → string[]`

- [ ] **Step 1: Failing tests**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mapBank, taxBase, monthWords, buildDraft, draftWarnings } from '../code/payreq.mjs';

const r2 = (v) => Math.round(v * 100) / 100;

test('every live TH bank name maps (2026-10-13 values)', () => {
  const live = { 'ธนาคารกสิกรไทย': 'Kasikorn Bank', 'ธนาคารกสิกร': 'Kasikorn Bank', 'ธนาคารกสิกรำทย': 'Kasikorn Bank',
    'ธนาคารไทยพาณิชย์': 'Siam Commercial Bank', 'ธนาคารกรุงเทพ': 'Bangkok Bank', 'ธนาคารกรุงไทย': 'Krung Thai Bank',
    'ธนาคารกรุงศรี': 'Krungsri Bank', 'ธนาคารทหารไทย': 'TTB Bank', 'KBank': 'Kasikorn Bank', 'SCB': 'Siam Commercial Bank' };
  for (const [raw, want] of Object.entries(live)) assert.equal(mapBank(raw, 'th').value, want, raw);
});
test('banks with no dropdown option are unmapped, not guessed', () => {
  for (const raw of ['ธนาคารยูโอบี', 'ธนาคารอาคารสงเคราะห์']) {
    const m = mapBank(raw, 'th'); assert.equal(m.value, null); assert.equal(m.unmapped, true);
  }
});
test('"-" and blank are no bank at all', () => {
  for (const raw of ['-', '', '  ', null]) assert.deepEqual(mapBank(raw, 'th'), { value: null, raw: '', unmapped: false });
});
test('SG banks', () => {
  assert.equal(mapBank('DBS Bank', 'sg').value, 'DBS / POSB');
  assert.equal(mapBank('OCBC', 'sg').value, 'OCBC');
});

test('tax base: the statement template figure', () => assert.equal(taxBase(1420, 0.07), 1327.10));
test('tax base reconciles to the satang for every payout 0.01..20,000.00', () => {
  for (let c = 1; c <= 2_000_000; c++) {
    const t = c / 100, b = taxBase(t, 0.07);
    assert.equal(r2(b + r2(b * 0.07)), r2(t), `payout ${t}`);
  }
});

test('month words', () => assert.deepEqual(monthWords('2026-09'), { long: 'Sep 2026', short: 'Sep26', lastDay: '2026-09-30' }));

test('TH draft is a PV whose total is the payout', () => {
  const d = buildDraft({ region: 'th', brand: 'AOT', payTo: 'Airports of Thailand',
    bank: { name: 'ธนาคารกรุงไทย', number: '123-4-56789-0', accountName: 'AOT PLC' }, payout: 1420, period: '2026-09' });
  assert.equal(d.form, 'PV');
  assert.deepEqual(d.header, { payTo: 'Airports of Thailand', payBank: 'Krung Thai Bank', payAccount: '123-4-56789-0',
    payAccountName: 'AOT PLC', currency: 'THB', details: 'Revenue share — AOT — Sep 2026' });
  assert.deepEqual(d.lineItems, [{ date: '2026-09-30', ref: 'MCRM', details: 'Revenue share Sep 2026', amount: 1327.10, vatRate: 0.07 }]);
});
test('TH unmapped bank keeps the raw name in details', () => {
  const d = buildDraft({ region: 'th', brand: 'X', payTo: 'X', bank: { name: 'ธนาคารยูโอบี' }, payout: 100, period: '2026-09' });
  assert.equal(d.header.payBank, undefined);
  assert.match(d.header.details, /bank: ธนาคารยูโอบี/);
});
test('SG draft is a PES following the licence-fee pattern', () => {
  const d = buildDraft({ region: 'sg', brand: 'Cheers', payTo: 'Cheers', bank: {}, payout: 812.5, period: '2026-09' });
  assert.equal(d.form, 'PES');
  assert.equal(d.header.subject, 'Cheers - ChargeSPOT Revenue Share_Sep26');
  assert.equal(d.header.competenceNo, 'II - 7 - (10) - 5');
  assert.equal(d.header.frequency, 'Monthly');
  assert.equal(d.header.currency, 'SGD');
  assert.deepEqual(d.lineItems, [{ description: 'Revenue Share_Sep26', amount: 812.5, vatRate: 0 }]);
});
test('warnings', () => {
  assert.deepEqual(draftWarnings({ region: 'th', entityName: '', bank: {} }),
    ['No contract entity — Pay to uses the Brand name', 'No bank on file']);
  assert.deepEqual(draftWarnings({ region: 'th', entityName: 'E', bank: { name: 'ธนาคารยูโอบี' } }),
    ['Bank "ธนาคารยูโอบี" is not in Payment Request\'s list — finance picks it']);
});
test('TH tax rate agrees with the statement (frontend TAX)', () => {
  const app = readFileSync(new URL('../../../frontend/app.js', import.meta.url), 'utf8');
  assert.match(app, /th: \{ rate: 0\.07, mode: 'inclusive' \}/);
});
```

- [ ] **Step 2:** `npm test` → FAIL.

- [ ] **Step 3: Implement** `payreq.mjs`:

```js
// payreq.mjs — what a Payment Request draft for one Brand and one month contains. Pure.
// TH files a Payment Voucher (PV); SG a Payment Expense & Settlement (PES), worded like the
// mall licence fees Singapore already files there.

export const PR_FORM = { th: 'PV', sg: 'PES' };
const TH_VAT = 0.07;   // the statement's TAX.th — a test reads app.js to keep the two equal
const SG_COMPETENCE_NO = 'II - 7 - (10) - 5';
const round2 = (v) => Math.round(Number(v) * 100) / 100;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Payment Request's dropdown values, and the names MCRM's free-text Finance Information uses.
const TH_BANKS = [
  [/กสิกร|kasikorn|kbank/i, 'Kasikorn Bank'],
  [/ไทยพาณิชย์|siam commercial|\bscb\b/i, 'Siam Commercial Bank'],
  [/กรุงเทพ|bangkok bank|\bbbl\b/i, 'Bangkok Bank'],
  [/กรุงไทย|krung ?thai|\bktb\b/i, 'Krung Thai Bank'],
  [/กรุงศรี|krungsri|ayudhya|\bbay\b/i, 'Krungsri Bank'],
  [/ทหารไทย|ธนชาต|\bttb\b|tmb/i, 'TTB Bank'],
  [/พร้อมเพย์|prompt ?pay/i, 'Prompt Pay'],
];
const SG_BANKS = [
  [/dbs|posb/i, 'DBS / POSB'], [/ocbc|oversea-chinese/i, 'OCBC'], [/\buob\b|united overseas/i, 'UOB'],
  [/standard chartered/i, 'Standard Chartered'], [/hsbc/i, 'HSBC'], [/maybank/i, 'Maybank'],
  [/citi/i, 'Citibank'], [/paynow/i, 'PayNow'],
];

export function mapBank(raw, region) {
  const s = String(raw ?? '').trim();
  if (!s || s === '-') return { value: null, raw: '', unmapped: false };
  for (const [re, value] of (region === 'sg' ? SG_BANKS : TH_BANKS)) if (re.test(s)) return { value, raw: s, unmapped: false };
  return { value: null, raw: s, unmapped: true };
}

// The amount to type so that Payment Request's own arithmetic (amount + round2(amount × rate))
// lands exactly on the payout. Plain total/(1+rate) is off by a satang for some totals.
export function taxBase(total, rate) {
  const t = round2(total);
  const b0 = round2(t / (1 + rate));
  for (const d of [0, 0.01, -0.01, 0.02, -0.02]) {
    const b = round2(b0 + d);
    if (round2(b + round2(b * rate)) === t) return b;
  }
  return b0;
}

export function monthWords(period) {
  const [y, m] = String(period).split('-').map(Number);
  const mon = MONTHS[m - 1];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { long: `${mon} ${y}`, short: `${mon}${String(y).slice(2)}`, lastDay: `${period}-${String(last).padStart(2, '0')}` };
}

export function buildDraft({ region, brand, payTo, bank = {}, payout, period }) {
  const w = monthWords(period);
  const b = mapBank(bank.name, region);
  const bankHeader = {
    ...(b.value ? { payBank: b.value } : {}),
    ...(bank.number ? { payAccount: String(bank.number).trim() } : {}),
    ...(bank.accountName ? { payAccountName: String(bank.accountName).trim() } : {}),
  };
  if (region === 'sg') {
    return {
      form: 'PES',
      header: { subject: `${brand} - ChargeSPOT Revenue Share_${w.short}`, competenceNo: SG_COMPETENCE_NO,
        frequency: 'Monthly', payTo, ...bankHeader, currency: 'SGD',
        ...(b.unmapped ? { remarks: `Bank on file: ${b.raw}` } : {}) },
      lineItems: [{ description: `Revenue Share_${w.short}`, amount: round2(payout), vatRate: 0 }],
    };
  }
  return {
    form: 'PV',
    header: { payTo, ...bankHeader, currency: 'THB',
      details: `Revenue share — ${brand} — ${w.long}${b.unmapped ? ` · bank: ${b.raw}` : ''}` },
    lineItems: [{ date: w.lastDay, ref: 'MCRM', details: `Revenue share ${w.long}`, amount: taxBase(payout, TH_VAT), vatRate: TH_VAT }],
  };
}

export function draftWarnings({ region, entityName, bank = {} }) {
  const out = [];
  if (!String(entityName || '').trim()) out.push('No contract entity — Pay to uses the Brand name');
  const b = mapBank(bank.name, region);
  if (b.unmapped) out.push(`Bank "${b.raw}" is not in Payment Request's list — finance picks it`);
  else if (!b.value) out.push('No bank on file');
  return out;
}
```

- [ ] **Step 4:** `npm test` → all pass. (The brute-force loop is 2M iterations; must finish in a few seconds. If `taxBase` returns `b0` for any total, the test names it.)

### Task 5: `payreq-db.mjs` — PAYREQ rows, statement object, invoke

**Files:**
- Create: `lambda/revshare-api/code/payreq-db.mjs`

**Interfaces:**
- Produces (all async):
  - `listPayReqs(period) → Array<{ contractId, requestId, region, amount, currency, runId, createdBy, createdAt }>`
  - `getPayReq(period, contractId) → row | null`
  - `putPayReq(period, row) → boolean` (false = already exists; conditional)
  - `deletePayReq(period, contractId)`
  - `putStatement(period, contractId, bytes) → { bucket, key }`
  - `invokePaymentRequest(action, payload) → result` — throws `Error` with `.code` from Payment Request; `.code = 'unreachable'` when the invoke itself fails.

No unit test: thin IO, exercised through Task 6's injected deps and the live check in Task 9.

- [ ] **Step 1: Implement**

```js
// payreq-db.mjs — MCRM's side of payment requests: one PAYREQ row per Brand per month, the
// statement file handed to Payment Request, and the Lambda invoke. Deliberately NOT in db.mjs:
// that file is never synced to Singapore, and this one must be identical in both regions —
// everything region-specific comes from Lambda env.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, GetCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { queryAll } from './ddb-util.mjs';

const REGION = process.env.AWS_REGION || 'ap-southeast-7';
const TABLE = process.env.REVSHARE_TABLE || 'RevsharePartner';
const BUCKET = process.env.REVSHARE_RUNS_BUCKET || 'revshare-runs-812751451548-sea7';
const FN = process.env.PAYMENT_REQUEST_FUNCTION || '';
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const s3 = new S3Client({ region: REGION });
const pk = (period) => `PAYREQ#${period}`;

export async function listPayReqs(period) {
  return queryAll(ddb, { TableName: TABLE, KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': pk(period) } });
}
export async function getPayReq(period, contractId) {
  const out = await ddb.send(new GetCommand({ TableName: TABLE, Key: { pk: pk(period), sk: contractId } }));
  return out.Item || null;
}
export async function putPayReq(period, row) {
  try {
    await ddb.send(new PutCommand({ TableName: TABLE, Item: { pk: pk(period), sk: row.contractId, ...row },
      ConditionExpression: 'attribute_not_exists(sk)' }));
    return true;
  } catch (e) { if (e.name === 'ConditionalCheckFailedException') return false; throw e; }
}
export async function deletePayReq(period, contractId) {
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { pk: pk(period), sk: contractId } }));
}
export async function putStatement(period, contractId, bytes) {
  const key = `payreq/${period}/${contractId}.xlsx`;
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: bytes,
    ContentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  return { bucket: BUCKET, key };
}

// The Node 22 runtime ships the v3 SDK, so client-lambda resolves without a package.json change
// (adding one would have to be installed in the SG repo by hand too).
export async function invokePaymentRequest(action, payload) {
  if (!FN) throw Object.assign(new Error('PAYMENT_REQUEST_FUNCTION is not set'), { code: 'unreachable' });
  let res;
  try {
    const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
    const out = await new LambdaClient({ region: REGION }).send(new InvokeCommand({
      FunctionName: FN, Payload: Buffer.from(JSON.stringify({ internal: 'mcrm', action, payload })) }));
    if (out.FunctionError) throw new Error(Buffer.from(out.Payload || []).toString() || out.FunctionError);
    res = JSON.parse(Buffer.from(out.Payload).toString());
  } catch (e) {
    throw Object.assign(new Error(`Payment Request could not be reached: ${e.message}`), { code: 'unreachable' });
  }
  if (!res.ok) throw Object.assign(new Error(res.error || 'failed'), { code: res.code || 'error' });
  return res.result;
}
```
Check `queryAll`'s real signature in `ddb-util.mjs` and match it.

- [ ] **Step 2:** `npm test` → still all pass (module only imported by Task 6).

### Task 6: Routes — create, list (with live status + warnings)

**Files:**
- Create: `lambda/revshare-api/code/routes/payment-requests.mjs`
- Modify: `lambda/revshare-api/code/index.mjs` (two routes, before the `/bulk-runs/[^/]+$` GET)
- Modify: `lambda/revshare-api/code/auth.mjs` (`requiredPermission`, before the `/bulk-runs/` catch-all)
- Test: `lambda/revshare-api/tests/payment-requests.test.mjs`; append to `auth.test.mjs`

**Interfaces:**
- Consumes: Task 4 (`buildDraft`, `draftWarnings`, `PR_FORM`), Task 5 (all), db.mjs `getBulkRun`, `getContract`, `listEntities`.
- Produces:
  - `POST /bulk-runs/:id/payment-requests` body `{ contractId, statement /* base64 xlsx */, filename }` → `201 { requestId, status: 'created' | 'recovered' }`; `409 { error: 'not_locked' | 'zero_payout' | 'exists' | 'owner_not_linked', message }`; `404 { error: 'not_in_run' }`; `502 { error: 'unreachable', message }`.
  - `GET /bulk-runs/:id/payment-requests` → `{ region, rows: { [contractId]: { requestId, createdBy, createdAt, amount, status: label-object | 'unknown' } }, warnings: { [contractId]: string[] } }`.
  - Route handlers take `(event, deps)`; `deps` defaults to the real modules.

- [ ] **Step 1: Failing tests** — `tests/payment-requests.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPaymentRequestRoute, listPaymentRequestsRoute } from '../code/routes/payment-requests.mjs';

const RUN = { runId: 'R1', periodStart: '2026-09-01', archived: true,
  results: [{ contractId: 'C1', merchantName: 'AOT', payout: 1420 }, { contractId: 'C0', merchantName: 'Zero', payout: 0 }] };
function deps(over = {}) {
  const rows = new Map(); const calls = [];
  return {
    rows, calls, region: 'th',
    getBulkRun: async () => RUN,
    getContract: async () => ({ contractId: 'C1', merchantName: 'AOT', entityId: 'E1', bankName: 'ธนาคารกรุงไทย', bankAccountNumber: '1', bankAccountName: 'A' }),
    listEntities: async () => [{ entityId: 'E1', name: 'Airports of Thailand' }],
    listPayReqs: async () => [...rows.values()],
    getPayReq: async (p, c) => rows.get(c) || null,
    putPayReq: async (p, r) => { if (rows.has(r.contractId)) return false; rows.set(r.contractId, r); return true; },
    deletePayReq: async (p, c) => { rows.delete(c); },
    putStatement: async (p, c) => ({ bucket: 'b', key: `payreq/${p}/${c}.xlsx` }),
    invokePaymentRequest: async (action, payload) => {
      calls.push([action, payload]);
      if (action === 'findDraft') return null;
      if (action === 'createDraft') return { requestId: 'PR1' };
      if (action === 'statuses') return Object.fromEntries(payload.requestIds.map((id) => [id, { status: 'DRAFT', label: 'Draft' }]));
    },
    ...over,
  };
}
const ev = (body) => ({ pathParameters: { runId: 'R1' }, auth: { email: 'ozzie.wang@inforich.com' }, body: JSON.stringify(body) });
const B = { contractId: 'C1', statement: Buffer.from('x').toString('base64'), filename: 'AOT.xlsx' };

test('creates a PV draft for a locked run and records it', async () => {
  const d = deps();
  const r = await createPaymentRequestRoute(ev(B), d);
  assert.equal(r.statusCode, 201);
  const [, p] = d.calls.find(([a]) => a === 'createDraft');
  assert.equal(p.form, 'PV');
  assert.equal(p.ownerEmail, 'ozzie.wang@inforich.com');
  assert.equal(p.header.payTo, 'Airports of Thailand');
  assert.deepEqual(p.source, { contractId: 'C1', period: '2026-09', runId: 'R1', brand: 'AOT' });
  assert.equal(d.rows.get('C1').requestId, 'PR1');
});
test('refuses an unlocked run', async () => {
  const r = await createPaymentRequestRoute(ev(B), deps({ getBulkRun: async () => ({ ...RUN, archived: false }) }));
  assert.equal(r.statusCode, 409); assert.equal(JSON.parse(r.body).error, 'not_locked');
});
test('refuses a zero payout and a Brand not in the run', async () => {
  assert.equal(JSON.parse((await createPaymentRequestRoute(ev({ ...B, contractId: 'C0' }), deps())).body).error, 'zero_payout');
  assert.equal((await createPaymentRequestRoute(ev({ ...B, contractId: 'NOPE' }), deps())).statusCode, 404);
});
test('refuses when this Brand + month is already recorded', async () => {
  const d = deps(); d.rows.set('C1', { contractId: 'C1', requestId: 'OLD' });
  assert.equal(JSON.parse((await createPaymentRequestRoute(ev(B), d)).body).error, 'exists');
});
test('recovers a request Payment Request already has instead of creating a second', async () => {
  const d = deps({ invokePaymentRequest: async (a) => (a === 'findDraft' ? { requestId: 'PR9' } : assert.fail('must not create')) });
  const r = await createPaymentRequestRoute(ev(B), d);
  assert.equal(JSON.parse(r.body).status, 'recovered');
  assert.equal(d.rows.get('C1').requestId, 'PR9');
});
test('owner_not_linked comes back as a 409 with that code', async () => {
  const d = deps({ invokePaymentRequest: async (a) => { if (a === 'findDraft') return null;
    throw Object.assign(new Error('Your account is not linked'), { code: 'owner_not_linked' }); } });
  const r = await createPaymentRequestRoute(ev(B), d);
  assert.equal(r.statusCode, 409); assert.equal(JSON.parse(r.body).error, 'owner_not_linked');
  assert.equal(d.rows.size, 0);
});
test('list joins live status and frees only explicitly missing requests', async () => {
  const d = deps({ invokePaymentRequest: async () => ({ PR1: { label: 'Draft' }, PR2: { missing: true } }) });
  d.rows.set('C1', { contractId: 'C1', requestId: 'PR1' });
  d.rows.set('C2', { contractId: 'C2', requestId: 'PR2' });
  d.rows.set('C3', { contractId: 'C3', requestId: 'PR3' });   // omitted from the reply
  const body = JSON.parse((await listPaymentRequestsRoute(ev({}), d)).body);
  assert.equal(body.rows.C1.status.label, 'Draft');
  assert.equal(body.rows.C2, undefined); assert.equal(d.rows.has('C2'), false);
  assert.equal(body.rows.C3.status, 'unknown'); assert.equal(d.rows.has('C3'), true);
});
test('list survives Payment Request being unreachable', async () => {
  const d = deps({ invokePaymentRequest: async () => { throw Object.assign(new Error('down'), { code: 'unreachable' }); } });
  d.rows.set('C1', { contractId: 'C1', requestId: 'PR1' });
  const body = JSON.parse((await listPaymentRequestsRoute(ev({}), d)).body);
  assert.equal(body.rows.C1.status, 'unknown'); assert.equal(d.rows.has('C1'), true);
});
test('list carries per-Brand warnings for payable Brands', async () => {
  const d = deps({ getContract: async () => ({ contractId: 'C1', merchantName: 'AOT' }), listEntities: async () => [] });
  const body = JSON.parse((await listPaymentRequestsRoute(ev({}), d)).body);
  assert.deepEqual(body.warnings.C1, ['No contract entity — Pay to uses the Brand name', 'No bank on file']);
  assert.equal(body.warnings.C0, undefined);
});
```

Append to `auth.test.mjs`:
```js
test('payment requests: create needs runCalcs, list is an open read', () => {
  assert.equal(requiredPermission('POST', '/bulk-runs/R1/payment-requests'), 'runCalcs');
  assert.equal(requiredPermission('GET', '/bulk-runs/R1/payment-requests'), null);
});
```

- [ ] **Step 2:** `npm test` → FAIL.

- [ ] **Step 3: Implement** `routes/payment-requests.mjs`:

```js
// routes/payment-requests.mjs — one draft payment request per Brand per month, created in
// Payment Request from a LOCKED run, and their live status read back. See spec 2026-10-13.
import * as realDb from '../db.mjs';
import * as realPr from '../payreq-db.mjs';
import { buildDraft, draftWarnings } from '../payreq.mjs';

const REGION = process.env.MCRM_REGION === 'sg' ? 'sg' : 'th';
const realDeps = () => ({ region: REGION, getBulkRun: realDb.getBulkRun, getContract: realDb.getContract,
  listEntities: realDb.listEntities, ...realPr });
const resp = (statusCode, body) => ({ statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const entityNameFor = (c, entities) => {
  const e = c?.entityId && (entities || []).find((x) => x.entityId === c.entityId);
  return String((e && e.name) || c?.counterParty || '').trim();
};
const bankOf = (c) => ({ name: c?.bankName, number: c?.bankAccountNumber, accountName: c?.bankAccountName });

export async function createPaymentRequestRoute(event, deps = realDeps()) {
  const body = JSON.parse(event.body || '{}');
  const run = await deps.getBulkRun(event.pathParameters?.runId);
  if (!run) return resp(404, { error: 'not_found' });
  if (!run.archived) return resp(409, { error: 'not_locked', message: 'Lock this month before creating payment requests.' });
  const result = (run.results || []).find((r) => r.contractId === body.contractId);
  if (!result) return resp(404, { error: 'not_in_run' });
  if (!(Number(result.payout) > 0)) return resp(409, { error: 'zero_payout', message: `${result.merchantName} has no payout this month.` });
  const period = String(run.periodStart).slice(0, 7);
  if (await deps.getPayReq(period, body.contractId)) return resp(409, { error: 'exists', message: `${result.merchantName} already has a request for ${period}.` });

  const source = { contractId: body.contractId, period, runId: run.runId, brand: result.merchantName };
  const record = async (requestId, status) => {
    await deps.putPayReq(period, { contractId: body.contractId, requestId, region: deps.region, amount: result.payout,
      runId: run.runId, createdBy: event.auth?.email || null, createdAt: new Date().toISOString() });
    return resp(201, { requestId, status });
  };
  try {
    const found = await deps.invokePaymentRequest('findDraft', { contractId: body.contractId, period });
    if (found) return record(found.requestId, 'recovered');

    const [contract, entities] = await Promise.all([deps.getContract(body.contractId), deps.listEntities()]);
    const payTo = entityNameFor(contract, entities) || result.merchantName;
    const draft = buildDraft({ region: deps.region, brand: result.merchantName, payTo, bank: bankOf(contract), payout: result.payout, period });
    const statement = body.statement
      ? { ...(await deps.putStatement(period, body.contractId, Buffer.from(body.statement, 'base64'))), filename: body.filename || `${result.merchantName}.xlsx` }
      : null;
    const { requestId } = await deps.invokePaymentRequest('createDraft',
      { ownerEmail: event.auth?.email, form: draft.form, header: draft.header, lineItems: draft.lineItems, source, statement });
    return record(requestId, 'created');
  } catch (e) {
    if (e.code === 'owner_not_linked' || e.code === 'exists' || e.code === 'wrong_form') return resp(409, { error: e.code, message: e.message });
    if (e.code === 'unreachable') return resp(502, { error: 'unreachable', message: e.message });
    throw e;
  }
}

export async function listPaymentRequestsRoute(event, deps = realDeps()) {
  const run = await deps.getBulkRun(event.pathParameters?.runId);
  if (!run) return resp(404, { error: 'not_found' });
  const period = String(run.periodStart).slice(0, 7);
  const recorded = await deps.listPayReqs(period);
  let statuses = null;
  if (recorded.length) {
    try { statuses = await deps.invokePaymentRequest('statuses', { requestIds: recorded.map((r) => r.requestId) }); }
    catch { statuses = null; }   // unreachable → every row 'unknown', nothing deleted
  }
  const rows = {};
  for (const r of recorded) {
    const s = statuses && statuses[r.requestId];
    if (s && s.missing === true) { await deps.deletePayReq(period, r.contractId); continue; }
    rows[r.contractId] = { requestId: r.requestId, createdBy: r.createdBy, createdAt: r.createdAt, amount: r.amount, status: s || 'unknown' };
  }
  const entities = await deps.listEntities();
  const warnings = {};
  for (const res of run.results || []) {
    if (!(Number(res.payout) > 0) || rows[res.contractId]) continue;
    const c = await deps.getContract(res.contractId);
    warnings[res.contractId] = draftWarnings({ region: deps.region, entityName: entityNameFor(c, entities), bank: bankOf(c) });
  }
  return resp(200, { region: deps.region, rows, warnings });
}
```

Note: `getContract` per payable Brand is one GetItem each (≈300 on TH). If the list route measures > 3 s live, swap to a single `listContracts()` and index by id — check in Task 9.

`auth.mjs` — insert above `if (path.startsWith('/bulk-runs/')) return 'deleteRuns';`:
```js
  if (/^\/bulk-runs\/[^/]+\/payment-requests$/.test(path)) return 'runCalcs';   // GET returned null above
```

`index.mjs` — import and route (above the plain `GET /bulk-runs/<id>` line):
```js
import { createPaymentRequestRoute, listPaymentRequestsRoute } from './routes/payment-requests.mjs';
…
    else if (method === 'POST'   && /^\/bulk-runs\/[^/]+\/payment-requests$/.test(path))      result = await routeBulkRun(event, createPaymentRequestRoute);
    else if (method === 'GET'    && /^\/bulk-runs\/[^/]+\/payment-requests$/.test(path))      result = await routeBulkRun(event, listPaymentRequestsRoute);
```
`routeBulkRun` calls `fn(event)` — the route's default `deps` applies. Check `route-signatures.test.mjs` still passes; extend it if it enumerates routes.

- [ ] **Step 4:** `npm test` → all pass.

### Task 7: Run page — tick, create, status column, unlock warning

**Files:**
- Modify: `frontend/app.js` — `REGIONS` (add `prSite`), `renderBulkRunDetail` (table + selection bar + handlers), the `#br-unarchive` handler (~line 8954); new helpers `payReqCell`, `payReqEligible`, `createPaymentRequests`.
- Modify: `frontend/styles.css` (or wherever `.pay-selbar`-like run styles live — scope under `#br-detail`)
- Modify: `frontend/sw.js` — bump `CACHE_VERSION`
- Test: `lambda/revshare-api/tests/payreq-ui.test.mjs` (extracts `payReqEligible` + `payReqCell` via the `grab` pattern from `run-view.test.mjs`)

**Interfaces:**
- Consumes: Task 6 routes; `statementWorkbook(result, index)`, `runOrderIndex(run)`, `postLarge(path, payload, what)`, `periodMonth`, `escape`, `fmt2`, `can`.
- Produces: `payReqEligible(result, run, pr) → { ok: boolean, reason: string }`; `payReqCell(row, prSite) → html string`.

- [ ] **Step 1: Failing tests**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../../../frontend/app.js', import.meta.url), 'utf8');
const grab = (n) => { const i = src.indexOf(`function ${n}(`); if (i < 0) throw new Error('missing ' + n);
  let d = 0; for (let k = src.indexOf('{', i); k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); } } };
const { payReqEligible, payReqCell } = new Function(
  'const escape = s => String(s ?? "");\n' + grab('payReqEligible') + '\n' + grab('payReqCell') + '\nreturn { payReqEligible, payReqCell };')();

const run = { archived: true };
test('eligibility', () => {
  assert.deepEqual(payReqEligible({ payout: 10, contractId: 'C' }, run, { rows: {} }), { ok: true, reason: '' });
  assert.equal(payReqEligible({ payout: 0, contractId: 'C' }, run, { rows: {} }).ok, false);
  assert.equal(payReqEligible({ payout: 10, contractId: 'C' }, { archived: false }, { rows: {} }).reason, 'Lock this month first');
  assert.equal(payReqEligible({ payout: 10, contractId: 'C' }, run, { rows: { C: {} } }).reason, 'Already requested');
});
test('cell links to the request in Payment Request and shows the live label', () => {
  const h = payReqCell({ requestId: 'abc', status: { label: 'Paid 2026-10-25', docNumber: 'PV-2026-0300' } }, 'https://pr.example');
  assert.match(h, /href="https:\/\/pr\.example\/#request\/abc"/);
  assert.match(h, /Paid 2026-10-25/); assert.match(h, /PV-2026-0300/);
  assert.match(payReqCell({ requestId: 'x', status: 'unknown' }, 'https://p'), /status unavailable/);
  assert.equal(payReqCell(null, 'https://p'), '<span class="muted">—</span>');
});
```

- [ ] **Step 2:** `npm test` → FAIL.

- [ ] **Step 3: Implement**

`REGIONS` — add to each entry:
```js
  th: { …, prSite: 'https://d3emsfshb1fwfl.cloudfront.net' },
  sg: { …, prSite: 'https://d2v9auketxzjkb.cloudfront.net' },
```

Helpers (place just above `renderBulkRunDetail`):
```js
// Payment requests (2026-10-13): a draft per Brand per month in Payment Request, from a locked
// run only. Payment Request owns the status wording; this only shows it.
function payReqEligible(result, run, pr) {
  if (!run.archived) return { ok: false, reason: 'Lock this month first' };
  if (!(Number(result.payout) > 0)) return { ok: false, reason: 'No payout this month' };
  if (pr.rows && pr.rows[result.contractId]) return { ok: false, reason: 'Already requested' };
  return { ok: true, reason: '' };
}
function payReqCell(row, prSite) {
  if (!row) return '<span class="muted">—</span>';
  const label = row.status === 'unknown' ? 'Requested · status unavailable' : (row.status.label || row.status.status || '');
  const doc = row.status && row.status.docNumber ? ` · ${escape(row.status.docNumber)}` : '';
  const who = row.createdBy ? `Created by ${escape(row.createdBy)} on ${escape(String(row.createdAt || '').slice(0, 10))}` : '';
  return `<a href="${prSite}/#request/${escape(row.requestId)}" target="_blank" rel="noopener" title="${who}">${escape(label)}${doc}</a>`;
}
```

In `renderBulkRunDetail`, after `const run = await api(...)`:
```js
  const pr = await api('/bulk-runs/' + runId + '/payment-requests').catch(() => ({ rows: {}, warnings: {} }));
```

`runRowsByEntity` row: add a leading tick cell and a trailing status cell (and bump every `colspan="7"` in that function and the `<tfoot>` to 9):
```js
        <td>${(() => { const e = payReqEligible(r, run, pr);
          return can('runCalcs') && e.ok
            ? `<input type="checkbox" class="pr-tick" data-cid="${escape(r.contractId)}" data-payout="${r.payout}"
                 title="${escape((pr.warnings[r.contractId] || []).join(' · '))}">`
            : `<input type="checkbox" disabled title="${escape(e.reason)}">`; })()}</td>
        …existing cells…
        <td>${payReqCell(pr.rows[r.contractId], R().prSite)}</td>
```
Header row: prepend `<th></th>`, append `<th>Payment request</th>`.

Above the table (only when `isArchived && can('runCalcs')`):
```html
<div class="pr-selbar" id="pr-selbar">
  <span id="pr-count">0 Brands selected</span>
  <button id="pr-create" class="btn" disabled>Create payment requests</button>
  <span class="muted" id="pr-summary"></span>
</div>
```
`pr-summary` = counts over `pr.rows` grouped by label prefix (Draft / Submitted / Approved / Paid), e.g. `12 requested · 3 paid · 8 in approval · 1 draft`.

Handler:
```js
async function createPaymentRequests(run, picked, index) {
  // One Brand per call, in order. Stop at the first failure and say how far it got; pressing
  // again resumes, because recorded Brands are no longer tickable.
  let done = 0;
  for (const cid of picked) {
    const result = run.results.find((r) => r.contractId === cid);
    const bytes = statementWorkbook(result, index);
    const b64 = btoa(Array.from(new Uint8Array(bytes), (c) => String.fromCharCode(c)).join(''));
    try {
      await postLarge(`/bulk-runs/${run.runId}/payment-requests`,
        { contractId: cid, statement: b64, filename: `${result.merchantName} ${periodMonth(run.periodStart)}.xlsx` }, 'statement');
      done++;
    } catch (e) {
      const owner = /owner_not_linked/.test(e.message);
      throw new Error(owner
        ? 'Your account is not linked to an employee in Payment Request — ask its admin to link it. Nothing was created.'
        : `Created ${done} of ${picked.length}; stopped at ${result.merchantName}: ${e.message}`);
    }
  }
  return done;
}
```
`postLarge` must return the parsed JSON and surface `HTTP 409: {"error":"owner_not_linked",…}` in `e.message` — check its error path and adjust the regex if it formats differently. `statementWorkbook` returns what `XLSX.write` gives — confirm whether that's an `ArrayBuffer` or `Uint8Array` and convert accordingly; for multi-MB files chunk `String.fromCharCode` (8 KB slices) to avoid call-stack limits.

Click on `#pr-create`: collect ticked ids; build the confirm text — `Create N draft payment requests for <period>, total <fmt2 sum>, owned by you?` followed by every warning line per Brand — `confirm()`; `const index = await runOrderIndex(run)`; call `createPaymentRequests`; on success or failure show the message in the page's existing status/error style, then `renderBulkRunDetail(runId)`.

Unlock handler (`#br-unarchive`): before its existing confirm, if `Object.keys(pr.rows).length`, prepend: `N Brands already have payment requests for this month (names…). Unlocking does not touch them.`

`sw.js`: bump `CACHE_VERSION`.

- [ ] **Step 4:** `npm test` → all pass. Re-read the run table markup: one header row, tick column narrow, status column right-aligned with the others, no double borders against `.ts` (CLAUDE.md "professional and tidy").

---

## Part C — Wire up and ship

### Task 8: IAM, env

- [ ] **Step 1: Let MCRM invoke Payment Request** (resource policy on each Payment Request function):
```bash
AWS_DEFAULT_OUTPUT=json aws lambda add-permission --region ap-southeast-7 --function-name csth-api \
  --statement-id mcrm-invoke --action lambda:InvokeFunction \
  --principal arn:aws:iam::812751451548:role/revshare-api-role
AWS_DEFAULT_OUTPUT=json aws lambda add-permission --region ap-southeast-7 --function-name cssg-api \
  --statement-id mcrm-invoke --action lambda:InvokeFunction \
  --principal arn:aws:iam::812751451548:role/revshare-api-sg-role
```
- [ ] **Step 2: MCRM roles may invoke exactly that function** (inline policy `payment-request-invoke`):
```bash
AWS_DEFAULT_OUTPUT=json aws iam put-role-policy --role-name revshare-api-role --policy-name payment-request-invoke \
  --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"lambda:InvokeFunction","Resource":"arn:aws:lambda:ap-southeast-7:812751451548:function:csth-api"}]}'
AWS_DEFAULT_OUTPUT=json aws iam put-role-policy --role-name revshare-api-sg-role --policy-name payment-request-invoke \
  --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"lambda:InvokeFunction","Resource":"arn:aws:lambda:ap-southeast-7:812751451548:function:cssg-api"}]}'
```
Also record both in `infra/role-policy.json` (MCRM) so it is not lost.
- [ ] **Step 3: Payment Request roles may read MCRM statements** (inline policy `mcrm-statements-read`):
```bash
AWS_DEFAULT_OUTPUT=json aws iam put-role-policy --role-name csth-api-role --policy-name mcrm-statements-read \
  --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"s3:GetObject","Resource":"arn:aws:s3:::revshare-runs-812751451548-sea7/payreq/*"}]}'
AWS_DEFAULT_OUTPUT=json aws iam put-role-policy --role-name cssg-api-role --policy-name mcrm-statements-read \
  --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"s3:GetObject","Resource":"arn:aws:s3:::revshare-runs-sg-812751451548-sea7/payreq/*"}]}'
```
- [ ] **Step 4: MCRM env** — `get-function-configuration` first, then `update-function-configuration` with the FULL existing map plus `PAYMENT_REQUEST_FUNCTION` (`csth-api` / `cssg-api`) and `MCRM_REGION` (`th` / `sg`). Never pass a partial map — it replaces all variables. Check `infra/deploy-lambda.sh` in both repos does not overwrite env on deploy; if it does, add the two keys there.

### Task 9: Deploy and live check

- [ ] **Step 1: Payment Request first.** In `~/CSTH_payment`: `git status --short` (name anything else that would ship — `.claude/` is untracked and not deployed), `npm test`, then deploy the Lambda to both stacks (`infra/deploy-lambda.sh` for TH per README; `infra/deploy-cssg.sh lambda` for SG). Lambda only — no frontend change there.
- [ ] **Step 2: MCRM.** In the worktree: `git status --short`, `npm test`, `infra/deploy-lambda-all.sh` (syncs to SG, preflights db exports, health-checks both), then `infra/deploy-frontend.sh`. Check `/healthz` in both regions.
- [ ] **Step 3: Live, TH.** Pick the smallest-payout Brand on a locked TH run (or lock one with Ozzie's OK). Create its request; open it in Payment Request: PV, Pay to, bank, one line at tax base + VAT 7% totalling the payout, statement attached and downloadable. MCRM shows `Draft`. Time the GET list route (Review Focus/Task 6 note). Delete the draft in Payment Request → reload MCRM → row back to `—`, Brand tickable.
- [ ] **Step 4: Live, SG.** Same on a locked SG run → PES with the subject/competence no., `Draft`, delete, freed.
- [ ] **Step 5:** Update both repos' CLAUDE.md handoff (new section in each: what it does, the invoke contract, IAM, env, where status wording lives). Report to Ozzie what was deployed, what was verified live, and that the rendered run page needs his eyes. No commit until "save progress".

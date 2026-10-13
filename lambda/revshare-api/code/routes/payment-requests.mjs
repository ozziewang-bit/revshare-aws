// routes/payment-requests.mjs — one draft payment request per Brand per month, created in
// Payment Request from a LOCKED run, and their live status read back (spec 2026-10-13).
//
// MCRM never submits, approves or pays: it creates a DRAFT owned by the person who clicked,
// who checks it in Payment Request and submits it through the normal approval chain.
import * as realDb from '../db.mjs';
import * as realPr from '../payreq-db.mjs';
import { buildDraft, draftWarnings } from '../payreq.mjs';

const REGION = process.env.MCRM_REGION === 'sg' ? 'sg' : 'th';
const realDeps = () => ({ region: REGION, getBulkRun: realDb.getBulkRun, listContracts: realDb.listContracts,
  listEntities: realDb.listEntities, ...realPr });
const resp = (statusCode, body) => ({ statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// Same rule as the frontend's entityNameOf: a linked contract reads its ENTITY record, an
// unlinked one its own counterParty string.
const entityNameFor = (c, entities) => {
  const e = c?.entityId && (entities || []).find((x) => x.entityId === c.entityId);
  return String((e && e.name) || c?.counterParty || '').trim();
};
const bankOf = (c) => ({ name: c?.bankName, number: c?.bankAccountNumber, accountName: c?.bankAccountName });
const periodOf = (run) => String(run.periodStart || '').slice(0, 7);

export async function createPaymentRequestRoute(event, deps = realDeps()) {
  const body = JSON.parse(event.body || '{}');
  const run = await deps.getBulkRun(event.pathParameters?.runId);
  if (!run) return resp(404, { error: 'not_found' });
  // Only a locked month: it cannot be recomputed or deleted, so a request's amount can never
  // drift away from the run it came from.
  if (!run.archived) return resp(409, { error: 'not_locked', message: 'Lock this month before creating payment requests.' });
  const result = (run.results || []).find((r) => r.contractId === body.contractId);
  if (!result) return resp(404, { error: 'not_in_run' });
  if (!(Number(result.payout) > 0)) return resp(409, { error: 'zero_payout', message: `${result.merchantName} has no payout this month.` });
  const period = periodOf(run);
  if (await deps.getPayReq(period, body.contractId)) {
    return resp(409, { error: 'exists', message: `${result.merchantName} already has a payment request for ${period}.` });
  }

  const source = { contractId: body.contractId, period, runId: run.runId, brand: result.merchantName };
  const record = async (requestId, status) => {
    await deps.putPayReq(period, { contractId: body.contractId, requestId, region: deps.region, amount: result.payout,
      runId: run.runId, createdBy: event.auth?.email || null, createdAt: new Date().toISOString() });
    return resp(201, { requestId, status });
  };
  try {
    // A request Payment Request already holds for this Brand + month — created, but never
    // recorded here because something failed in between — is adopted, never duplicated.
    const found = await deps.invokePaymentRequest('findDraft', { contractId: body.contractId, period });
    if (found) return await record(found.requestId, 'recovered');

    const [contracts, entities] = await Promise.all([deps.listContracts(), deps.listEntities()]);
    const contract = (contracts || []).find((c) => c.contractId === body.contractId);
    const payTo = entityNameFor(contract, entities) || result.merchantName;
    const draft = buildDraft({ region: deps.region, brand: result.merchantName, payTo, bank: bankOf(contract),
      payout: result.payout, period });
    const statement = body.statement
      ? { ...(await deps.putStatement(period, body.contractId, Buffer.from(body.statement, 'base64'))),
          filename: body.filename || `${result.merchantName}.xlsx` }
      : null;
    const { requestId } = await deps.invokePaymentRequest('createDraft',
      { ownerEmail: event.auth?.email, form: draft.form, header: draft.header, lineItems: draft.lineItems, source, statement });
    return await record(requestId, 'created');
  } catch (e) {
    if (['owner_not_linked', 'exists', 'wrong_form'].includes(e.code)) return resp(409, { error: e.code, message: e.message });
    if (e.code === 'unreachable') return resp(502, { error: 'unreachable', message: e.message });
    throw e;
  }
}

export async function listPaymentRequestsRoute(event, deps = realDeps()) {
  const run = await deps.getBulkRun(event.pathParameters?.runId);
  if (!run) return resp(404, { error: 'not_found' });
  const period = periodOf(run);
  const recorded = await deps.listPayReqs(period);
  let statuses = null;
  if (recorded.length) {
    // Unreachable → every row reads 'unknown' and NOTHING is freed: the table must not blank,
    // and a Brand must not become requestable again just because the other app was down.
    try { statuses = await deps.invokePaymentRequest('statuses', { requestIds: recorded.map((r) => r.requestId) }); }
    catch { statuses = null; }
  }
  const rows = {};
  for (const r of recorded) {
    const s = statuses && statuses[r.requestId];
    // Only an explicit `missing` frees the Brand — the draft was deleted in Payment Request.
    if (s && s.missing === true) { await deps.deletePayReq(period, r.contractId); continue; }
    rows[r.contractId] = { requestId: r.requestId, createdBy: r.createdBy || null, createdAt: r.createdAt || null,
      amount: r.amount ?? null, status: s || 'unknown' };
  }
  const payable = (run.results || []).filter((res) => Number(res.payout) > 0 && !rows[res.contractId]);
  const warnings = {};
  if (payable.length) {
    const [contracts, entities] = await Promise.all([deps.listContracts(), deps.listEntities()]);
    const byId = new Map((contracts || []).map((c) => [c.contractId, c]));
    for (const res of payable) {
      const c = byId.get(res.contractId);
      warnings[res.contractId] = draftWarnings({ region: deps.region, entityName: entityNameFor(c, entities), bank: bankOf(c) });
    }
  }
  return resp(200, { region: deps.region, rows, warnings });
}

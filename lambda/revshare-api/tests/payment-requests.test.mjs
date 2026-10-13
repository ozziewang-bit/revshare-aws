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
    listContracts: async () => [{ contractId: 'C1', merchantName: 'AOT', entityId: 'E1', bankName: 'ธนาคารกรุงไทย', bankAccountNumber: '1', bankAccountName: 'A' }],
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
      return null;
    },
    ...over,
  };
}
const ev = (body) => ({ pathParameters: { runId: 'R1' }, auth: { email: 'ozzie.wang@inforich.com' }, body: JSON.stringify(body) });
const B = { contractId: 'C1', statement: Buffer.from('x').toString('base64'), filename: 'AOT.xlsx' };
const json = (r) => JSON.parse(r.body);

test('creates a PV draft for a locked run and records it', async () => {
  const d = deps();
  const r = await createPaymentRequestRoute(ev(B), d);
  assert.equal(r.statusCode, 201);
  const [, p] = d.calls.find(([a]) => a === 'createDraft');
  assert.equal(p.form, 'PV');
  assert.equal(p.ownerEmail, 'ozzie.wang@inforich.com');
  assert.equal(p.header.payTo, 'Airports of Thailand');
  assert.equal(p.header.payBank, 'Krung Thai Bank');
  assert.deepEqual(p.source, { contractId: 'C1', period: '2026-09', runId: 'R1', brand: 'AOT' });
  assert.deepEqual(p.statement, { bucket: 'b', key: 'payreq/2026-09/C1.xlsx', filename: 'AOT.xlsx' });
  assert.equal(d.rows.get('C1').requestId, 'PR1');
  assert.equal(d.rows.get('C1').createdBy, 'ozzie.wang@inforich.com');
});
test('Pay to falls back to the Brand name when no entity is linked', async () => {
  const d = deps({ listContracts: async () => [{ contractId: 'C1', merchantName: 'AOT' }] });
  await createPaymentRequestRoute(ev(B), d);
  assert.equal(d.calls.find(([a]) => a === 'createDraft')[1].header.payTo, 'AOT');
});
test('refuses an unlocked run', async () => {
  const r = await createPaymentRequestRoute(ev(B), deps({ getBulkRun: async () => ({ ...RUN, archived: false }) }));
  assert.equal(r.statusCode, 409); assert.equal(json(r).error, 'not_locked');
});
test('refuses a zero payout and a Brand not in the run', async () => {
  assert.equal(json(await createPaymentRequestRoute(ev({ ...B, contractId: 'C0' }), deps())).error, 'zero_payout');
  assert.equal((await createPaymentRequestRoute(ev({ ...B, contractId: 'NOPE' }), deps())).statusCode, 404);
});
test('refuses when this Brand + month is already recorded', async () => {
  const d = deps(); d.rows.set('C1', { contractId: 'C1', requestId: 'OLD' });
  assert.equal(json(await createPaymentRequestRoute(ev(B), d)).error, 'exists');
  assert.equal(d.calls.length, 0);
});
test('recovers a request Payment Request already has instead of creating a second', async () => {
  const d = deps({ invokePaymentRequest: async (a) => (a === 'findDraft' ? { requestId: 'PR9' } : assert.fail('must not create')) });
  const r = await createPaymentRequestRoute(ev(B), d);
  assert.equal(json(r).status, 'recovered');
  assert.equal(d.rows.get('C1').requestId, 'PR9');
});
test('owner_not_linked comes back as a 409 with that code and nothing is recorded', async () => {
  const d = deps({ invokePaymentRequest: async (a) => { if (a === 'findDraft') return null;
    throw Object.assign(new Error('Your account is not linked'), { code: 'owner_not_linked' }); } });
  const r = await createPaymentRequestRoute(ev(B), d);
  assert.equal(r.statusCode, 409); assert.equal(json(r).error, 'owner_not_linked');
  assert.equal(d.rows.size, 0);
});
test('unreachable Payment Request is a 502, nothing recorded', async () => {
  const d = deps({ invokePaymentRequest: async () => { throw Object.assign(new Error('down'), { code: 'unreachable' }); } });
  const r = await createPaymentRequestRoute(ev(B), d);
  assert.equal(r.statusCode, 502); assert.equal(d.rows.size, 0);
});
test('list joins live status and frees only explicitly missing requests', async () => {
  const d = deps({ invokePaymentRequest: async () => ({ PR1: { label: 'Draft' }, PR2: { missing: true } }) });
  d.rows.set('C1', { contractId: 'C1', requestId: 'PR1' });
  d.rows.set('C2', { contractId: 'C2', requestId: 'PR2' });
  d.rows.set('C3', { contractId: 'C3', requestId: 'PR3' });   // left out of the reply
  const body = json(await listPaymentRequestsRoute(ev({}), d));
  assert.equal(body.rows.C1.status.label, 'Draft');
  assert.equal(body.rows.C2, undefined); assert.equal(d.rows.has('C2'), false);
  assert.equal(body.rows.C3.status, 'unknown'); assert.equal(d.rows.has('C3'), true);
});
test('list survives Payment Request being unreachable', async () => {
  const d = deps({ invokePaymentRequest: async () => { throw Object.assign(new Error('down'), { code: 'unreachable' }); } });
  d.rows.set('C1', { contractId: 'C1', requestId: 'PR1' });
  const body = json(await listPaymentRequestsRoute(ev({}), d));
  assert.equal(body.rows.C1.status, 'unknown'); assert.equal(d.rows.has('C1'), true);
});
test('list carries per-Brand warnings for payable Brands only', async () => {
  const d = deps({ listContracts: async () => [{ contractId: 'C1', merchantName: 'AOT' }], listEntities: async () => [] });
  const body = json(await listPaymentRequestsRoute(ev({}), d));
  assert.deepEqual(body.warnings.C1, ['No contract entity — Pay to uses the Brand name', 'No bank on file']);
  assert.equal(body.warnings.C0, undefined);
  assert.equal(body.region, 'th');
});

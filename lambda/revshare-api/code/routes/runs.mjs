import { getPartner, putRun, listRuns, getRun, ulid } from '../db.mjs';
import { parseCsv } from '../csv.mjs';
import { evaluateRun } from '../engine.mjs';

export async function createRunRoute(event) {
  const id = event.pathParameters?.partnerId;
  const partner = await getPartner(id);
  if (!partner) return resp(404, { error: 'partner_not_found' });

  const body = JSON.parse(event.body || '{}');
  const { periodStart, periodEnd, csvBase64 } = body;
  if (!periodStart || !periodEnd || !csvBase64) {
    return resp(400, { error: 'missing_fields' });
  }

  const csvText = Buffer.from(csvBase64, 'base64').toString('utf-8');
  let parsed;
  try { parsed = parseCsv(csvText); }
  catch (e) { return resp(400, { error: 'csv_parse', message: e.message }); }

  let result;
  try {
    result = evaluateRun({
      rule: partner.rule,
      rows: parsed,
      aggregationMode: partner.aggregationMode
    });
  } catch (e) {
    return resp(400, { error: 'eval', message: e.message });
  }

  const run = {
    runId: ulid(),
    partnerId: id,
    periodStart, periodEnd,
    uploadedAt: new Date().toISOString(),
    csvRaw: csvBase64,
    csvParsed: parsed,
    ruleSnapshot: partner.rule,
    result
  };
  await putRun(run);
  return resp(201, run);
}

export async function listRunsRoute(event) {
  const id = event.pathParameters?.partnerId;
  const items = await listRuns(id);
  return resp(200, items);
}

export async function getRunRoute(event) {
  const partnerId = event.pathParameters?.partnerId;
  const runId = event.pathParameters?.runId;
  const item = await getRun(partnerId, runId);
  if (!item) return resp(404, { error: 'not_found' });
  return resp(200, item);
}

export async function rerunRoute(event) {
  const partnerId = event.pathParameters?.partnerId;
  const runId = event.pathParameters?.runId;
  const prev = await getRun(partnerId, runId);
  if (!prev) return resp(404, { error: 'not_found' });
  const partner = await getPartner(partnerId);
  if (!partner) return resp(404, { error: 'partner_not_found' });

  const csvText = Buffer.from(prev.csvRaw, 'base64').toString('utf-8');
  const parsed = parseCsv(csvText);
  const result = evaluateRun({
    rule: partner.rule,
    rows: parsed,
    aggregationMode: partner.aggregationMode
  });
  const run = {
    runId: ulid(),
    partnerId,
    periodStart: prev.periodStart, periodEnd: prev.periodEnd,
    uploadedAt: new Date().toISOString(),
    csvRaw: prev.csvRaw,
    csvParsed: parsed,
    ruleSnapshot: partner.rule,
    result,
    rerunOf: runId
  };
  await putRun(run);
  return resp(201, run);
}

function resp(statusCode, body) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  };
}

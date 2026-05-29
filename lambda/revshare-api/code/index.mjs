import {
  listPartnersRoute, createPartnerRoute,
  getPartnerRoute, updatePartnerRoute, archivePartnerRoute
} from './routes/partners.mjs';
import {
  createRunRoute, listRunsRoute, getRunRoute, rerunRoute
} from './routes/runs.mjs';
import {
  listMerchantsRoute, createMerchantRoute, getMerchantRoute,
  updateMerchantRoute, deleteMerchantRoute
} from './routes/merchants.mjs';
import { importRevShareRoute } from './routes/import.mjs';
import { createBulkRunRoute, listBulkRunsRoute, getBulkRunRoute } from './routes/bulk-runs.mjs';

export const handler = async (event) => {
  try {
    const method = event.requestContext?.http?.method ?? event.httpMethod;
    const path = event.requestContext?.http?.path ?? event.rawPath ?? event.path ?? '';

    if (method === 'OPTIONS') return {
      statusCode: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
        'access-control-allow-headers': 'content-type,x-app-password',
      },
      body: ''
    };

    if (method === 'GET' && path === '/healthz') return ok({ ok: true });

    let result;
    // Partners
    if      (method === 'GET'    && path === '/partners')                                        result = await listPartnersRoute();
    else if (method === 'POST'   && path === '/partners')                                        result = await createPartnerRoute(event);
    else if (method === 'GET'    && /^\/partners\/[^/]+$/.test(path))                           result = await routePartner(event, getPartnerRoute);
    else if (method === 'PUT'    && /^\/partners\/[^/]+$/.test(path))                           result = await routePartner(event, updatePartnerRoute);
    else if (method === 'DELETE' && /^\/partners\/[^/]+$/.test(path))                           result = await routePartner(event, archivePartnerRoute);
    // Runs
    else if (method === 'POST'   && /^\/partners\/[^/]+\/runs$/.test(path))                     result = await routePartner(event, createRunRoute);
    else if (method === 'GET'    && /^\/partners\/[^/]+\/runs$/.test(path))                     result = await routePartner(event, listRunsRoute);
    else if (method === 'GET'    && /^\/partners\/[^/]+\/runs\/[^/]+$/.test(path))              result = await routePartnerRun(event, getRunRoute);
    else if (method === 'POST'   && /^\/partners\/[^/]+\/runs\/[^/]+\/rerun$/.test(path))       result = await routePartnerRun(event, rerunRoute);
    // Merchants
    else if (method === 'GET'    && path === '/merchants')                                       result = await listMerchantsRoute();
    else if (method === 'POST'   && path === '/merchants')                                       result = await createMerchantRoute(event);
    else if (method === 'GET'    && /^\/merchants\/[^/]+$/.test(path))                          result = await routeMerchant(event, getMerchantRoute);
    else if (method === 'PUT'    && /^\/merchants\/[^/]+$/.test(path))                          result = await routeMerchant(event, updateMerchantRoute);
    else if (method === 'DELETE' && /^\/merchants\/[^/]+$/.test(path))                          result = await routeMerchant(event, deleteMerchantRoute);
    // Import
    else if (method === 'POST'   && path === '/import/rev-share')                               result = await importRevShareRoute(event);
    // Bulk runs
    else if (method === 'POST'   && path === '/bulk-runs')                                      result = await createBulkRunRoute(event);
    else if (method === 'GET'    && path === '/bulk-runs')                                      result = await listBulkRunsRoute();
    else if (method === 'GET'    && /^\/bulk-runs\/[^/]+$/.test(path))                         result = await routeBulkRun(event, getBulkRunRoute);
    else result = resp(404, { error: 'not_found', path, method });

    return cors(result);
  } catch (e) {
    console.error('handler exception', e);
    return cors(resp(500, { error: 'internal', message: e.message }));
  }
};

function cors(r) {
  return { ...r, headers: { ...r.headers, 'access-control-allow-origin': '*' } };
}

async function routePartner(event, fn) {
  const path = event.requestContext?.http?.path ?? event.rawPath ?? event.path ?? '';
  const m = path.match(/\/partners\/([^/]+)/);
  event.pathParameters = { ...(event.pathParameters || {}), partnerId: m?.[1] };
  return fn(event);
}

async function routePartnerRun(event, fn) {
  const path = event.requestContext?.http?.path ?? event.rawPath ?? event.path ?? '';
  const m = path.match(/\/partners\/([^/]+)\/runs\/([^/]+)/);
  event.pathParameters = { partnerId: m?.[1], runId: m?.[2] };
  return fn(event);
}

async function routeMerchant(event, fn) {
  const path = event.requestContext?.http?.path ?? event.rawPath ?? event.path ?? '';
  const m = path.match(/\/merchants\/([^/]+)/);
  event.pathParameters = { ...(event.pathParameters || {}), merchantId: m?.[1] };
  return fn(event);
}

async function routeBulkRun(event, fn) {
  const path = event.requestContext?.http?.path ?? event.rawPath ?? event.path ?? '';
  const m = path.match(/\/bulk-runs\/([^/]+)/);
  event.pathParameters = { runId: m?.[1] };
  return fn(event);
}

function ok(b) { return resp(200, b); }
function resp(statusCode, body) {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

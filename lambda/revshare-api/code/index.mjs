import { verifyGoogleToken, resolvePermissions, requiredPermission } from './auth.mjs';
import { getUser } from './users-db.mjs';
import { meRoute } from './routes/me.mjs';
import { listUsersRoute, putUserRoute, deleteUserRoute } from './routes/users.mjs';
import { listFeatureRequestsRoute, createFeatureRequestRoute, updateFeatureRequestRoute, deleteFeatureRequestRoute } from './routes/features.mjs';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const ALLOWED_DOMAINS = (process.env.ALLOWED_DOMAINS || '').split(',').map(s => s.trim()).filter(Boolean);
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim()).filter(Boolean);

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
import {
  listContractsRoute, createContractRoute, updateContractRoute, deleteContractRoute,
  importContractsRoute,
} from './routes/contracts.mjs';
import { importRevShareRoute } from './routes/import.mjs';
import { createBulkRunRoute, listBulkRunsRoute, getBulkRunRoute, deleteBulkRunRoute, prepareBulkRunRoute, archiveBulkRunRoute, unarchiveBulkRunRoute, recomputeBulkRunRoute, getBulkRunInputsRoute } from './routes/bulk-runs.mjs';
import {
  listMachineModelsRoute, createMachineModelRoute,
  updateMachineModelRoute, deleteMachineModelRoute
} from './routes/machine-models.mjs';

export const handler = async (event) => {
  try {
    const method = event.requestContext?.http?.method ?? event.httpMethod;
    const path = event.requestContext?.http?.path ?? event.rawPath ?? event.path ?? '';

    if (method === 'OPTIONS') return {
      statusCode: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
        'access-control-allow-headers': 'content-type,authorization',
      },
      body: ''
    };

    if (method === 'GET' && path === '/healthz') return ok({ ok: true });

    // ── Auth gate (everything except OPTIONS + /healthz) ──
    const authz = event.headers?.authorization || event.headers?.Authorization || '';
    const token = authz.replace(/^Bearer\s+/i, '');
    let claims;
    try {
      claims = await verifyGoogleToken(token, { clientId: GOOGLE_CLIENT_ID, allowedDomains: ALLOWED_DOMAINS });
    } catch (e) {
      return cors(resp(401, { error: 'unauthenticated', reason: e.message }));
    }
    const userRow = await getUser(claims.email.toLowerCase());
    const permissions = resolvePermissions(claims.email, userRow, ADMIN_EMAILS);
    const need = requiredPermission(method, path);
    if (need && !permissions[need]) return cors(resp(403, { error: 'forbidden', need }));
    event.auth = { email: claims.email.toLowerCase(), name: claims.name, permissions };

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
    // Contracts
    else if (method === 'GET'    && path === '/contracts')                                     result = await listContractsRoute();
    else if (method === 'POST'   && path === '/contracts')                                     result = await createContractRoute(event);
    else if (method === 'POST'   && path === '/contracts/import')                              result = await importContractsRoute(event);
    else if (method === 'PUT'    && /^\/contracts\/[^/]+$/.test(path))                        result = await routeContract(event, updateContractRoute);
    else if (method === 'DELETE' && /^\/contracts\/[^/]+$/.test(path))                        result = await routeContract(event, deleteContractRoute);
    // Import
    else if (method === 'POST'   && path === '/import/rev-share')                               result = await importRevShareRoute(event);
    // Bulk runs
    else if (method === 'GET'    && path === '/feature-requests')                                result = await listFeatureRequestsRoute();
    else if (method === 'POST'   && path === '/feature-requests')                                result = await createFeatureRequestRoute(event);
    else if (method === 'PUT'    && /^\/feature-requests\/[^/]+$/.test(path))                    result = await updateFeatureRequestRoute(event, path.split('/')[2]);
    else if (method === 'DELETE' && /^\/feature-requests\/[^/]+$/.test(path))                    result = await deleteFeatureRequestRoute(path.split('/')[2]);
    else if (method === 'POST'   && path === '/bulk-runs/prepare')                              result = await prepareBulkRunRoute(event);
    else if (method === 'POST'   && path === '/bulk-runs')                                      result = await createBulkRunRoute(event);
    else if (method === 'GET'    && path === '/bulk-runs')                                      result = await listBulkRunsRoute();
    else if (method === 'POST'   && /^\/bulk-runs\/[^/]+\/archive$/.test(path))                result = await routeBulkRun(event, archiveBulkRunRoute);
    else if (method === 'POST'   && /^\/bulk-runs\/[^/]+\/unarchive$/.test(path))              result = await routeBulkRun(event, unarchiveBulkRunRoute);
    else if (method === 'POST'   && /^\/bulk-runs\/[^/]+\/recompute$/.test(path))              result = await routeBulkRun(event, recomputeBulkRunRoute);
    else if (method === 'GET'    && /^\/bulk-runs\/[^/]+\/inputs$/.test(path))                 result = await routeBulkRun(event, getBulkRunInputsRoute);
    else if (method === 'GET'    && /^\/bulk-runs\/[^/]+$/.test(path))                         result = await routeBulkRun(event, getBulkRunRoute);
    else if (method === 'DELETE' && /^\/bulk-runs\/[^/]+$/.test(path))                         result = await routeBulkRun(event, deleteBulkRunRoute);
    // Machine models
    else if (method === 'GET'    && path === '/machine-models')                         result = await listMachineModelsRoute();
    else if (method === 'POST'   && path === '/machine-models')                         result = await createMachineModelRoute(event);
    else if (method === 'PUT'    && /^\/machine-models\/[^/]+$/.test(path))             result = await routeMachineModel(event, updateMachineModelRoute);
    else if (method === 'DELETE' && /^\/machine-models\/[^/]+$/.test(path))             result = await routeMachineModel(event, deleteMachineModelRoute);
    // Me + Users
    else if (method === 'GET'    && path === '/me')                                    result = await meRoute(event);
    else if (method === 'GET'    && path === '/users')                                 result = await listUsersRoute(event);
    else if (method === 'PUT'    && /^\/users\/[^/]+$/.test(path))                      result = await routeUser(event, putUserRoute);
    else if (method === 'DELETE' && /^\/users\/[^/]+$/.test(path))                     result = await routeUser(event, deleteUserRoute);
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

function routeContract(event, handler) {
  const path = event.requestContext?.http?.path ?? event.rawPath ?? event.path ?? '';
  const m = path.match(/\/contracts\/([^/]+)/);
  return handler({ ...event, pathParameters: { contractId: m ? m[1] : null } });
}

async function routeBulkRun(event, fn) {
  const path = event.requestContext?.http?.path ?? event.rawPath ?? event.path ?? '';
  const m = path.match(/\/bulk-runs\/([^/]+)/);
  event.pathParameters = { runId: m?.[1] };
  return fn(event);
}

async function routeMachineModel(event, fn) {
  const path = event.requestContext?.http?.path ?? event.rawPath ?? event.path ?? '';
  const m = path.match(/\/machine-models\/([^/]+)/);
  event.pathParameters = { ...(event.pathParameters || {}), code: m?.[1] };
  return fn(event);
}

async function routeUser(event, fn) {
  const path = event.requestContext?.http?.path ?? event.rawPath ?? event.path ?? '';
  const m = path.match(/\/users\/([^/]+)/);
  event.pathParameters = { ...(event.pathParameters || {}), email: decodeURIComponent(m?.[1] || '') };
  return fn(event);
}

function ok(b) { return resp(200, b); }
function resp(statusCode, body) {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

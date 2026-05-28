import { verifyPassword } from './auth.mjs';
import { recordAuthFail, countAuthFailsLastMinute } from './db.mjs';
import { handleLogin } from './routes/login.mjs';
import {
  listPartnersRoute, createPartnerRoute,
  getPartnerRoute, updatePartnerRoute, archivePartnerRoute
} from './routes/partners.mjs';
import {
  createRunRoute, listRunsRoute, getRunRoute, rerunRoute
} from './routes/runs.mjs';

export const handler = async (event) => {
  try {
    const method = event.requestContext?.http?.method;
    const path = event.requestContext?.http?.path || event.rawPath || '';

    if (method === 'GET' && path === '/healthz') return ok({ ok: true });
    if (method === 'POST' && path === '/login') return await handleLogin(event);

    const authResult = await checkAuth(event);
    if (authResult) return authResult;

    if (method === 'GET'    && path === '/partners')                                         return await listPartnersRoute();
    if (method === 'POST'   && path === '/partners')                                         return await createPartnerRoute(event);
    if (method === 'GET'    && /^\/partners\/[^/]+$/.test(path))                             return await routePartner(event, getPartnerRoute);
    if (method === 'PUT'    && /^\/partners\/[^/]+$/.test(path))                             return await routePartner(event, updatePartnerRoute);
    if (method === 'DELETE' && /^\/partners\/[^/]+$/.test(path))                             return await routePartner(event, archivePartnerRoute);
    if (method === 'POST'   && /^\/partners\/[^/]+\/runs$/.test(path))                       return await routePartner(event, createRunRoute);
    if (method === 'GET'    && /^\/partners\/[^/]+\/runs$/.test(path))                       return await routePartner(event, listRunsRoute);
    if (method === 'GET'    && /^\/partners\/[^/]+\/runs\/[^/]+$/.test(path))                return await routePartnerRun(event, getRunRoute);
    if (method === 'POST'   && /^\/partners\/[^/]+\/runs\/[^/]+\/rerun$/.test(path))         return await routePartnerRun(event, rerunRoute);

    return resp(404, { error: 'not_found', path, method });
  } catch (e) {
    console.error('handler exception', e);
    return resp(500, { error: 'internal', message: e.message });
  }
};

async function checkAuth(event) {
  const ip = event.requestContext?.http?.sourceIp || 'unknown';
  const pw = event.headers?.['x-app-password'];
  if (!pw) return resp(401, { error: 'missing_password' });

  const fails = await countAuthFailsLastMinute(ip);
  if (fails >= 5) return resp(429, { error: 'rate_limited' });

  const ok = await verifyPassword(pw);
  if (!ok) {
    await recordAuthFail(ip);
    return resp(401, { error: 'invalid' });
  }
  return null;
}

async function routePartner(event, handlerFn) {
  const path = event.requestContext?.http?.path || event.rawPath || '';
  const m = path.match(/\/partners\/([^/]+)/);
  event.pathParameters = { ...(event.pathParameters || {}), partnerId: m && m[1] };
  return await handlerFn(event);
}

async function routePartnerRun(event, handlerFn) {
  const path = event.requestContext?.http?.path || event.rawPath || '';
  const m = path.match(/\/partners\/([^/]+)\/runs\/([^/]+)/);
  event.pathParameters = { partnerId: m && m[1], runId: m && m[2] };
  return await handlerFn(event);
}

function ok(b) { return resp(200, b); }
function resp(statusCode, body) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  };
}

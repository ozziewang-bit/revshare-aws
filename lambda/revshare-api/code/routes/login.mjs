import { verifyPassword } from '../auth.mjs';
import { recordAuthFail, countAuthFailsLastMinute } from '../db.mjs';

export async function handleLogin(event) {
  const ip = event.requestContext?.http?.sourceIp || 'unknown';
  const fails = await countAuthFailsLastMinute(ip);
  if (fails >= 5) return resp(429, { error: 'rate_limited' });

  const body = parseBody(event);
  const pw = body?.password || event.headers?.['x-app-password'];
  if (!pw) return resp(400, { error: 'missing_password' });

  const ok = await verifyPassword(pw);
  if (!ok) {
    await recordAuthFail(ip);
    return resp(401, { error: 'invalid' });
  }
  return resp(200, { ok: true });
}

function parseBody(event) {
  if (!event.body) return null;
  try { return JSON.parse(event.body); } catch { return null; }
}

function resp(statusCode, body) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  };
}

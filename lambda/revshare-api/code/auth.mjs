// Authentication (Google ID token verification) + authorization (permission resolution
// and the route→permission map). The resolver + map are pure and unit-tested; token
// verification uses Node 22 crypto.subtle against Google's cached JWKS (no npm dependency).
import { webcrypto } from 'node:crypto';

export const PERMS = ['editPartners', 'runCalcs', 'deleteRuns', 'manageMerchants', 'manageDeviceTypes', 'applyRuleBatch', 'admin'];

// Resolve a caller's effective permissions. admin email → all true; else row's permissions
// (missing keys false); else read-only baseline (all false).
export function resolvePermissions(email, row, adminEmails) {
  const e = (email || '').toLowerCase();
  const admins = (adminEmails || []).map(a => a.toLowerCase());
  if (admins.includes(e)) return Object.fromEntries(PERMS.map(k => [k, true]));
  const granted = (row && row.permissions) || {};
  const out = Object.fromEntries(PERMS.map(k => [k, !!granted[k]]));
  if (out.admin) for (const k of PERMS) out[k] = true;   // admin implies all
  return out;
}

// Map a request to the permission it requires. null → any valid token (reads / me).
export function requiredPermission(method, path) {
  if (method === 'GET') return path.startsWith('/users') ? 'admin' : null;   // reads are open; /users list is admin
  if (path.startsWith('/users')) return 'admin';
  if (path.startsWith('/partners') && /\/runs(\/|$)/.test(path)) return 'runCalcs';   // POST runs / rerun
  if (path.startsWith('/partners')) return 'editPartners';
  if (path === '/bulk-runs' || path === '/bulk-runs/prepare') return 'runCalcs';
  if (/^\/bulk-runs\/[^/]+\/unarchive$/.test(path)) return 'admin';
  if (/^\/bulk-runs\/[^/]+\/archive$/.test(path)) return 'runCalcs';
  if (path.startsWith('/bulk-runs/')) return 'deleteRuns';   // DELETE only mutating sub-route
  if (path.startsWith('/merchants')) return 'manageMerchants';
  if (path.startsWith('/machine-models')) return 'manageDeviceTypes';
  if (path.startsWith('/import/')) return 'applyRuleBatch';
  return 'admin';   // unknown mutation → require admin (fail-closed)
}

// ── Google ID token verification ──────────────────────────────────────────────
const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];
let jwksCache = { keys: null, exp: 0 };
async function getGoogleKeys() {
  const now = Date.now();
  if (jwksCache.keys && now < jwksCache.exp) return jwksCache.keys;
  const r = await fetch('https://www.googleapis.com/oauth2/v3/certs');
  if (!r.ok) throw new Error('jwks_fetch_failed');
  const body = await r.json();
  jwksCache = { keys: body.keys, exp: now + 3600_000 };   // cache 1h
  return body.keys;
}
const b64urlToBuf = s => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

// Verify a Google ID token; return its claims or throw. Checks signature, aud, iss, exp, hd.
export async function verifyGoogleToken(idToken, { clientId, allowedDomains }) {
  if (!clientId) throw new Error('server_misconfigured');           // fail loud if env not set
  if (!idToken) throw new Error('no_token');
  const [h, p, s] = idToken.split('.');
  if (!h || !p || !s) throw new Error('malformed_token');
  const header = JSON.parse(b64urlToBuf(h).toString('utf8'));
  if (header.alg !== 'RS256') throw new Error('bad_alg');           // pin the algorithm
  const payload = JSON.parse(b64urlToBuf(p).toString('utf8'));
  const keys = await getGoogleKeys();
  const jwk = keys.find(k => k.kid === header.kid && k.kty === 'RSA' && (k.use === 'sig' || k.alg === 'RS256'));
  if (!jwk) throw new Error('unknown_kid');
  const key = await webcrypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await webcrypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBuf(s), Buffer.from(`${h}.${p}`));
  if (!ok) throw new Error('bad_signature');
  if (payload.aud !== clientId) throw new Error('bad_aud');
  if (!GOOGLE_ISSUERS.includes(payload.iss)) throw new Error('bad_iss');
  if (payload.exp * 1000 < Date.now() - 60000) throw new Error('expired');   // 60s clock-skew leeway
  if (typeof payload.email !== 'string' || !payload.email) throw new Error('no_email');
  if (payload.email_verified !== true) throw new Error('email_unverified');
  if (!allowedDomains.map(d => d.toLowerCase()).includes((payload.hd || '').toLowerCase())) throw new Error('bad_domain');
  return payload;   // { email, hd, name, ... }
}

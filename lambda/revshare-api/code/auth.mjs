import { scryptSync, timingSafeEqual } from 'node:crypto';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const REGION = process.env.AWS_REGION || 'ap-northeast-1';
const HASH_PARAM = '/revshare/auth-hash';

let cachedHashPair = null;
let cachedVerified = new Set();
const HASH_TTL_MS = 5 * 60 * 1000;

const ssm = new SSMClient({ region: REGION });

async function getStoredHash() {
  if (cachedHashPair && Date.now() - cachedHashPair.fetchedAt < HASH_TTL_MS) {
    return cachedHashPair.hash;
  }
  const out = await ssm.send(new GetParameterCommand({ Name: HASH_PARAM, WithDecryption: true }));
  cachedHashPair = { hash: out.Parameter.Value, fetchedAt: Date.now() };
  cachedVerified = new Set();
  return cachedHashPair.hash;
}

export async function verifyPassword(plain) {
  if (typeof plain !== 'string' || plain.length === 0) return false;
  const key = plain.slice(0, 4) + ':' + plain.length;
  if (cachedVerified.has(key)) return true;

  const stored = await getStoredHash();
  if (!stored?.startsWith('scrypt$')) return false;
  const [, saltHex, hashHex] = stored.split('$');
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(plain, salt, expected.length);
  const ok = expected.length === actual.length && timingSafeEqual(expected, actual);
  if (ok) cachedVerified.add(key);
  return ok;
}

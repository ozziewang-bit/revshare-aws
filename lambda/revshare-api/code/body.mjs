import { gunzipSync } from 'node:zlib';

// A request body the browser compressed, because API Gateway's REST payload limit is a HARD
// 10 MB and one month of orders passed it.
//
// September 2026: 32,277 orders serialise to ~13 MB and the POST came back 413 — with no
// access-control-allow-origin, because an oversized body is rejected before gateway responses
// apply, so the browser reported only "Failed to fetch". (REQUEST_TOO_LARGE already inherits
// CORS headers; it makes no difference. The size check that produces a real message therefore
// lives in the browser, which knows the size before it sends.)
//
// Orders are dense repetitive JSON, so gzip takes that 13 MB to roughly 1.3 MB, ~1.7 MB once
// base64'd. Not unlimited — at about ten times the current volume this breaks again, and the
// answer then is a presigned S3 upload with the run request carrying only the key. Written
// down so that day is a decision rather than a surprise.
//
// Node's zlib is built in: no new dependency, no IAM, no bucket CORS, nothing to deploy but code.
const MAX_INFLATED = 64 * 1024 * 1024;   // a decompression bomb must not take the Lambda down

// Returns the JSON string a route should parse. A body without `gz` is returned untouched, so
// every existing caller — and an old browser tab mid-run — keeps working unchanged.
export function decodeBody(raw) {
  if (!raw) return raw;
  let outer;
  try {
    outer = JSON.parse(raw);
  } catch {
    return raw;                      // not JSON: not ours to touch
  }
  if (!outer || typeof outer.gz !== 'string') return raw;

  const packed = Buffer.from(outer.gz, 'base64');
  const inflated = gunzipSync(packed, { maxOutputLength: MAX_INFLATED });
  return inflated.toString('utf8');
}

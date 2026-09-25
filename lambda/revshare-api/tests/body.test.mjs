import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { decodeBody } from '../code/body.mjs';

// API Gateway's REST payload limit is a HARD 10 MB. In September 2026 one month of orders —
// 32,277 of them, ~13 MB — crossed it, and the 413 arrived with no CORS headers, so the browser
// could only report "Failed to fetch". The body now goes up gzipped.
//
// The test that matters is the round trip between the two halves, which live in different
// runtimes and cannot import each other: the BROWSER's encoder, extracted from app.js, against
// the LAMBDA's decoder. Node 18+ has CompressionStream, Blob and btoa, so the browser function
// runs here unmodified.
const app = readFileSync(new URL('../../../frontend/app.js', import.meta.url), 'utf8');
const grab = (n) => {
  const i = app.indexOf(`function ${n}(`);
  if (i < 0) throw new Error('missing ' + n);
  let d = 0;
  for (let k = app.indexOf('{', i); k < app.length; k++) {
    if (app[k] === '{') d++; else if (app[k] === '}') { d--; if (!d) return app.slice(i, k + 1); }
  }
};
const gzipBase64 = new Function(
  'async ' + grab('gzipBase64').replace(/^async /, '') + '\nreturn gzipBase64;')();

const order = (i) => ({
  merchantName: 'รถไฟฟ้ามหานคร สถานีมีนบุรี ' + (i % 40),
  netAmount: 30, machineNo: 'S5-2024-000' + i,
  rentalTime: '2026-09-14 18:32:11', returnTime: '2026-09-14 21:04:55',
  returnMerchant: 'เซเว่นอีเลฟเว่น กลางซอยรังสิตภิรมย์', duration: 152, orderStatus: 'Returned',
});

test('what the browser packs, the Lambda unpacks — byte for byte', async () => {
  const payload = { periodStart: '2026-09-01', periodEnd: '2026-09-30',
                    merchants: [{ merchantName: '7-Eleven', model: 'S5' }],
                    orders: Array.from({ length: 500 }, (_, i) => order(i)) };
  const text = JSON.stringify(payload);
  const body = JSON.stringify({ gz: await gzipBase64(text) });
  assert.deepEqual(JSON.parse(decodeBody(body)), payload);
});

test('a real month of orders fits, and that is the whole point', async () => {
  // 32,277 is the September figure that broke it. Uncompressed this is ~13 MB.
  const payload = { orders: Array.from({ length: 32277 }, (_, i) => order(i)) };
  const text = JSON.stringify(payload);
  const body = JSON.stringify({ gz: await gzipBase64(text) });
  // BYTES. The gateway limit is on bytes, and Thai merchant names are 3 bytes per character —
  // measuring String.length here would understate this payload by about a third and let the
  // test claim a fit that production does not have.
  const bytes = (s) => new TextEncoder().encode(s).length;
  assert.ok(bytes(text) > 10 * 1024 * 1024, `raw body should exceed the limit, was ${bytes(text)}`);
  assert.ok(bytes(body) < 10 * 1024 * 1024, `packed body must fit, was ${bytes(body)}`);
  assert.equal(JSON.parse(decodeBody(body)).orders.length, 32277);
});

test('an uncompressed body passes through untouched', () => {
  // Old tabs, the CLI, curl, and every route that never sends a big array.
  const raw = JSON.stringify({ periodStart: '2026-09-01', orders: [] });
  assert.equal(decodeBody(raw), raw);
});

test('a body that is not JSON at all is left alone rather than guessed at', () => {
  assert.equal(decodeBody('not json'), 'not json');
  assert.equal(decodeBody(''), '');
  assert.equal(decodeBody(undefined), undefined);
});

test('a body with a `gz` that is not a string is not treated as compressed', () => {
  // `gz` is a plausible field name; only a string one means "this is packed".
  const raw = JSON.stringify({ gz: 42, orders: [] });
  assert.equal(decodeBody(raw), raw);
});

test('corrupt compressed data fails loudly, not silently', () => {
  // The route turns this into a 400 naming the reason. Returning the raw body instead would
  // hand a route a JSON.parse error about a base64 blob.
  assert.throws(() => decodeBody(JSON.stringify({ gz: 'bm90IGd6aXA=' })));
});

test('a decompression bomb cannot exhaust the Lambda', () => {
  // 200 MB of zeroes gzip to a few hundred KB. Without maxOutputLength this inflates in memory
  // and takes the function down; every route on that container fails with it.
  const bomb = gzipSync(Buffer.alloc(200 * 1024 * 1024)).toString('base64');
  assert.throws(() => decodeBody(JSON.stringify({ gz: bomb })), /maxOutputLength|Buffer|size/i);
});

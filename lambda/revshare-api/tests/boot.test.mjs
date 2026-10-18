import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// The app must get through its own top level. 2026-10-15: a `const` declared below code that runs
// while the script loads (CT_CELLS = contractRenderCells()) threw "Cannot access 'GRID_MERGES'
// before initialization" and the WHOLE app came up blank. The no-undef lint cannot see that —
// the name IS defined, just later — and every other test extracts single functions. This one
// runs the entire file against a stub page. It also runs before every frontend deploy.
export function bootApp(src) {
  const any = new Proxy(function () {}, {
    get: (t, k) => (k === Symbol.toPrimitive ? () => '' : any), apply: () => any, construct: () => any });
  const ctx = vm.createContext({
    console: { log() {}, warn() {}, error() {}, info() {} }, window: any, document: any, navigator: any,
    google: any, history: any, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { search: '', hash: '', pathname: '/', href: '', origin: '' },
    setTimeout() {}, setInterval() {}, clearTimeout() {}, clearInterval() {},
    fetch: () => new Promise(() => {}), addEventListener() {}, matchMedia: () => any,
    URL, URLSearchParams, Intl, Date, Math, JSON, Promise, TextEncoder, TextDecoder });
  vm.runInContext(src, ctx, { filename: 'app.js' });
}

const app = readFileSync(new URL('../../../frontend/app.js', import.meta.url), 'utf8');

test('the whole app.js loads without throwing', () => {
  assert.doesNotThrow(() => bootApp(app));
});

test('the check catches a const used before its declaration', () => {
  // Proof the harness bites on exactly the 2026-10-15 failure shape.
  assert.throws(() => bootApp(app + '\nconst early = () => LATE; early();\nconst LATE = 1;'),
    /before initialization/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ── "I build merchant name after dear in the script, but it's not shown here" (2026-10-01) ───
//
// The Payment Schedule template's first line is `เรียน {{merchant}}`. With SEND TO = "Every
// merchant paid in this period" the Message box showed `เรียน` and nothing else.
//
// The mail itself was correct — the bulk branch renders once per recipient — but the PREVIEW
// substituted `merchant` from the entity filter box, which is empty in that mode, so the token
// was replaced by "". A preview that silently deletes the personalisation is indistinguishable
// from a template that lost it.
//
// Worse, found while checking: the bulk branch rendered `template.body`, the STORED text, so any
// correction typed into the box was discarded without a word.
const app = readFileSync(new URL('../../../frontend/app.js', import.meta.url), 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const grab = (n) => {
  const i = app.indexOf(`function ${n}(`);
  if (i < 0) throw new Error('missing ' + n);
  let d = 0;
  for (let k = app.indexOf('{', app.indexOf(')', i)); k < app.length; k++) {
    if (app[k] === '{') d++; else if (app[k] === '}') { d--; if (!d) return app.slice(i, k + 1); }
  }
};
const renderTemplate = new Function(grab('renderTemplate') + 'return renderTemplate;')();

const BODY = 'เรียน {{merchant}}\n\nบริษัท ChargeSpot ขอขอบพระคุณ\n\n{{unknownToken}}';

test('a known placeholder is filled', () => {
  assert.equal(renderTemplate(BODY, { merchant: '7-Eleven' }).split('\n')[0], 'เรียน 7-Eleven');
});

// This is the rule the preview was relying on, and the reason leaving `merchant` OUT of `vars`
// is the right fix rather than a hack: an absent key means "not mine to fill".
test('a placeholder with no variable is left alone, not blanked', () => {
  assert.equal(renderTemplate(BODY, { period: '2026-09' }).split('\n')[0], 'เรียน {{merchant}}');
  assert.match(renderTemplate(BODY, {}), /\{\{unknownToken\}\}/);
});

test('a variable that is present but empty DOES blank it — which is what went wrong', () => {
  assert.equal(renderTemplate(BODY, { merchant: '' }).split('\n')[0], 'เรียน ');
});

// ── The preview must show the token in bulk mode ─────────────────────────────────────────────
test('bulk mode leaves merchant and entity to the per-recipient render', () => {
  const i = app.indexOf('const fillText = () => {');
  const fn = strip(app.slice(i, app.indexOf('\n  };', i)));
  assert.match(fn, /isPaidMode\(\)\s*\?\s*\{ period:/,
    'in bulk mode only the period is substituted');
  assert.match(fn, /merchant: entity/, 'and a typed list still fills them from the entity box');
});

test('isPaidMode is declared before fillText calls it', () => {
  // `const` is in its temporal dead zone until evaluated; fillText() runs immediately, so a
  // declaration further down would throw on every open of the Send tab.
  const decl = app.indexOf('const isPaidMode = () =>');
  const use = app.indexOf('const fillText = () => {');
  assert.ok(decl > 0 && decl < use, 'declared above fillText');
  assert.equal(app.split('const isPaidMode = () =>').length - 1, 1, 'and declared exactly once');
  assert.equal(app.split("const modeEl = host.querySelector('#mmsg-mode')").length - 1, 1);
});

// ── What is on screen is what is sent ────────────────────────────────────────────────────────
test('the bulk send renders the BOX, not the stored template', () => {
  const i = app.indexOf('if (isPaidMode()) {');
  const branch = strip(app.slice(i, app.indexOf('await onMode();', i)));
  assert.match(branch, /renderTemplate\(subjEl\.value, vars\)/);
  assert.match(branch, /renderTemplate\(bodyEl\.value, vars\)/);
  assert.ok(!/renderTemplate\(template\.(subject|body)/.test(branch),
            'a correction typed before Send must not be discarded');
});

test('and it still renders once per recipient', () => {
  const i = app.indexOf('if (isPaidMode()) {');
  const branch = strip(app.slice(i, app.indexOf('await onMode();', i)));
  assert.match(branch, /for \(const r of plan\.ready\)/);
  assert.match(branch, /const vars = mailVarsFor\(r, run\);/, 'vars are per merchant, inside the loop');
});

test('the confirm shows the greeting as a recipient will read it', () => {
  const i = app.indexOf('if (isPaidMode()) {');
  const branch = app.slice(i, app.indexOf('await onMode();', i));
  assert.match(branch, /const sampleVars = mailVarsFor\(plan\.ready\[0\], run\)/);
  assert.match(branch, /Opens:/);
  assert.match(branch, /filled in per recipient/);
});

// ── The end-to-end shape, executed ───────────────────────────────────────────────────────────
test('one template, 58 recipients, 58 different greetings', () => {
  const ready = [
    { contractId: 'a', merchantName: '7-Eleven', payout: 341585, revenue: 364725 },
    { contractId: 'b', merchantName: 'BTS', payout: 144000, revenue: 70960 },
    { contractId: 'c', merchantName: 'Turtle Shop', payout: 76000, revenue: 22070 },
  ];
  const run = { periodStart: '2026-09-01' };
  const mailVarsFor = new Function('CONTRACTS', `
    const contractEntityFor = () => null;
    const periodTag = d => String(d||'').slice(0,7).replace('-','_');
    const fmt2 = n => String(n);
    const CCY = 'THB';
    ${grab('mailVarsFor')}
    return mailVarsFor;`)([]);
  const greetings = ready.map(r => renderTemplate(BODY, mailVarsFor(r, run)).split('\n')[0]);
  assert.deepEqual(greetings, ['เรียน 7-Eleven', 'เรียน BTS', 'เรียน Turtle Shop']);
  assert.equal(new Set(greetings).size, 3, 'each merchant is addressed by its own name');
});

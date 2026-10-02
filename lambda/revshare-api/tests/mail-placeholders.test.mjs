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

// ── A letter is never sent blank (2026-10-02) ────────────────────────────────────────────────
// "want to send mail and this happened" — the Send dialog opened with an empty subject and an
// empty message, under an entity reading "Siam Center · Siam Discovery — 2 statements, one
// letter". The first letter of a session went out correctly; every dialog opened AFTER a
// successful send was blank, because the post-send redraw called drawMailSendList(run.runId)
// with no template. Nothing stopped Send being pressed on it.
const appSrc = readFileSync(new URL('../../../frontend/app.js', import.meta.url), 'utf8');
const fnOf = (n) => {
  const i = appSrc.indexOf(`function ${n}(`);
  if (i < 0) throw new Error('missing ' + n);
  let d = 0, k = appSrc.indexOf('(', i);
  for (; k < appSrc.length; k++) { if (appSrc[k] === '(') d++; else if (appSrc[k] === ')') { d--; if (!d) break; } }
  for (let j = appSrc.indexOf('{', k), b = 0; j < appSrc.length; j++) {
    if (appSrc[j] === '{') b++; else if (appSrc[j] === '}') { b--; if (!b) return appSrc.slice(i, j + 1); }
  }
};

test('EVERY caller of drawMailSendList passes the template', () => {
  // The one that did not is the whole bug. A signature-level check, because the symptom was
  // two empty boxes — nothing threw, nothing logged, and the Send button stayed live.
  // Parentheses are BALANCED, not matched to the first `)` — one caller's first argument is
  // `document.getElementById('msend-run').value`, and a lazy regex stops inside it and reports a
  // missing template that is right there. A check that misreads the code is worse than none.
  const calls = [];
  for (let i = appSrc.indexOf('drawMailSendList('); i >= 0;
       i = appSrc.indexOf('drawMailSendList(', i + 1)) {
    let k = appSrc.indexOf('(', i), d = 0, j = k;
    for (; j < appSrc.length; j++) {
      if (appSrc[j] === '(') d++; else if (appSrc[j] === ')') { d--; if (!d) break; }
    }
    const args = appSrc.slice(k + 1, j).trim();
    if (!args.startsWith('runId,')) calls.push(args);   // skip the definition itself
  }
  assert.ok(calls.length >= 2, 'expected the redraws to still be there');
  for (const args of calls) {
    assert.match(args, /,\s*template\s*$/,
      `drawMailSendList(${args}) must pass the template — this is the bug, in one line`);
  }
});

test('the dialog refuses to open on a template that did not load', () => {
  const fn = fnOf('mailSendDialog');
  const i = fn.indexOf('The template did not load');
  assert.ok(i > 0, 'there is an explicit refusal');
  // It must come BEFORE the form is rendered, or the blank boxes appear anyway.
  assert.ok(i < fn.indexOf('id="ms-subject"'), 'and it returns before rendering the form');
  assert.match(fn, /if \(!template \|\| !\(String\(template\.subject \|\| ''\)\.trim\(\) \|\| String\(template\.body \|\| ''\)\.trim\(\)\)\)/);
  assert.match(fn.slice(i, i + 600), /nothing has been sent/);
});

test('and the send itself refuses an empty subject or message', () => {
  // The dialog guard covers a missing template; this covers wording typed away by hand, and is
  // the check that is actually next to the Gmail call.
  const fn = fnOf('mailSendDialog');
  assert.match(fn, /if \(!\$\('#ms-subject'\)\.value\.trim\(\)\) blockers\.push\('The subject is empty\.'\)/);
  assert.match(fn, /if \(!\$\('#ms-body'\)\.value\.trim\(\)\) blockers\.push\('The message is empty\.'\)/);
  // Before the send, not after.
  assert.ok(fn.indexOf("blockers.push('The subject is empty.')") < fn.indexOf('sendGmail('));
  assert.ok(fn.indexOf('if (blockers.length) return fail') < fn.indexOf('sendGmail('));
});

test('the dialog names every attachment, not just the first brand', () => {
  // "2 statements, one letter" then "attaching Siam Center.xlsx". The send has always attached
  // one file per brand (results.map); only this line was wrong, and it was the line being read.
  const fn = fnOf('mailSendDialog');
  const i = fn.indexOf("$('#ms-meta').textContent");
  const meta = fn.slice(i, fn.indexOf(';', fn.indexOf('attaching', i)));
  assert.match(meta, /results\.map\(r => `\$\{sanitizeFilename\(r\.merchantName\)\}\.xlsx`\)\.join\(', '\)/);
  assert.ok(!/attaching \$\{result\.merchantName\}/.test(meta),
    'result is results[0] — it must not stand in for the whole entity');
});

test('the attachment line and the files actually sent are built the same way', () => {
  // The two used to disagree, which is the only reason the line could be wrong without anyone
  // receiving the wrong files. Same source, same sanitiser, same order.
  const fn = fnOf('mailSendDialog');
  assert.match(fn, /const files = results\.map\(r => \(\{\s*filename: `\$\{sanitizeFilename\(r\.merchantName\)\}\.xlsx`/);
});

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
// Asserted against the SHARED pair (2026-10-02): `prepareStatementLetter` works out what
// would be sent, `deliverStatementLetter` sends exactly that. Both the per-entity dialog and
// "Send all" go through them, so one assertion now covers both senders.
  const prep = fnOf('prepareStatementLetter');
  assert.match(prep, /if \(!String\(subject \|\| ''\)\.trim\(\)\) blockers\.push\('The subject is empty\.'\)/);
  assert.match(prep, /if \(!String\(body \|\| ''\)\.trim\(\)\) blockers\.push\('The message is empty\.'\)/);
  assert.ok(!/sendGmail\(/.test(prep), 'preparing must not send — it only works out what would');
  // And the dialog refuses on them before delivering.
  const fn = fnOf('mailSendDialog');
  assert.ok(fn.indexOf('letter.blockers.length') < fn.indexOf('deliverStatementLetter('));
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
  assert.match(fnOf('prepareStatementLetter'),
    /const files = results\.map\(r => \(\{\s*filename: `\$\{sanitizeFilename\(r\.merchantName\)\}\.xlsx`/);
});

// ── Send all (2026-10-02) ───────────────────────────────────────────────────────────────────
// "please add a button to send to all in ready to send section."
//
// The dangerous button on this screen: one click, every merchant, cannot be unsent. What makes
// it safe is that it is not a second sender — it goes through the same prepare/deliver pair as
// the dialog, so it cannot send something a single send would have refused.
test('Send all goes through the SAME pair as the single send — no second sender', () => {
  const all = fnOf('sendAllReady');
  assert.match(all, /prepareStatementLetter\(\{ group: g, run, template, index,/);
  assert.match(all, /await deliverStatementLetter\(\{ group: g, run, template, letter,/);
  assert.ok(!/sendGmail\(/.test(all), 'it must not build its own message');
  assert.ok(!/statementWorkbook\(/.test(all), 'nor its own attachment');
  assert.ok(!/mail-log/.test(all), 'nor its own log row');
});

test('it refuses a letter the single send would refuse, and says which', () => {
  const all = fnOf('sendAllReady');
  assert.match(all, /if \(letter\.blockers\.length\) \{/);
  assert.match(all, /skipped\.push\(/, 'skipped, not silently dropped');
  assert.match(all, /continue;/, 'and the rest of the batch still goes');
});

test('the token is taken on the click, before any await', () => {
  // A browser only permits Google's permission window while the gesture is live. Taking it
  // after the first await is how this breaks on the first use of a session, and only then.
  const all = fnOf('sendAllReady');
  assert.ok(all.indexOf('const tokenReady = gmailToken()') < all.indexOf('await '),
    'gmailToken() must be called before the first await');
});

test('the order index is fetched ONCE for the batch, not per letter', () => {
  const all = fnOf('sendAllReady');
  const loop = all.slice(all.indexOf('for (const g of ready)'));
  assert.ok(!/runOrderIndex\(/.test(loop),
    'it is several MB — inside the loop that is one download per merchant');
  assert.match(all.slice(0, all.indexOf('for (const g of ready)')), /await runOrderIndex\(run\)/);
});

test('letters go one at a time, so progress means something', () => {
  const all = fnOf('sendAllReady');
  assert.ok(!/Promise\.all|Promise\.allSettled/.test(all),
    'parallel sends make "how far did it get" unanswerable');
  assert.match(all, /Sending <strong>\$\{done \+ 1\} of \$\{letters\}<\/strong>/);
});

test('one confirmation up front, naming what cannot be undone', () => {
  const all = fnOf('sendAllReady');
  for (const line of ['Period:', 'Letters:', 'Brands:', 'Payout:', 'To:']) {
    assert.ok(all.includes(line), `the confirmation must state ${line}`);
  }
  assert.match(all, /CANNOT BE UNSENT/);
  assert.match(all, /ASSIGNED address/, 'and an assigned batch says so first');
  assert.ok(all.indexOf('confirm(') < all.indexOf('gmailToken()'),
    'asked before the permission window, not after');
});

test('a delivery failure STOPS the batch and says how far it got', () => {
  // A blocked letter is a known state and the batch continues. A failed send is not — carrying
  // on past it would make "which ones went out" unanswerable.
  const all = fnOf('sendAllReady');
  const c = all.slice(all.indexOf('} catch (e) {'));
  assert.match(c, /Stopped after \$\{done\} of \$\{letters\}/);
  assert.match(c, /have NOT been sent/);
  assert.match(c, /await redraw\(\)/, 'and the list is redrawn so what is left is visible');
});

test('nothing already sent can be swept up by it', () => {
  // It is handed `ready`, which drawMailSendList builds by excluding everything in the mail log.
  const src = readFileSync(new URL('../../../frontend/app.js', import.meta.url), 'utf8');
  const i = src.indexOf('const ready = [], done = [], noFinance = [];');
  assert.ok(i > 0);
  assert.match(src.slice(i, i + 220), /if \(g\.sentAt\) done\.push\(g\);/);
  assert.match(src, /sendAllReady\(\s*ready, run, template/,
    'and Send all is given exactly that list');
  // The assigned flag is read at CLICK time, like the dialog reads it at open time — not
  // captured when the list was drawn.
  assert.match(fnOf('sendAllReady'), /const assign = MAIL_ASSIGNED\.length > 0;/);
});

test('the button lives in the Ready to send header and nowhere else', () => {
  const src = readFileSync(new URL('../../../frontend/app.js', import.meta.url), 'utf8');
  assert.equal((src.match(/id="msend-all"/g) || []).length, 1);
  const i = src.indexOf("section('Ready to send'");
  const j = src.indexOf("section('Already sent'");
  assert.ok(src.slice(i, j).includes('msend-all'), 'it belongs to Ready to send');
});

// ── What a bulk send must not lose (2026-10-02) ──────────────────────────────────────────────
// "please examine again that the all send will not miss out anything since we are not able to
// look through one by one." Both of these were found by running the app's own grouping and
// blocker functions over the live September run, not by reading the code.

test('an entity letter may go to any address its own brands list', () => {
  // `บริษัท เอ็มแอนด์ เอ็ม 2007 จำกัด` covers Song Wat Coffee and Someday in Copenhagen. The
  // recipients are the union across the two; the check ran per BRAND against that brand's own
  // addresses, so the union looked like a stranger and the whole letter blocked itself. Under
  // Send all it was skipped with one line in the closing summary — which is exactly what nobody
  // can catch in a batch of 66.
  const fn = fnOf('statementSendBlockers');
  assert.match(fn, /function statementSendBlockers\(result, run, recipients, attachmentFor, assigned, allowed\)/);
  assert.match(fn, /new Set\(\(allowed \|\| mailRecipients\(result\.contractId\)\)\.map/,
    'the letter’s own addresses when given, the brand’s when not');
  const prep = fnOf('prepareStatementLetter');
  assert.match(prep, /const allowed = \[\.\.\.new Set\(results\.flatMap\(r => mailRecipients\(r\.contractId\)\)\)\]/);
  assert.match(prep, /statementSendBlockers\(r, run, recipients, r\.contractId, !!assign, allowed\)/);
});

test('but an address from a DIFFERENT entity is still refused', () => {
  // The protection this check exists for: 7-Eleven's payout must never reach IMPACT.
  const fn = fnOf('statementSendBlockers');
  assert.match(fn, /const strangers = recipients\.filter\(a => !own\.has\(a\.toLowerCase\(\)\)\)/);
  assert.match(fn, /if \(strangers\.length\)/);
  assert.ok(!/if \(assigned\) return \[\]/.test(fn), 'the rest of the checks still run');
});

test('the attachment is still checked against its OWN brand, per row', () => {
  // Widening the address check must not widen this one: the file in the envelope has to be the
  // file built for that brand.
  const fn = fnOf('statementSendBlockers');
  assert.match(fn, /if \(attachmentFor !== result\.contractId\)/);
});

test('a letter that was SENT is never reported as not sent', () => {
  // Gmail has accepted the message before the log is written. If recording it then failed, the
  // old code threw — the group came back under "Ready to send" and a retry delivered a SECOND
  // copy to a real merchant. Over a batch of 66, one transient API error was enough.
  const fn = fnOf('deliverStatementLetter');
  const afterSend = fn.slice(fn.indexOf('await sendGmail'));
  assert.match(afterSend, /for \(let attempt = 0; attempt < 3 && !wrote; attempt\+\+\)/, 'it retries');
  assert.match(afterSend, /try \{[\s\S]*?catch \(e\) \{/, 'and never lets the write throw');
  assert.match(afterSend, /if \(!wrote\) unlogged\.push\(r\.merchantName\)/);
  assert.match(fn, /return \{ sent, unlogged \}/, 'the fact is returned, not raised');
});

test('and both senders say so, in the words that stop a resend', () => {
  for (const name of ['mailSendDialog', 'sendAllReady']) {
    const fn = fnOf(name);
    assert.match(fn, /WAS SENT|WERE SENT/, `${name} must say the letter went out`);
    // The batch shouts it ("DO NOT"), the single send does not — both are right, so the
    // check reads the instruction, not its capitalisation.
    assert.match(fn, /do not send (it|them) again/i, `${name} must say not to resend`);
    assert.match(fn, /Ready to send/, `${name} must warn it will reappear there`);
  }
});

test('Send all reports unlogged sends BEFORE the ordinary skipped summary', () => {
  // Two different messages: "these never went" and "these went but are not written down". The
  // second is the one that costs a merchant a duplicate, so it is not buried under the first.
  const fn = fnOf('sendAllReady');
  assert.ok(fn.indexOf('WERE SENT but could not be recorded') < fn.indexOf('could not be sent:'));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Mail goes OUTSIDE the company and cannot be unsent, so the two pieces that decide what a
// merchant actually receives — the template substitution and the MIME message — are pinned
// here. Both live in frontend/app.js because the browser holds the attachment and sends
// directly through the operator's Gmail; they are extracted and run, as elsewhere in this suite.
const app = readFileSync(new URL('../../../frontend/app.js', import.meta.url), 'utf8');
const grab = (n) => {
  const i = app.indexOf(`function ${n}(`);
  if (i < 0) throw new Error('missing ' + n);
  let d = 0;
  for (let k = app.indexOf('{', i); k < app.length; k++) {
    if (app[k] === '{') d++; else if (app[k] === '}') { d--; if (!d) return app.slice(i, k + 1); }
  }
};
// splitAddresses now leans on a shared VALID_ADDRESS constant, so every helper that extracts
// it needs the constant too — an address with a space is not an address, and that rule lives in
// one place.
const splitSrc = () =>
  app.slice(app.indexOf('const VALID_ADDRESS'), app.indexOf('function splitAddresses'))
  + grab('splitAddresses');

const load = (...names) => new Function(
  names.map(grab).join('\n') + `\nreturn { ${names.join(', ')} };`)();

const { renderTemplate } = load('renderTemplate');
const recipientsWith = (contracts) => new Function('CONTRACTS',
  splitSrc() + '\n' + grab('mailRecipients') + '\nreturn mailRecipients;')(contracts);
const { buildMimeMessage, encodeHeaderWord, base64Url, base64Std } =
  load('encodeHeaderWord', 'base64Std', 'base64Url', 'buildMimeMessage');

test('placeholders are filled from the run', () => {
  assert.equal(
    renderTemplate('Dear {{entity}}, your {{period}} payout is {{payout}} {{currency}}.',
      { entity: 'AOT Public Co., Ltd.', period: '2026-09', payout: '51,495.00', currency: 'THB' }),
    'Dear AOT Public Co., Ltd., your 2026-09 payout is 51,495.00 THB.');
});

test('an UNKNOWN placeholder is left alone, never blanked', () => {
  // "Your payout is  THB" looks like a system that lost the number; "{{payout}}" is obviously
  // a template fault and gets noticed in the preview before anything is sent.
  assert.equal(renderTemplate('A {{nope}} B', { merchant: 'x' }), 'A {{nope}} B');
});

test('a placeholder present but empty renders as empty, because that IS the value', () => {
  assert.equal(renderTemplate('[{{entity}}]', { entity: '' }), '[]');
});

test('a statement reads the finance column, and ONLY that', () => {
  // It used to fall back to the ordinary contact, which quietly sent a remittance advice to an
  // ops or marketing address. A statement is a financial document: it goes to the person who
  // handles money, or it does not go. Several addresses in one field still split — IMPACT
  // really does carry two.
  const f = recipientsWith([
    { contractId: 'c1', financeContactEmail: 'ap@x.com', contactEmail: 'ops@x.com' },
    { contractId: 'c2', contactEmail: 'KornjiraS@impact.co.th, creditcontrol@impact.co.th' },
    { contractId: 'c3', financeContactEmail: 'a@x.com, b@x.com' },
  ]);
  assert.deepEqual(f('c1'), ['ap@x.com'], 'the contact email is NOT used as well');
  assert.deepEqual(f('c2'), [], 'a contact email alone does not make a merchant sendable');
  assert.deepEqual(f('c3'), ['a@x.com', 'b@x.com']);
});

test('what is on file is still reported, so the gap reads as a to-do', () => {
  // 17 merchants in the August run have a contact email and no finance one. Saying only
  // "missing" would hide the address someone could copy across.
  const f = new Function('CONTRACTS',
    splitSrc() + '\n' + grab('fallbackContact') + '\nreturn fallbackContact;')(
    [{ contractId: 'c2', contactEmail: 'KornjiraS@impact.co.th, creditcontrol@impact.co.th' }]);
  assert.deepEqual(f('c2'), ['KornjiraS@impact.co.th', 'creditcontrol@impact.co.th']);
});

test('a merchant with no usable address yields none, so it cannot be silently mailed nowhere', () => {
  const f = recipientsWith([{ contractId: 'c1', contactEmail: 'not an address' },
                            { contractId: 'c2' }]);
  assert.deepEqual(f('c1'), []);
  assert.deepEqual(f('c2'), []);
  assert.deepEqual(f('missing'), []);
});

test('a non-ASCII subject is RFC 2047 encoded, not sent raw', () => {
  // Thai merchant names in a Subject: arrive as mojibake otherwise.
  assert.match(encodeHeaderWord('ติดมันส์ payout'), /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
  assert.equal(encodeHeaderWord('AOT payout'), 'AOT payout', 'plain ASCII is left readable');
});

test('the message carries the right From, To and attachment', () => {
  const mime = buildMimeMessage({
    from: 'partner.th@inforich.com',
    to: ['ap@merchant.com', 'finance@merchant.com'],
    subject: 'September statement',
    body: 'Attached.',
    filename: '1) AOT.xlsx',
    attachment: new Uint8Array([80, 75, 3, 4]),   // a zip/xlsx magic number
  });
  assert.match(mime, /^From: partner\.th@inforich\.com\r\n/);
  assert.match(mime, /^To: ap@merchant\.com, finance@merchant\.com$/m);
  assert.match(mime, /filename="1\) AOT\.xlsx"/);
  assert.match(mime, /multipart\/mixed; boundary="mcrm_/);
  assert.match(mime, /spreadsheetml\.sheet/);
});

test('the boundary appears exactly three times: two parts and the close', () => {
  // A boundary that collides with content truncates the mail silently. It is random per message
  // for that reason; this pins the structure that makes the randomness matter.
  const mime = buildMimeMessage({
    from: 'a@b.c', to: ['d@e.f'], subject: 's', body: 'b',
    filename: 'x.xlsx', attachment: new Uint8Array([1, 2, 3]),
  });
  const boundary = mime.match(/boundary="([^"]+)"/)[1];
  assert.equal(mime.split('--' + boundary).length - 1, 3);
  assert.ok(mime.trimEnd().endsWith(`--${boundary}--`), 'and closes properly');
});

test('a message with no attachment is still a valid message', () => {
  const mime = buildMimeMessage({ from: 'a@b.c', to: ['d@e.f'], subject: 's', body: 'hello' });
  assert.ok(!/Content-Disposition/.test(mime));
  const boundary = mime.match(/boundary="([^"]+)"/)[1];
  assert.ok(mime.trimEnd().endsWith(`--${boundary}--`));
});

test('base64url output carries no characters that would corrupt a URL-safe payload', () => {
  const bytes = new Uint8Array(Array.from({ length: 300 }, (_, i) => i % 256));
  assert.ok(!/[+/=]/.test(base64Url(bytes)));
});

// ── Layout coupling (2026-09-25) ───────────────────────────────────────────────────────────
// The first version of these dialogs used `.nm-f`, which is not a CSS rule at all: the
// new-merchant form's layout comes from its `.nm-grid` PARENT. In a plain modal the labels fell
// inline and the textarea floated mid-dialog. A class that only works inside a container it does
// not carry is exactly the kind of coupling worth a test.
const css = readFileSync(new URL('../../../frontend/style.css', import.meta.url), 'utf8');

test('the mail dialogs use a form layout that stands on its own', () => {
  for (const fn of ['editMailTemplate', 'mailSendDialog']) {
    const src = grab(fn);
    assert.match(src, /class="mail-form"/, `${fn} must use the standalone mail form`);
    assert.ok(!/class="nm-f"/.test(src),
      `${fn} must not use .nm-f, which only lays out inside .nm-grid`);
  }
});

test('and that layout is actually defined in the stylesheet', () => {
  // The bug was markup naming a class with no rule behind it. Check the rules exist.
  for (const rule of ['.mail-form label', '.mail-form textarea', '.mail-row']) {
    assert.ok(css.includes(rule), `style.css is missing ${rule}`);
  }
});

// ── The sender alias (2026-09-25) ──────────────────────────────────────────────────────────
// Every Thai template sends as the partner group, so it defaults rather than being retyped.
// It stays a per-template field because a Thai note and a Singapore one need not share a
// sender — not because anyone wants the choice each time.
const aliasIn = (region) => new Function('REGION',
  app.slice(app.indexOf('const DEFAULT_FROM_ALIAS'), app.indexOf('function mailSendDialog'))
  + '\nreturn mailFromAlias;')(region);

test('a template with no sender falls back to the region default', () => {
  // Templates saved before the default existed must still send, rather than failing at the
  // last step with an error about a field nobody knew to fill in.
  assert.equal(aliasIn('th')({}), 'partner.th@inforich.com');
  assert.equal(aliasIn('th')({ fromAlias: '' }), 'partner.th@inforich.com');
  assert.equal(aliasIn('th')(null), 'partner.th@inforich.com');
});

test('a template that names a sender keeps it', () => {
  assert.equal(aliasIn('th')({ fromAlias: 'someone.else@inforich.com' }),
    'someone.else@inforich.com');
});

test('Singapore does NOT borrow the Thai group address', () => {
  // Silently sending as partner.th from Singapore would put the wrong company in a merchant's
  // inbox. Empty is the right answer until SG has a group of its own: the send is refused with
  // a message saying to set one.
  assert.equal(aliasIn('sg')({}), '');
  assert.equal(aliasIn('sg')({ fromAlias: 'partner.sg@inforich.com' }), 'partner.sg@inforich.com');
});

test('a sender address is trimmed, since a stray space makes Gmail reject it', () => {
  assert.equal(aliasIn('th')({ fromAlias: '  partner.th@inforich.com  ' }),
    'partner.th@inforich.com');
});

// ── One place sends (2026-09-25) ───────────────────────────────────────────────────────────
// "All mails happen in the mailing page, never from Run share" (user). Two places that can send
// means two places that can send a second copy, and two places to look when someone asks what
// went out. A run detail reports what was CALCULATED; Mailing is where anything leaves.
test('the run detail cannot send mail', () => {
  const src = grab('renderBulkRunDetail');
  for (const forbidden of ['mailSendDialog', 'mail-log', 'Statement']) {
    assert.ok(!src.includes(forbidden),
      `renderBulkRunDetail must not reference ${forbidden} — sending belongs to Mailing`);
  }
});

test('the Mailing screen opens on Send, because that is the job', () => {
  const src = grab('renderMailingScreen');
  assert.match(src, /tab = 'send'/, 'the default tab is the work, not the configuration');
  const order = ['send', 'templates', 'sent'].map(id => src.indexOf(`id: '${id}'`));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'Send comes first');
});

test('the send list separates what can be sent from what cannot', () => {
  // Three groups because they need three different things: work, a record, and a gap in the
  // merchant list that no amount of mailing fixes.
  const src = grab('drawMailSendList');
  for (const group of ['Ready to send', 'Already sent', 'No finance email']) {
    assert.ok(src.includes(group), `the send list must show "${group}"`);
  }
  assert.match(src, /effectiveRecipients\(r\.contractId\)\.length/,
    'membership of those groups must follow the batch recipient decision');
});

// ── Choosing recipients (2026-09-25) ───────────────────────────────────────────────────────
// Either tick the merchant's known addresses, or type one — typing your own is how a test send
// is done, and the dialog has to make that visibly different from mailing the merchant.
const knownIn = (contracts) => new Function('CONTRACTS',
  splitSrc() + '\n' + grab('knownAddresses') + '\nreturn knownAddresses;')(contracts);

test('every known address is offered, labelled with where it came from', () => {
  const f = knownIn([{ contractId: 'c1', financeContactEmail: 'ap@x.com', contactEmail: 'ops@x.com' }]);
  assert.deepEqual(f('c1'), [
    { address: 'ap@x.com', source: 'finance contact' },
    { address: 'ops@x.com', source: 'contact' },
  ]);
});

test('the same address in both fields is offered once', () => {
  // Otherwise it appears twice, both ticked, and the merchant gets two copies.
  const f = knownIn([{ contractId: 'c1', financeContactEmail: 'AP@x.com', contactEmail: 'ap@x.com' }]);
  assert.equal(f('c1').length, 1);
  assert.equal(f('c1')[0].source, 'finance contact', 'and the finance one is the survivor');
});

test('several addresses in one field are offered separately', () => {
  // IMPACT really does carry two in one field; they must be individually tickable.
  const f = knownIn([{ contractId: 'c1', contactEmail: 'KornjiraS@impact.co.th, creditcontrol@impact.co.th' }]);
  assert.deepEqual(f('c1').map(k => k.address),
    ['KornjiraS@impact.co.th', 'creditcontrol@impact.co.th']);
});

test('a merchant with nothing on file offers nothing, rather than a blank row', () => {
  assert.deepEqual(knownIn([{ contractId: 'c1' }])('c1'), []);
  assert.deepEqual(knownIn([])('nope'), []);
});


test('the dialog says when a send is not going to the merchant', () => {
  // An assigned send must not look identical to the real thing.
  const src = grab('mailSendDialog');
  assert.match(src, /Assigned/);
  assert.match(src, /instead of/, 'and names the address it is NOT going to');
});

// ── One report, one deliberate assignment (2026-09-25) ─────────────────────────────────────
// The whole-batch redirect was built, used once, and removed: it made "where is this going" a
// question about screen state rather than about the row. A single statement can still go
// somewhere else, per report, as an act with a reason — and it is recorded as one.
const recipientsFor = (contracts, assigned = []) => new Function('CONTRACTS', 'MAIL_ASSIGNED',
  splitSrc() + '\n' + grab('mailRecipients') + '\n' + grab('effectiveRecipients')
  + '\nreturn effectiveRecipients;')(contracts, assigned);

const BOOK = [
  { contractId: 'c1', merchantName: '7-Eleven', financeContactEmail: 'wiparatron@cpall.co.th' },
  { contractId: 'c2', merchantName: 'No finance', contactEmail: 'ops@x.com' },
];

test('a statement goes to its merchant\u2019s finance address by default', () => {
  const f = recipientsFor(BOOK);
  assert.deepEqual(f('c1'), ['wiparatron@cpall.co.th']);
  assert.deepEqual(f('c2'), [], 'a contact email is not a finance address');
});

test('an assigned address replaces it for every merchant', () => {
  // One choice at the top: a per-row button was tried and made the table unreadable.
  const f = recipientsFor(BOOK, ['ozzie.wang@inforich.com']);
  assert.deepEqual(f('c1'), ['ozzie.wang@inforich.com']);
  assert.deepEqual(f('c2'), ['ozzie.wang@inforich.com'],
    'including a merchant that has no finance address of its own');
});

test('no assignment means the merchant\u2019s own address', () => {
  const f = recipientsFor(BOOK, []);
  assert.deepEqual(f('c1'), ['wiparatron@cpall.co.th']);
});

test('the assignment cannot outlive the visit that set it', () => {
  // An assignment left on from yesterday, silently redirecting a real send, is the one thing
  // this must never do.
  const src = grab('renderStatementSend');
  assert.match(src, /MAIL_ASSIGNED = \[\]/, 'the screen clears it on load');
});

test('the dialog only accepts a stranger address when it was assigned deliberately', () => {
  const f = blockersIn(BOOK, {});
  const SEVEN = { contractId: 'c1', merchantName: '7-Eleven' };
  const RUN2 = { runId: 'r1', periodStart: '2026-08-01' };
  assert.match(f(SEVEN, RUN2, ['someone@else.com'], 'c1', false).join(' '),
    /not a finance address/, 'an accidental one is still blocked');
  assert.deepEqual(f(SEVEN, RUN2, ['someone@else.com'], 'c1', true), [],
    'a deliberate assignment is allowed — that is what the action is for');
});

test('an assigned send is recorded as assigned', () => {
  // Otherwise the Sent log cannot tell a statement that went to its merchant from one that
  // went somewhere else, which is the first question anyone would ask of it.
  const src = grab('mailSendDialog');
  assert.match(src, /assigned: !!assign/);
  assert.match(src, /ASSIGNED address/, 'and the confirmation says so before it goes');
});

test('the list says where an assigned batch is going', () => {
  const src = grab('drawMailSendList');
  assert.match(src, /not to the merchants/);
  assert.match(src, /No assigned address yet/, 'and prompts when the mode is on but empty');
});

test('the send list says what is left for the period', () => {
  const src = grab('drawMailSendList');
  assert.match(src, /of \$\{total\} sent/);
  assert.match(src, /still to send/);
  assert.match(src, /this period is complete/);
});

// ── The template decides what the send screen asks (2026-09-25) ────────────────────────────
// "Select template first, and then develop details for each" (user, twice). A statement
// attaches one merchant's figures for a period, so it needs a period. A plain message attaches
// nothing and knows nothing about a run — asking for a period there is noise, and offering
// {{payout}} is a promise that cannot be kept.
const kindsIn = () => new Function(
  app.slice(app.indexOf('const MAIL_KINDS'), app.indexOf('// Placeholders a template may use'))
  + '\nreturn { MAIL_KINDS, mailKind };')();

test('a template without a kind is treated as a statement', () => {
  // Both existing templates predate the field; they must keep working as what they were.
  const { mailKind } = kindsIn();
  assert.equal(mailKind({}), 'statement');
  assert.equal(mailKind({ kind: 'nonsense' }), 'statement');
  assert.equal(mailKind(null), 'statement');
  assert.equal(mailKind({ kind: 'message' }), 'message');
});

test('only a statement needs a period', () => {
  const { MAIL_KINDS } = kindsIn();
  assert.equal(MAIL_KINDS.statement.needsPeriod, true);
  assert.equal(MAIL_KINDS.message.needsPeriod, false);
});

test('nothing is chosen for you, and nothing is shown until you choose', () => {
  // An auto-selected first template would put one click between landing on this screen and
  // sending a real merchant a real statement.
  const src = grab('renderMailSendTab');
  assert.match(src, /<option value="" selected>Choose a template/);
  assert.match(src, /if \(raw === ''\)/, 'the empty choice is handled explicitly');
  assert.match(src, /Choose a template to continue/, 'and says so rather than rendering nothing');
});

test('the send screen asks for the template FIRST and nothing else', () => {
  // The first step must not carry a period: whether a period is even meaningful is decided by
  // the answer to this question.
  const src = grab('renderMailSendTab');
  assert.match(src, /1 · Template/);
  assert.ok(!src.includes('msend-run'), 'no period selector before a template is chosen');
  assert.match(src, /renderMessageSend|renderStatementSend/, 'the kind routes to its own screen');
});

test('a plain message screen has no period and no attachment', () => {
  const src = grab('renderMessageSend');
  assert.ok(!src.includes('msend-run'), 'no period');
  // Behaviour, not wording — the screen legitimately says the words "no attachment".
  assert.ok(!/attachment:/.test(src), 'no attachment is passed to the message builder');
  assert.ok(!/XLSX\.write/.test(src), 'and no statement file is built');
  assert.match(src, /2 · Send to/, 'its second step is recipients, not a period');
});

test('a plain message sends each recipient their own copy', () => {
  // One mail addressed to thirty merchants shows every one of them the others' addresses.
  const src = grab('renderMessageSend');
  assert.match(src, /for \(const to of list\)/, 'one message per recipient');
  assert.match(src, /to: \[to\]/, 'each addressed only to itself');
});

test('a statement screen asks for the period and where it goes', () => {
  const src = grab('renderStatementSend');
  assert.match(src, /2 · Period/);
  assert.match(src, /3 · Send to/);
  assert.match(src, /An assigned address/);
  assert.ok(!src.includes('massign-btn'), 'and not a button on every row');
});

test('a statement template with no run says so instead of showing an empty list', () => {
  const src = grab('renderStatementSend');
  assert.match(src, /nothing to attach/);
});

// ── Per-merchant preview (2026-09-25) ──────────────────────────────────────────────────────
// Reading fourteen mails to check the wording, in a dialog with a Send button, is fourteen
// chances to send one early. The preview is a reading view: nothing leaves from it.
test('the preview cannot send, it can only hand over to the send dialog', () => {
  const src = grab('mailPreviewDialog');
  assert.ok(!src.includes('sendGmail'), 'the preview must not send');
  assert.ok(!src.includes('mail-log'), 'and must not record anything');
  assert.match(src, /mailSendDialog\(result, run, sentAlready, template\)/,
    'Send this… hands over to the real dialog rather than duplicating it');
});

test('the preview renders the same text the send would', () => {
  // If the preview and the send could differ, the preview would be worse than nothing.
  const src = grab('mailPreviewDialog');
  assert.match(src, /renderTemplate\(template\.subject, vars\)/);
  assert.match(src, /renderTemplate\(template\.body, vars\)/);
  assert.match(src, /mailRecipients\(result\.contractId\)/);
});

test('the preview warns about placeholders the template left unfilled', () => {
  // An unknown placeholder renders as itself, by design — so the merchant would receive
  // "{{payout}}" literally. The preview is the last place that can be caught.
  const src = grab('mailPreviewDialog');
  assert.match(src, /\\\{\\\{\\w\+\\\}\\\}/, 'it scans the rendered text for leftovers');
  assert.match(src, /would receive it literally/);
});

test('every row that has a mail offers a preview of it', () => {
  const src = grab('drawMailSendList');
  assert.match(src, /mprev-btn[\s\S]*Preview/, 'ready rows');
  assert.equal((src.match(/mprev-btn/g) || []).length >= 3, true,
    'both the ready and already-sent groups, plus the handler');
});

// ── The emailed file IS the downloaded file (2026-09-25) ───────────────────────────────────
// The mail used to build its attachment with `null` orders — a summary-only sheet — while its
// own wording promised "every rental in the period". A merchant comparing the file with the
// letter would have found the letter wrong. Both paths now go through one builder.
test('mail and download build the statement from the same function', () => {
  const send = grab('mailSendDialog');
  assert.match(send, /statementWorkbook\(result, index\)/, 'the mail builds the shared workbook');
  assert.match(send, /await runOrderIndex\(run\)/, 'from the run\u2019s own order index');
  assert.ok(!/buildPartnerSheet\(XLSX, result, null/.test(send),
    'and never passes null orders, which is what dropped the rental rows');
});

test('the order index is fetched once per run, not per merchant', () => {
  // It is several MB. Fetching it per row would mean 14 downloads to send 14 statements.
  const src = grab('runOrderIndex');
  assert.match(src, /RUN_ORDER_INDEX\.has\(run\.runId\)/);
  assert.match(src, /RUN_ORDER_INDEX\.set\(run\.runId, index\)/);
});

test('a run with no stored order detail still produces a statement', () => {
  // Runs before 2026-09-01 stored no orders (§1j). That is a fact about the run, not a fault:
  // the sheet carries the summary block and the preview says so.
  const src = grab('runOrderIndex');
  assert.match(src, /orders = null/, 'orders stay null rather than throwing');
  const prev = grab('mailPreviewDialog');
  assert.match(prev, /predates stored order detail/,
    'and the preview says the attachment has no rental rows');
});

test('the preview states what the attachment will actually contain', () => {
  // A covering letter promising rows the file does not have is the failure this prevents.
  const src = grab('mailPreviewDialog');
  assert.match(src, /rental row/);
  assert.match(src, /summary only/);
});

// ── Nothing here is recoverable (2026-09-25) ───────────────────────────────────────────────
// "We cannot afford a wrong file or any mistake" (user). A statement sent to the wrong merchant
// cannot be recalled, and the merchant who receives someone else's payout figures is the one
// who tells you. These run at the MOMENT of sending, against the values actually about to be
// used — not against what the screen showed a minute ago.
const blockersIn = (contracts, state) => new Function('CONTRACTS', 'MAIL_SEND_TO',
  splitSrc() + '\n' + grab('mailRecipients') + '\n'
  + grab('statementSendBlockers') + '\nreturn statementSendBlockers;')(contracts, state);

const RUN = { runId: 'r1', periodStart: '2026-08-01' };
const SEVEN = { contractId: 'c1', merchantName: '7-Eleven' };
const BOOKS = [
  { contractId: 'c1', merchantName: '7-Eleven', financeContactEmail: 'wiparatron@cpall.co.th' },
  { contractId: 'c2', merchantName: 'IMPACT', financeContactEmail: 'ap@impact.co.th' },
];

test('a clean send has nothing blocking it', () => {
  const f = blockersIn(BOOKS, { mode: 'merchant', addresses: [] });
  assert.deepEqual(f(SEVEN, RUN, ['wiparatron@cpall.co.th'], 'c1', false), []);
});

test('a file built for another merchant blocks the send', () => {
  // The letter and the file both come from one row today, so this can only fail if a future
  // change threads a different row into one of them — which is exactly the change that would
  // otherwise ship silently.
  const f = blockersIn(BOOKS, { mode: 'merchant', addresses: [] });
  const out = f(SEVEN, RUN, ['wiparatron@cpall.co.th'], 'c2', false);
  assert.equal(out.length, 1);
  assert.match(out[0], /built for a different merchant/);
});

test('another merchant’s address blocks the send', () => {
  // Sending 7-Eleven's payout figures to IMPACT is the worst thing this screen could do.
  const f = blockersIn(BOOKS, { mode: 'merchant', addresses: [] });
  const out = f(SEVEN, RUN, ['ap@impact.co.th'], 'c1', false);
  assert.equal(out.length, 1);
  assert.match(out[0], /not a finance address for 7-Eleven/);
});

test('no recipient and no run both block', () => {
  const f = blockersIn(BOOKS, { mode: 'merchant', addresses: [] });
  assert.match(f(SEVEN, RUN, [], 'c1', false).join(' '), /no recipient/i);
  assert.match(f(SEVEN, null, ['wiparatron@cpall.co.th'], 'c1').join(' '), /not attached to a run/);
});

test('the send restates merchant, period, payout and recipient before it goes', () => {
  const src = grab('mailSendDialog');
  for (const line of ['Merchant:', 'Period:', 'Payout:', 'To:', 'Attached:']) {
    assert.ok(src.includes(line), `the confirmation must restate ${line}`);
  }
  assert.match(src, /cannot be unsent/);
});

test('the log records enough to check that the RIGHT one was sent', () => {
  // "We sent it" is not the same claim as "we sent the right one".
  const src = grab('mailSendDialog');
  for (const field of ['period:', 'payout:', 'attachmentRows:']) {
    assert.ok(src.includes(field), `the mail log must record ${field}`);
  }
});

// ── A save either happens or says why (2026-09-25) ─────────────────────────────────────────
// An edit to the "Rev share" template was lost: the payload was built OUTSIDE the try, so a
// missing field element threw before anything was sent — the button did nothing, no error
// appeared, and the template silently stayed as it was. The report was "I made an adjustment,
// why is it not updated".
test('the whole save is guarded, not just the request', () => {
  const src = grab('editMailTemplate');
  const tryAt = src.indexOf('try {');
  const payloadAt = src.indexOf('const payload');
  assert.ok(tryAt > 0 && payloadAt > tryAt,
    'the payload must be built INSIDE the try, or a missing element fails silently');
  assert.match(src, /reload the page and try again/,
    'a stale dialog must say so rather than doing nothing');
});

test('a save is only reported once the server confirms the text', () => {
  // A 200 carrying different text is not a save, and this screen must not claim one.
  const src = grab('editMailTemplate');
  assert.match(src, /saved\.subject !== payload\.subject/);
  assert.match(src, /saved\.body !== payload\.body/);
  assert.match(src, /Nothing has been saved/);
});

// ── An address with a space is not an address (2026-09-25) ─────────────────────────────────
// The first check was /.+@.+\\..+/, where `.` matches a space — so 'baanying mkt@gmail.com',
// a real entry on BAANYING and Oranuch, passed as valid. It would have been offered as a
// recipient and Gmail would have rejected the whole message at the moment of sending.
const addrFns = () => new Function(
  app.slice(app.indexOf('const VALID_ADDRESS'), app.indexOf('function malformedAddresses'))
  + grab('malformedAddresses')
  + '\nreturn { splitAddresses, malformedAddresses };')();

test('an address containing a space is rejected', () => {
  const { splitAddresses } = addrFns();
  assert.deepEqual(splitAddresses('baanying mkt@gmail.com'), []);
  assert.deepEqual(splitAddresses('ap@x.com, baanying mkt@gmail.com'), ['ap@x.com'],
    'and the good one beside it still comes through');
});

test('ordinary addresses still pass, including the awkward real ones', () => {
  const { splitAddresses } = addrFns();
  assert.deepEqual(
    splitAddresses('KornjiraS@impact.co.th, creditcontrol@impact.co.th'),
    ['KornjiraS@impact.co.th', 'creditcontrol@impact.co.th']);
  assert.deepEqual(splitAddresses('natthakarn.jitth@airportthai.co.th'),
    ['natthakarn.jitth@airportthai.co.th']);
});

test('a broken address is reported as broken, not as absent', () => {
  // "No address" sends someone looking for a missing field. "Not a valid address" sends them to
  // the one that is there and wrong — which is the actual job.
  const { malformedAddresses } = addrFns();
  assert.deepEqual(malformedAddresses('baanying mkt@gmail.com'), ['baanying mkt@gmail.com']);
  assert.deepEqual(malformedAddresses('ap@x.com'), [], 'a good address is not reported');
  assert.deepEqual(malformedAddresses('not an email at all'), [],
    'and neither is something that was never trying to be one');
});

// ── The Google permission window needs the click (2026-09-25) ──────────────────────────────
// Asking Google for a send token opens a popup, and a browser only allows that DURING a user
// gesture. The first real send failed with "Failed to open popup window" because the handler
// fetched the run's orders, built the file and showed a confirm before asking — by which point
// the click was spent. The token must be requested before the first await.
test('the statement send asks for the token before anything it has to wait for', () => {
  const src = grab('mailSendDialog');
  const ask = src.indexOf('gmailToken()');
  const firstAwait = src.indexOf('await ', src.indexOf("addEventListener('click'"));
  assert.ok(ask > 0, 'it must ask for a token');
  assert.ok(ask < firstAwait,
    'and must ask BEFORE the first await, or the popup is blocked');
});

test('the plain-message send does the same', () => {
  const src = grab('renderMessageSend');
  const ask = src.indexOf('gmailToken()');
  const firstAwait = src.indexOf('await ', src.indexOf("'#mmsg-send'"));
  assert.ok(ask > 0 && ask < firstAwait);
});

test('a blocked popup says what to do about it', () => {
  // "Failed to open popup window" on its own reads as a fault in the app rather than a browser
  // setting the reader can change.
  const src = grab('gmailToken');
  assert.match(src, /Allow pop-ups for this site/);
});

// ── Everything a row renders must be inside the row (2026-09-25) ───────────────────────────
// A button was appended AFTER row(...), which is after the closing </tr>. A browser hoists
// non-cell content out of a table, so 106 loose buttons rendered as a grid and their rows
// vanished with them. Cheap to do, invisible to every other kind of test, and it made a whole
// section unreadable.
test('no row helper output is concatenated outside its own markup', () => {
  const src = grab('drawMailSendList');
  // `row(...)` closes its own <tr>. Anything appended to that call lands outside the table.
  assert.ok(!/row\(r,[\s\S]*?\)\s*\n\s*\+ `?\s*<button/.test(src),
    'a button appended after row(...) would render outside the table');
});

test('every table cell the send list builds is opened and closed', () => {
  // Counting tags is crude, but an unbalanced cell is exactly the fault above wearing a
  // different hat, and it is otherwise only visible on screen.
  // Comments mention tags too — the comment explaining THIS bug contains a </tr>. Count markup.
  const src = grab('drawMailSendList').replace(/\/\/.*$/gm, '');
  const open = (src.match(/<td[ >]/g) || []).length;
  const close = (src.match(/<\/td>/g) || []).length;
  assert.equal(open, close, `${open} <td> against ${close} </td>`);
  const tr = (src.match(/<tr[ >]/g) || []).length;
  const trc = (src.match(/<\/tr>/g) || []).length;
  assert.equal(tr, trc, `${tr} <tr> against ${trc} </tr>`);
});

// ── Actions belong in their own column (2026-09-25) ────────────────────────────────────────
// With the address and the buttons in ONE cell, a long address pushed the buttons onto a second
// line and no two rows lined up — worst on 'account@hanumanworldphuket.com'.
test('the send list puts actions in a column of their own', () => {
  const src = grab('drawMailSendList').replace(/\/\/.*$/gm, '');
  assert.match(src, /class="msend-actions"/, 'actions have their own cell');
  const header = src.slice(src.indexOf('<thead>'), src.indexOf('</thead>'));
  assert.equal((header.match(/<th[ >]/g) || []).length, 5,   // not /<th/, which matches <thead
    'five headers: entity, merchant, payout, the reason column, and actions');
  const rowFn = src.slice(src.indexOf('const row ='), src.indexOf('const section'));
  assert.equal((rowFn.match(/<td/g) || []).length, 5, 'and five cells to match');
});

// ── A file carried by a template (2026-09-25) ──────────────────────────────────────────────
// A plain message can carry a file — a notice, a rate card — uploaded once and sent with every
// message using that template. A statement cannot: it already attaches the merchant's own
// figures, and two attachments raise the question of which one matters.
test('a message can carry several files, each with its own type', () => {
  const mime = buildMimeMessage({
    from: 'partner.th@inforich.com', to: ['a@b.com'], subject: 'Notice', body: 'See attached.',
    attachments: [{ bytes: new Uint8Array([37, 80, 68, 70]), filename: 'notice.pdf', type: 'application/pdf' }],
  });
  assert.match(mime, /Content-Type: application\/pdf/);
  assert.match(mime, /filename="notice\.pdf"/);
  assert.ok(!/spreadsheetml/.test(mime),
    'the type used to be hard-coded to Excel, which would label a PDF unopenable');
});

test('a statement still gets the spreadsheet type without being told', () => {
  const mime = buildMimeMessage({
    from: 'a@b.c', to: ['d@e.f'], subject: 's', body: 'b',
    filename: 'AOT.xlsx', attachment: new Uint8Array([80, 75, 3, 4]),
  });
  assert.match(mime, /spreadsheetml\.sheet/);
});

test('an attachment survives the round trip byte for byte', () => {
  // A corrupted attachment is worse than a missing one: it looks delivered.
  const bytes = new Uint8Array(Array.from({ length: 1000 }, (_, i) => (i * 7) % 256));
  const mime = buildMimeMessage({
    from: 'a@b.c', to: ['d@e.f'], subject: 's', body: 'b',
    attachments: [{ bytes, filename: 'x.bin', type: 'application/octet-stream' }],
  });
  const part = mime.split('Content-Disposition: attachment; filename="x.bin"')[1];
  const b64 = part.split('\r\n').filter(Boolean)[0];
  const back = Uint8Array.from(Buffer.from(b64, 'base64'));
  assert.deepEqual([...back], [...bytes]);
});

test('the send fetches a template file once, not once per recipient', () => {
  // Thirty recipients would otherwise mean thirty downloads of the same 5 MB.
  const src = grab('renderMessageSend');
  const fetchAt = src.indexOf('/attachment');
  const loopAt = src.indexOf('for (const to of list)');
  assert.ok(fetchAt > 0 && fetchAt < loopAt, 'fetched before the loop starts');
});

test('a failed attachment fetch sends nothing at all', () => {
  // Better than a letter whose attachment silently went missing.
  const src = grab('renderMessageSend');
  assert.match(src, /Nothing was sent/);
});

test('only a plain message offers an attachment field', () => {
  const src = grab('editMailTemplate');
  assert.match(src, /mailKind\(t\) === 'message' \? '' : ' hidden'/,
    'the field is hidden for a statement');
  assert.match(src, /!== 'message'/, 'and hides again if the kind is changed to statement');
});

test('the upload refuses a file too large to send, with its size', () => {
  const src = grab('editMailTemplate');
  assert.match(src, /5 \* 1024 \* 1024/);
  assert.match(src, /The limit is 5 MB/);
  assert.match(src, /fileSizeLabel\(file\.size\)/, 'and says how big the file actually is');
});

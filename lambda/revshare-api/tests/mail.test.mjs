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
const load = (...names) => new Function(
  names.map(grab).join('\n') + `\nreturn { ${names.join(', ')} };`)();

const { renderTemplate } = load('renderTemplate');
const recipientsWith = (contracts) => new Function('CONTRACTS',
  grab('splitAddresses') + '\n' + grab('mailRecipients') + '\nreturn mailRecipients;')(contracts);
const { buildMimeMessage, encodeHeaderWord, base64Url } =
  load('encodeHeaderWord', 'base64Url', 'buildMimeMessage');

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
    grab('splitAddresses') + '\n' + grab('fallbackContact') + '\nreturn fallbackContact;')(
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
  grab('splitAddresses') + '\n' + grab('knownAddresses') + '\nreturn knownAddresses;')(contracts);

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

test('the dialog shows the recipients the batch decided, and does not re-ask', () => {
  // Deciding per row AS WELL was considered and rejected: the top saying one thing while a row
  // was quietly changed is exactly how a test send reaches a merchant.
  const src = grab('mailSendDialog');
  assert.match(src, /effectiveRecipients\(result\.contractId\)/,
    'the dialog reads the batch decision');
  for (const gone of ['ms-known', 'ms-extra', 'knownAddresses(']) {
    assert.ok(!src.includes(gone), `${gone} is a per-row picker and must not return`);
  }
});

test('the dialog says when a send is not going to the merchant', () => {
  // A test send must not look identical to the real thing.
  const src = grab('mailSendDialog');
  assert.match(src, /not the merchant/,
    'it must say so when the batch is routed somewhere other than the merchant');
});

// ── Recipients decided once for the batch (2026-09-25) ─────────────────────────────────────
// "Once, at the top" (user). Two modes: each merchant's own address — the real job — or a fixed
// set, which is how a whole run is tested without a merchant receiving anything.
const sendToIn = (contracts, state) => new Function('CONTRACTS', 'MAIL_SEND_TO',
  grab('splitAddresses') + '\n' + grab('mailRecipients') + '\n'
  + grab('allMerchantAddresses') + '\n' + grab('effectiveRecipients')
  + '\nreturn { allMerchantAddresses, effectiveRecipients };')(contracts, state);

const CONTRACTS_FIXTURE = [
  { contractId: 'c1', merchantName: '7-Eleven', financeContactEmail: 'wiparatron@cpall.co.th' },
  { contractId: 'c2', merchantName: 'IMPACT', contactEmail: 'KornjiraS@impact.co.th, creditcontrol@impact.co.th' },
  { contractId: 'c3', merchantName: 'Shared Co', contactEmail: 'WIPARATRON@cpall.co.th' },
  { contractId: 'c4', merchantName: 'Gone', archived: true, contactEmail: 'old@x.com' },
  { contractId: 'c5', merchantName: 'No address' },
];

test('merchant mode sends each merchant its own address', () => {
  const f = sendToIn(CONTRACTS_FIXTURE, { mode: 'merchant', addresses: [] });
  assert.deepEqual(f.effectiveRecipients('c1'), ['wiparatron@cpall.co.th']);
  assert.deepEqual(f.effectiveRecipients('c5'), [], 'and none where there is none');
});

test('fixed mode sends EVERY merchant to the chosen addresses', () => {
  // This is what makes a whole-list test possible: the recipient stops depending on the row.
  const f = sendToIn(CONTRACTS_FIXTURE, { mode: 'fixed', addresses: ['ozzie.wang@inforich.com'] });
  assert.deepEqual(f.effectiveRecipients('c1'), ['ozzie.wang@inforich.com']);
  assert.deepEqual(f.effectiveRecipients('c5'), ['ozzie.wang@inforich.com'],
    'including merchants that have no address of their own');
});

test('the picker offers every address on file, grouped by address', () => {
  // One address can serve several merchants; listing it twice would let it be ticked twice and
  // sent twice.
  const all = sendToIn(CONTRACTS_FIXTURE, { mode: 'merchant', addresses: [] }).allMerchantAddresses();
  const shared = all.find(a => a.address.toLowerCase() === 'wiparatron@cpall.co.th');
  assert.ok(shared, 'the shared address is offered');
  assert.deepEqual(shared.merchants.sort(), ['7-Eleven', 'Shared Co']);
  assert.equal(all.filter(a => a.address.toLowerCase() === 'wiparatron@cpall.co.th').length, 1);
});

test('an archived merchant contributes no addresses', () => {
  const all = sendToIn(CONTRACTS_FIXTURE, { mode: 'merchant', addresses: [] }).allMerchantAddresses();
  assert.ok(!all.some(a => a.address === 'old@x.com'));
});

test('the batch mode is reset on every visit, never remembered', () => {
  // A test set left switched on from yesterday, silently applying to a real send, is the worst
  // outcome this screen has.
  const src = grab('renderMailSendTab');
  assert.match(src, /MAIL_SEND_TO = \{ mode: 'merchant', addresses: \[\] \}/,
    'the screen must reset the mode when it loads');
});

test('a fixed batch warns, in the list itself, that nothing reaches a merchant', () => {
  const src = grab('drawMailSendList');
  assert.match(src, /not to the merchants/,
    'the banner must say where the batch is actually going');
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

test('a statement screen asks for the period as step 2', () => {
  const src = grab('renderStatementSend');
  assert.match(src, /2 · Period/);
  assert.match(src, /3 · Send to/);
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
  assert.match(src, /effectiveRecipients\(result\.contractId\)/);
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
  grab('splitAddresses') + '\n' + grab('mailRecipients') + '\n'
  + grab('statementSendBlockers') + '\nreturn statementSendBlockers;')(contracts, state);

const RUN = { runId: 'r1', periodStart: '2026-08-01' };
const SEVEN = { contractId: 'c1', merchantName: '7-Eleven' };
const BOOKS = [
  { contractId: 'c1', merchantName: '7-Eleven', financeContactEmail: 'wiparatron@cpall.co.th' },
  { contractId: 'c2', merchantName: 'IMPACT', financeContactEmail: 'ap@impact.co.th' },
];

test('a clean send has nothing blocking it', () => {
  const f = blockersIn(BOOKS, { mode: 'merchant', addresses: [] });
  assert.deepEqual(f(SEVEN, RUN, ['wiparatron@cpall.co.th'], 'c1'), []);
});

test('a file built for another merchant blocks the send', () => {
  // The letter and the file both come from one row today, so this can only fail if a future
  // change threads a different row into one of them — which is exactly the change that would
  // otherwise ship silently.
  const f = blockersIn(BOOKS, { mode: 'merchant', addresses: [] });
  const out = f(SEVEN, RUN, ['wiparatron@cpall.co.th'], 'c2');
  assert.equal(out.length, 1);
  assert.match(out[0], /built for a different merchant/);
});

test('another merchant’s address blocks the send', () => {
  // Sending 7-Eleven's payout figures to IMPACT is the worst thing this screen could do.
  const f = blockersIn(BOOKS, { mode: 'merchant', addresses: [] });
  const out = f(SEVEN, RUN, ['ap@impact.co.th'], 'c1');
  assert.equal(out.length, 1);
  assert.match(out[0], /not a finance address for 7-Eleven/);
});

test('a deliberate fixed set is allowed, because that is what it is for', () => {
  // Test sends go somewhere that is not the merchant's address ON PURPOSE. The banner carries
  // the warning there; blocking it would make testing impossible.
  const f = blockersIn(BOOKS, { mode: 'fixed', addresses: ['ozzie.wang@inforich.com'] });
  assert.deepEqual(f(SEVEN, RUN, ['ozzie.wang@inforich.com'], 'c1'), []);
});

test('no recipient and no run both block', () => {
  const f = blockersIn(BOOKS, { mode: 'merchant', addresses: [] });
  assert.match(f(SEVEN, RUN, [], 'c1').join(' '), /no recipient/i);
  assert.match(f(SEVEN, null, ['wiparatron@cpall.co.th'], 'c1').join(' '), /not attached to a run/);
});

test('a fixed set containing a merchant address is named, not reassured away', () => {
  // The banner used to say "nothing reaches a merchant" unconditionally. If the chosen address
  // belongs to IMPACT, every merchant's figures would reach IMPACT — the opposite of comfort.
  const f = new Function('CONTRACTS',
    grab('splitAddresses') + '\n' + grab('allMerchantAddresses') + '\n'
    + grab('fixedSetOwners') + '\nreturn fixedSetOwners;')(BOOKS);
  assert.deepEqual(f(['ozzie.wang@inforich.com']), []);
  assert.match(f(['ap@impact.co.th'])[0], /IMPACT/);
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

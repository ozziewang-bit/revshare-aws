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

test('the finance address wins, and several addresses in one field are split', () => {
  // Real shape from the live data: IMPACT carries two addresses in one field.
  const f = recipientsWith([
    { contractId: 'c1', financeContactEmail: 'ap@x.com', contactEmail: 'ops@x.com' },
    { contractId: 'c2', contactEmail: 'KornjiraS@impact.co.th, creditcontrol@impact.co.th' },
  ]);
  assert.deepEqual(f('c1'), ['ap@x.com']);
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
  for (const group of ['Ready to send', 'Already sent', 'No email address']) {
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

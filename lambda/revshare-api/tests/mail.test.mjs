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
  grab('mailRecipients') + '\nreturn mailRecipients;')(contracts);
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

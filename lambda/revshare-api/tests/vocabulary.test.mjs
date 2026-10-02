import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// ── One vocabulary, enforced (2026-10-01) ───────────────────────────────────────────────────
// "I still see branch...come on, is it that hard, I am going crazy" · "and I also see shop, wtf,
// fix all wording !!!!!!!"
//
//   app      — this platform
//   Brand    — the file's `Merchant label` column
//   Merchant — the file's `merchant name (English)`: the shop, the branch
//   File     — the user's upload        Registry — what the app currently holds
//
// So branch, shop and store must not reach a screen. This was checked three times by hand and
// three times something was missed, because each pass was a throwaway script. It is a test now:
// the scan is worthless unless it runs on every change.
//
// WHAT THIS DELIBERATELY DOES NOT EXCLUDE: any string a person can read. The two earlier passes
// each failed by filtering too hard — one required a space in the match and so missed the single
// words 'Branches', 'Shop' and 'Stores'; one only looked at single-line templates. Identifiers,
// CSS selectors, data attributes and HTML attribute values are not screen text and are the only
// things dropped here.
const ROOT = new URL('../../../', import.meta.url);
const BAD = /\b(branch|branches|shop|shops|store|stores|storefront)\b/i;

// Values that are a real taxonomy or a FILE's own column name, not our wording for a merchant.
// Each entry is the EXACT literal, not a substring of a line — a broad entry would hide real
// screen text behind one allowance.
const ALLOWED = new Set([
  'Shopping Malls', 'Convenience Store',   // MERCHANT_TYPES — the platform's own taxonomy
  'store', 'store name', 'branch',         // WEEKLY_ALIASES: headers a FILE may carry, read not written
  'no-store',                              // a fetch cache directive
]);
// `store` as a verb, about keeping data — not about a merchant.
const VERB = /\b(?:not |does not |did not |cannot |can )?stores?\b(?=\s(?:it|this|them|the|a|any))/i;

function stripComments(src) {
  let out = '', i = 0;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === '/' && n === '/') { const j = src.indexOf('\n', i); out += '\n'; i = j < 0 ? src.length : j + 1; continue; }
    if (c === '/' && n === '*') { const j = src.indexOf('*/', i); out += ' '; i = j < 0 ? src.length : j + 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) { if (src[j] === '\\') j++; j++; }
      out += src.slice(i, j + 1); i = j + 1; continue;
    }
    out += c; i++;
  }
  return out;
}

// SCREEN TEXT IS WHAT IS INSIDE A STRING, between the interpolations. That is the one
// discrimination that holds: `${r.branches}` is code and reads nothing to anybody, while
// `${n} branch${n === 1 ? '' : 'es'}` has the word sitting in the literal text around it.
//
// An earlier version of this scan tried to subtract identifiers from whole LINES and drowned in
// `b.branches` / `x.store` — property names, in value position, which no filter of that shape
// can tell from prose. So: pull the literals out, drop the `${...}` holes, and judge what is
// left. Three forms of literal are then dropped because they are addresses, not sentences.
// Returns [text, line] for every string in the file. Offsets are tracked so a multi-line
// template reports the line its WORDS are on.
function screenText(src) {
  const out = [];
  let i = 0, line = 1;
  while (i < src.length) {
    const c = src[i];
    if (c !== '"' && c !== "'" && c !== '`') { if (c === '\n') line++; i++; continue; }
    let j = i + 1, depth = 0, chunk = '', at = line;
    const flush = () => { if (chunk.trim()) out.push([chunk, at]); chunk = ''; at = line; };
    while (j < src.length) {
      if (src[j] === '\\') { j += 2; continue; }
      if (c === '`' && src[j] === '$' && src[j + 1] === '{') {   // a hole: skip the expression
        depth = 1; j += 2;
        while (j < src.length && depth) {
          if (src[j] === '{') depth++; else if (src[j] === '}') depth--;
          else if (src[j] === '\n') line++;
          j++;
        }
        chunk += ' \u0000 ';                                    // and mark the gap
        continue;
      }
      if (src[j] === c) break;
      // A newline inside a template ends the chunk, so the line reported is the words' own.
      if (src[j] === '\n') { line++; flush(); } else chunk += src[j];
      j++;
    }
    flush();
    i = j + 1;
  }
  return out;
}

// Not a sentence: a path or URL, a bare identifier / kebab-case token, an inline style rule.
const isAddress = (s) => {
  const t = s.trim();
  return !t || /^[/.#?&]/.test(t) || /^[a-z][a-z0-9_-]*$/.test(t)
      || (t.includes(':') && t.includes(';') && !/\s[A-Z]/.test(t));
};

// An HTML attribute NAME is markup, not text, and so is the value of the handful of attributes
// that only ever hold identifiers — `class`, `id`, `for` and every `data-*`. Everything else
// keeps its value, because `title=` and `placeholder=` ARE read off the screen and dropping
// whole attributes is the hole that let three hand passes through.
const MARKUP_ATTR = /\b(?:class|id|for|name|data-[a-z0-9-]+)=["'][^"']*["']/g;
const dropAttrNames = (s) => s.replace(MARKUP_ATTR, ' ').replace(/\b[a-z][a-z0-9-]*=(?=["'])/g, ' ');

function offenders(file) {
  const raw = readFileSync(new URL(file, ROOT), 'utf8');
  const out = [];
  if (file.endsWith('.js')) {
    // ONE PASS OVER THE WHOLE FILE, not line by line. stripComments keeps one newline per
    // comment line, so the line numbers still point at the source.
    for (const [s, line] of screenText(stripComments(raw))) {
      const text = dropAttrNames(s);
      if (!BAD.test(text) || isAddress(s) || ALLOWED.has(s.trim()) || VERB.test(text)) continue;
      out.push(`${file}:${line}  ${s.trim().slice(0, 120)}`);
    }
    return out;
  }
  // HTML: every text node and every title/placeholder is read.
  raw.split('\n').forEach((line, i) => {
    const text = line.replace(/<[^>]*>/g, ' ') + ' '
      + (line.match(/(?:title|placeholder|aria-label)="([^"]*)"/g) || []).join(' ');
    if (BAD.test(dropAttrNames(text)) && !VERB.test(text)) {
      out.push(`${file}:${i + 1}  ${line.trim().slice(0, 120)}`);
    }
  });
  return out;
}

test('no screen in the app says branch, shop or store', () => {
  const found = [...offenders('frontend/app.js'), ...offenders('frontend/index.html')];
  assert.deepEqual(found, [], 'these reach a screen:\n' + found.join('\n'));
});

test('the scanner can still see the words it is looking for', () => {
  // A filter that excludes the case it is checking for passes while the bug is on screen. These
  // are the exact four lines that survived three hand passes; each must be caught.
  const samples = [
    "        ? ` <span class=\"muted\">· ${branchCount} branch${branchCount === 1 ? '' : 'es'}</span>` : ''}</div>",
    "  if (m.branchCount) bits.push(`${m.branchCount} branch${m.branchCount === 1 ? '' : 'es'} recorded.`);",
    "        faults.push(`${item.branchCount} live branch rows start with this name`",
    "      diffs.push({ field: 'Branch', from: String(existing.branchCount ?? ''), to: String(branches) });",
    "      html += t(['Brand', 'Branches', 'Shop', 'Stores'],",
  ];
  for (const s of samples) {
    const seen = screenText(stripComments(s))
      .filter(([x]) => BAD.test(dropAttrNames(x)) && !isAddress(x) && !ALLOWED.has(x.trim()));
    assert.ok(seen.length, `the scan would have missed: ${s.trim().slice(0, 70)}`);
  }
});

test('a MULTI-LINE template is scanned, and reports the line the words are on', () => {
  // `shop(s) across` lived on its own line inside a template whose backtick was two lines up.
  // A per-line parse sees that line as bare code and reads nothing in it — which is how this
  // exact string survived three hand passes and the first version of this test.
  const src = [
    'const html = `',
    "  <div>${j.stores.size.toLocaleString('en-US')} shop(s) across ${n} brand(s)</div>",
    '`;',
  ].join('\n');
  const hits = screenText(src).filter(([x]) => BAD.test(dropAttrNames(x)));
  assert.equal(hits.length, 1, 'the words inside a multi-line template must be seen');
  assert.equal(hits[0][1], 2, 'and reported on their own line, not the backtick’s');
});

test('a title or placeholder is still read, even though class and data-* are not', () => {
  const read = `<button class="ct-branch" data-brand="x" title="Show the branches">go</button>`;
  const seen = screenText('`' + read + '`').filter(([x]) => BAD.test(dropAttrNames(x)));
  assert.ok(seen.length, 'a tooltip is screen text and must be scanned');
  const markup = `<button class="ct-branch" data-store="x" id="shop-list">go</button>`;
  assert.deepEqual(screenText('`' + markup + '`').filter(([x]) => BAD.test(dropAttrNames(x))), [],
    'a class, an id and a data-* value are identifiers, not words');
});

test('an identifier or a selector is NOT reported', () => {
  for (const s of ['  const b = fileBrandOf(c); return b ? b.branches : null;',
                   "  if (branch) { openBranchList(branch.dataset.brand); return; }",
                   "  for (const [store, entry] of byStore) {",
                   "  out.noContract.push({ label: b.label, branches: b.branches });",
                   "    data = await api('/roster/shops?brand=' + encodeURIComponent(brand));",
                   "  const shops = data.shops || [], held = data.heldBack || [];"]) {
    const seen = screenText(stripComments(s))
      .filter(([x]) => BAD.test(dropAttrNames(x)) && !isAddress(x) && !ALLOWED.has(x.trim()));
    assert.deepEqual(seen, [], `false positive: ${s.trim()}`);
  }
});

test('nor does the backend put those words in anything a person reads', () => {
  const dir = new URL('../code/', import.meta.url);
  const files = ['db.mjs', 'payout.mjs', 'contracts.mjs', 'rules.mjs', 'engine.mjs']
    .concat(readdirSync(new URL('routes/', dir)).map(f => 'routes/' + f));
  const found = [];
  for (const f of files) {
    const src = stripComments(readFileSync(new URL(f, dir), 'utf8'));
    src.split('\n').forEach((line, i) => {
      for (const s of line.match(/'[^']{12,}'|"[^"]{12,}"|`[^`]{12,}`/g) || []) {
        if (BAD.test(dropAttrNames(s)) && /\s/.test(s) && !ALLOWED.has(s.trim()) && !VERB.test(s)) {
          found.push(`${f}:${i + 1}  ${s.slice(0, 110)}`);
        }
      }
    });
  }
  assert.deepEqual(found, [], found.join('\n'));
});

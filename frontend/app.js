// === API / region ===
// One site, two backends. Both API URLs are public (no auth). Switching region
// persists to localStorage and reloads (see switchRegion) so no TH/SG state bleeds.
const REGIONS = {
  th: { name: 'Thailand',  api: 'https://7z269nmx74.execute-api.ap-southeast-7.amazonaws.com/prod', ccy: 'THB', sym: '฿',  notFound: 'ไม่พบข้อมูล' },
  sg: { name: 'Singapore', api: 'https://4qcyojfg79.execute-api.ap-southeast-7.amazonaws.com/prod', ccy: 'SGD', sym: 'S$', notFound: 'Not found'   },
};
let REGION = (localStorage.getItem('rs_region') in REGIONS) ? localStorage.getItem('rs_region') : 'th';
const R = () => REGIONS[REGION];
const API_URL = R().api;
const GOOGLE_CLIENT_ID = '1087526052921-3426va3t0ah8lnbfndvp739uf37sc7uv.apps.googleusercontent.com';   // public OAuth client ID
let ID_TOKEN = localStorage.getItem('rs_idtoken') || '';
let ME = null;   // { email, name, permissions }
const can = perm => !!(ME && ME.permissions && ME.permissions[perm]);
const CCY = R().ccy;

// ── Rule form helpers ──────────────────────────────────────────────────────

// Four payout methods (form.method):
//   default       → single term payout (just the one term)
//   hybrid        → sum of all terms
//   higher        → max( each comparable term … , MG ) + Electricity  — highest of
//                   GP/Placement/Others/MG, with electricity always added on top
//   hybrid-higher → max( sum of comparable terms , MG ) + Electricity — summed
//                   GP/Placement/Others vs MG, whichever higher, plus electricity
// Electricity is a cost reimbursement, not a comparison candidate: it is excluded from
// the WH/HH max() and added to whatever the comparison settles on (2026-08-06).
// Leaves are tagged (_t = term), root tagged (_method) so decompile is exact.
const PAYOUT_METHODS = ['default', 'hybrid', 'higher', 'hybrid-higher'];

function compileRule(form) {
  const { gpPercent, electricity, placementRows, others, mgRows } = form;
  const method = PAYOUT_METHODS.includes(form.method) ? form.method : 'hybrid';

  const gpLeaf = Number(gpPercent) > 0
    ? { type: 'percent', _t: 'gp', rows: [{ model: 'ALL', percent: Number(gpPercent) }] } : null;
  const elecLeaf = Number(electricity) > 0
    ? { type: 'flat_per_partner_total', _t: 'elec', amount: Number(electricity) } : null;
  const vp = (placementRows || []).filter(r => r.model && Number(r.amount) > 0);
  const placementLeaf = vp.length
    ? { type: 'flat_per_machine', _t: 'placement', rows: vp.map(r => ({ model: r.model, amount: Number(r.amount) })) } : null;
  const othersLeaf = Number(others) > 0
    ? { type: 'flat_per_partner_total', _t: 'others', amount: Number(others) } : null;
  const vmg = (mgRows || []).filter(r => r.model && Number(r.amount) > 0);
  const mgLeaf = vmg.length
    ? { type: 'flat_per_machine', _t: 'mg', rows: vmg.map(r => ({ model: r.model, amount: Number(r.amount) })) } : null;

  // Electricity is a cost reimbursement — it never competes in a max(), it is added to
  // whatever the comparison settles on. Keep in lockstep with routes/import.mjs.
  const cmpTerms = [gpLeaf, placementLeaf, othersLeaf].filter(Boolean);
  const allTerms = [gpLeaf, elecLeaf, placementLeaf, othersLeaf].filter(Boolean);

  const zero = () => ({ type: 'percent', _t: 'gp', rows: [{ model: 'ALL', percent: 0 }] });
  const nest = (type, list) => list.length === 0 ? null : (list.length === 1 ? list[0] : { type, children: list });
  const addElec = core => elecLeaf ? (core ? { type: 'sum', children: [core, elecLeaf] } : elecLeaf) : (core || zero());

  let rule;
  if (method === 'higher') {
    rule = addElec(nest('max', mgLeaf ? [...cmpTerms, mgLeaf] : cmpTerms));
  } else if (method === 'hybrid-higher') {
    const s = nest('sum', cmpTerms);
    rule = addElec(mgLeaf ? (s ? { type: 'max', children: [s, mgLeaf] } : mgLeaf) : s);
  } else {
    rule = nest('sum', allTerms) || zero();   // default | hybrid (MG not used)
  }
  return { ...rule, _method: method };
}

function legacyRole(node, ctx) {
  if (node.type === 'percent') return 'gp';
  if (node.type === 'flat_per_partner_total') return 'elec';
  if (node.type === 'flat_per_machine') return ctx === 'add' ? 'placement' : 'mg';
  return null;
}

function decompileRule(rule) {
  const base = { gpPercent: 0, electricity: 0, placementRows: [], others: 0, mgRows: [], method: 'hybrid' };
  // mgEnabled/mgAmount kept for back-compat with the share-terms CSV export.
  const compat = f => ({ ...f, mgEnabled: f.mgRows.length > 0, mgAmount: f.mgRows[0]?.amount ?? 0 });
  if (!rule || typeof rule !== 'object') return compat({ ...base, placementRows: [], mgRows: [] });
  const rowsOf = n => (n.rows || []).map(r => ({ model: r.model, amount: r.amount ?? 0 }));

  const leaves = [];
  (function walk(n, ctx) {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'sum') (n.children || []).forEach(c => walk(c, 'add'));
    else if (n.type === 'max') (n.children || []).forEach(c => walk(c, 'max'));
    else leaves.push({ node: n, ctx });
  })(rule, rule.type === 'max' ? 'max' : 'add');

  const f = { ...base, placementRows: [], mgRows: [] };
  for (const { node, ctx } of leaves) {
    const role = node._t || legacyRole(node, ctx);
    if (role === 'gp') f.gpPercent = node.rows?.[0]?.percent ?? 0;
    else if (role === 'elec') f.electricity = node.amount ?? 0;
    else if (role === 'placement') f.placementRows.push(...rowsOf(node));
    else if (role === 'others') f.others = node.amount ?? 0;
    else if (role === 'mg') f.mgRows.push(...rowsOf(node));
  }

  // The comparison node is the root max, or a max wrapped in a root sum alongside the
  // always-added electricity lump.
  const cmpNode = rule.type === 'max' ? rule
    : (rule.type === 'sum' ? (rule.children || []).find(c => c.type === 'max') : null);
  if (PAYOUT_METHODS.includes(rule._method)) {
    f.method = rule._method;
  } else if (cmpNode) {
    f.method = (cmpNode.children || []).some(c => c.type === 'sum') ? 'hybrid-higher' : 'higher';
  } else {
    const termCount = [f.gpPercent > 0, f.electricity > 0, f.placementRows.length > 0, f.others > 0].filter(Boolean).length;
    f.method = termCount <= 1 ? 'default' : 'hybrid';
  }
  return compat(f);
}

const PAYOUT_METHOD_META = [
  { val: 'default',       code: 'D',  title: 'Default',             desc: 'Single term — just pay it' },
  { val: 'hybrid',        code: 'H',  title: 'Hybrid',              desc: 'All terms summed' },
  { val: 'higher',        code: 'WH', title: 'Whichever is higher', desc: 'Highest of each term, incl. MG — electricity added on top' },
  { val: 'hybrid-higher', code: 'HH', title: 'Hybrid-higher',       desc: 'max( summed terms , MG ) — electricity added on top' },
];
// Accept the payout-method NAME (default / hybrid / whichever higher / hybrid-higher); legacy codes (D/H/WH/HH) still work.
const parseMethod = input => {
  const s = String(input || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (!s) return 'hybrid';
  if (PAYOUT_METHODS.includes(s)) return s;
  const byCode = PAYOUT_METHOD_META.find(m => m.code.toLowerCase() === s);
  if (byCode) return byCode.val;
  if (s.includes('hybrid') && s.includes('high')) return 'hybrid-higher';
  if (s.startsWith('default')) return 'default';
  if (s.includes('whichever') || s.includes('higher')) return 'higher';
  if (s.includes('hybrid')) return 'hybrid';
  return 'hybrid';
};
const methodToName = v => (PAYOUT_METHOD_META.find(m => m.val === v) || {}).title || 'Hybrid';

function presentTermLabels(form) {
  const out = [];
  if (Number(form.gpPercent) > 0) out.push('GP%');
  if (Number(form.electricity) > 0) out.push('Electricity');
  if ((form.placementRows || []).some(r => r.model && Number(r.amount) > 0)) out.push('Placement');
  if (Number(form.others) > 0) out.push('Others');
  return out;
}

// Readable payout formula for the selected method.
function payoutFormula(form) {
  const labels = presentTermLabels(form);
  const hasElec = Number(form.electricity) > 0;
  const cmp = labels.filter(l => l !== 'Electricity');   // electricity never competes
  const hasMg = (form.mgRows || []).some(r => r.model && Number(r.amount) > 0);
  const method = form.method || 'hybrid';
  const withElec = base => hasElec ? (base ? `${base} + Electricity` : 'Electricity') : (base || '0');

  if (method === 'higher') {
    const c = hasMg ? [...cmp, 'MG'] : [...cmp];
    return withElec(c.length === 0 ? '' : (c.length === 1 ? c[0] : `max( ${c.join(' , ')} )`));
  }
  if (method === 'hybrid-higher') {
    const s = cmp.join(' + ');
    return withElec(hasMg ? (s ? `max( ${s} , MG )` : 'MG') : s);
  }
  return labels.join(' + ') || '0';   // default | hybrid
}


function readExcel(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const wb = XLSX.read(e.target.result, { type: 'binary' });
        resolve(wb);
      } catch (err) { reject(err); }
    };
    reader.onerror = reject;
    reader.readAsBinaryString(file);
  });
}

// ── Merchant-list (Businessmen list) parser ────────────────────────────────
// Keep in step with engine.mjs MACHINE_MODELS and merchants.mjs VALID_MODELS. parseDeviceModel
// picks the LONGEST match, which is what keeps these apart: "…-LL40" also ends with "L40", and
// "…-S10-A" also contains "S10". LL20, LL40 and L20 are distinct codes — the Thai roster has
// both LL40 and L20 machines.
const RS_MODELS = ['S5','S8','S10','T8','T10','T20','T35','L20','L40','M10','LL20','LL40','S10-A'];

function parseDeviceModel(deviceType) {
  const s = String(deviceType || '').toUpperCase();
  // trailing model code, e.g. "ADVERTISING PLAYER-S5" -> S5
  const hit = RS_MODELS.filter(m => s.endsWith(m) || s.includes('-' + m) || s.includes(' ' + m));
  return hit.length ? hit.sort((a, b) => b.length - a.length)[0] : null;
}

// Returns the Approved rows the run uses, AND the rows it dropped. The dropped ones are not
// paid — a review state of Disapproved or Pending means exactly that — but a store in that
// state can still be taking rentals, and its orders then land in `unmatched` looking like a
// name nobody recognises. Sending them lets the run say which is which.
async function parseMerchantList(file) {
  const wb = await readExcel(file);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: null });
  const named = rows.filter(r => String(r['merchant name.'] || '').trim());
  const approved = r => String(r['Merchant Review State'] || '').trim().toLowerCase() === 'approved';
  return {
    merchants: named.filter(approved).map(r => ({
      name: String(r['merchant name.'] || '').trim(),
      nameEn: String(r['merchant name (English)'] || '').trim(),
      partnerName: String(r['Merchant label'] || '').trim(),
      model: parseDeviceModel(r['device type.']),
      externalId: String(r['ID'] || '').trim(),
    })),
    excluded: named.filter(r => !approved(r)).map(r => ({
      name: String(r['merchant name.'] || '').trim(),
      label: String(r['Merchant label'] || '').trim(),
      reviewState: String(r['Merchant Review State'] || '').trim() || 'Not approved',
    })),
  };
}

const MERCHANT_LIST_COLUMNS = [
  'ID','merchant name.','merchant name (English)','contact','phone','Country','Province','City','County',
  'Address','Address(English)','merchant type.','Merchant grade','Merchant label','Advertising State',
  'Sharing amount','device type.','Cumulative Rental','Sales employee','Person in charge','Operator',
  'Cumulative Return','entry time.','Create time','update time','Contract start date','Contract expire date',
  'Location','Merchant Review State','Longitude','Latitude','Monday business hours',
  'Tuesday Business Hours','Wednesday business hours','Thursday business hours',
  'Business hours on Friday','Saturday business hours','Business hours on Sundays','Remark 1','Remark 2'
];

function downloadMerchantListSample() {
  const example = MERCHANT_LIST_COLUMNS.map(col => {
    if (col === 'merchant name.') return 'Example Merchant';
    if (col === 'merchant name (English)') return 'Example Merchant';
    if (col === 'Merchant label') return 'Example Partner';
    if (col === 'device type.') return 'Advertising Player-S8';
    if (col === 'Merchant Review State') return 'Approved';
    return '';
  });
  const ws = XLSX.utils.aoa_to_sheet([MERCHANT_LIST_COLUMNS, example]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Businessmen list');
  XLSX.writeFile(wb, 'merchant-list-sample.xlsx');
}

async function api(path, opts = {}) {
  const headers = { 'content-type': 'application/json', ...(opts.headers || {}) };
  if (ID_TOKEN) headers['authorization'] = 'Bearer ' + ID_TOKEN;
  const res = await fetch(API_URL + path, { ...opts, headers });
  if (res.status === 401) { ID_TOKEN = ''; localStorage.removeItem('rs_idtoken'); showLoginGate(); initGsi(); throw new Error('unauthenticated'); }
  if (!res.ok) { const text = await res.text(); throw new Error(`HTTP ${res.status}: ${text}`); }
  if (res.status === 204) return null;
  return res.json();
}

// Inflate a gzipped body. `DecompressionStream` is in every browser this app supports; if it
// somehow is not, say so rather than hand back a half-read object.
function showLoginGate(msg) {
  // NOTE: the gate has inline `display:flex`, which overrides the [hidden] attribute —
  // so we must toggle style.display directly, not just the hidden property.
  const g = document.getElementById('login-gate'); if (g) { g.hidden = false; g.style.display = 'flex'; }
  const m = document.getElementById('main'); if (m) m.style.display = 'none';
  if (msg) { const e = document.getElementById('login-err'); if (e) e.textContent = msg; }
}
function hideLoginGate() {
  const g = document.getElementById('login-gate'); if (g) { g.hidden = true; g.style.display = 'none'; }
  const m = document.getElementById('main'); if (m) m.style.display = '';
}
// Fetch the caller's profile, retrying transient failures (5xx / network) — e.g. the IAM
// permission to read RevshareUsers can lag a fresh deploy by a few seconds. A 401 ("token
// rejected") is NOT retried — that means the token is genuinely bad.
async function fetchMe() {
  for (let i = 0; ; i++) {
    try { return await api('/me'); }
    catch (e) {
      if (e.message === 'unauthenticated' || i >= 3) throw e;
      await new Promise(r => setTimeout(r, 600 * (i + 1)));
    }
  }
}
async function onCredential(response) {
  ID_TOKEN = response.credential; localStorage.setItem('rs_idtoken', ID_TOKEN);
  let me; try { me = await fetchMe(); } catch (e) {
    if (e.message === 'unauthenticated') { showLoginGate('That account is not allowed. Use your @inforich.com / @inforichjapan.com account.'); }
    else { showLoginGate('Sign-in hit a temporary error — please reload. (' + e.message + ')'); }
    return;
  }
  ME = me; hideLoginGate(); initApp();
}
function initGsi() {
  if (!window.google || !google.accounts) { return setTimeout(initGsi, 200); }
  google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: onCredential, auto_select: true });
  google.accounts.id.renderButton(document.getElementById('gsi-btn'), { theme: 'outline', size: 'large', type: 'standard' });
  google.accounts.id.prompt();
}
// ── "A new version is available" ──────────────────────────────────────────
// A deploy replaces the service worker, but a tab that is already open keeps running the
// JavaScript it parsed at load time — so someone can sit on a stale build indefinitely and
// never know. The worker now waits instead of taking over silently; this notices it and asks.
//
// Deliberately a prompt rather than an automatic reload: someone may be mid-way through the
// run wizard with an uploaded roster held in memory, and reloading under them would discard it.
let updatePromptShown = false;

function showUpdatePrompt(reg) {
  if (updatePromptShown) return;
  updatePromptShown = true;

  const box = document.createElement('div');
  // Inline styles, and appended to <body> rather than #main: this has to be able to appear over
  // the login gate too, which replaces the app's markup entirely.
  box.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;'
    + 'justify-content:center;background:rgba(15,18,24,.45);backdrop-filter:blur(2px);';
  box.innerHTML = `
    <div role="dialog" aria-modal="true" aria-labelledby="sw-up-t" style="background:#fff;border-radius:12px;
         box-shadow:0 18px 48px rgba(0,0,0,.25);max-width:420px;width:calc(100% - 40px);padding:22px 24px;
         font-family:inherit;">
      <h3 id="sw-up-t" style="margin:0 0 6px;font-size:17px;">A new version is available</h3>
      <p style="margin:0 0 18px;font-size:13.5px;line-height:1.5;color:#5c6470;">
        This page is running an older build. Reload to pick up the latest changes.
        Anything you have typed or uploaded but not saved will be lost.
      </p>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button type="button" id="sw-up-later" class="btn-ghost">Not now</button>
        <button type="button" id="sw-up-now" class="btn-primary">Reload</button>
      </div>
    </div>`;
  document.body.appendChild(box);

  // "Not now" must not nag: the prompt returns on the next update, or the next page load.
  box.querySelector('#sw-up-later').addEventListener('click', () => box.remove());
  box.querySelector('#sw-up-now').addEventListener('click', () => {
    const btn = box.querySelector('#sw-up-now');
    btn.disabled = true; btn.textContent = 'Reloading…';
    const waiting = reg && reg.waiting;
    if (!waiting) { location.reload(); return; }
    // controllerchange fires once the waiting worker takes over — reload THEN, so the new page
    // is served by the new worker rather than racing it.
    navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
    waiting.postMessage({ type: 'SKIP_WAITING' });
    // If the worker never reports back (an old browser, or it was already active), don't leave
    // the viewer staring at a disabled button.
    setTimeout(() => location.reload(), 3000);
  });
}

async function initUpdatePrompt() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return;
    // Already waiting when this tab loaded — e.g. the deploy happened while it was closed.
    if (reg.waiting && navigator.serviceWorker.controller) showUpdatePrompt(reg);
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      if (!nw) return;
      nw.addEventListener('statechange', () => {
        // `controller` is null on the very first install; prompting then would ask someone to
        // reload a page that is already current.
        if (nw.state === 'installed' && navigator.serviceWorker.controller) showUpdatePrompt(reg);
      });
    });
    // A tab left open overnight would otherwise never check. Poll quietly, and again whenever
    // it comes back to the foreground, which is when someone is about to act on what they see.
    const check = () => reg.update().catch(() => {});
    setInterval(check, 5 * 60 * 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  } catch { /* update prompting is a nicety — never let it break boot */ }
}

async function boot() {
  initUpdatePrompt();
  if (ID_TOKEN) {
    let me = null;
    try { me = await fetchMe(); } catch (_) { me = null; }   // transient/invalid → fall back to sign-in
    if (me) { ME = me; hideLoginGate(); initApp(); return; }  // initApp runs OUTSIDE the try — an app error never bounces back to the gate
  }
  showLoginGate(); initGsi();
}

// === router + screens ===
function initApp() {
  const rs = document.getElementById('region-switch');
  if (rs) { rs.value = REGION; rs.onchange = e => switchRegion(e.target.value); }
  renderNav();
  renderContractsScreen();   // Overview is the first tab, so it is also the landing screen
}

function switchRegion(rk) {
  if (!(rk in REGIONS) || rk === REGION) return;
  try { localStorage.setItem('rs_region', rk); } catch {}
  location.reload();   // full reset — partner/run/merchant state is per-backend
}

// ── Feature requests ──────────────────────────────────────────────────────
// A header button rather than a nav tab: filing one is a thing you do mid-task, and it should
// not cost you the screen you are on. The dialog carries which screen you were looking at,
// because that is usually half the request.
const FR_STATUS = { open: 'Open', planned: 'Planned', done: 'Done', declined: 'Declined' };

function currentScreenName() {
  const active = document.querySelector('.nav-btn.active');
  return active ? active.textContent.trim() : '';
}

async function openFeatureRequests() {
  const { card, close } = ctModal(680);
  card.innerHTML = `
    <h3 style="margin:0 0 4px;">Feature requests</h3>
    <p class="muted" style="margin:0 0 14px;font-size:12.5px;">
      What is this app missing, or what slows you down? Anyone can file one; ${escape(R().name)} and
      Singapore keep separate lists.
    </p>
    <label style="font-size:12.5px;color:var(--ink-soft);">What would you like?
      <input id="fr-title" class="input" maxlength="140" placeholder="One line — e.g. show last month next to this one" style="display:block;margin-top:4px;width:100%;">
    </label>
    <label style="font-size:12.5px;color:var(--ink-soft);display:block;margin-top:10px;">Any detail (optional)
      <textarea id="fr-detail" class="input" rows="3" maxlength="4000" placeholder="Why it matters, or what you do today instead" style="display:block;margin-top:4px;width:100%;resize:vertical;"></textarea>
    </label>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;">
      <button type="button" id="fr-cancel" class="btn-ghost">Close</button>
      <button type="button" id="fr-send" class="btn-primary">Send</button>
    </div>
    <div id="fr-status" style="margin-top:8px;font-size:13px;"></div>
    <div id="fr-list" style="margin-top:18px;border-top:1px solid var(--line);padding-top:14px;">Loading…</div>`;

  card.querySelector('#fr-cancel').addEventListener('click', close);
  card.querySelector('#fr-send').addEventListener('click', async () => {
    const title = card.querySelector('#fr-title').value.trim();
    const statusEl = card.querySelector('#fr-status');
    if (!title) { statusEl.className = 'form-error'; statusEl.textContent = 'A one-line description is required.'; return; }
    const btn = card.querySelector('#fr-send');
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      await api('/feature-requests', { method: 'POST', body: JSON.stringify({
        title, detail: card.querySelector('#fr-detail').value.trim(), screen: currentScreenName() }) });
      card.querySelector('#fr-title').value = '';
      card.querySelector('#fr-detail').value = '';
      statusEl.className = ''; statusEl.style.color = '#2b8a3e';
      statusEl.textContent = 'Thanks — filed.';
      await loadRequests();
    } catch (e) {
      statusEl.className = 'form-error'; statusEl.textContent = e.message || 'Could not file that — try again.';
    } finally { btn.disabled = false; btn.textContent = 'Send'; }
  });

  async function loadRequests() {
    const box = card.querySelector('#fr-list');
    let rows = [];
    try { rows = await api('/feature-requests'); }
    catch (e) { box.innerHTML = `<p class="muted">Could not load existing requests: ${escape(e.message)}</p>`; return; }
    if (!rows.length) { box.innerHTML = '<p class="muted" style="font-size:13px;">No requests yet.</p>'; return; }
    box.innerHTML = `<table style="font-size:13px;width:100%;">
      <thead><tr><th style="text-align:left;">Request</th><th style="text-align:left;">From</th><th style="text-align:left;">Status</th>${can('admin') ? '<th></th>' : ''}</tr></thead>
      <tbody>${rows.map(r => `<tr>
        <td><strong>${escape(r.title)}</strong>
          ${r.detail ? `<div class="muted" style="font-size:12px;white-space:pre-wrap;">${escape(r.detail)}</div>` : ''}
          ${r.screen ? `<div class="muted" style="font-size:11.5px;">on ${escape(r.screen)}</div>` : ''}</td>
        <td class="muted">${escape((r.createdBy || '').split('@')[0])}<div style="font-size:11.5px;">${escape((r.createdAt || '').slice(0, 10))}</div></td>
        <td>${escape(FR_STATUS[r.status] || r.status || 'Open')}</td>
        ${can('admin') ? `<td style="text-align:right;white-space:nowrap;">
          <select class="fr-set" data-id="${escape(r.id)}" style="font-size:12px;">
            ${Object.entries(FR_STATUS).map(([v, l]) => `<option value="${v}"${r.status === v ? ' selected' : ''}>${l}</option>`).join('')}
          </select></td>` : ''}
      </tr>`).join('')}</tbody></table>`;
    box.querySelectorAll('.fr-set').forEach(sel => sel.addEventListener('change', async () => {
      sel.disabled = true;
      try { await api(`/feature-requests/${encodeURIComponent(sel.dataset.id)}`, { method: 'PUT', body: JSON.stringify({ status: sel.value }) }); await loadRequests(); }
      catch (e) { alert(`Could not update: ${e.message}`); sel.disabled = false; }
    }));
  }
  loadRequests();
}

function renderNav() {
  const nav = document.getElementById('topnav');
  // FIVE destinations since 2026-09-25. The nav was folded to four on purpose (Analytics reads
  // the same runs Run share lists; Device types / Users are both configuration), and Mailing
  // was added back out of Settings by explicit decision: what gets written to a merchant is
  // not configuration, it is work someone does, and burying it two clicks deep under Settings
  // made it read as a preference. If a sixth is ever proposed, re-read this and the §1b note.
  //
  // Run share is NOT gated on runCalcs: reads are open backend-side, and gating the nav here
  // was also hiding Analytics from read-only users. Creating a run is still gated, on the
  // + New run button. Mailing is the same shape — anyone may read what was sent, sending is
  // gated where it happens.
  nav.innerHTML = `
    <button id="nav-contracts" class="nav-btn active">Overview</button>
    <button id="nav-upload" class="nav-btn">Upload</button>
    <button id="nav-bulk-runs" class="nav-btn">Run share</button>
    <button id="nav-mailing" class="nav-btn">Mailing</button>
    <button id="nav-archived" class="nav-btn">Archived</button>
    <button id="nav-settings" class="nav-btn">Settings</button>`;
  nav.querySelector('#nav-archived').addEventListener('click', () => { setActiveNav('nav-archived'); renderArchivedScreen(); });
  nav.querySelector('#nav-bulk-runs').addEventListener('click', () => { setActiveNav('nav-bulk-runs'); renderBulkRunsList(); });
  nav.querySelector('#nav-contracts').addEventListener('click', () => { setActiveNav('nav-contracts'); renderContractsScreen(); });
  // Not gated: reading what a file WOULD change is harmless, and the two buttons that write are
  // gated where they act — same shape as Run share, whose nav item is open while + New run is not.
  nav.querySelector('#nav-upload').addEventListener('click', () => { setActiveNav('nav-upload'); renderUploadScreen(); });
  nav.querySelector('#nav-settings').addEventListener('click', () => { setActiveNav('nav-settings'); renderSettingsScreen(); });
  nav.querySelector('#nav-mailing').addEventListener('click', () => { setActiveNav('nav-mailing'); renderMailingScreen(); });
  // Lives in the brand bar, not the nav, so it survives every screen change.
  const frBtn = document.getElementById('feature-request');
  if (frBtn && !frBtn.dataset.wired) { frBtn.dataset.wired = '1'; frBtn.addEventListener('click', openFeatureRequests); }
}

// In-screen tabs, shared by Run share and Settings so the two behave identically. The nav
// button stays active while these switch — they are views of one destination, not new ones.
function subTabsHtml(tabs, active) {
  return `<div class="subtabs">${tabs.map(t =>
    `<button type="button" class="subtab${t.id === active ? ' active' : ''}" data-tab="${t.id}">${escape(t.label)}</button>`).join('')}</div>`;
}

function wireSubTabs(root, go) {
  root.querySelectorAll('.subtab').forEach(b =>
    b.addEventListener('click', () => { if (!b.classList.contains('active')) go(b.dataset.tab); }));
}

// Every screen paint takes a token before it awaits anything and abandons the paint if the token
// is no longer current. Without it, a slow screen finishes into a DOM that belongs to a screen the
// user has since navigated to: the Reconcile tab's ~900KB run payload landing after a switch back
// to Merchants found `.subtabs` (which exists under BOTH), repainted it as Reconcile-active, then
// threw on `getElementById('rc-out').innerHTML` of null — an unhandled rejection, and the strip
// left lying about which tab you are on. It races in both directions, since the grid awaits too.
let PAINT_TOKEN = 0;
function newPaintToken() { return ++PAINT_TOKEN; }
function paintIsCurrent(token) { return token === PAINT_TOKEN; }

function setActiveNav(id) {
  newPaintToken();   // navigating away invalidates whatever paint is still in flight
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.id === id));
  // The merchant grid is ~2400px of columns; the app's 1100px content column hides most
  // of them behind a scrollbar. Let this one screen use the whole window.
  // Every screen takes the window (2026-09-25). This app is tables — merchants, runs, mail,
  // archived rows — and each of them was being squeezed into a 1100px reading column on a
  // 2000px display, which is what made addresses wrap and buttons fall out of line on Mailing.
  // Width is also what makes the next column cheap to add rather than a layout problem.
  //
  // PROSE is capped separately in the stylesheet: a paragraph 2000px wide is harder to read,
  // not easier, and that is the one thing a reading column was right about.
  document.getElementById('main')?.classList.add('main-wide');
}


// Configuration, one screen. Users is admin-only, so a non-admin sees Settings with a single
// tab rather than a nav item that 403s — the tab list is built from what you can actually open.
async function renderSettingsScreen(tab = 'device-types') {
  const main = document.getElementById('main');
  setActiveNav('nav-settings');
  const tabs = [{ id: 'device-types', label: 'Device types' }];
  if (can('admin')) tabs.push({ id: 'users', label: 'Users' });
  if (!tabs.some(t => t.id === tab)) tab = 'device-types';
  main.innerHTML = `<div class="page-head"><h2>Settings</h2></div>
    ${subTabsHtml(tabs, tab)}
    <div id="settings-body">Loading…</div>`;
  wireSubTabs(main, id => renderSettingsScreen(id));
  const body = document.getElementById('settings-body');
  if (tab === 'users') await renderUsersScreen(body);
  else await renderDeviceTypesScreen(body);
}

// Every key in PERMS must appear here. This map drives the Users screen's columns AND what a
// Save sends; putUserRoute rebuilds the row over all of PERMS, so a permission with no
// checkbox is written back as false. applyRuleBatch was missing until 2026-09-29 and was
// silently revoked whenever anyone saved a row that held it.
const PERM_LABELS = { editPartners:'Edit partners & rules', runCalcs:'Run calcs', deleteRuns:'Delete runs', manageMerchants:'Manage merchants', manageDeviceTypes:'Device types', applyRuleBatch:'Apply rule batch', manageMailTemplates:'Mail templates', admin:'Admin' };
async function renderUsersScreen(host) {
  const main = host || document.getElementById('main');
  main.innerHTML = `${host ? '' : '<h2>Users</h2>'}<p class="muted">Grant per-feature access. Anyone with a company Google account can sign in (read-only) until granted more.</p><div id="users-out">Loading…</div>`;
  const users = await api('/users');
  const keys = Object.keys(PERM_LABELS);
  const rowHtml = u => `<tr data-email="${escape(u.email)}"><td>${escape(u.email)}</td>${keys.map(k => `<td style="text-align:center"><input type="checkbox" data-perm="${k}" ${u.permissions?.[k] ? 'checked' : ''}></td>`).join('')}<td><button class="btn-primary" data-save>Save</button> <button data-del>Remove</button></td></tr>`;
  document.getElementById('users-out').innerHTML = `
    <div style="margin:10px 0;"><input id="new-user-email" placeholder="email@inforich.com" style="width:240px"> <button id="add-user" class="btn-primary">Add user</button></div>
    <table class="ts"><thead><tr><th>Email</th>${keys.map(k => `<th>${escape(PERM_LABELS[k])}</th>`).join('')}<th></th></tr></thead>
    <tbody>${users.map(rowHtml).join('') || '<tr><td colspan="${keys.length + 2}" class="muted">No granted users yet.</td></tr>'}</tbody></table>`;
  const save = async tr => {
    const email = tr.dataset.email;
    const permissions = {}; tr.querySelectorAll('input[data-perm]').forEach(c => permissions[c.dataset.perm] = c.checked);
    await api('/users/' + encodeURIComponent(email), { method: 'PUT', body: JSON.stringify({ permissions }) });
  };
  document.querySelectorAll('#users-out [data-save]').forEach(b => b.onclick = () => save(b.closest('tr')).then(() => b.textContent = 'Saved ✓'));
  document.querySelectorAll('#users-out [data-del]').forEach(b => b.onclick = async () => { const tr = b.closest('tr'); await api('/users/' + encodeURIComponent(tr.dataset.email), { method: 'DELETE' }); tr.remove(); });
  document.getElementById('add-user').onclick = async () => {
    const email = document.getElementById('new-user-email').value.trim().toLowerCase(); if (!email) return;
    await api('/users/' + encodeURIComponent(email), { method: 'PUT', body: JSON.stringify({ permissions: {} }) });
    renderUsersScreen(host);   // keep the Settings tab strip — a bare call would replace it
  };
}

// What KIND of thing is the money being paid for? A payout of 894,760 says nothing about
// whether it is a revenue share or a floor being topped up — and those behave completely
// differently as revenue moves. Classified from the engine's own recorded components:
//
//   percent                -> Revenue share
//   flat_per_machine       -> Guarantee if this merchant's max resolved to its MG, else Placement
//   flat_per_partner_total -> Lump sum (electricity, others)
//
// The guarantee test is guaranteeInfo's: the engine records only the branch of a `max` that
// won, so a rule with a GP percentage that contributed no percent leaf was paid on its floor.
const COMPOSITION_ORDER = ['Guarantee', 'Revenue share', 'Placement', 'Lump sum'];

// Horizontal bars, widest first. Deliberately plain: this answers one question, and a legend
// or axis would cost more attention than it returns.
function compositionHtml(comp, monthLabel) {
  const total = Object.values(comp).reduce((a, b) => a + b, 0);
  if (!total) return '';
  const shade = { Guarantee: '#e8590c', 'Revenue share': '#1971c2', Placement: '#2b8a3e', 'Lump sum': '#868e96' };
  const rows = COMPOSITION_ORDER.filter(k => comp[k] > 0);
  return `<div style="margin-top:22px;">
    <h3 style="margin:0 0 2px;font-size:15px;">What the payout is made of</h3>
    <p class="muted" style="margin:0 0 10px;font-size:13px;">${escape(monthLabel)} · total ${fmt2(total)}</p>
    ${rows.map(k => {
      const pct = comp[k] / total * 100;
      return `<div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;font-size:13px;">
        <div style="width:104px;flex:0 0 104px;">${escape(k)}</div>
        <div style="flex:1;background:var(--bg-soft);border-radius:4px;height:16px;overflow:hidden;">
          <div style="width:${pct.toFixed(1)}%;background:${shade[k]};height:100%;"></div>
        </div>
        <div style="width:104px;flex:0 0 104px;text-align:right;">${fmt2(comp[k])}</div>
        <div style="width:46px;flex:0 0 46px;text-align:right;color:var(--ink-soft);">${pct.toFixed(0)}%</div>
      </div>`;
    }).join('')}
  </div>`;
}

function payoutComposition(run, onlyContractId) {
  const out = { Guarantee: 0, 'Revenue share': 0, Placement: 0, 'Lump sum': 0 };
  for (const r of run.results || []) {
    if (onlyContractId && r.contractId !== onlyContractId) continue;
    const onGuarantee = !!guaranteeInfo(r, (run.ruleSnapshots || {})[r.contractId]);
    for (const c of engineComponents(r.engineResult)) {
      const pay = Number(c.payout) || 0;
      if (!pay) continue;
      if (c.leafType === 'percent' || c.leafType === 'tiered_percent') out['Revenue share'] += pay;
      else if (c.leafType === 'flat_per_machine') out[onGuarantee ? 'Guarantee' : 'Placement'] += pay;
      else out['Lump sum'] += pay;
    }
  }
  return out;
}

async function renderRevsharePathScreen() {
  const main = document.getElementById('main');
  setActiveNav('nav-bulk-runs');
  main.innerHTML = `${runShareHead('analytics')}
    <div style="max-width:340px;margin-bottom:8px;">
      <input id="rp-search" class="search-input" list="rp-options" placeholder="Search merchant… (or Total)" autocomplete="off">
      <datalist id="rp-options"></datalist>
    </div>
    <div id="rp-title" class="muted" style="margin:4px 0 10px;font-size:13px;"></div>
    <div id="rp-chart">Loading…</div>`;
  wireRunShareTabs();

  const list = await api('/bulk-runs');
  const fulls = await Promise.all(list.map(r => api('/bulk-runs/' + r.runId)));
  // one run per month (latest wins)
  const byMonth = {};
  fulls.forEach(run => {
    const m = periodMonth(run.periodStart);
    if (!byMonth[m] || (run.uploadedAt || '') > (byMonth[m].uploadedAt || '')) byMonth[m] = run;
  });
  const months = Object.keys(byMonth).sort();
  const pct = (payout, revenue) => revenue > 0 ? payout / revenue * 100 : 0;

  const totalSeries = months.map(m => {
    const run = byMonth[m];
    const revenue = (run.results || []).reduce((s, r) => s + (r.revenue || 0), 0);
    const payout = run.totalPayout || 0;
    return { month: m, revenue, payout, sharePct: pct(payout, revenue) };
  });
  const series = {};
  months.forEach(m => (byMonth[m].results || []).forEach(r => {
    (series[r.merchantName] = series[r.merchantName] || []).push({ month: m, revenue: r.revenue || 0, payout: r.payout || 0, sharePct: pct(r.payout || 0, r.revenue || 0) });
  }));
  const names = Object.keys(series).sort((a, b) => a.localeCompare(b));
  const byLower = {}; names.forEach(n => { byLower[n.toLowerCase()] = n; });

  document.getElementById('rp-options').innerHTML = ['Total', ...names].map(n => `<option value="${escape(n)}"></option>`).join('');

  function show(sel) {
    const titleEl = document.getElementById('rp-title');
    const chartEl = document.getElementById('rp-chart');
    const key = (sel || '').trim().toLowerCase();
    let label, data;
    if (!key || key === 'total') { label = 'Total — all merchants'; data = totalSeries; }
    else if (byLower[key]) { label = byLower[key]; data = series[byLower[key]]; }
    else { titleEl.textContent = ''; chartEl.innerHTML = `<p class="muted">No merchant matching “${escape(sel)}”.</p>`; return; }
    titleEl.textContent = label;
    chartEl.innerHTML = data && data.length ? revsharePathChartSvg(data) : '<p class="muted">No calculations yet to chart.</p>';

    // Composition of the most recent month, following whatever the search box has selected.
    // The trend chart shows how much; this shows what kind.
    const latest = months[months.length - 1];
    const run = latest ? byMonth[latest] : null;
    if (run) {
      const cid = (!key || key === 'total') ? null
        : (run.results || []).find(r => r.merchantName === byLower[key])?.contractId;
      const comp = (!key || key === 'total' || cid) ? payoutComposition(run, cid) : null;
      if (comp) chartEl.insertAdjacentHTML('beforeend', compositionHtml(comp, latest));
    }
  }

  document.getElementById('rp-search').addEventListener('input', e => show(e.target.value));
  show('Total');   // default
}

async function renderDeviceTypesScreen(host) {
  const main = host || document.getElementById('main');
  main.innerHTML = `
    <div class="page-head" style="margin-bottom:14px;">
      ${host ? '<div></div>' : '<h2>Device Types</h2>'}
      ${can('manageDeviceTypes') ? '<button id="add-model-btn" class="btn-primary">+ Add device type</button>' : ''}
    </div>
    <div id="model-form-slot"></div>
    <div id="models-out">Loading…</div>`;

  document.getElementById('add-model-btn')?.addEventListener('click', showAddModelForm);

  // Every per-machine term row in a rule, at any depth.
  function ruleModels(node, out = []) {
    if (!node || typeof node !== 'object') return out;
    if (node.type === 'flat_per_machine') for (const r of node.rows || []) if (r.model) out.push(r.model);
    (node.children || []).forEach(c => ruleModels(c, out));
    return out;
  }

  // What each device type is actually doing in THIS region. Two very different kinds of use:
  // machines counted against merchants, and per-machine terms that pay by model. A type with
  // neither is safe to remove; one with either is not.
  function modelUsage(contracts) {
    const use = {};
    const touch = (m) => (use[m] = use[m] || { units: 0, merchants: new Set(), termOf: new Set() });
    for (const c of contracts || []) {
      for (const [m, n] of Object.entries(c.units || {})) { touch(m).units += Number(n) || 0; use[m].merchants.add(c.merchantName); }
      for (const m of ruleModels(c.rule)) { if (m === 'ALL') continue; touch(m).termOf.add(c.merchantName); }
    }
    return use;
  }

  async function loadModels() {
    const out = document.getElementById('models-out');
    if (!out) return;
    // Contracts come along so the list can say what each type is used for. Deleting one is not
    // cosmetic: createBulkRunRoute builds allowedModels from these rows, so a roster row that
    // parses to a removed model makes evaluateRun reject it and drops the whole brand into
    // `skipped`. That has to be visible BEFORE the Delete button, not after.
    const [models, contracts] = await Promise.all([api('/machine-models'), api('/contracts').catch(() => [])]);
    if (!models.length) { out.innerHTML = '<p class="muted">No device types yet.</p>'; return; }
    const usage = modelUsage(contracts);
    window.__MODEL_USAGE = usage;
    out.innerHTML = `
      <p class="muted" style="font-size:12.5px;margin:0 0 10px;">
        This list is per country — you are editing <strong>${escape(R().name)}</strong>. It decides which
        machine columns the Overview shows, and which models a run will accept.
      </p>
      <table class="ts">
        <thead><tr><th>Display Name</th><th>Code</th><th>In use</th><th></th></tr></thead>
        <tbody>
          ${models.map(m => {
            const u = usage[m.code];
            const inUse = u && (u.units > 0 || u.termOf.size > 0);
            const bits = [];
            if (u?.units) bits.push(`${u.units} machine${u.units === 1 ? '' : 's'} at ${u.merchants.size} merchant${u.merchants.size === 1 ? '' : 's'}`);
            if (u?.termOf.size) bits.push(`paid by ${u.termOf.size} term${u.termOf.size === 1 ? '' : 's'}`);
            return `
            <tr id="model-row-${escape(m.code)}">
              <td>${escape(m.displayName)}</td>
              <td><span class="badge badge-neutral">${escape(m.code)}</span></td>
              <td style="font-size:12.5px;">${inUse
                ? escape(bits.join(' · '))
                : '<span class="muted">not used — safe to remove</span>'}</td>
              <td>
                ${can('manageDeviceTypes') ? `<button class="btn-ghost edit-model" data-code="${escape(m.code)}" data-dn="${escape(m.displayName)}">Edit</button>` : ''}
                ${can('manageDeviceTypes') ? `<button class="btn-ghost del-model" data-code="${escape(m.code)}" style="color:var(--loss)">Delete</button>` : ''}
              </td>
            </tr>`; }).join('')}
        </tbody>
      </table>`;
    out.querySelectorAll('.edit-model').forEach(btn => {
      btn.addEventListener('click', () => showEditModelForm(btn.dataset.code, btn.dataset.dn));
    });
    out.querySelectorAll('.del-model').forEach(btn => {
      btn.addEventListener('click', async () => {
        const code = btn.dataset.code;
        const u = (window.__MODEL_USAGE || {})[code];
        const names = u ? [...new Set([...u.merchants, ...u.termOf])] : [];
        // Spell out the consequence rather than the action. A removed model is not merely
        // hidden: a run will REJECT a roster row that parses to it, and skip that brand's
        // payout entirely.
        const warn = names.length
          ? `"${code}" is still in use by ${names.length} merchant(s):\n\n`
            + names.slice(0, 8).map(n => `  • ${n}`).join('\n')
            + (names.length > 8 ? `\n  …and ${names.length - 8} more` : '')
            + `\n\nRemoving it means a run will REJECT any roster row with this model and skip that`
            + ` merchant's payout entirely. Their stored counts and terms stay, but stop working.\n\nDelete anyway?`
          : `Delete device type "${code}"? It is not used by any merchant in ${R().name}.`;
        if (!confirm(warn)) return;
        await api('/machine-models/' + code, { method: 'DELETE' });
        loadModels();
      });
    });
  }

  function showAddModelForm() {
    const slot = document.getElementById('model-form-slot');
    slot.innerHTML = `
      <div class="batch-panel" style="max-width:480px;margin-bottom:16px;">
        <div class="batch-panel-head">
          <div class="batch-panel-title">Add device type</div>
          <button id="mf-close" class="btn-ghost">✕</button>
        </div>
        <label style="display:block;margin-bottom:10px;font-size:12.5px;color:var(--ink-soft);">Display name
          <input id="mf-dn" style="display:block;margin-top:4px;width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-size:13.5px;" placeholder="e.g. Advertising Player-S5">
        </label>
        <label style="display:block;margin-bottom:14px;font-size:12.5px;color:var(--ink-soft);">Code (immutable)
          <input id="mf-code" style="display:block;margin-top:4px;width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-size:13.5px;font-family:var(--font-mono);" placeholder="e.g. S5">
        </label>
        <div style="display:flex;gap:8px;">
          <button id="mf-save" class="btn-primary">Save</button>
          <button id="mf-cancel" class="btn-ghost">Cancel</button>
        </div>
        <div id="mf-err" style="margin-top:8px;font-size:13px;color:var(--loss);"></div>
      </div>`;
    slot.querySelector('#mf-close').addEventListener('click', () => { slot.innerHTML = ''; });
    slot.querySelector('#mf-cancel').addEventListener('click', () => { slot.innerHTML = ''; });
    slot.querySelector('#mf-save').addEventListener('click', async () => {
      const displayName = slot.querySelector('#mf-dn').value.trim();
      const code = slot.querySelector('#mf-code').value.trim().toUpperCase();
      const err = slot.querySelector('#mf-err');
      if (!displayName || !code) { err.textContent = 'Both fields are required.'; return; }
      try {
        await api('/machine-models', { method: 'POST', body: JSON.stringify({ code, displayName }) });
        slot.innerHTML = '';
        loadModels();
      } catch (e) {
        err.textContent = e.message.includes('409') ? 'Code already exists.' : escape(e.message);
      }
    });
  }

  function showEditModelForm(code, currentDn) {
    const row = document.getElementById(`model-row-${code}`);
    if (!row) return;
    row.innerHTML = `
      <td><input id="mf-edit-dn" style="width:100%;padding:6px 9px;border:1px solid var(--border);border-radius:var(--radius-sm);font-size:13px;" value="${escape(currentDn)}"></td>
      <td><span class="badge badge-neutral">${escape(code)}</span></td>
      <td style="display:flex;gap:4px;">
        <button id="mf-edit-save" class="btn-primary" style="padding:5px 12px;font-size:12px;">Save</button>
        <button id="mf-edit-cancel" class="btn-ghost" style="padding:5px 12px;font-size:12px;">Cancel</button>
      </td>`;
    row.querySelector('#mf-edit-cancel').addEventListener('click', () => loadModels());
    row.querySelector('#mf-edit-save').addEventListener('click', async () => {
      const displayName = row.querySelector('#mf-edit-dn').value.trim();
      if (!displayName) return;
      await api('/machine-models/' + code, { method: 'PUT', body: JSON.stringify({ displayName }) });
      loadModels();
    });
  }

  loadModels();
}

// ── Contracts ──────────────────────────────────────────────────────────────
let CONTRACTS = [];
// Managed device-types list ({code, displayName}), loaded once with the grid and
// cached module-scope — the per-model popover must not re-fetch on every open.
let MACHINE_MODELS_CACHE = [];
// What the last weekly merchant upload contained: `{ at, names[] }`, or null before any upload.
// An import never deletes, so a merchant that has dropped off your list stays here silently —
// this is what lets the grid mark it. Recomputed into MISSING_UPLOAD (contractIds) on paint.
let LAST_UPLOAD = null;

// The legal entity a payout is settled with, as records (2026-09-29). ONE ENTITY COVERS MANY
// BRANDS — Central Pattana holds Ladprao, Eastville and Westgate. It replaced a free-text
// `counterParty` re-typed on every contract, which split one company in two whenever someone
// typed a space differently.
let ENTITIES = [];
const entityById = id => ENTITIES.find(e => e.entityId === id) || null;
// A contract that has never been linked still reads its own `counterParty` string, untouched.
// That is what makes this additive: nothing had to be rewritten for the entity to exist.
function entityName(c) {
  return entityNameOf(c, ENTITIES);
}

// The same rule, with the entity list passed in — so the helpers that already take `contracts`
// stay pure and testable. A linked contract reads its RECORD; an unlinked one falls back to the
// string it has always carried.
function entityNameOf(c, entities) {
  const id = c && c.entityId;
  if (id) {
    const e = (entities || []).find(x => x.entityId === id);
    if (e) return String(e.name || '').trim();
  }
  return String((c && c.counterParty) || '').trim();
}
const loadEntities = () => api('/entities').then(r => (ENTITIES = r || [])).catch(() => (ENTITIES = []));
let MISSING_UPLOAD = new Set();
// How many reconcile items the tab last computed, so the Reconcile(N) badge survives a repaint
// (e.g. switching back from Reconcile to Merchants and looking at the tab strip again) without
// a refetch. Stays 0 — no badge — until the tab has actually been opened once.
let RECONCILE_COUNT = 0;

// Merchants that exist here but were NOT in the latest uploaded file. Same lowercase-trim name
// match `diffWeeklyRows` uses, so the import preview's count and the grid's can never disagree.
// Archived contracts are never included — an ended contract is not expected in a merchant list,
// and marking it would be noise on a screen that already excludes it.
// "3 Sep" — short enough to sit in a tooltip and a filter label without wrapping.
function uploadLabel() {
  if (!LAST_UPLOAD?.at) return 'latest';
  const d = new Date(LAST_UPLOAD.at);
  return isNaN(d) ? 'latest' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function missingFromUpload(contracts, names) {
  if (!names || !names.length) return [];
  const inFile = new Set(names.map(n => String(n ?? '').toLowerCase().trim()).filter(Boolean));
  return (contracts || []).filter(c =>
    !c.archived && !inFile.has(String(c.merchantName ?? '').toLowerCase().trim()));
}

// The Reconcile tab's comparison key. NFKC first because the merchant list mixes Thai, English
// and full-width characters, and 'ｇｌｏｗ' must not read as a different brand from 'glow'.
// missingFromUpload's plain lower/trim is left alone — it is load-bearing for the ⦿ marks and
// this must not change what those mark.
function reconcileKey(s) {
  return String(s ?? '').normalize('NFKC').toLowerCase().trim();
}

// Revenue a run did NOT pay, by brand. Read from the run's own frozen `skipped` list, so the
// figure is one the run page also shows — nothing here recomputes a payout.
function skippedByName(run) {
  const m = new Map();
  for (const s of (run?.skipped || [])) {
    const k = reconcileKey(s.merchantName);
    if (k) m.set(k, (m.get(k) || 0) + (Number(s.revenue) || 0));
  }
  return m;
}

// Dice coefficient over character bigrams. Chosen over edit distance because it is
// length-insensitive: 'Andamanda' vs 'Andamanda Phuket' scores on shared substance rather than
// being penalised for the added word, which is the exact shape a brand rename takes here.
function similarity(a, b) {
  const grams = (s) => {
    const t = reconcileKey(s).replace(/\s+/g, ' ');
    const g = new Map();
    for (let i = 0; i < t.length - 1; i++) g.set(t.slice(i, i + 2), (g.get(t.slice(i, i + 2)) || 0) + 1);
    return g;
  };
  const A = grams(a), B = grams(b);
  let total = 0, shared = 0;
  for (const n of A.values()) total += n;
  for (const [g, n] of B) { total += n; shared += Math.min(n, A.get(g) || 0); }
  return total ? (2 * shared) / total : 0;
}

// A term set, compared by value rather than by identity. DynamoDB does not preserve map key
// order, so a plain JSON.stringify of two equal rules can differ — the same trap §1h hit with
// `units`. Sorting keys is what makes "do these merchants agree?" answerable at all.
function termSignature(c) {
  if (c?.noPayout) return 'NO_PAYOUT';
  if (!c?.rule) return 'NONE';
  const sort = (v) => Array.isArray(v) ? v.map(sort)
    : (v && typeof v === 'object')
      ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sort(v[k])]))
      : v;
  return JSON.stringify([sort(c.rule), c.aggregationMode || null]);
}

// Every difference between the app's merchant list and the last upload, as flat items the page
// groups by type. Pure: the caller supplies the contracts, the stored upload, the latest run and
// the dismissals. Archived contracts are excluded from "not in your file" for the reason §1m
// gives — an ended contract is not expected in a merchant list — but they are the SUBJECT of
// `archived-in-file`, which is the opposite question and the one nothing asked before.
function classifyDifferences(opts) {
  const { contracts, upload, run, dismissals } = opts;
  const RENAME_MIN = 0.55;   // below this, 'Somsak'/'Jims Burger' start pairing. Measured, not guessed.
  const names = (upload?.names || []).map(reconcileKey).filter(Boolean);
  const inFile = new Set(names);
  const live = (contracts || []).filter(c => c && c.merchantName);
  const byKey = new Map(live.map(c => [reconcileKey(c.merchantName), c]));
  const money = skippedByName(run);
  const out = [];

  for (const c of live) {
    const k = reconcileKey(c.merchantName);
    if (c.archived) {
      if (inFile.has(k)) {
        // BOTH flags travel with the item. `archived` alone has a one-step fix; archived AND
        // `noPayout` does not, and telling someone to unarchive a noPayout row is advice that
        // pays them zero again next run (the `Central` case: 51,495 THB). The classifier can
        // see both, so it says both — see reconcileFix.
        out.push({ type: 'archived-in-file', key: k, names: [c.merchantName],
                   appNames: [c.merchantName], fileNames: [c.merchantName],
                   contractIds: [c.contractId], money: money.get(k) || 0,
                   archived: true, noPayout: !!c.noPayout,
                   detail: c.noPayout
                     ? 'Contract archived AND marked “no revenue share”, but this brand is on your merchant list.'
                     : 'Contract archived, but this brand is on your merchant list.' });
      }
      continue;                     // an archived row is never "missing from the file"
    }
    if (!inFile.has(k)) {
      out.push({ type: 'in-app-not-in-file', key: k, names: [c.merchantName],
                 appNames: [c.merchantName], fileNames: [],
                 contractIds: [c.contractId], money: 0, detail: '' });
    }
  }

  for (const k of inFile) {
    if (byKey.has(k)) continue;
    const name = (upload.names || []).find(n => reconcileKey(n) === k);
    out.push({ type: 'in-file-no-row', key: k, names: [name], contractIds: [],
               appNames: [], fileNames: [name],
               money: money.get(k) || 0, detail: '' });
  }

  // Every splice below goes through this — never trust an `indexOf` result unchecked. Every
  // call site is provably safe by construction (nothing here removes an item twice), but a -1
  // from a future edit must fail loudly rather than silently delete `out`'s last element, which
  // is exactly what an earlier unguarded version did.
  const removeItem = (item) => {
    const i = out.indexOf(item);
    if (i < 0) throw new Error('reconcile pairing: tried to remove an item no longer in `out`');
    out.splice(i, 1);
  };
  const byId = new Map(live.map(c => [c.contractId, c]));

  // One file tag, several merchant rows whose names start with it. This is the brand-vs-branch
  // split: the roster labels every machine with the brand tag, so the branch rows can never be
  // reached by a run however good their terms are.
  //
  // This runs over EVERY name in the file, not only tags with no merchant row — which is the
  // case the whole feature exists for. `Central` HAS a row (archived, noPayout), so a pass that
  // only looked at rowless tags never fired on it: the page showed `Central` archived in one
  // group and `Central Ladprao`/`Eastville`/`Westgate` scattered across another, with nothing
  // linking them. The branch members are ATTACHED to whatever item the tag already has rather
  // than emitted as a second item, so one brand is one finding (spec §1, §10) and no contract
  // is ever reported twice. A tag whose row is LIVE and in the file has no item to attach to,
  // so it gets a `brand-has-merchants` item of its own — the merchants are just as unreachable.
  //
  // A member is WITHHELD when it looks much more like the rename of some OTHER rowless file
  // name than like a branch of this tag: file `Glow` + `Glow Fis` against rows `Glow Fish` and
  // `Glow Bar` used to swallow `Glow Fish` into the `Glow` group, so a 93% rename match was
  // never suggested and left no trace. The bar is deliberately high (0.80 vs RENAME_MIN's
  // 0.55) — a merchant that is genuinely a branch usually scores well BELOW it against any
  // other tag, and the brand reading stays the right one for `Citadines`/`Classic` (R2).
  const BRAND_YIELD_MIN = 0.80;
  const rowlessFileKeys = [...inFile].filter(k => !byKey.has(k));
  for (const k of inFile) {
    const tagged = out.filter(o => o.type === 'in-app-not-in-file'
      && reconcileKey(o.names[0]).startsWith(k + ' '));
    const members = tagged.filter(o => !rowlessFileKeys.some(other =>
      other !== k && similarity(other, o.names[0]) >= BRAND_YIELD_MIN));
    if (members.length < 2) continue;
    const sigs = new Set(members.flatMap(m => m.contractIds).map(id => termSignature(byId.get(id))));
    const branchIds = members.flatMap(m => m.contractIds);
    const branch = {
      branchNames: members.map(m => m.names[0]),
      branchContractIds: branchIds,
      branchCount: members.length,
      sameTerms: sigs.size === 1,
      termSetCount: sigs.size,
    };
    const termsDetail = sigs.size === 1
      ? 'terms identical on all rows'
      : `${sigs.size} different term sets — only one can ever be paid under this tag`;
    const termsSentence = sigs.size === 1
      ? 'The rows below carry identical terms.'
      : `The rows below carry ${sigs.size} different term sets, and only one can ever be paid under this tag.`;
    const existing = out.find(o => o.key === k
      && (o.type === 'archived-in-file' || o.type === 'in-file-no-row'));
    if (existing && existing.type === 'archived-in-file') {
      // Keep the archived item's own type: "archived and still earning" is the more severe
      // fact and the group it belongs in. The merchants ride along as extra facts on that row.
      Object.assign(existing, branch, {
        contractIds: [...existing.contractIds, ...branchIds],
        // The branch rows themselves are listed under the row, so the detail only adds the one
        // fact that list cannot show: whether those rows agree on terms.
        detail: `${existing.detail} ${termsSentence}`,
      });
    } else if (existing) {
      out[out.indexOf(existing)] = {
        type: 'brand-has-branches', key: k,
        names: [existing.names[0], ...branch.branchNames],
        // `existing` is the in-file-no-row item being converted, so its name is the FILE's tag —
        // there is no merchant row of that name, which is why it was an orphan. Only the branch
        // rows belong on the app side.
        appNames: [...branch.branchNames], fileNames: [existing.names[0]],
        contractIds: [...branchIds], money: existing.money, ...branch, detail: termsDetail };
    } else {
      // The tag resolves to a LIVE row that is itself in the file. Nothing is wrong with the
      // tag; the branch rows below it are still unreachable, so the finding still exists.
      const tagContract = byKey.get(k);
      out.push({
        type: 'brand-has-branches', key: k,
        names: [tagContract ? tagContract.merchantName : (upload.names || []).find(n => reconcileKey(n) === k),
                ...branch.branchNames],
        // The tag is what the FILE says. The branch rows are what the app holds, plus the tag's
        // own live row when it has one.
        appNames: [...(tagContract ? [tagContract.merchantName] : []), ...branch.branchNames],
        fileNames: [(upload.names || []).find(n => reconcileKey(n) === k)
                    || (tagContract ? tagContract.merchantName : '')].filter(Boolean),
        contractIds: [...(tagContract ? [tagContract.contractId] : []), ...branchIds],
        money: money.get(k) || 0, ...branch, detail: termsDetail });
    }
    for (const m of members) removeItem(m);
  }

  // Pair the two orphan sets: a file name with no row, against merchants the file omits. Every
  // score is computed once, up front, against the STATIC lists below — nothing here recomputes
  // a candidate list from `out` mid-loop, because `out` is what earlier iterations are editing.
  // (An earlier version did exactly that: a first-come-first-served loop let two file names each
  // separately claim the SAME orphan contract as a confident 1:1 match — reporting that contract
  // TWICE — and once the orphan had already been spliced out for the first claim, the second
  // claim's `out.splice(out.indexOf(orphan), 1)` found `indexOf` returned -1 and silently deleted
  // the LAST element of `out` instead — an unrelated, genuine finding, gone with no trace.)
  //
  // One candidate on either side is a suggestion; two or more on EITHER side is a question the
  // page must ask rather than pick. `Classic` matching two live rows is the file-name-side shape
  // of that; two file names each resembling one orphaned `Andamanda` is the same problem from the
  // contract side, and is resolved the same way — one ambiguous item, not two confident wrong
  // guesses.
  //
  // INVARIANT, load-bearing: when this returns, no contractId appears in more than one item.
  // The badge count, the per-group counts and "this merchant needs one decision" all rest on it.
  // Every branch below therefore CONSUMES the orphans it names, including the ambiguous one —
  // listing a contract inside an ambiguous item and ALSO leaving it as its own row showed the
  // same merchant twice, with contradictory advice, and inflated every count.
  const orphanContracts = out.filter(i => i.type === 'in-app-not-in-file');
  const fileItems = out.filter(i => i.type === 'in-file-no-row');
  const scoredFor = new Map(fileItems.map(f => [f,
    orphanContracts
      .map(o => ({ o, score: similarity(f.names[0], o.names[0]) }))
      .filter(x => x.score >= RENAME_MIN)
      .sort((a, b) => b.score - a.score)]));

  // An orphan for which more than one file name is the ONLY candidate is contested: each of
  // those file names looks, in isolation, like a confident 1:1 rename — but only one of them can
  // be right, so this resolves ALL of them first, as one ambiguous-rename per contested orphan,
  // before any single-candidate file item below is allowed to claim anything.
  const soleClaimants = new Map();   // orphan item -> file items for which it is the ONLY candidate
  for (const [f, scored] of scoredFor) {
    if (scored.length !== 1) continue;
    const o = scored[0].o;
    if (!soleClaimants.has(o)) soleClaimants.set(o, []);
    soleClaimants.get(o).push(f);
  }
  const consumedOrphans = new Set();
  const consumedFiles = new Set();
  for (const [o, claimants] of soleClaimants) {
    if (claimants.length < 2) continue;
    consumedOrphans.add(o);
    for (const f of claimants) consumedFiles.add(f);
    const i = out.indexOf(claimants[0]);
    if (i < 0) throw new Error('reconcile pairing: claimant already removed from `out`');
    out[i] = { type: 'ambiguous-rename', key: o.key,
               names: [o.names[0], ...claimants.map(f => f.names[0])],
               appNames: [o.names[0]], fileNames: claimants.map(f => f.names[0]),
               contractIds: [...o.contractIds],
               money: claimants.reduce((sum, f) => sum + (f.money || 0), 0),
               detail: `${claimants.length} upload names could be this merchant's rename — pick one` };
    removeItem(o);
    for (const f of claimants.slice(1)) removeItem(f);
  }

  // Confident pairs are settled BEFORE ambiguous ones, and to a fixpoint: an ambiguous file name
  // consuming its candidates could otherwise take the single candidate of a file name that had a
  // clean 1:1 match, leaving the clean one with nothing to suggest. Each resolution can drop
  // another file name to one candidate, so this repeats until nothing changes.
  const remaining = (f) => scoredFor.get(f).filter(x => !consumedOrphans.has(x.o));
  const pairOne = (f, o, score) => {
    const i = out.indexOf(f);
    if (i < 0) throw new Error('reconcile pairing: file item already removed from `out`');
    out[i] = { type: 'likely-rename', key: f.key,
               names: [o.names[0], f.names[0]], contractIds: [...o.contractIds],
               appNames: [o.names[0]], fileNames: [f.names[0]],
               money: f.money, detail: `${Math.round(score * 100)}% match` };
    removeItem(o);
    consumedOrphans.add(o);
    consumedFiles.add(f);
  };
  for (let moved = true; moved; ) {
    moved = false;
    for (const f of fileItems) {
      if (consumedFiles.has(f)) continue;
      const scored = remaining(f);
      if (scored.length !== 1) continue;
      pairOne(f, scored[0].o, scored[0].score);
      moved = true;
    }
  }

  // What is left is genuinely ambiguous: several merchants still fit this one file name. The
  // item names every candidate AND consumes them, so the reader sees this merchant exactly once.
  for (const f of fileItems) {
    if (consumedFiles.has(f)) continue;
    const scored = remaining(f);
    if (scored.length < 2) continue;
    const i = out.indexOf(f);
    if (i < 0) throw new Error('reconcile pairing: file item already removed from `out`');
    out[i] = { type: 'ambiguous-rename', key: f.key,
               names: [f.names[0], ...scored.map(s => s.o.names[0])],
               appNames: scored.map(s => s.o.names[0]), fileNames: [f.names[0]],
               contractIds: scored.flatMap(s => s.o.contractIds),
               money: f.money, detail: `${scored.length} merchants could be this` };
    consumedFiles.add(f);
    for (const { o } of scored) { removeItem(o); consumedOrphans.add(o); }
  }

  // The optional machine-list upload matches each merchant to a brand through the registry.
  // Two different failures need two different fixes (§1l): `unknown` usually resolves itself
  // once the next run's roster teaches the registry the name; `unlinked` needs a person to link
  // the merchant to a merchant. Keeping them apart is the point — merging them would hide which fix
  // each name needs. Name lists are capped at 200 by the backend, so `count` carries the exact
  // total rather than `names.length`.
  const mm = upload?.machineMisses;
  if (mm?.unknownTotal) out.push({ type: 'machine-list-miss', key: 'unknown',
    appNames: [], fileNames: mm.unknown || [],
    names: mm.unknown || [], contractIds: [], money: 0, count: mm.unknownTotal,
    detail: 'These merchants are not in the registry. The registry learns merchant names from run '
          + 'rosters, so they usually resolve after the next run.' });
  if (mm?.unlinkedTotal) out.push({ type: 'machine-list-miss', key: 'unlinked',
    appNames: [], fileNames: mm.unlinked || [],
    names: mm.unlinked || [], contractIds: [], money: 0, count: mm.unlinkedTotal,
    detail: 'These merchants are in the registry but belong to no brand, so their machines were '
          + 'not counted anywhere.' });

  const silenced = new Set((dismissals || []).map(d => `${d.type}::${d.key}`));
  return out.filter(i => !silenced.has(`${i.type}::${i.key}`));
}

// The per-model unit columns are built from the REGION's configured machine models, not a
// fixed list. They used to be hardcoded to S5/S8/M10/L20/L40, which matched neither region:
// Thailand's S10/T8/T10/T20/T35 had no column, and Singapore's S10-A/LL20/LL40 had none
// either — so SG merchants showed blank unit counts even when the data was there. Device
// Types is the source of truth; add a model there and its column appears.
const UNIT_MODELS_FALLBACK = ['S5', 'S8', 'M10', 'L20', 'L40'];
// What this screen owns. The rest of the grid mirrors the weekly merchant upload, so it is
// shown but not typed over — see startCellEdit. `terms` is here because the Edit terms dialog
// owns it; the cells themselves still open read-only.
const EDITABLE_GROUPS = new Set(['contract', 'terms', 'finance']);

// Where the payout is actually sent. BOTH regions as of 2026-09-04 — the columns were TH-only
// for half a day, guarded on REGION, purely because Singapore's Lambda had no such fields in
// WRITABLE and `pick()` drops an unknown key without erroring: the cell would have opened, taken
// what you typed, and lost it on the next paint. The guard came off together with the SG deploy
// that added them, never before it. That ordering is the whole point — if a future field lands
// here TH-first, guard it again until SG's WRITABLE has caught up.
//
// Editable inline (see EDITABLE_GROUPS) because nothing else writes them: the weekly merchant
// upload has no bank columns, so unlike Contact/Phone/Email these cannot be reverted by an
// import. The contact here is the FINANCE contact — who the remittance advice goes to, usually
// AP rather than the operational contact in the Contact group.
// The prose the download sheet carries for each finance column — as a hover comment on the
// header cell and a row in the Field guide. Keyed by field so the sheet cannot list a column
// the grid does not have, or vice versa.
const FINANCE_SHEET_DESC = {
  bankName:            'Bank the payout is transferred to. Free text, as written on the account.',
  bankAccountName:     'Account holder name, exactly as the bank has it \u2014 a mismatch is what bounces a transfer. '
                     + 'May differ from both the brand and the contract entity.',
  bankAccountNumber:   'Bank account number. Kept exactly as typed, so leading zeros and dashes survive.',
  financeContactName:  'Who to contact about payment \u2014 usually accounts payable, NOT the operational contact '
                     + 'in the Contact group.',
  financeContactEmail: 'Where the remittance advice is sent.',
};

const FINANCE_COLUMNS = [
  { key: 'bankName',             label: 'Bank',            type: 'text', width: 145, group: 'finance' },
  { key: 'bankAccountName',      label: 'Account name',    type: 'text', width: 170, group: 'finance' },
  { key: 'bankAccountNumber',    label: 'Account no.',     type: 'text', width: 145, group: 'finance' },
  { key: 'financeContactName',   label: 'Finance contact', type: 'text', width: 135, group: 'finance' },
  { key: 'financeContactEmail',  label: 'Finance email',   type: 'text', width: 175, group: 'finance' },
];

function buildContractGridColumns(models) {
  const codes = (models && models.length ? models : UNIT_MODELS_FALLBACK);
  return [
    { key: 'merchantName',          label: 'Brand',         type: 'text',  width: 165 , group: 'id' },
    { key: 'merchantType',          label: 'Type',          type: 'select', width: 120 , group: 'id' },
    // How many MERCHANTS this brand has — merchant being one merchant, read from the file's
    // `merchant name (English)`. Counted from the file, so it is as current as the last upload.
    { key: 'branchCount',           label: 'Merchants',     type: 'number', width: 86  , group: 'id' },
    { key: 'salesPerson',           label: 'Sales person',  type: 'text',   width: 125 , group: 'contact' },
    { key: 'contactName',           label: 'Contact',       type: 'text',   width: 125 , group: 'contact' },
    { key: 'contactPhone',          label: 'Phone',         type: 'text',   width: 110 , group: 'contact' },
    { key: 'contactEmail',          label: 'Email',         type: 'text',   width: 160 , group: 'contact' },
    { key: 'installedUnits',        label: 'Units',         type: 'computed', width: 55 , group: 'machines' },
    ...codes.map(code => ({ key: `units.${code}`, label: code, type: 'number',
                            width: Math.max(46, 20 + code.length * 9), group: 'machines' })),
    { key: 'counterParty',          label: 'Contract entity', type: 'text', width: 175 , group: 'contract' },
    { key: 'startDate',             label: 'Start',         type: 'date',   width: 108 , group: 'contract' },
    { key: 'endDate',               label: 'End',           type: 'date',   width: 108 , group: 'contract' },
    { key: 'terminationNoticeDays', label: 'Notice',        type: 'number', width: 84  , group: 'contract', suffix: ' days' },
    { key: 'autoRenewal',           label: 'Auto-renewal',  type: 'select', width: 135 , group: 'contract' },
    { key: 'contractLink',          label: 'Contract',      type: 'url',    width: 80  , group: 'contract' },
    ...FINANCE_COLUMNS,
    { key: 'term.method',      label: 'Mode',         type: 'term-mode',    width: 130, group: 'terms' },
    { key: 'term.summary',     label: 'Rev terms',    type: 'term-summary', width: 230, group: 'terms' },
  ];
}
let CONTRACT_GRID_COLUMNS = buildContractGridColumns();

// Call once the region's machine models are known, so the unit columns match what this region
// actually deploys. Safe to call repeatedly.
// Only the models this region actually DEPLOYS get a column. Showing every configured type
// meant Thailand carried five permanently blank columns (S10, T8, T10, T20, T35) and Singapore
// six — noise in a grid that is already too wide to fit on a laptop. A model earns its column
// by having machines counted against it, or by being named in a per-machine term (a merchant
// can have a rate agreed for a cabinet that is not installed yet).
//
// Device Types remains the source of truth for what a run will ACCEPT; this is only about what
// is worth showing. If a type is configured and unused, it simply has no column until it does.
function modelsInUse(contracts, configured) {
  const used = new Set();
  const fromRule = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'flat_per_machine') for (const r of n.rows || []) if (r.model && r.model !== 'ALL') used.add(r.model);
    (n.children || []).forEach(fromRule);
  };
  for (const c of contracts || []) {
    for (const [m, n] of Object.entries(c.units || {})) if (Number(n) > 0) used.add(m);
    fromRule(c.rule);
  }
  // And every model the latest upload mentions. The grid now shows the FILE's counts, so a model
  // that exists only in the file would otherwise have its numbers hidden behind a missing column.
  for (const b of Object.values(ROSTER_BRANDS.brands || {})) {
    for (const [m, n] of Object.entries(b.units || {})) if (Number(n) > 0) used.add(m);
  }
  // Keep the configured order, so the columns do not reshuffle as data changes.
  const inUse = (configured || []).filter(m => used.has(m));
  // A model in use but NOT configured still gets a column — otherwise its numbers would be
  // invisible and uneditable, which is worse than an unexpected column.
  for (const m of used) if (!inUse.includes(m)) inUse.push(m);
  return inUse;
}

function refreshContractGridColumns() {
  CONTRACT_GRID_COLUMNS = buildContractGridColumns(
    modelsInUse(CONTRACTS, MACHINE_MODELS_CACHE.map(m => m.code)));
}

// 23 columns is ~2400px — more than a laptop can show at once even full-width. Rather than
// hiding data behind a horizontal scrollbar, let the user switch whole groups off. `id` has
// no toggle: the merchant is what identifies the row.
// TWO CATEGORIES, stated by the user 2026-09-29:
//
//   MERCHANT INFORMATION — brand, merchants, machines, contacts. Read from the file you upload;
//                          never edited in the app.
//   MERCHANT TERMS       — contract, finance AND share terms. ONE data set, maintained by hand.
//
// The three terms groups keep their own keys because the editor and the new-merchant form build
// their sections from them, but the GRID shows them as a single category: they are agreed,
// signed and settled together, so reading one without the others is reading half a contract.
const CONTRACT_GROUPS = [
  { key: 'contact',  label: 'Contact'  },
  { key: 'machines', label: 'Machines' },
  { key: 'contract', label: 'Contract',            category: 'terms' },
  { key: 'finance',  label: 'Finance Information', category: 'terms' },
  { key: 'terms',    label: 'Share terms',         category: 'terms' },
];
// What the grid's category row shows for a merged category, and the one key its toggle writes.
const CONTRACT_CATEGORIES = { terms: 'Brand terms' };
// A column's category is its group's, falling back to the group itself.
function contractCategoryOf(groupKey) {
  const g = CONTRACT_GROUPS.find(x => x.key === groupKey);
  return (g && g.category) || groupKey;
}
// The screen OPENS COLLAPSED (2026-09-04). Six groups spread is ~2,900px, well past a laptop,
// so the honest default is the compact list — merchant, type, branch, and one narrow stub per
// group, each of which reopens it. Someone who wants a column spends one click, instead of
// everyone paying a horizontal scrollbar.
//
// The storage key is VERSIONED because the old default was all-open and was already saved in
// every returning browser — keeping the key would have shipped a new default that nobody using
// the screen could see. The cost is one deliberate reset of a low-stakes preference; choices
// made from here on persist as before.
// v3 (2026-09-30): the three terms groups became one category, so saved per-group choices no
// longer address anything, and the default for that category changed to OPEN. Keeping the old
// key would have shipped a default only a brand-new browser could see.
const CT_GROUPS_KEY = 'rs_ct_groups_v3';
let CONTRACT_GROUPS_ON = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(CT_GROUPS_KEY) || 'null');
    if (saved && typeof saved === 'object') return saved;
  } catch { /* corrupt or unavailable storage — fall through to all-collapsed */ }
  // MERCHANT TERMS OPENS BY DEFAULT (2026-09-30). Everything else stays closed: those groups are
  // file-owned, wide, and read rarely. `terms` is the opposite — it is the one set maintained by
  // hand, and it now covers contract, finance AND share terms since the three were merged into
  // one category. Leaving it collapsed meant an edit saved correctly and the table showed a
  // narrow empty stub, which reads as "my change did not save".
  return Object.fromEntries(CONTRACT_GROUPS.map(g => [g.key, g.category === 'terms' || g.key === 'terms']));
})();
// One definition of "is this group open", used by the layout AND the toggle. They disagreed in
// the obvious way when the default flipped: a group that is open unless explicitly false, and a
// toggle that opens only what is explicitly false, leaves an absent key rendering as closed and
// clicking to closed — a dead header. Open means exactly `true`.
const groupOpen = key => CONTRACT_GROUPS_ON[key] === true;
// The grid's columns as contiguous groups, in render order. `id` is not toggleable — the
// merchant is what identifies the row, so there must always be something to read.
function contractLayout() {
  const segs = [];
  for (const col of CONTRACT_GRID_COLUMNS) {
    const groupKey = col.group || 'id';
    // Contract, Finance and Share terms collapse into one segment — one header, one toggle, one
    // data set. Everything else is its own group exactly as before.
    const key = contractCategoryOf(groupKey);
    let seg = segs[segs.length - 1];
    if (!seg || seg.key !== key) {
      const g = CONTRACT_GROUPS.find(x => x.key === key);
      const label = CONTRACT_CATEGORIES[key] || (g ? g.label : '');
      const toggleable = !!(g || CONTRACT_CATEGORIES[key]);
      segs.push(seg = { key, label, toggleable,
                        open: !toggleable || groupOpen(key), cols: [] });
    }
    seg.cols.push(col);
  }
  return segs;
}

// One entry per rendered cell: every open group's columns, plus a single stub cell standing
// in for each closed group. A closed group keeps that one narrow column so its header — the
// only way to reopen it — never disappears along with its data. Header and body both walk
// this list, so they cannot disagree about how many cells a row has.
function contractRenderCells() {
  const out = [];
  let prev = null;
  for (const seg of contractLayout()) {
    if (seg.toggleable && !seg.open) {
      out.push({ stub: seg, sep: prev !== null });
    } else {
      seg.cols.forEach((col, i) => out.push({ col, sep: i === 0 && prev !== null }));
    }
    prev = seg.key;
  }
  return out;
}
// Recomputed whenever the header is built; contractRowHtml reads it so the cell list is
// walked once per paint rather than once per row.
let CT_CELLS = contractRenderCells();

function contractHeadHtml() {
  const groupRow = [], colRow = [];
  for (const seg of contractLayout()) {
    if (!seg.toggleable) {
      // The Merchant column is frozen, so the group row needs its own pinned cell above it —
      // otherwise group labels slide under the frozen column when the grid scrolls right.
      groupRow.push('<th class="ct-sticky"></th>');
      if (seg.cols.length > 1) groupRow.push(`<th colspan="${seg.cols.length - 1}"></th>`);
    } else if (seg.open) {
      groupRow.push(`<th class="ct-gsep ct-ghead-btn" colspan="${seg.cols.length}" data-group="${seg.key}"`
        + ` title="Hide the ${escape(seg.label)} columns">${escape(seg.label)} <span class="ct-caret">▾</span></th>`);
    } else {
      groupRow.push(`<th class="ct-gsep ct-ghead-btn ct-ghead-closed" data-group="${seg.key}"`
        + ` title="Show the ${escape(seg.label)} columns"><span class="ct-caret">▸</span> ${escape(seg.label)}</th>`);
    }
  }
  groupRow.push('<th class="ct-gsep" colspan="2"></th>');

  CT_CELLS = contractRenderCells();
  CT_CELLS.forEach((cell, i) => {
    if (cell.stub) {
      colRow.push(`<th class="ct-gsep ct-ghead-stub" data-group="${cell.stub.key}"`
        + ` title="Show the ${escape(cell.stub.label)} columns"></th>`);
    } else {
      colRow.push(`<th style="min-width:${cell.col.width}px" class="${colClasses(cell, i)}">${escape(cell.col.label)}</th>`);
    }
  });
  colRow.push('<th class="ct-gsep" style="min-width:135px">Edit</th><th style="min-width:96px"></th>');

  return `<tr class="ct-ghead-row">${groupRow.join('')}</tr>`
       + `<tr class="ct-chead-row">${colRow.join('')}</tr>`;
}

function toggleContractGroup(key) {
  CONTRACT_GROUPS_ON = { ...CONTRACT_GROUPS_ON, [key]: !groupOpen(key) };
  try { localStorage.setItem(CT_GROUPS_KEY, JSON.stringify(CONTRACT_GROUPS_ON)); } catch { /* private mode */ }
  const thead = document.querySelector('.ct-table thead');
  if (thead) thead.innerHTML = contractHeadHtml();   // header and body must be rebuilt together
  paintContracts();
}

const MERCHANT_TYPES = ['F&B', 'Hospitality', 'Lifestyle', 'Shopping Malls', 'Nightlife',
                        'Exhibition Center', 'Convenience Store', 'other'];
const AUTO_RENEWAL_OPTIONS = ['Yes', 'No'];

// Units is derived, never typed: it is the sum of the per-model counts. Verified against
// the source workbook — all 208 rows have a total equal to their model sum, so nothing is
// lost by computing it, and it can no longer drift from the models beneath it.
// The total of a row's machines is the sum of the machines ON that row — no allow-list.
// It used to reduce over a fixed ['S5','S8','M10','L20','L40'], which the 2026-08-27 L40→LL40
// rekey never updated (§11): it named `L40`, which exists in neither region's data, and omitted
// `LL40`, `LL20` and `S10-A`, which is what both regions actually store. The per-model COLUMNS
// beside it are built from Device Types (see UNIT_MODELS_FALLBACK), so the row rendered
// `Units 0` next to `LL40 3` — 50 TH and 114 SG contracts understated, 384 machines invisible.
// Summing the row's own keys is the only version that cannot drift from the columns, and it
// follows the rule §1f already set for those columns: showing a machine under an unexpected
// code beats hiding a machine that is really there.
const unitsTotal = c => Object.values(unitsOf(c) || {}).reduce((a, n) => a + (Number(n) || 0), 0);

// The tab strip on the Upload page. One tab per KIND of disagreement, because they are fixed in
// different places: a wrong model code is a terms edit, a missing brand is an add, a missing
// finance address is a contact edit. A single mixed list would make you re-decide what kind of
// problem you are looking at on every row.
const UP_TABS = [
  { id: 'files',      label: 'Files' },
  { id: 'terms',      label: 'Terms vs machines',  hint: 'A per-machine term names a model the file says this brand does not have, so it pays nothing.' },
  { id: 'noContract', label: 'Brand not registered', hint: 'In your file and earning, but this brand is not registered, so it cannot be paid. Registering it creates the brand that carries the terms.' },
  { id: 'notInFile',  label: 'Brand left the file', hint: 'A registered brand your latest file no longer mentions — no merchant is left under it. Nothing is deleted; archive or remove it one by one.' },
  { id: 'counts',     label: 'Counts differ',      hint: 'What the app has recorded against what your file says. The file is the record, so one button writes all of them. A brand whose file no longer lists a machine type is marked — a per-machine term still keyed to that type pays nothing.' },
  { id: 'noShareTerms', label: 'Share terms incomplete', hint: 'The brand has no share terms, terms that pay nothing, or no aggregation mode — a run cannot pay it. Brands marked "no payout" are not listed: they are deliberately unpaid.' },
  { id: 'noContractInfo', label: 'Contract info incomplete', hint: 'Missing the contract entity, dates, notice period or auto-renewal. The entity is what a payout is settled with and what a statement is addressed to.' },
  { id: 'noFinanceInfo', label: 'Finance info incomplete', hint: 'Missing bank details or the finance contact. Without a finance email a brand cannot be sent a statement or a payment notice.' },
  { id: 'mDeployed',  label: 'Not approved, machines live', hint: 'The merchant is not Approved, yet machines are deployed under it. They are earning while the paperwork lags — these merchants do not reach the registry until the review state changes.' },
  { id: 'mNone',      label: 'Approved, no machine',  hint: 'The merchant is Approved but no deployed machine is bound to it, so there is nothing to pay for yet.' },
  { id: 'mUnbound',   label: 'Machine, no merchant', hint: 'A machine is deployed under a merchant name your file does not carry, so nothing can attribute it to a brand.' },
  { id: 'registry',   label: 'Registry vs file',   hint: 'The registry maps each merchant to its brand. Your file states the same thing every week and is the authority. Review state is shown but never used to leave a merchant out: a run and the platform\'s approval are not related.' },
];

// Served by the backend, which holds both the registry (several MB) and the stored roster, so
// only the differences cross the wire. Loaded with the screen; never fatal.
let REGISTRY_CHECK = null;
let MISMATCH_READ_AT = null;

// Everything the comparison needs, re-read together. The team edits this app WHILE someone is
// looking at it — terms get set, merchants get added, a new file lands — so a page painted at
// 09:00 is quietly answering a question about 09:00. One button re-asks, and every row that has
// since been settled disappears.
//
// `ensureContractCache(true)` forces the refetch; without the flag it returns early on a warm
// cache and the counts would not move after someone else's save.
// Writes the FILE's merchant and machine counts onto every brand that differs. Only those three
// fields are sent, so the contract merge leaves terms, entity, dates and contacts exactly as they
// are — and the engine reads roster rows at run time, so no payout can move because of this.
//
// Runs on its own, because the file is the record. It is NOT a decision anyone was being asked to
// make, and a page of "Update to the list" buttons for numbers the file already settled is work
// the app can do itself.
let FILE_COUNTS_APPLIED = null;
async function applyFileCounts() {
  if (!can('manageMerchants')) return null;
  const rows = fileMismatches(CONTRACTS, ROSTER_BRANDS.brands || {}).counts;
  if (!rows.length) return null;
  let done = 0; const failed = [];
  for (const r of rows) {
    const units = r.fileUnits || {};
    const installedUnits = Object.values(units).reduce((a, n) => a + (Number(n) || 0), 0);
    try {
      const saved = await api('/contracts/' + encodeURIComponent(r.c.contractId), { method: 'PUT',
        body: JSON.stringify({ branchCount: r.fileBranches, units, installedUnits }) });
      Object.assign(r.c, saved || { branchCount: r.fileBranches, units, installedUnits });
      done++;
    } catch (e) { failed.push(`${r.label}: ${e.message}`); }
  }
  FILE_COUNTS_APPLIED = { at: new Date(), done, failed };
  return FILE_COUNTS_APPLIED;
}

async function refreshMismatchData() {
  await ensureContractCache(true);
  const [rb, rc] = await Promise.all([
    api('/roster/brands').catch(() => null),
    api('/registry/check').catch(() => null),
  ]);
  if (rb && rb.brands) ROSTER_BRANDS = rb;
  if (rc && rc.counts) REGISTRY_CHECK = rc;
  MISMATCH_READ_AT = new Date();

  // The file is the record, so bring the registry to it rather than listing the difference.
  // Re-read afterwards so every tab reflects what was just written.
  const applied = await applyFileCounts().catch(e => { console.warn('counts not applied:', e); return null; });
  if (applied && applied.done) {
    await ensureContractCache(true).catch(() => {});
    const again = await api('/roster/brands').catch(() => null);
    if (again && again.brands) ROSTER_BRANDS = again;
  }
}

let UP_TAB = 'files';

function upMismatchCounts() {
  const m = fileMismatches(CONTRACTS, ROSTER_BRANDS.brands || {});
  m.registry = REGISTRY_CHECK;
  const mc = (REGISTRY_CHECK && REGISTRY_CHECK.machineCheck) || { counts: {} };
  m.mDeployed = mc.notApprovedDeployed || [];
  m.mNone = mc.approvedNoDeployed || [];
  m.mUnbound = mc.deployedUnbound || [];
  const rc = (REGISTRY_CHECK && REGISTRY_CHECK.counts) || {};
  return { m, n: { terms: m.terms.length, noContract: m.noContract.length,
                   notInFile: m.notInFile.length, counts: m.counts.length,
                   noShareTerms: m.noShareTerms.length,
                   noContractInfo: m.noContractInfo.length,
                   noFinanceInfo: m.noFinanceInfo.length,
                   mDeployed: (mc.counts || {}).notApprovedDeployed || 0,
                   mNone: (mc.counts || {}).approvedNoDeployed || 0,
                   mUnbound: (mc.counts || {}).deployedUnbound || 0,
                   registry: (rc.missing || 0) + (rc.wrongLink || 0) + (rc.noLink || 0) } };
}

function paintUploadTabs() {
  const strip = document.getElementById('up-tabs');
  if (!strip) return;
  const { m, n } = upMismatchCounts();
  strip.innerHTML = UP_TABS.map(t => {
    const count = t.id === 'files' ? null : n[t.id];
    const label = count == null ? t.label : `${t.label} (${count})`;
    return `<button type="button" class="subtab${t.id === UP_TAB ? ' active' : ''}"
             data-tab="${t.id}"${count === 0 ? ' data-zero="1"' : ''}>${escape(label)}</button>`;
  }).join('');
  strip.querySelectorAll('.subtab').forEach(b => b.addEventListener('click', () => {
    UP_TAB = b.dataset.tab;
    paintUploadTabs();
  }));

  const files = document.getElementById('up-files');
  const box = document.getElementById('up-mismatch');
  if (!files || !box) return;
  files.hidden = UP_TAB !== 'files';     // hidden, never rebuilt — a held file survives
  box.hidden = UP_TAB === 'files';
  if (UP_TAB !== 'files') drawMismatchTab(box, UP_TAB, m);
}

// Each row states what the APP holds and what the FILE says, side by side, and offers the one
// action that resolves it. Nothing is applied in bulk and nothing is applied automatically.
function drawMismatchTab(box, tab, m) {
  const meta = UP_TABS.find(t => t.id === tab);
  const rows = tab === 'registry'
    ? [...(((m.registry || {}).missing) || []), ...(((m.registry || {}).wrongLink) || []),
       ...(((m.registry || {}).noLink) || [])]
    : (m[tab] || []);
  const readAt = MISMATCH_READ_AT
    ? MISMATCH_READ_AT.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : null;
  const head = `<p class="muted" style="margin:0 0 12px;font-size:13px;max-width:780px;">
      ${escape(meta.hint)}</p>
    <p class="muted" style="margin:-6px 0 12px;font-size:12.5px;">
      Against your ${escape(rosterDateLabel())} file${readAt ? ` · read at ${escape(readAt)}` : ''}${
        FILE_COUNTS_APPLIED && FILE_COUNTS_APPLIED.done
          ? ` · <strong>${FILE_COUNTS_APPLIED.done} brand(s) updated from the file</strong>` : ''}${
        FILE_COUNTS_APPLIED && FILE_COUNTS_APPLIED.failed.length
          ? ` · <span class="rc-warn">${FILE_COUNTS_APPLIED.failed.length} could not be written</span>` : ''}
      <button type="button" class="btn-ghost" id="up-recheck" style="margin-left:8px;">Re-check</button>
      <span class="muted" style="margin-left:6px;">someone else may have changed something since</span></p>`;

  if (!rows.length) {
    const noMachines = ['mDeployed', 'mNone', 'mUnbound'].includes(tab)
      && !(((REGISTRY_CHECK || {}).machineCheck || {}).counts || {}).hasMachineFile;
    box.innerHTML = head + (noMachines
      ? `<p class="muted">No machine list has been stored yet. Upload one on the
         <strong>Files</strong> tab and this fills in — the merchant list alone cannot say what is
         deployed.</p>`
      : `<p class="muted">Nothing here — the app and your ${escape(rosterDateLabel())} file agree.</p>`);
    wireMismatchActions(box);
    return;
  }

  // `table.ts` is this app's table, and `.up-mm-wrap` scrolls it HORIZONTALLY on its own rather
  // than letting the page scroll sideways. Deliberately NOT `.ct-scroll`: that sets a border and
  // no overflow, and reusing it once painted a table straight over the controls above it.
  const t = (cols, body) => `<div class="up-mm-wrap"><table class="ts">
      <thead><tr>${cols.map(c => `<th>${escape(c)}</th>`).join('')}</tr></thead>
      <tbody>${body}</tbody></table></div>`;
  const act = (label, kind, id) =>
    `<button type="button" class="btn-ghost up-fix" data-kind="${kind}" data-id="${escape(id)}">${escape(label)}</button>`;
  const u = (obj) => Object.entries(obj || {}).map(([k, v]) => `${k} ${v}`).join(', ') || '—';

  let html = head;
  if (tab === 'terms') {
    html += t(['Brand', 'The term is set on', 'The file says they run', 'Effect', ''],
      rows.map(r => `<tr>
        <td>${escape(r.label)}</td>
        <td>${r.dead.length ? `<span class="rc-warn">${escape(r.dead.join(', '))}</span>` : escape(r.termModels.join(', ') || '—')}</td>
        <td>${escape(r.fileModels.join(', ') || '—')}</td>
        <td>${r.dead.length
              ? `pays <strong>nothing</strong> for ${escape(r.uncovered.join(', ') || 'these machines')}`
              : `nothing pays for ${escape(r.uncovered.join(', '))} — no per-machine term and no
                 revenue share reaches it`}</td>
        <td>${act('Edit terms', 'terms', r.c.contractId)}${
          r.uncovered.length && !r.dead.length
            ? ` <button type="button" class="btn-ghost up-fix" data-kind="ackmodel"
                 data-id="${escape(r.c.contractId)}" data-models="${escape(r.uncovered.join(','))}"
                 title="Record that ${escape(r.uncovered.join(', '))} is deliberately not paid for this brand. It stops being raised; a machine type added later still will be."
                 >Intentional</button>` : ''}</td></tr>`).join(''));
  } else if (tab === 'noContract') {
    html += t(['In your file', 'Merchants', 'Machines', 'State', ''],
      rows.map(r => {
        const a = r.archivedContract;
        return `<tr><td>${escape(r.label)}</td><td>${r.branches}</td><td>${escape(u(r.units))}</td>
        <td>${a
          ? `<span class="rc-warn" title="Adding it again would create a second brand of this name. ${
              r.archivedHasTerms ? 'Its terms are on the archived brand and would be left behind.'
                                 : 'It carries no terms.'}">already registered — archived${
              a.archivedAt ? ' ' + escape(String(a.archivedAt).slice(0, 10)) : ''}${
              r.archivedHasTerms ? ', <strong>has terms</strong>' : ', no terms'}</span>`
          : '<span class="muted">new</span>'}</td>
        <td>${a ? act('Unarchive', 'unarchive', a.contractId) : act('Add to list', 'add', r.label)}</td></tr>`;
      }).join(''));
  } else if (tab === 'notInFile') {
    html += t(['In the registry', 'Merchants recorded', ''],
      rows.map(r => `<tr><td>${escape(r.label)}</td><td>${r.branches ?? '—'}</td>
        <td>${act('Archive', 'archive', r.c.contractId)} ${act('Delete', 'delete', r.c.contractId)}</td></tr>`).join(''));
  } else if (tab === 'counts') {
    // THE FILE IS THE TRUTH — it is applied, never offered (user, 2026-10-01: "just update, i
    // said my file is the truth, you don't have to ask me to initiate it"). `applyFileCounts`
    // writes these as soon as the page reads them, so this table is what is ABOUT to be written
    // or, by the time you look, what already was. No button, because there is nothing to decide.
    html += `<p class="muted" style="margin:0 0 12px;font-size:12.5px;">
      ${rows.length} brand(s) still to write — merchant and machine counts only. Terms, entity,
      contacts and past runs are untouched.</p>`;
    html += t(['Brand', 'App merchants', 'File merchants', 'App machines', 'File machines', ''],
      rows.map(r => {
        // A MACHINE TYPE present on one side and not the other, not merely a different count.
        // It matters on its own: a per-machine term keyed to the type that disappeared matches
        // no machine and pays nothing — which is how two brands were paid 0 (§1ad).
        const gone = r.changed.filter(mm => !(mm in (r.fileUnits || {})));
        return `<tr>
          <td>${escape(r.label)}${gone.length ? ` <span class="rc-warn"
            title="The file no longer lists ${escape(gone.join(', '))} for this brand. A per-machine term still keyed to it matches no machine and pays nothing.">no longer has ${escape(gone.join(', '))}</span>` : ''}</td>
          <td>${r.appBranches ?? '—'}</td><td><strong>${r.fileBranches}</strong></td>
          <td>${escape(u(r.appUnits))}</td><td><strong>${escape(u(r.fileUnits))}</strong></td>
          <td>${gone.length ? act('Check terms', 'terms', r.c.contractId) : ''}</td></tr>`;
      }).join(''));
  } else if (tab === 'noShareTerms' || tab === 'noContractInfo' || tab === 'noFinanceInfo') {
    // One renderer: the three parts differ only in which section of the editor they open.
    const open = tab === 'noShareTerms' ? ['Set terms', 'terms'] : ['Edit', 'edit'];
    html += t(['Brand', 'Merchants', 'What is missing', ''],
      rows.map(r => `<tr><td>${escape(r.label)}</td><td>${r.branches}</td>
        <td class="rc-warn">${escape((r.gaps || []).map(g => INCOMPLETE_LABEL[g] || g).join(', '))}</td>
        <td>${act(open[0], open[1], r.c.contractId)}</td></tr>`).join(''));
  } else if (tab === 'mDeployed') {
    html += t(['Merchant', 'Review state', 'Brand', 'Machines deployed'],
      rows.map(r => `<tr><td>${escape(r.name)}</td>
        <td><span class="rc-warn">${escape(r.state)}</span></td>
        <td>${escape(r.brand) || '<span class="muted">no label</span>'}</td>
        <td>${r.deployed}</td></tr>`).join(''));
  } else if (tab === 'mNone') {
    html += t(['Merchant', 'Brand', 'Machines bound (none deployed)'],
      rows.map(r => `<tr><td>${escape(r.name)}</td><td>${escape(r.brand)}</td>
        <td>${r.machines || 0}</td></tr>`).join(''));
  } else if (tab === 'mUnbound') {
    html += t(['Merchant on the machine', 'Machines deployed', 'Business ID'],
      rows.map(r => `<tr><td>${escape(r.name)}</td><td>${r.deployed}</td>
        <td class="muted">${escape(r.businessId || '—')}</td></tr>`).join(''));
  } else if (tab === 'registry') {
    box.innerHTML = head + registryHtml(m.registry);
    wireMismatchActions(box);
    return;
  }
  box.innerHTML = html;

  wireMismatchActions(box);
}

// ── Registry vs file (2026-10-01) ────────────────────────────────────────────────────────────
// Five ways the registry and the weekly file can differ, each needing a different action.
// Every write goes through POST /registry, which is additive by construction: a merchant keeps its
// id, its notes and its externalId, only the link and the model can be refreshed from a value
// the file actually carries, and a merchant the file does not mention is never touched.
function registryHtml(chk) {
  if (!chk) return `<p class="muted">The registry comparison could not be read. Use Re-check.</p>`;
  const c = chk.counts || {};
  const esc = escape;
  const sec = (title, note, body) => `<h4 style="margin:22px 0 6px;font-size:14px;">${esc(title)}</h4>
    <p class="muted" style="margin:0 0 8px;font-size:12.5px;">${note}</p>${body}`;
  const tbl = (cols, rowsHtml) => `<div class="up-mm-wrap"><table class="ts">
      <thead><tr>${cols.map(x => `<th>${esc(x)}</th>`).join('')}</tr></thead>
      <tbody>${rowsHtml}</tbody></table></div>`;
  const state = (v) => v === 'Approved'
    ? `<span class="muted">Approved</span>` : `<span class="rc-warn">${esc(v || '—')}</span>`;
  const payload = (r) => esc(JSON.stringify({ name: r.name, contractId: r.contractId,
                                              machineModel: r.model || null, externalId: r.externalId || null }));

  let html = '';

  if (c.missing) {
    html += sec(`Not in the registry — ${c.missing}`,
      `Approved merchants with a deployed machine whose brand is already registered — only the
       merchant row is missing. A brand with one merchant shares its name, so both columns can
       read the same: the left is the merchant, the right is the brand it belongs to.`,
      tbl(['Merchant', 'Review state', 'Your file puts it under', ''],
        chk.missing.map(r => `<tr><td>${esc(r.name)}</td><td>${state(r.state)}</td>
          <td><strong>${esc(r.brand)}</strong></td>
          <td><button type="button" class="btn-ghost reg-one" data-shop="${payload(r)}">Add</button></td></tr>`).join(''))
      + `<p style="margin:10px 0 0;"><button type="button" class="btn-primary" id="reg-add-all"
           >Add all ${c.missing} to the registry</button>
         <span class="muted" style="margin-left:8px;">one row per merchant; nothing else is changed</span></p>`);
  }

  if (c.wrongLink) {
    html += sec(`Pointing at a different brand — ${c.wrongLink}`,
      `The registry links the merchant to a live brand your file does not name. The file is the
       authority, so the button moves <em>every</em> row for that merchant.`,
      tbl(['Merchant', 'Your file says', 'The registry says', ''],
        chk.wrongLink.map(r => `<tr><td>${esc(r.name)}</td>
          <td><strong>${esc(r.brand)}</strong></td>
          <td><span class="rc-warn">${esc(r.registryBrand)}</span> <span class="muted">· ${r.rows} row(s)</span></td>
          <td><button type="button" class="btn-ghost up-fix" data-kind="repoint"
               data-id="${esc(r.name)}" data-brand="${esc(r.brand)}">Point at ${esc(r.brand)}</button></td></tr>`).join('')));
  }

  if (c.noLink) {
    const can = chk.noLink.filter(r => r.contractId), cannot = chk.noLink.length - can.length;
    html += sec(`In the registry with no brand — ${c.noLink}`,
      `The merchant has a row but it points at nothing, or at a brand that has been deleted or
       archived.${cannot ? ` ${cannot} of these name a brand that is not registered yet — register
       it first (see the <strong>Brand not registered</strong> tab).` : ''}`,
      tbl(['Merchant', 'Review state', 'Your file puts it under', ''],
        chk.noLink.map(r => `<tr><td>${esc(r.name)}</td><td>${state(r.state)}</td>
          <td>${r.contractId ? `<strong>${esc(r.brand)}</strong>` : `<span class="muted">${esc(r.brand)} — brand not registered</span>`}</td>
          <td>${r.contractId
            ? `<button type="button" class="btn-ghost reg-one" data-shop="${payload(r)}">Link</button>` : ''}</td></tr>`).join(''))
      + (can.length ? `<p style="margin:10px 0 0;"><button type="button" class="btn-primary" id="reg-link-all"
           >Link all ${can.length}</button></p>` : ''));
  }

  if (c.notInFile) {
    html += sec(`In the registry, not in your file — ${c.notInFile}`,
      `Nothing is deleted: merchants come and go, and the registry is not where that is decided.
       Listed so you know what the file no longer mentions.`,
      tbl(['Merchant', 'Currently under', 'Rows'],
        chk.notInFile.map(r => `<tr><td>${esc(r.name)}</td>
          <td>${r.brand ? esc(r.brand) : '<span class="muted">nothing</span>'}</td>
          <td>${r.rows}</td></tr>`).join('')));
  }

  if (c.duplicated) {
    html += sec(`Merchants with more than one row — ${c.duplicated}`,
      `${c.duplicateRows} rows beyond one per merchant, all created before the 24 Aug pagination fix.
       They change no payout. Collapsing them is a separate job — nothing here writes to them.`, '');
  }

  if (c.internal) {
    html += `<p class="muted" style="margin:14px 0 0;font-size:12.5px;">
      ${c.internal} ChargeSpot machine(s) are not listed — internal testing machines, not a
      merchant. They are skipped from this comparison only; nothing about a run changes.</p>`;
  }
  if (c.missingNoMerchant || c.onBrandTab || c.notEligible) {
    html += `<p class="muted" style="margin:18px 0 0;font-size:12.5px;">Not listed above:
      ${c.notEligible ? `<strong>${c.notEligible}</strong> merchant(s) that are not Approved, or
        have no deployed machine — only an Approved merchant with a machine deployed and bound to
        it belongs in the registry. The ones earning anyway are under
        <strong>Not approved, machines live</strong>. ` : ''}${
      (c.missingNoMerchant + (c.onBrandTab || 0))
        ? `<strong>${c.missingNoMerchant + (c.onBrandTab || 0)}</strong> whose brand is the thing
           to fix — not registered, or gone from your file. See <strong>Brand not registered</strong>
           and <strong>Brand left the file</strong>; sorting the brand sorts every merchant under it.`
        : ''}</p>`;
  }
  return html || `<p class="muted">The registry matches your file.</p>`;
}

function wireMismatchActions(box) {
  const refreshAll = async () => { await refreshMismatchData().catch(() => {}); paintUploadTabs(); };

  // One merchant, or a whole bucket — the same request either way, so there is one write path.
  const send = async (btn, shops, what) => {
    if (!shops.length) return;
    if (shops.length > 1 && !confirm(`${what}\n\n${shops.length} merchant(s) in the registry.\n\n`
        + `Each keeps its own id, notes and merchant id — only the brand it points at, and its\n`
        + `machine model, are set from your file. No brand, terms or past run are touched.`)) return;
    const was = btn.textContent;
    btn.disabled = true; btn.textContent = 'Updating…';
    try {
      const r = await api('/registry', { method: 'POST', body: JSON.stringify({ shops }) });
      await refreshAll();
      alert(`Registry updated — ${r.created} added, ${r.updated} changed, ${r.unchanged} already correct.`);
    } catch (e) {
      btn.disabled = false; btn.textContent = was;
      alert('Could not update the registry: ' + e.message);
    }
  };

  const chk = (REGISTRY_CHECK || {});
  box.querySelectorAll('.reg-one').forEach(b => b.addEventListener('click', () =>
    send(b, [JSON.parse(b.dataset.shop)], 'Add this merchant to the registry?')));
  const addAll = box.querySelector('#reg-add-all');
  if (addAll) addAll.addEventListener('click', () => send(addAll,
    (chk.missing || []).map(r => ({ name: r.name, contractId: r.contractId,
                                    machineModel: r.model || null, externalId: r.externalId || null })),
    'Add every merchant your file names that the registry does not have?'));
  const linkAll = box.querySelector('#reg-link-all');
  if (linkAll) linkAll.addEventListener('click', () => send(linkAll,
    (chk.noLink || []).filter(r => r.contractId).map(r => ({ name: r.name, contractId: r.contractId,
                                    machineModel: r.model || null, externalId: r.externalId || null })),
    'Link every unlinked merchant to the brand your file names?'));

  const recheck = box.querySelector('#up-recheck');
  if (recheck) recheck.addEventListener('click', async () => {
    const was = recheck.textContent;
    recheck.disabled = true; recheck.textContent = 'Checking…';
    try { await refreshMismatchData(); } catch (e) { console.warn('re-check failed:', e); }
    recheck.disabled = false; recheck.textContent = was;
    paintUploadTabs();
  });

  box.querySelectorAll('.up-fix').forEach(b => b.addEventListener('click', async () => {
    const id = b.dataset.id;
    // Each one reuses the editor the Overview already uses, so there is one definition of
    // what editing a contract means — and `paintUploadTabs` re-counts afterwards, so a row that
    // now agrees with the file leaves the tab by itself.
    // After any fix, re-read EVERYTHING rather than only the contracts — a repoint changes the
    // registry, which only the conflicts route can see.
    const after = async () => { await refreshMismatchData().catch(() => {}); paintUploadTabs(); };
    // Each of these refreshes WHEN IT SAVES. Running `after()` next to the call refreshed while
    // the dialog was still open, which is why a row stayed in the table after being fixed.
    if (b.dataset.kind === 'terms')        await openTermsEditor(id, after);
    else if (b.dataset.kind === 'edit')    openContractEditor(id, after);
    else if (b.dataset.kind === 'add')     await openAddFromFile(id, b, after);
    else if (b.dataset.kind === 'archive') { await archiveFromUpload(id, b); await after(); }
    else if (b.dataset.kind === 'unarchive') { await unarchiveFromUpload(id, b); await after(); }
    else if (b.dataset.kind === 'delete')  { await deleteFromUpload(id, b); await after(); }
    else if (b.dataset.kind === 'ackmodel') {
      const models = String(b.dataset.models || '').split(',').filter(Boolean);
      const c = CONTRACTS.find(x => x.contractId === id);
      if (!c || !models.length) return;
      if (!confirm(`Record that ${models.join(', ')} is deliberately not paid per machine for `
        + `${c.merchantName}?\n\nThose machines earn nothing under these terms. This only stops `
        + `the app asking — it changes no terms and no payout. A machine type added later is `
        + `still raised.`)) return;
      const was = b.textContent; b.disabled = true; b.textContent = 'Saving…';
      try {
        const ack = [...new Set([...(c.uncoveredModelsAck || []), ...models])];
        const saved = await api('/contracts/' + encodeURIComponent(id), {
          method: 'PUT', body: JSON.stringify({ uncoveredModelsAck: ack }) });
        Object.assign(c, saved || { uncoveredModelsAck: ack });
        await after();
      } catch (e) {
        b.disabled = false; b.textContent = was;
        alert('Could not record that: ' + e.message);
      }
    }
    else if (b.dataset.kind === 'repoint') {
      await repointStoreFromFile(id, b.dataset.brand, b, after);
    }
  }));
}

// C2 (2026-10-01): "you remind us with the latest update date of files and which brands are with
// incomplete terms, the latter requires update to proceed run."
//
// SHARE TERMS block a run — without them the brand cannot be paid. Contract and finance gaps are
// REPORTED and do not block, by the user's decision: 217 brands lack contract info and 277 lack
// finance info, so blocking on those would mean no run could happen at all. They still matter —
// a brand with no finance email cannot be sent its statement afterwards — so the run says so
// where the decision to run is being made.
function incompleteTermsNote() {
  const live = (CONTRACTS || []).filter(c => !c.archived);
  const missing = (c, part) => INCOMPLETE_FIELDS[part]
    .some(f => !String((f === 'entity' ? entityName(c) : c[f]) ?? '').trim());
  const noContract = live.filter(c => missing(c, 'contract')).length;
  const noFinance = live.filter(c => missing(c, 'finance')).length;
  if (!noContract && !noFinance) return '';
  return `<p class="muted" style="margin:10px 0 0;font-size:12.5px;">
    ${noContract ? `<strong>${noContract}</strong> brand(s) have incomplete contract information` : ''}
    ${noContract && noFinance ? ' and ' : ''}
    ${noFinance ? `<strong>${noFinance}</strong> have incomplete finance information` : ''}.
    Neither stops this run — a brand without a finance email simply cannot be sent its statement
    afterwards. They are listed on the <strong>Upload</strong> page.</p>`;
}

// ── C5: brands and merchants that have GONE (2026-10-01) ─────────────────────────────────────
// "there will be brands or merchants that is not registered anymore, it's ok, because they come
// and go, and we still need to calculate to pay."
//
//   GONE BRAND    — your latest file carries no merchant under it at all.
//   GONE MERCHANT — the brand is still in the file, but this one merchant is not.
//
// Neither changes a payout: a run computes what actually happened in the period, from the roster
// it was given. They are MARKED so a figure for a brand you no longer carry is explained rather
// than read as an error.
function brandIsGone(brandName) {
  const brands = ROSTER_BRANDS.brands || {};
  if (!Object.keys(brands).length) return false;      // no file on record: claim nothing
  return !brands[String(brandName || '').trim().toLowerCase()];
}

// A merchant of a brand that IS still in the file, but which the file no longer lists.
function goneMerchants(result) {
  const b = (ROSTER_BRANDS.brands || {})[String(result.merchantName || '').trim().toLowerCase()];
  if (!b) return new Set();                            // whole brand gone — marked at brand level
  const have = new Set((b.merchantNames || []).map(n => String(n).toLowerCase().trim()));
  if (!have.size) return new Set();                    // the file list is not loaded; claim nothing
  const gone = new Set();
  for (const m of result.merchants || []) {
    const k = String(m.merchantName || '').toLowerCase().trim();
    if (k && !have.has(k)) gone.add(k);
  }
  return gone;
}

// ── C4: a brand's own merchants, exactly as the download states them ─────────────────────────
// "build a developed view when I click on brands, it shows exactly the table grid of the download
// file is, I mean the summary of each merchant part." So this is block 1 of the statement, built
// from the same frozen run result — not a second rendering that could disagree with the file the
// merchant receives.
function openRunBrandDetail(run, contractId) {
  const r = (run.results || []).find(x => x.contractId === contractId);
  if (!r) return;
  const { card, close } = ctModal(1180);
  const gone = goneMerchants(r);
  const rule = (run.ruleSnapshots || {})[contractId];
  const term = termText(rule);
  const rows = buildPartnerSheet({ utils: { aoa_to_sheet: a => a } }, r, null, new Map(), null, rule);
  const end = rows.findIndex(x => x[0] === 'Grand Total');
  const body = rows.slice(1, end + 1);

  card.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px;">
      <div>
        <h3 style="margin:0 0 2px;">${escape(r.merchantName)}${
          brandIsGone(r.merchantName) ? ' <span class="rc-warn">gone from your file</span>' : ''}</h3>
        <p class="muted" style="margin:0;font-size:12.5px;">
          ${escape(contractEntityFor(contractId) || 'no contract entity')} ·
          ${escape(periodMonth(run.periodStart))} · terms ${escape(term || 'not stated')}</p>
      </div>
      <button type="button" class="btn-ghost" id="rb-close">Close</button>
    </div>
    <p class="muted" style="margin:12px 0 8px;font-size:12.5px;">
      The summary block of this brand's download, merchant by merchant. A merchant your latest file
      no longer carries is marked — it is still paid for what it earned this period. Where the terms
      are a comparison and each merchant is settled on its own, the share column states which side
      <em>won on that merchant</em>; otherwise it states the agreed term, which is in the heading
      above.</p>
    <div class="up-mm-wrap" style="max-height:56vh;overflow-y:auto;">
      <table class="ts"><thead><tr>
        <th>Rental Place</th><th>รุ่นเครื่อง</th><th>จำนวนการยืม</th><th>ยอดรายได้ทั้งหมด</th>
        <th>ส่วนแบ่งรายได้</th><th>มูลค่าส่วนแบ่ง (ฐานภาษี)</th><th>ภาษี</th><th>ยอดรวม</th>
      </tr></thead><tbody>${body.map(x => {
        const isTotal = x[0] === 'Grand Total';
        const isGone = !isTotal && gone.has(String(x[0] || '').toLowerCase().trim());
        return `<tr${isTotal ? ' style="font-weight:600;border-top:2px solid var(--border);"' : ''}>
          <td>${escape(String(x[0] ?? ''))}${isGone
            ? ' <span class="rc-warn" title="Your latest file no longer lists this merchant. It is still paid for this period.">gone</span>' : ''}</td>
          ${[1,2,3,4,5,6,7].map(i => `<td class="${i === 4 ? 'rb-term' : ''}"${
            i >= 2 && i !== 4 ? ' style="text-align:right;"' : ''}>${
            escape(String(x[i] ?? ''))}</td>`).join('')}
        </tr>`;
      }).join('')}</tbody></table>
    </div>`;
  card.querySelector('#rb-close').addEventListener('click', close);
}

// ── The merchants behind a merchant count (2026-10-01) ─────────────────────────────────────────────
// Clicking the Branch number opens the merchants it counts, read straight from the uploaded file —
// the Thai name, the English name, the Merchant label they are grouped under, and the machine.
// Nothing here edits anything: it exists to answer "which merchants is this, exactly" while working
// through a brand one merchant at a time.
async function openBranchList(brand) {
  const { card, close } = ctModal(860);
  card.innerHTML = `<p class="muted" style="margin:0;">Loading the merchants…</p>`;
  let data;
  try {
    data = await api('/roster/shops?brand=' + encodeURIComponent(brand));
  } catch (e) {
    card.innerHTML = `<h3 style="margin:0 0 8px;">${escape(brand)}</h3>
      <p class="rc-warn">Could not read the merchants for this brand (${escape(e.message || 'unknown error')}).</p>`;
    return;
  }
  const shops = data.shops || [], held = data.heldBack || [];
  const when = data.at ? new Date(data.at).toLocaleDateString('en-GB',
                 { day: 'numeric', month: 'short', year: 'numeric' }) : 'your latest file';

  card.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px;">
      <div>
        <h3 style="margin:0 0 2px;">${escape(brand)}</h3>
        <p class="muted" style="margin:0;font-size:12.5px;">
          ${shops.length} merchant(s)${data.stations > shops.length
            ? ` · ${data.stations} station(s)` : ''} — from your ${escape(when)} upload</p>
      </div>
      <button type="button" class="btn-ghost" id="bl-close">Close</button>
    </div>
    <input id="bl-filter" class="input" style="margin:14px 0 10px;max-width:320px;"
           placeholder="Filter by merchant name…">
    <div class="up-mm-wrap" style="max-height:52vh;overflow-y:auto;">
      <table class="ts"><thead><tr>
        <th>Merchant name (Thai)</th><th>Merchant name (English)</th>
        <th>Merchant label</th><th>Machine type</th></tr></thead>
        <tbody id="bl-body"></tbody></table>
    </div>
    ${held.length ? `<p class="muted" style="margin:12px 0 0;font-size:12.5px;">
      <span class="rc-warn">${held.length} merchant(s) held back by their review state</span>
      and not counted: ${escape(held.map(h => `${h.name} (${h.reviewState || '—'})`)
        .slice(0, 8).join(', '))}${held.length > 8 ? ` … and ${held.length - 8} more` : ''}</p>` : ''}`;

  const body = card.querySelector('#bl-body');
  const draw = (q) => {
    const k = String(q || '').toLowerCase().trim();
    const rows = !k ? shops : shops.filter(sh =>
      (sh.name || '').toLowerCase().includes(k) || (sh.nameEn || '').toLowerCase().includes(k));
    body.innerHTML = rows.length
      ? rows.map(sh => `<tr>
          <td>${escape(sh.name)}</td>
          <td>${sh.nameEn ? escape(sh.nameEn) : '<span class="muted">—</span>'}</td>
          <td>${escape(sh.label)}</td>
          <td>${sh.model ? escape(sh.model) : '<span class="rc-warn">no device type</span>'}</td>
        </tr>`).join('')
      : `<tr><td colspan="4" class="muted">No merchant matches that.</td></tr>`;
  };
  draw('');
  card.querySelector('#bl-filter').addEventListener('input', e => draw(e.target.value));
  card.querySelector('#bl-close').addEventListener('click', close);
}

// ── Where the app disagrees with the file (2026-10-01) ───────────────────────────────────────
// "File upload is the real data, if any setting on the app is not corresponding to the file, just
// highlight it." So this REPORTS; it changes nothing and proposes nothing automatically. Each
// row names what the app holds and what the file says, and the person decides.
//
// The one that costs money: a per-machine term keyed to a model the merchant does not have.
// `evalFlatPerMachine` counts roster rows of that exact code, so a term on `L40` against `LL40`
// machines evaluates to ZERO — and nothing says so. Measured 1 Oct: SEACON Bangkae earned 17,200
// and was paid 0; Platinum Fashion Mall earned 2,580 and was paid 0; PMCU's guarantee cannot
// fire. The device codes are deliberately distinct and nothing folds (§11), so this cannot be
// fixed by matching loosely — only by showing it.
//
// Pure: contracts + the file's brands in, six lists out.
function termModelsOf(node, out = new Set()) {
  if (!node || typeof node !== 'object') return out;
  if (node.type === 'flat_per_machine') {
    for (const r of node.rows || []) {
      if (r.model && r.model !== 'ALL' && Number(r.amount) > 0) out.add(r.model);
    }
  }
  (node.children || []).forEach(c => termModelsOf(c, out));
  return out;
}

// Which models a PERCENTAGE term earns on. A revenue share does not care how many machines there
// are — a `model: 'ALL'` row pays on every rental, whatever machine took it.
//
// This is why QSNCC was wrongly flagged (2026-10-01): its rule is `GP 35% (ALL) + Placement LL40
// 2,000`, and its S8 machines earn through the 35%. Reading only the per-machine terms made five
// earning machines look uncovered. A model is uncovered only when NOTHING pays for it.
function percentCoversAll(node) {
  if (!node || typeof node !== 'object') return false;
  if (node.type === 'percent') {
    return (node.rows || []).some(r => Number(r.percent) > 0 && (!r.model || r.model === 'ALL'));
  }
  if (node.type === 'tiered_percent') return (node.tiers || []).length > 0;
  return (node.children || []).some(percentCoversAll);
}

function percentModelsOf(node, out = new Set()) {
  if (!node || typeof node !== 'object') return out;
  if (node.type === 'percent') {
    for (const r of node.rows || []) {
      if (Number(r.percent) > 0 && r.model && r.model !== 'ALL') out.add(r.model);
    }
  }
  (node.children || []).forEach(c => percentModelsOf(c, out));
  return out;
}

// What each part of the brand's terms must carry to be complete. Labels, not keys, are what the
// person sees — `entity` is special-cased because a linked brand reads its ENTITY record rather
// than the contract's own string.
const INCOMPLETE_FIELDS = {
  contract: ['entity', 'startDate', 'endDate', 'terminationNoticeDays', 'autoRenewal'],
  finance: ['bankName', 'bankAccountName', 'bankAccountNumber', 'financeContactName', 'financeContactEmail'],
};
const INCOMPLETE_LABEL = {
  entity: 'contract entity', startDate: 'start date', endDate: 'end date',
  terminationNoticeDays: 'notice period', autoRenewal: 'auto-renewal',
  bankName: 'bank', bankAccountName: 'account name', bankAccountNumber: 'account number',
  financeContactName: 'finance contact', financeContactEmail: 'finance email',
  rule: 'share terms', 'rule pays nothing': 'terms that pay nothing', aggregation: 'aggregation mode',
};

// A rule that exists but pays nothing is as incomplete as no rule at all — it is how 39 brands
// once reached a run and were paid zero with no warning (§1b). THE ONE DEFINITION IS
// `ruleHasValue` below, which mirrors payout.mjs — the backend's copy is what actually locks
// step 4 of a run, so a second opinion here can only ever disagree with the thing that decides.
//
// There was a second copy here (removed 2026-10-01). It read a `tiered_percent` leaf as
// `node.tiers`, while the engine and the backend both read `node.rows[].tiers` — so every
// tiered rule looked empty to it: the Upload page would have called a real tiered term "terms
// that pay nothing", and the adopt picker would have refused to copy one. It also tested the
// array's LENGTH rather than its percentages, so an all-zero tiered rule passed for the wrong
// reason. No live contract is tiered today, which is the only reason nothing was on screen.

// ChargeSpot's own machines are not a merchant (2026-10-01) — "they are all internal testing
// machines". Matched with punctuation and spacing removed, because the real names are spelled
// `CHARGESPOT-TH`, `ChargeSpot` and `CHARGESPOT TEST`. The backend has the same rule for the
// registry and machine comparisons; a test asserts the two agree.
//
// COMPARISONS ONLY. Nothing here touches a run or a payout.
function isInternalName(...names) {
  return names.some(n => /chargespot/.test(String(n || '').toLowerCase().replace(/[^a-z0-9]/g, '')));
}

function fileMismatches(contracts, brands) {
  const key = s => String(s || '').trim().toLowerCase();
  const live = (contracts || []).filter(c => !c.archived);
  const byName = new Map(live.map(c => [key(c.merchantName), c]));
  // ARCHIVED IS REGISTERED (2026-10-01). A brand your file still carries may already exist and
  // simply be archived — three did on 1 Oct, and `Bossotel` CARRIED ITS TERMS. "Add to list" on
  // one of those creates a SECOND brand of the same name with no terms, and the negotiated ones
  // stay on the archived row where no run can reach them. That is exactly how `Central` was paid
  // zero on 51,495 THB of revenue. So the row says which it is, and offers Unarchive instead.
  const archived = new Map();
  for (const c of contracts || []) {
    if (c && c.archived) { const k = key(c.merchantName); if (k && !archived.has(k)) archived.set(k, c); }
  }
  const out = { terms: [], noContract: [], notInFile: [], counts: [], noTerms: [], noFinance: [],
                noContractInfo: [], noFinanceInfo: [], noShareTerms: [] };

  for (const [k, b] of Object.entries(brands || {})) {
    if (isInternalName(b.label)) continue;
    const c = byName.get(k);
    if (!c) {
      const a = archived.get(k) || null;
      out.noContract.push({ label: b.label, branches: b.branches, units: b.units,
                            archivedContract: a,
                            archivedHasTerms: !!(a && a.rule && ruleHasValue(a.rule)) });
      continue;
    }

    const fileModels = new Set(Object.keys(b.units || {}));
    const stored = c.units || {};
    const changed = [...new Set([...Object.keys(stored), ...fileModels])]
      .filter(m => (Number(stored[m]) || 0) !== (Number((b.units || {})[m]) || 0));
    if ((c.branchCount ?? null) !== b.branches || changed.length) {
      out.counts.push({ c, label: b.label, appBranches: c.branchCount ?? null, fileBranches: b.branches,
                        appUnits: stored, fileUnits: b.units || {}, changed });
    }

    // B4 (2026-10-01): "if any part is missing, it is incomplete". The three parts are the three
    // sections of the editor — Contract, Finance, Share terms — so a row lands on the page that
    // opens the section it is missing, rather than on one list of mixed problems.
    //
    // `noPayout` excuses the SHARE TERMS only. A brand nobody pays still needs its entity and its
    // finance details: it is invoiced, reconciled and written to like any other.
    const missingIn = (part) => INCOMPLETE_FIELDS[part]
      .filter(f => !String((f === 'entity' ? entityName(c) : c[f]) ?? '').trim());
    for (const part of ['contract', 'finance']) {
      const gaps = missingIn(part);
      if (gaps.length) out[part === 'contract' ? 'noContractInfo' : 'noFinanceInfo']
        .push({ c, label: b.label, branches: b.branches, gaps });
    }
    if (!c.noPayout) {
      const gaps = [];
      if (!c.rule) gaps.push('rule');
      else if (!ruleHasValue(c.rule)) gaps.push('rule pays nothing');
      if (!['whole', 'per_store'].includes(c.aggregationMode)) gaps.push('aggregation');
      if (gaps.length) out.noShareTerms.push({ c, label: b.label, branches: b.branches, gaps });
    }
    if (!c.noPayout) {
      const tm = termModelsOf(c.rule);
      // A term naming a model the file does not list pays nothing. The other direction — a model
      // with no term — is only worth saying when the contract HAS per-machine terms; a pure
      // percentage rule covers every model by design and is not a mismatch.
      const dead = [...tm].filter(m => !fileModels.has(m));
      // A model earns if ANY term reaches it: a per-machine row of its own, a percentage on that
      // model, or a percentage on ALL. Only then is it genuinely paid nothing.
      const pctAll = percentCoversAll(c.rule);
      const pctModels = percentModelsOf(c.rule);
      // …and a type someone has said is deliberately unpaid is not raised again. Recorded per
      // MODEL rather than per brand, so a type added to the file later is still a new question.
      const acked = new Set(c.uncoveredModelsAck || []);
      const uncovered = (tm.size && !pctAll)
        ? [...fileModels].filter(m => !tm.has(m) && !pctModels.has(m) && !acked.has(m)) : [];
      if (dead.length || uncovered.length) {
        out.terms.push({ c, label: b.label, dead, uncovered,
                         fileModels: [...fileModels], termModels: [...tm] });
      }
      if (!c.rule) out.noTerms.push({ c, label: b.label, branches: b.branches });
    }
    if (!String(c.financeContactEmail || '').trim()) {
      out.noFinance.push({ c, label: b.label, branches: b.branches });
    }
  }

  // The reverse direction: in the app, absent from the latest file. Not a fault — a merchant can
  // leave a file for a week — which is why nothing here deletes anything.
  for (const c of live) if (!(brands || {})[key(c.merchantName)]) {
    if (isInternalName(c.merchantName)) continue;
    out.notInFile.push({ c, label: c.merchantName, branches: c.branchCount ?? null });
  }
  return out;
}

// ── Branches and machines are what the FILE says (2026-10-01) ────────────────────────────────
// "please read from the latest file for branch and machine number, if mu files says 5, then it
// is 5." Merchant INFORMATION is file-owned; the grid was showing the CONTRACT's stored
// `branchCount`/`units`, which are only as fresh as the last import that touched them. Central
// read 10 merchants / 10 LL40 against a file saying 5 of each — a leftover from before the brand
// was split per mall.
//
// Keyed on the brand label, lower-cased, because that is what the file groups merchants under and
// what a run resolves on. NOTHING IS WRITTEN: the stored columns are left exactly as they are
// and remain the answer for a brand the latest file does not mention (those rows already carry
// the ⦿ mark, so the grid is not quietly mixing two vintages without saying so).
let ROSTER_BRANDS = { at: null, by: null, brands: {} };

const rosterDateLabel = () => {
  const d = new Date(ROSTER_BRANDS.at || 0);
  return isNaN(d) || !ROSTER_BRANDS.at
    ? 'latest' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
};

// One line on purpose: the suite extracts these helpers by `const <name> =` up to the newline.
const fileBrandOf = (c) => (ROSTER_BRANDS.brands || {})[String((c && c.merchantName) || '').trim().toLowerCase()] || null;
// The file wins where it speaks; the stored value answers where it is silent.
const branchesOf = (c) => { const b = fileBrandOf(c); return b ? b.branches : (c?.branchCount ?? null); };
const unitsOf = (c) => { const b = fileBrandOf(c); return b ? b.units : ((c && c.units) || {}); };

// Presentation derived from the column's type, computed once and used by BOTH the header
// and the body so the two can never drift out of alignment.
const GROUP_ORDER = ['id', 'contact', 'machines', 'contract', 'terms'];
function colClasses(cell, i) {
  const out = [];
  const col = cell.col;
  if (col.type === 'bool') out.push('ct-c');
  else if (['number', 'computed', 'term-num', 'term-model'].includes(col.type)) out.push('ct-r');
  if (i === 0) out.push('ct-sticky');
  // A hairline where one group of columns ends and the next begins — at 25 columns the eye
  // needs somewhere to rest.
  if (cell.sep) out.push('ct-gsep');
  return out.join(' ');
}

const cellValue = (c, key) => key.includes('.')
  ? (c[key.split('.')[0]] || {})[key.split('.')[1]]
  : c[key];

// Days until the contract ends; null when there is no end date.
function daysToEnd(c) {
  if (!c.endDate) return null;
  const end = Date.parse(c.endDate + 'T00:00:00Z');
  if (Number.isNaN(end)) return null;
  const n = new Date();
  const today = Date.UTC(n.getFullYear(), n.getMonth(), n.getDate());   // compare calendar days, not instants
  return Math.round((end - today) / 86400000);
}

// Renewal risk, shown on the End date cell only.
// An approaching end date matters only when the contract does NOT auto-renew — if it
// renews by itself, nothing needs doing and a highlight would be noise. For a non-renewing
// contract the actionable moment is when the notice window opens: you must give notice
// `terminationNoticeDays` before the end, so once days-remaining falls to that, it is due.
// With no notice period recorded we cannot say the window is open, so only flag overdue.
function renewalFlag(c) {
  if (!/^no/i.test(String(c.autoRenewal || ''))) return { cls: '', title: '' };
  const d = daysToEnd(c);
  if (d == null) return { cls: '', title: '' };
  if (d < 0) return { cls: 'ct-expired', title: `Contract ended ${-d} day(s) ago and does not auto-renew` };
  const notice = c.terminationNoticeDays;
  if (notice == null || notice === '') return { cls: '', title: '' };
  if (d <= Number(notice)) {
    return { cls: 'ct-soon', title: `Notice window is open — ${d} day(s) left, ${notice} day(s) notice required` };
  }
  return { cls: '', title: '' };
}

// Canonical string form of a value for structural equality checks — key-order-insensitive
// (compileRule emits `_method` last, so plain JSON.stringify gives false negatives when
// comparing a freshly compiled rule against one stored earlier with different key order).
const canon = v => JSON.stringify(v, (k, val) =>
  val && typeof val === 'object' && !Array.isArray(val)
    ? Object.fromEntries(Object.keys(val).sort().map(kk => [kk, val[kk]]))
    : val);

// What the grid would recompile a rule to right now, with no edits applied — this is
// exactly what a true no-op blur produces, and it's also the round-trip probe for
// representability below.
const roundTripRule = r => compileRule(decompileRule(r));

// A rule is representable in the grid's five-term form when decompiling then
// recompiling reproduces it exactly. Non-representable shapes (tiered_percent, min, or
// anything else compileRule can't emit) show as "custom" in the grid rather than the
// simplified summary — the terms editor's tree editor can still open and edit them (via
// its raw-JSON mode), this flag only gates whether the grid's one-line label can describe
// them honestly. A contract with no rule at all is always representable: creating one
// from the grid is legitimate, terms are only ever written through the terms editor's
// tree editor, which cannot fabricate a rule by accident.
function isRepresentable(r) {
  if (!r || !r.type) return true;
  // An empty sum is "no rule" in all but name — the same shape the tree editor starts a
  // brand new rule from, so without this a freshly-started row would land back in the
  // grid with its term cells already locked, defeating the flow that created it.
  if (r.type === 'sum' && !(r.children || []).length) return true;
  return canon(roundTripRule(r)) === canon(r);
}

// Treat an empty sum as "no rule" everywhere the no-rule guards apply, for the same reason.
const ruleIsAbsent = r => !r || !r.type || (r.type === 'sum' && !(r.children || []).length);

// Mirror of `ruleHasValue` in lambda/revshare-api/code/payout.mjs — kept deliberately
// identical, because the run pipeline decides who gets paid with that function and this
// screen must not disagree with it. `ruleIsAbsent` above is the weaker "is there a tree at
// all" test; this is "does the tree actually pay anything", which is what matters: a rule of
// `percent ALL 0%` has a tree and pays nothing, and the run skips it.
// The SPA cannot import from lambda/ (no build step), so this is a maintained duplicate —
// change one, change the other.
function ruleHasValue(node) {
  if (!node || typeof node !== 'object') return false;
  switch (node.type) {
    case 'flat_per_partner_total': return Number(node.amount) > 0;
    case 'percent':                return (node.rows || []).some(r => Number(r.percent) > 0);
    case 'flat_per_machine':       return (node.rows || []).some(r => Number(r.amount) > 0);
    case 'tiered_percent':         return (node.rows || []).some(r => (r.tiers || []).some(t => Number(t.percent) > 0));
    default:                       return (node.children || []).some(ruleHasValue);
  }
}

// A merchant needs terms when it is meant to be paid but nothing says how much, OR nothing says
// how to aggregate it. Both halves, because this is the grid's ◆ badge and filter and it has to
// mean what `contractNeedsTerms` means — that is what actually locks step 4 of a run.
//
// The aggregation half was missing until 2026-10-01: a paying rule with no `aggregationMode`
// read as complete here and blocked the run, with no row anywhere saying which brand. The same
// gap on the backend let 73 contracts clear step 3 in August and then get skipped at run time
// (§1b). One line, one direction: `payoutDecision` is the authority, `contractNeedsTerms`
// mirrors it, and this mirrors that.
const needsTerms = c => !c.archived && !c.noPayout
  && (!ruleHasValue(c.rule) || !['whole', 'per_store'].includes(c.aggregationMode));

// The merchant-view row owns its terms directly — no partner lookup involved.
function termCellHtml(c, col) {
  const sub = col.key.split('.')[1];          // 'method' | 'summary'
  if (c.noPayout) return '<span class="ct-none" title="Not paid — skipped in revenue-share runs">None</span>';
  if (ruleIsAbsent(c.rule)) {
    return sub === 'method' ? '<span class="ct-empty">–</span>' : '<span class="muted" title="No terms set yet">not set</span>';
  }
  // A rule the simplified form can't express (tiered_percent, min, nested shapes) has no
  // honest one-word mode and no one-line formula — say so rather than print a wrong label.
  if (!isRepresentable(c.rule)) {
    return sub === 'method'
      ? '<span class="ct-locked" title="A rule shape the simplified form cannot label">custom</span>'
      : '<span class="ct-terms ct-locked" title="Click for the full breakdown">custom rule ›</span>';
  }
  const f = decompileRule(c.rule);
  if (sub === 'method') return escape(methodToName(f.method));
  // The same one-line formula the partner Rule tab shows, so the two screens describe a
  // rule identically rather than each inventing a wording.
  return `<span class="ct-terms" title="Click for the full breakdown">${escape(payoutFormula(f))}</span>`;
}



function contractRowHtml(c) {
  const rf = renewalFlag(c);
  const cells = CT_CELLS.map((cell, i) => {
    if (cell.stub) return '<td class="ct-cell ct-gsep ct-ghead-stub"></td>';
    const col = cell.col;
    // Reads the ENTITY record when the contract is linked, and the contract's own string when
    // it is not — so an unlinked row looks exactly as it always did.
    const v = col.key === 'counterParty' ? (entityName(c) || null)
            : col.key === 'branchCount'  ? branchesOf(c)
            : col.key.startsWith('units.') ? (unitsOf(c)[col.key.slice(6)] ?? null)
            : cellValue(c, col.key);
    let disp;
    if (col.type && col.type.startsWith('term-')) disp = termCellHtml(c, col);
    else if (col.type === 'computed') {
      const fromFile = !!fileBrandOf(c);
      const why = fromFile
        ? `From your ${rosterDateLabel()} upload — ${branchesOf(c)} merchant(s). Merchant information is read from the file, not typed.`
        : 'Sum of the per-model counts. This brand is not in your latest upload, so these are the stored numbers.';
      disp = `<span class="ct-computed" title="${escape(why)}">${unitsTotal(c)}</span>`;
    }
    else if (col.type === 'bool') disp = v ? '✓' : '';
    else if (col.type === 'url') {
      disp = !v ? ''
        : (/^https?:\/\//i.test(v)
            ? `<a href="${escape(v)}" target="_blank" rel="noopener">open ↗</a>`
            : escape(String(v)));
    }
    // `suffix` is display-only — the editor still shows the bare number, so typing and
    // saving are unaffected.
    // The merchant count opens the merchants behind it — but only where the file can list them. A
    // number from the stored column has nothing to show, so it stays plain text rather than
    // offering a click that would open an empty dialog.
    else if (col.key === 'branchCount' && v != null && fileBrandOf(c)) {
      disp = `<button type="button" class="ct-branch" data-brand="${escape(c.merchantName || '')}"
               title="Show the ${v} merchant(s) this counts, from your ${escape(rosterDateLabel())} file">${escape(String(v))}</button>`;
    }
    else disp = v == null || v === '' ? '' : escape(String(v)) + (col.suffix ? `<span class="ct-unit">${escape(col.suffix)}</span>` : '');
    // The End-date highlight only helps if that column is on screen; the Merchant column is
    // frozen, so the icon rides there and the row stays spottable however far you scroll.
    // Say why a cell does not open, rather than letting a click do nothing unexplained.
    // NOTHING in the grid is edited in place any more (2026-09-29). Contract, Finance and
    // Share terms are changed through the row's Edit button, which saves once, validates once,
    // and cannot be triggered by a stray click on a table cell.
    const editable = false;
    if (i === 0) {
      // Two independent row-level flags ride the frozen Merchant column so they stay visible
      // however far right the grid is scrolled: renewal risk, and "this will block a run".
      if (needsTerms(c)) {
        disp = '<span class="ct-alert ct-alert-terms" title="No terms that pay anything — this merchant will block Step 4 of a run until its terms are set, or it is marked None">◆</span>' + disp;
      }
      // Third row-level flag: your latest merchant file did not mention this merchant. Nothing
      // is deleted by an import, so this is the only trace that it has dropped off the list.
      if (MISSING_UPLOAD.has(c.contractId)) {
        disp = `<span class="ct-alert ct-alert-missing" title="Not in the ${escape(uploadLabel())} upload — nothing was deleted, but your latest merchant file does not mention this merchant">⦿</span>` + disp;
      }
      if (rf.cls) {
        disp = `<span class="ct-alert ${rf.cls === 'ct-expired' ? 'ct-alert-over' : 'ct-alert-soon'}" title="${escape(rf.title)}">⚠</span>` + disp;
      }
    }
    // An explicit dash for empty, so "nothing recorded" is distinguishable from a cell that
    // simply failed to render — at this width a blank cell reads as a glitch.
    if (disp === '') disp = '<span class="ct-empty">–</span>';
    const cls = colClasses(cell, i);
    const flag = col.key === 'endDate' && rf.cls ? ` ${rf.cls}` : '';
    const ro = editable || !can('manageMerchants') ? '' : ' ct-ro';
    const tip = col.key === 'endDate' && rf.title ? ` title="${escape(rf.title)}"`
      : (ro ? ' title="From your merchant upload — change it in the file, not here. An import would overwrite an edit made in this cell."' : '');
    return `<td class="ct-cell ${cls}${flag}${ro}" data-id="${escape(c.contractId)}" data-key="${col.key}"${tip}>${disp}</td>`;
  }).join('');
  // Edit-terms column: the row owns its terms directly now, so this is just a control,
  // never a partner badge.
  const editCell = can('manageMerchants')
    ? `<button class="btn-ghost ct-pe-btn" data-id="${escape(c.contractId)}" title="Edit this merchant's contract, finance details and share terms">Edit…</button>`
    : '';
  // Archive is the soft exit — the contract ended, the row stops being paid, but its history
  // stays. Delete is the hard one, kept next to it deliberately so the gentler option is the
  // one in reach.
  const actions = can('manageMerchants')
    ? `<button class="ct-arch-btn" data-id="${escape(c.contractId)}" title="Archive — the contract has ended. Stops payouts, keeps the row."><span class="ct-arch-ico">🗄</span>Archive</button>`
      + `<button class="btn-ghost ct-del-btn" data-id="${escape(c.contractId)}" title="Delete this merchant row">×</button>`
    : '';
  return `<tr data-id="${escape(c.contractId)}">${cells}<td class="ct-cell ct-gsep">${editCell}</td><td class="ct-cell ct-c ct-actions">${actions}</td></tr>`;
}



// The contract-entity control, used by both the row editor and Add-to-list (2026-09-29).
//
// One box that does both jobs: type to filter the entities you already have, or type a name
// nobody has used and it is created on save. A plain dropdown could only ever assign, and a
// separate "new entity" button made creating one feel like a different task from choosing one —
// which is how the free-text field it replaced ended up with one company spelled two ways.
function entityPickerHtml(id, entityId) {
  const cur = entityId ? entityById(entityId) : null;
  return `<label><span>Contract entity</span>
    <input id="${id}" list="${id}-list" value="${escape(cur ? cur.name : '')}"
           placeholder="type to filter, or type a new company to create it"
           autocomplete="off">
    <datalist id="${id}-list">${ENTITIES.map(e => {
      const n = CONTRACTS.filter(c => !c.archived && c.entityId === e.entityId).length;
      return `<option value="${escape(e.name)}">${n ? `${n} brand${n === 1 ? '' : 's'}` : 'no brands yet'}</option>`;
    }).join('')}</datalist></label>`;
}

// Turn what was typed into an entityId, creating the entity only when the name is genuinely new.
// Matching ignores case and spacing — the same comparison the backend refuses duplicates on, so
// the two can never disagree about whether a name is new.
async function resolveEntityInput(value) {
  const name = String(value || '').trim();
  if (!name) return null;
  const squash = x => String(x || '').toLowerCase().replace(/\s+/g, '');
  const found = ENTITIES.find(e => squash(e.name) === squash(name));
  if (found) return found.entityId;
  const made = await api('/entities', { method: 'PUT', body: JSON.stringify({ name }) });
  await loadEntities();
  return made.entityId;
}

// ── The row editor (2026-09-29) ─────────────────────────────────────────────────────────────
// One Edit button per row, one dialog, one save. Editing used to happen cell by cell in the
// grid, which meant a stray click could open a field and a mistyped value was saved the moment
// focus left — on a table that is mostly data a FILE owns and nobody should be typing into.
//
// Three sections, matching the two categories of merchant data:
//   Contract · Finance · Share terms   — all manual, all here
// Everything else on the row (brand, merchants, machine counts, contacts) comes from the weekly
// upload and is not editable anywhere, by design.
// `onSaved` fires AFTER a successful save, not when the dialog opens. The Upload page's tabs
// refresh from it: calling the refresh beside `openContractEditor(...)` ran it while the dialog
// was still on screen, so the row the person was fixing was still there when they closed it and
// the fix looked like it had not worked (2026-10-01).
function openContractEditor(contractId, onSaved) {
  const c = CONTRACTS.find(x => x.contractId === contractId);
  if (!c || !can('manageMerchants')) return;
  const { card, close } = ctModal(760);

  const cols = CONTRACT_GRID_COLUMNS.filter(col =>
    (col.group === 'contract' || col.group === 'finance')
    && col.type !== 'computed' && !(col.type || '').startsWith('term-'));

  const field = (col) => {
    const v = c[col.key] == null ? '' : String(c[col.key]);
    if (col.key === 'counterParty') return '';            // the entity picker replaces it
    if (col.type === 'date') return `<label><span>${escape(col.label)}</span><input type="date" data-k="${col.key}" value="${escape(v)}"></label>`;
    if (col.type === 'number') return `<label><span>${escape(col.label)}</span><input type="number" data-k="${col.key}" value="${escape(v)}"></label>`;
    if (col.type === 'select') {
      const opts = col.key === 'autoRenewal' ? ['', 'Yes', 'No'] : ['', ...MERCHANT_TYPES];
      return `<label><span>${escape(col.label)}</span><select data-k="${col.key}">${opts.map(o =>
        `<option value="${escape(o)}"${v === o ? ' selected' : ''}>${escape(o || '—')}</option>`).join('')}</select></label>`;
    }
    return `<label><span>${escape(col.label)}</span><input type="text" data-k="${col.key}" value="${escape(v)}"></label>`;
  };

  const contractCols = cols.filter(x => x.group === 'contract');
  const financeCols  = cols.filter(x => x.group === 'finance');
  const linked = c.entityId ? entityById(c.entityId) : null;

  card.innerHTML = `
    <h3 style="margin:0 0 4px;">${escape(c.merchantName || 'Merchant')}</h3>
    <p class="muted" style="margin:0 0 16px;font-size:12.5px;">
      Brand, merchant count, machine counts and contacts come from your upload and are not
      edited here. These three sections are the parts you maintain by hand.</p>

    <h4 class="ct-ed-h">Contract</h4>
    <div class="mail-form">
      ${entityPickerHtml('ce-entity', c.entityId)}
      <p class="mail-hint" id="ce-entity-note">${linked
        ? `Settled with <strong>${escape(linked.name)}</strong>. One entity can cover several brands.`
        : (String(c.counterParty || '').trim()
            ? `Not linked yet. This row still reads its own text: <strong>${escape(c.counterParty)}</strong>. Picking an entity does not erase it.`
            : 'Not linked to an entity.')}</p>
      ${contractCols.map(field).join('')}
    </div>

    <h4 class="ct-ed-h">Finance</h4>
    <div class="mail-form">${financeCols.map(field).join('')}</div>

    <h4 class="ct-ed-h">Share terms</h4>
    <div class="mail-form">
      <p class="mail-hint" style="margin:0 0 8px;">${c.noPayout
        ? 'Marked <strong>None</strong> — not paid, and skipped in every run.'
        : (ruleIsAbsent(c.rule)
            ? '<span class="rc-warn">No terms set. This merchant will block step 4 of a run until terms are set, or it is marked None.</span>'
            : `Current terms: ${termCellHtml(c, { key: 'term.summary' })}`)}</p>
      <div><button type="button" id="ce-terms" class="btn">Edit share terms…</button></div>
    </div>

    <p class="nm-err" id="ce-err" hidden></p>
    <div class="mail-actions">
      <button id="ce-cancel" class="btn-ghost">Cancel</button>
      <button id="ce-save" class="btn-primary">Save</button>
    </div>`;

  card.querySelector('#ce-terms').addEventListener('click', () => { close(); openTermsEditor(contractId); });
  card.querySelector('#ce-cancel').addEventListener('click', close);

  card.querySelector('#ce-save').addEventListener('click', async () => {
    const btn = card.querySelector('#ce-save'), err = card.querySelector('#ce-err');
    btn.disabled = true; err.hidden = true;
    // Only the fields this dialog actually shows are sent. Nothing the file owns is in the
    // payload at all, so a save here cannot touch brand, merchants, machines or contacts.
    const body = {};
    card.querySelectorAll('[data-k]').forEach(el => {
      const raw = el.value == null ? '' : String(el.value).trim();
      body[el.dataset.k] = raw === '' ? null : (el.type === 'number' ? Number(raw) : raw);
    });
    try {
      // Created here if the name is new, so linking never sends you to another screen mid-edit.
      body.entityId = await resolveEntityInput(card.querySelector('#ce-entity').value);
      const saved = await api('/contracts/' + encodeURIComponent(contractId), {
        method: 'PUT', body: JSON.stringify(body) });
      Object.assign(c, saved || body);
      close();
      if (onSaved) { await onSaved(); return; }
      // Show what was just changed. Everything this dialog edits lives in the Merchant terms
      // group, and a save landing behind a collapsed stub is indistinguishable from no save.
      if (!groupOpen('terms')) toggleContractGroup('terms'); else paintContracts();
    } catch (e) {
      btn.disabled = false; err.hidden = false; err.textContent = 'Could not save: ' + e.message;
    }
  });
}

// ── Overview: add / delete / link ─────────────────────────────────────

// The new-merchant form is generated from CONTRACT_GRID_COLUMNS — the same list the grid
// renders — so a column added there appears here without a second field list to keep in step.
// Two kinds are excluded: `computed` (Units is the sum of the model counts, never typed) and
// `term-*` (the revenue-share terms have their own editor, reached after the row exists).
function newMerchantSections() {
  const sections = [];
  for (const col of CONTRACT_GRID_COLUMNS) {
    if (col.type === 'computed' || (col.type && col.type.startsWith('term-'))) continue;
    const key = col.group || 'id';
    let s = sections[sections.length - 1];
    if (!s || s.key !== key) {
      const meta = CONTRACT_GROUPS.find(x => x.key === key);
      sections.push(s = { key, label: meta ? meta.label : 'Merchant', cols: [] });
    }
    s.cols.push(col);
  }
  return sections;
}

const nmFieldId = key => 'nm-' + key.replace('.', '-');

function nmFieldHtml(col) {
  const id = nmFieldId(col.key);
  let input;
  if (col.type === 'select') {
    const opts = col.key === 'merchantType' ? MERCHANT_TYPES : AUTO_RENEWAL_OPTIONS;
    input = `<select id="${id}"><option value=""></option>`
          + opts.map(o => `<option>${escape(o)}</option>`).join('') + '</select>';
  } else if (col.type === 'bool') {
    input = `<input type="checkbox" id="${id}">`;
  } else {
    const t = col.type === 'date' ? 'date' : col.type === 'number' ? 'number' : 'text';
    input = `<input type="${t}" id="${id}"${col.type === 'number' ? ' min="0"' : ''}`
          + `${col.key === 'merchantName' ? ' required' : ''}${col.type === 'url' ? ' placeholder="https://…"' : ''}>`;
  }
  const label = escape(col.label) + (col.suffix ? `<span class="ct-unit">${escape(col.suffix)}</span>` : '');
  return col.type === 'bool'
    ? `<label class="nm-f nm-f-bool">${input}<span>${label}</span></label>`
    : `<label class="nm-f"><span>${label}</span>${input}</label>`;
}

function createContractRow() {
  const sections = newMerchantSections();
  const { card, close } = ctModal(700);
  card.innerHTML = `
    <h3 style="margin:0 0 2px;">New merchant</h3>
    <p class="muted" style="margin:0 0 4px;font-size:12.5px;">
      Only the merchant name is required — everything else can be filled in later by editing
      the row. Revenue-share terms are set separately, with <strong>Edit terms</strong>.</p>
    <form class="nm-form" novalidate>
      ${sections.map(s => `
        <div class="nm-sec">
          <h4>${escape(s.label)}</h4>
          <div class="nm-grid${s.key === 'machines' ? ' nm-grid-5' : ''}">${s.cols.map(nmFieldHtml).join('')}</div>
        </div>`).join('')}
      <p class="nm-err" id="nm-err" hidden></p>
      <div>
        <button type="submit" class="btn btn-primary">Create merchant</button>
        <button type="button" id="nm-terms" class="btn">Create &amp; set terms…</button>
        <button type="button" id="nm-cancel" class="btn">Cancel</button>
      </div>
    </form>`;
  const form = card.querySelector('form');
  const err = card.querySelector('#nm-err');
  const fail = msg => { err.textContent = msg; err.hidden = false; };
  card.querySelector('#nm-cancel').addEventListener('click', close);
  card.querySelector('#' + nmFieldId('merchantName')).focus();

  // Read the form back through the same column list that built it, so a field can never be
  // rendered and then silently not collected.
  function collect() {
    const body = {};
    for (const s of sections) for (const col of s.cols) {
      const node = card.querySelector('#' + nmFieldId(col.key));
      let v = col.type === 'bool' ? node.checked : node.value.trim();
      if (col.type === 'number') { if (v === '') continue; v = Number(v); if (!Number.isFinite(v)) continue; }
      if (v === '' || v === false) continue;          // don't write empties over a fresh row
      if (col.key.includes('.')) {
        const [outer, inner] = col.key.split('.');
        (body[outer] = body[outer] || {})[inner] = v;
      } else body[col.key] = v;
    }
    return body;
  }

  async function submit(thenEditTerms) {
    err.hidden = true;
    const body = collect();
    const name = body.merchantName;
    if (!name) return fail('Merchant name is required.');
    // The grid only renders an http(s) contract link as a link — anything else falls back to
    // plain text (the javascript: guard). Catch it at entry rather than letting someone type
    // a link that silently never works.
    if (body.contractLink && !/^https?:\/\//i.test(body.contractLink)) {
      return fail('Contract link must start with http:// or https://');
    }
    if (body.startDate && body.endDate && body.endDate < body.startDate) {
      return fail('Contract end is before contract start.');
    }
    const clash = CONTRACTS.find(c => !c.archived && (c.merchantName || '').toLowerCase().trim() === name.toLowerCase());
    if (clash && !confirm(`"${clash.merchantName}" is already in the list. Add a second row with the same name?\n\nA sheet re-import matches on merchant name, so two rows sharing one name will be merged into one on the next import.`)) return;

    const btns = card.querySelectorAll('button');
    btns.forEach(b => { b.disabled = true; });
    try {
      const created = await api('/contracts', { method: 'POST', body: JSON.stringify(body) });
      CONTRACTS.push(created);
      close();
      const search = document.getElementById('ct-search');
      if (search) search.value = name;      // filter to it so it isn't lost among 248 rows
      paintContracts();
      if (thenEditTerms) openTermsEditor(created.contractId);
    } catch (e) {
      btns.forEach(b => { b.disabled = false; });
      fail('Could not create: ' + e.message);
    }
  }

  form.addEventListener('submit', ev => { ev.preventDefault(); submit(false); });
  card.querySelector('#nm-terms').addEventListener('click', () => submit(true));
}

async function deleteContractRow(contractId) {
  const c = CONTRACTS.find(x => x.contractId === contractId);
  if (!c) return;
  // The row now owns its own revenue-share terms, so deleting it deletes those terms too —
  // say so, since this used to be safe when terms lived on a separate partner record.
  const note = (!ruleIsAbsent(c.rule) || c.noPayout) ? '\n\nThis also deletes its revenue-share terms.' : '';
  if (!confirm(`Delete "${c.merchantName}" from the merchant view?${note}\n\nThis cannot be undone.`)) return;
  try {
    await api('/contracts/' + encodeURIComponent(contractId), { method: 'DELETE' });
    CONTRACTS = CONTRACTS.filter(x => x.contractId !== contractId);
    paintContracts();
  } catch (err) { alert('Could not delete: ' + err.message); }
}

// Shared chrome for the two merchant-view dialogs.
// Money formatter, shared. This lived as a const INSIDE renderBulkRunDetail, which made it
// invisible to anything defined at module scope: the assign dialog referenced it, threw
// ReferenceError while rendering its payout-impact line, and — because that ran before the
// Cancel/Assign listeners were attached — left both buttons dead with no visible error.
const fmt2 = v => Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function ctModal(width) {
  const box = document.createElement('div');
  box.className = 'ct-modal';
  box.innerHTML = `<div class="ct-modal-card" style="width:${width}px;max-width:94vw;max-height:88vh;overflow:auto;"></div>`;
  document.getElementById('main').appendChild(box);
  const card = box.querySelector('.ct-modal-card');
  const close = () => box.remove();
  box.addEventListener('click', ev => { if (ev.target === box) close(); });
  return { box, card, close };
}

// Read-only terms detail. Reuses the partner Rule tab's own editor in readOnly mode, so the
// breakdown a user sees here is literally the same component, not a second rendering that
// could describe the rule differently.
function openTermsView(contractId) {
  const c = CONTRACTS.find(x => x.contractId === contractId);
  if (!c) return;
  const { card, close } = ctModal(640);
  card.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px;">
      <div>
        <h3 style="margin:0 0 2px;">${escape(c.merchantName)}</h3>
        <p class="muted" style="margin:0;font-size:12.5px;">Revenue-share terms</p>
      </div>
      <div style="display:flex;gap:8px;">
        ${can('manageMerchants') ? '<button type="button" id="ct-tv-edit" class="btn-primary">Edit…</button>' : ''}
        <button type="button" id="ct-tv-close" class="btn">Close</button>
      </div>
    </div>
    <div id="ct-tv-rule" style="margin-top:16px;"></div>
    <p class="muted" style="margin:14px 0 0;font-size:12px;">${can('manageMerchants')
      ? 'Read-only here. <strong>Edit…</strong> opens the merchant, where contract, finance and share terms are changed together.'
      : 'Read-only — changing revenue-share terms needs the “Manage merchants” permission.'}</p>`;
  renderStructuredRuleEditor(card.querySelector('#ct-tv-rule'), c.rule, MACHINE_MODELS_CACHE, { readOnly: true });
  card.querySelector('#ct-tv-close').addEventListener('click', close);
  // The viewer used to be a dead end that pointed at a column label ("Edit terms") which no
  // longer exists — the grid's own cells are inert, so clicking the terms cell left someone
  // with no way forward and the impression they were not allowed to edit.
  card.querySelector('#ct-tv-edit')?.addEventListener('click', () => { close(); openContractEditor(contractId); });
}

// Add/update the revenue-share terms on a merchant row: aggregation mode, whether it is
// paid at all, and its full rule — edited with the same tree editor as the partner Rule
// tab rather than the flattened cells this grid used to carry. The row IS the payout
// record now; there is no partner to create or link.
// `onSaved(saved)` is optional and fires only after a successful save (not on cancel) —
// callers outside the Overview screen (e.g. the run wizard) use it to know when to
// re-check readiness, since this dialog has no other way to report completion.
async function openTermsEditor(contractId, onSaved) {
  const c = CONTRACTS.find(x => x.contractId === contractId);
  if (!c) return;
  const { card, close } = ctModal(720);
  card.innerHTML = `
    <h3 style="margin:0 0 4px;">Revenue-share terms — ${escape(c.merchantName)}</h3>
    <p class="muted" style="margin:0 0 16px;font-size:12.5px;">
      ${ruleIsAbsent(c.rule) && !c.noPayout ? 'Saving sets the payout terms for this merchant.' : 'Editing the payout terms for this merchant.'}
    </p>
    <div style="display:flex;gap:16px;align-items:flex-start;margin-bottom:14px;flex-wrap:wrap;">
      <label style="font-size:12.5px;color:var(--ink-soft);">Aggregation
        <select id="ct-pe-agg" class="input" style="min-width:230px;display:block;margin-top:4px;">
          <option value="whole"${c.aggregationMode !== 'per_store' ? ' selected' : ''}>Whole — one calculation across all merchants</option>
          <option value="per_store"${c.aggregationMode === 'per_store' ? ' selected' : ''}>Per merchant — calculate each merchant separately</option>
        </select>
      </label>
      <label class="nopay-toggle" style="display:flex;gap:8px;align-items:center;font-size:13px;margin-top:22px;">
        <input type="checkbox" id="ct-pe-nopay"${c.noPayout ? ' checked' : ''}> No revenue share — not paid
      </label>
    </div>
    <p class="muted" style="margin:-6px 0 14px;font-size:11.5px;">
      Per merchant matters when a minimum guarantee should apply to each merchant on its own — under
      Whole the guarantee collapses to the brand total and small merchants lose their floor.
    </p>
    <!-- B2 (2026-10-01): "I can type to complete every details terms, or adopt current or
         archived one (select by brand)". Adopting FILLS THE FORM and nothing more — nothing is
         stored until Save, so it can be adjusted or abandoned. Archived brands are offered too:
         an ended contract is often the exact shape being renewed. -->
    <label style="display:block;font-size:12.5px;color:var(--ink-soft);margin:0 0 12px;">
      Adopt terms from another brand
      <select id="ct-pe-adopt" class="input" style="min-width:320px;display:block;margin-top:4px;">
        <option value="">— type them below, or pick a brand to copy —</option>
      </select>
    </label>
    <div id="ct-pe-rule"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:18px;">
      <button type="button" id="ct-pe-cancel" class="btn">Cancel</button>
      <button type="button" id="ct-pe-save" class="btn btn-primary">Save</button>
    </div>`;
  const ruleBox = card.querySelector('#ct-pe-rule');
  let editor = renderStructuredRuleEditor(ruleBox, c.rule, MACHINE_MODELS_CACHE, { readOnly: false });
  const nopay = card.querySelector('#ct-pe-nopay');
  const agg = card.querySelector('#ct-pe-agg');
  const dim = () => { ruleBox.style.opacity = nopay.checked ? '.45' : '1'; ruleBox.style.pointerEvents = nopay.checked ? 'none' : ''; };
  nopay.addEventListener('change', dim); dim();

  // Every OTHER brand with terms worth copying, archived ones included and marked. Labelled with
  // the terms themselves, so the choice is made on what they pay rather than on remembering which
  // brand had which deal.
  const adopt = card.querySelector('#ct-pe-adopt');
  const donors = (CONTRACTS || [])
    .filter(x => x.contractId !== contractId && x.rule && ruleHasValue(x.rule))
    .sort((a, b) => String(a.merchantName || '').localeCompare(String(b.merchantName || '')));
  for (const d of donors) {
    const o = document.createElement('option');
    o.value = d.contractId;
    o.textContent = `${d.merchantName}${d.archived ? ' (archived)' : ''} — ${termText(d.rule) || 'terms set'}`;
    adopt.appendChild(o);
  }
  adopt.addEventListener('change', () => {
    const d = donors.find(x => x.contractId === adopt.value);
    if (!d) return;
    // COPIED, NOT LINKED: a deep copy, so editing either brand afterwards cannot touch the other.
    editor = renderStructuredRuleEditor(ruleBox, JSON.parse(JSON.stringify(d.rule)),
                                        MACHINE_MODELS_CACHE, { readOnly: false });
    if (['whole', 'per_store'].includes(d.aggregationMode)) agg.value = d.aggregationMode;
    nopay.checked = false;
    dim();
  });
  card.querySelector('#ct-pe-cancel').addEventListener('click', close);

  card.querySelector('#ct-pe-save').addEventListener('click', async ev => {
    const btn = ev.target; btn.disabled = true; btn.textContent = 'Saving…';
    try {
      let rule;
      try { rule = editor.getRule(); } catch (e) { alert('Invalid rule: ' + e.message); return; }
      // Never save something that quietly throws a term away. PMCU is how this was found: an MG
      // was typed against a `hybrid` method, the save succeeded, and the value was gone.
      const dropped = editor.droppedTerms?.() || [];
      if (dropped.length && !confirm(
          `This would save WITHOUT ${dropped.join(' and ')}.\n\n`
          + `The payout method you have chosen adds the terms together, and a minimum guarantee `
          + `is a floor — it is only used by "Whichever is higher" and "Hybrid-higher".\n\n`
          + `Cancel to go back and change the method, or OK to save without it.`)) {
        return;
      }
      const saved = await api('/contracts/' + encodeURIComponent(contractId), { method: 'PUT',
        body: JSON.stringify({ rule, noPayout: nopay.checked, aggregationMode: agg.value }) });
      Object.assign(c, saved);
      close(); paintContracts();
      onSaved?.(saved);
    } catch (err) {
      alert('Could not save: ' + err.message);
    } finally { btn.disabled = false; btn.textContent = 'Save'; }
  });
}

// `All_Merchant` has a two-row header (row 1 groups, row 2 sub-headers); data starts
// at row 3. Merged group cells make header-keyed parsing unreliable, so read by index
// and let the backend normalizer do every coercion.
// ── Merchant-sheet template ────────────────────────────────────────────────
// The download and the import are two halves of one contract, so this table is written to
// mirror `normalizeContractRow`'s `at(i)` reads in lambda/revshare-api/code/contracts.mjs
// exactly. Index IS the meaning — the importer reads by position, not by header name, so a
// column added here without the same change there silently shifts every field after it.
// `head2` values for columns 1 and 22 are also the two anchors parseAllMerchantSheet checks,
// which means a template produced here always passes the importer's own layout guard.
const SHEET_TERMS_GROUP = 'Share terms — NOT imported, set these with "Edit terms" in the app';
// Spreadsheet column letter for a 0-based index. The sheet is 23 wide, so single letters
// suffice, but the AA+ case is handled anyway rather than left as a trap for column 26.
const colLetter = i => (i < 26 ? '' : String.fromCharCode(64 + Math.floor(i / 26))) + String.fromCharCode(65 + (i % 26));
// The old positional TEMPLATE_COLUMNS was removed on 2026-08-27: the sheet is now written
// grid-shaped and read by header name, so the eight dead columns it had to carry (kept only
// because a positional layout cannot drop one without shifting every field) are gone.

// Downloads the current merchant list in the exact shape `Upload sheet` expects, so the file
// round-trips: download, edit in Excel, upload. Archived merchants are left out — they are
// not part of the working list, and re-uploading one would only rewrite the row it already has.
// A filled-in sample, first in the sheet so the expected format is visible where you type.
// Its name matches EXAMPLE_ROW_NAME in lambda/revshare-api/code/contracts.mjs, which makes
// the importer skip it — leaving it in place on upload is harmless, not a junk merchant.
// Keep the two in step. Shown as a contract row, not a machine one: the values are ordinary
// (3 units = 1×S5 + 2×S8, so the Installed units column visibly agrees with the model counts).
const EXAMPLE_ROW = {
  merchantName: 'EXAMPLE ROW — safe to leave, it is never imported',
  merchantType: 'Shopping Malls',
  counterParty: 'Example Holdings Co., Ltd.',
  installedUnits: 3,
  units: { S5: 1, S8: 2 },
  startDate: '2026-01-01',
  endDate: '2026-12-31',
  terminationNoticeDays: 30,
  autoRenewal: 'Yes',
  contractLink: 'https://drive.google.com/file/d/EXAMPLE/view',
  contactName: 'Somchai P.',
  contactPhone: '+66 2 123 4567',
  contactEmail: 'ops@example.com',
  bankName: 'Kasikornbank',
  bankAccountName: 'Example Holdings Co., Ltd.',
  bankAccountNumber: '123-4-56789-0',
  financeContactName: 'Nutcha S.',
  financeContactEmail: 'ap@example.com',
  // Shown so the sample demonstrates the Rev terms format, which is the one column people
  // most need an example of.
  rule: { type: 'sum', _method: 'hybrid', children: [
    { type: 'percent', _t: 'gp', rows: [{ model: 'ALL', percent: 20 }] },
    { type: 'flat_per_machine', _t: 'placement', rows: [{ model: 'S5', amount: 500 }] } ] },
};

// Columns appended AFTER the fixed 22. They are addressed by header NAME on import (see
// normalizeContractRow), which is what allows their number to differ by region: the per-model
// Placement / MG / Units columns come from this region's Device Types. Never insert one of
// these before column 22 — everything up to there is read by position.
// The merchant sheet is the Overview grid, in the same column ORDER, with row 1 carrying
// the grid's own category names. Every column is addressed by header NAME on import, which is
// what let the old layout's dead columns go — it had eight of them, kept only because that
// sheet was read by position and dropping one would have shifted every field after it.
//
// Machine columns are EIGHT slots under "Machines". Models that actually have units are
// written in; the rest are left blank for you to label. Neither region's model list is baked
// into the sheet, so one shape serves both.
const MACHINE_SLOTS = 8;

function gridTemplateColumns(contracts) {
  const used = [];
  for (const c of contracts || []) for (const [m, n] of Object.entries(c.units || {})) {
    if (Number(n) > 0 && !used.includes(m)) used.push(m);
  }
  const slots = used.slice(0, MACHINE_SLOTS);
  while (slots.length < MACHINE_SLOTS) slots.push(null);       // blank, ready to be labelled

  const terms = c => decompileRule(c && c.rule);
  const amountFor = (c, rowsKey, model) => {
    if (!c || c.noPayout || !c.rule || !isRepresentable(c.rule)) return null;
    const hit = terms(c)[rowsKey].find(r => r.model === model || r.model === 'ALL');
    return hit && hit.amount ? hit.amount : null;
  };
  const col = (group, head2, from, desc) => ({ group, head2, from, desc });
  return [
    col('Brand', 'Brand', c => c.merchantName ?? null,
      'REQUIRED — the brand name, and the key an upload matches on. An existing name updates that merchant; a new one creates it. '
      + 'Editing a name here therefore ADDS a merchant rather than renaming one. It should also match the "Merchant label" in the '
      + 'ChargeSpot roster, or the brand\u2019s machines will not be found when a run is prepared. A row with this cell empty is skipped.'),
    col('Brand', 'Type', c => c.merchantType ?? null, 'Category. One of: ' + MERCHANT_TYPES.join(', ') + '.'),
    col('Brand', 'Merchants', c => branchesOf(c),
      'How many merchants this brand has, counted from the last weekly upload.'),

    col('Contact', 'Sales person', c => c.salesPerson ?? null, 'Who at ChargeSpot owns this relationship.'),
    col('Contact', 'Contact', c => c.contactName ?? null, 'Contact name at the merchant.'),
    col('Contact', 'Phone', c => c.contactPhone ?? null, 'Contact phone. Kept exactly as typed.'),
    col('Contact', 'Email', c => c.contactEmail ?? null, 'Contact email.'),
    col('Machines', 'Units', c => (unitsTotal(c) || c.installedUnits || null),
      'Total machines installed. Should equal the eight model columns to its right; the app shows the sum of those, so a mismatch is visible.'),
    ...slots.map(model => col('Machines', model,
      c => model ? ((c.units || {})[model] ?? null) : null,
      'A machine model. Put the model code in this header row (S5, S8, LL20, S10-A \u2026) and the count below it. '
      + 'Eight slots are provided; blank ones are ignored, so a column with no model code in its header imports nothing.')),
    col('Contract', 'Contract entity', c => entityName(c) || null,
      'The legal entity named on the contract. Maintained in the app, not read from this file.'),
    col('Contract', 'Start', c => c.startDate ?? null, 'Contract start date. YYYY-MM-DD.'),
    col('Contract', 'End', c => c.endDate ?? null, 'Contract end date. YYYY-MM-DD. The app flags rows due or overdue.'),
    col('Contract', 'Notice', c => c.terminationNoticeDays ?? null, 'Termination notice period, in days. A plain number.'),
    col('Contract', 'Auto-renewal', c => c.autoRenewal ?? null, 'Whether the contract renews automatically.'),
    col('Contract', 'Contract', c => c.contractLink ?? null, 'Link to the signed contract. A full https:// URL.'),
    // Derived from FINANCE_COLUMNS, not retyped: the header a download writes is exactly the
    // label the grid shows, and GRID_FIELDS in the importer is keyed on that same text. Retyping
    // it here would be a third place for the wording to drift, and a drifted header imports
    // nothing in silence.
    ...FINANCE_COLUMNS.map(f =>
      col('Finance Information', f.label, c => c[f.key] ?? null, FINANCE_SHEET_DESC[f.key])),
    col('Share terms', 'Mode', c => (!c.noPayout && c.rule && isRepresentable(c.rule)) ? methodToName(terms(c).method) : null,
      'How the terms below combine. Default = a single term, just pay it. Hybrid = add every term together. '
      + 'Whichever is higher = pay the best of each comparable term against the MG. Hybrid-higher = pay the best of the '
      + 'SUMMED terms against the MG. Electricity is always added on top and never competes. See the "Rev share guide" sheet.'),
    col('Share terms', 'No payout', c => c.noPayout ? 'Y' : null,
      'Y = this merchant is deliberately not paid, and every term below is ignored. Blank = paid normally.'),
    col('Share terms', 'GP %', c => (!c.noPayout && c.rule && terms(c).gpPercent) || null,
      'Revenue share as a percentage of the merchant\u2019s net revenue. Enter 25 for 25%.'),
    ...slots.filter(Boolean).map(model => col('Share terms', `Placement ${model}`,
      c => amountFor(c, 'placementRows', model),
      `Placement fee for each ${model} machine, per period. Charged PER MACHINE — three machines at 500 pay 1,500.`)),
    ...slots.filter(Boolean).map(model => col('Share terms', `MG ${model}`,
      c => amountFor(c, 'mgRows', model),
      `Minimum guarantee for each ${model} machine, per period. A floor, not an addition: only the "Whichever is higher" `
      + `and "Hybrid-higher" modes use it, and it is compared against the other terms rather than added to them.`)),
    col('Share terms', 'Electricity', c => (!c.noPayout && c.rule && terms(c).electricity) || null,
      'Electricity reimbursement, one lump sum per merchant per period. Never competes in a comparison \u2014 it is added '
      + 'to whatever the mode settles on.'),
    col('Share terms', 'Others', c => (!c.noPayout && c.rule && terms(c).others) || null,
      'Any other lump sum per merchant per period. Unlike Electricity this DOES compete inside a "Whichever is higher" '
      + 'or "Hybrid-higher" comparison.'),
  ].map((c, i) => ({ ...c, i }));
}

// A merchant whose name is prefixed "(Closed)" has shut. Singapore's list carries 207 of them
// out of 554, and they are not archived in the app — the prefix is how that list records it.
// They are excluded from the download so the sheet is the merchants you still deal with; they
// stay in the app, and an upload without them changes nothing, since an import never deletes.
const CLOSED_NAME = /^\s*\(?\s*closed\s*\)/i;

// Excel data validation — a real dropdown on the Mode column. SheetJS's community build cannot
// write <dataValidations>, so the workbook is re-opened after it is written and the element is
// spliced into the worksheet XML. Everything here degrades to null on anything unexpected, and
// the caller then ships the untouched file: a sheet without a dropdown is a small loss, a
// corrupt workbook is not.
function withModeDropdown(bytes, sheetName, modeCol, lastRow) {
  try {
    if (!modeCol || !window.SimpleZip?.readZip) return null;
    const files = SimpleZip.readZip(bytes);
    if (!files) return null;
    const dec = new TextDecoder(), enc = new TextEncoder();
    const get = n => files.find(f => f.name === n);

    // sheet name -> r:id -> the worksheet part it points at
    const wbXml = dec.decode(get('xl/workbook.xml')?.data || new Uint8Array());
    const rid = wbXml.match(new RegExp(`<sheet[^>]*name="${sheetName}"[^>]*r:id="([^"]+)"`))?.[1];
    if (!rid) return null;
    const relsXml = dec.decode(get('xl/_rels/workbook.xml.rels')?.data || new Uint8Array());
    const target = relsXml.match(new RegExp(`<Relationship[^>]*Id="${rid}"[^>]*Target="([^"]+)"`))?.[1];
    if (!target) return null;
    const part = get('xl/' + target.replace(/^\/?xl\//, ''));
    if (!part) return null;

    const colRef = colLetter(modeCol.i);
    const dv = `<dataValidations count="1"><dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1"`
      + ` errorTitle="Pick a mode" error="Choose one of the four modes, or leave the cell blank."`
      + ` sqref="${colRef}3:${colRef}${Math.max(lastRow, 200)}"><formula1>"${PAYOUT_METHOD_META.map(m => m.title).join(',')}"</formula1></dataValidation></dataValidations>`;

    let xml = dec.decode(part.data);
    if (xml.includes('<dataValidations')) return null;
    // Schema order matters: dataValidations sits after sheetData and before pageMargins.
    xml = xml.includes('<pageMargins') ? xml.replace('<pageMargins', dv + '<pageMargins')
                                       : xml.replace('</worksheet>', dv + '</worksheet>');
    part.data = enc.encode(xml);
    return SimpleZip.makeZip(files);
  } catch { return null; }
}

// NO CALLER since 2026-09-29 — the Download sheet button was removed from the Overview.
// Kept because the format is still real: tests/sheet-grid-shape and tests/finance-columns pin
// it against the grid's own columns, and infra/import-merchant-sheet.mjs reads that shape.
// Same situation as parseAllMerchantSheet (§1n). Delete both together or neither.
function downloadMerchantTemplate() {
  const rows = CONTRACTS.filter(c => !c.archived && !CLOSED_NAME.test(c.merchantName || ''))
    .slice()
    .sort((a, b) => (a.merchantName || '').localeCompare(b.merchantName || ''));
  const COLS = gridTemplateColumns(rows);
  const aoa = [
    COLS.map(c => c.group || null),
    COLS.map(c => c.head2),
    COLS.map(col => col.from(EXAMPLE_ROW, null)),
    ...rows.map((c, n) => COLS.map(col => col.from(c, n + 1))),
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = COLS.map(c => ({ wch: c.i === 1 ? 44 : c.i === 3 ? 34 : c.i === 22 ? 40 : 12 }));
  // The same description twice, in the two places people actually look: hovering the header
  // cell, and a sheet they can read end to end. Both come from `desc`, so they cannot disagree.
  for (const col of COLS) {
    if (!col.desc) continue;
    const ref = XLSX.utils.encode_cell({ r: 1, c: col.i });      // row 2 = the header row
    const cell = ws[ref] || (ws[ref] = { t: 's', v: '' });
    cell.c = [{ a: 'RevShare', t: col.desc }];
    cell.c.hidden = true;                                        // marker, not a popped-open note
  }

  const wb = XLSX.utils.book_new();
  // First, so the workbook opens on the instructions rather than on 249 rows of data.
  // `All_Merchant` is found by name, not position, so extra sheets are invisible to the import.
  const guide = XLSX.utils.aoa_to_sheet([
    ['Merchant list — field guide'],
    [],
    ['Upload this file with "Upload sheet" on the Overview.'],
    ['Only the All_Merchant sheet is read. This sheet, and anything else you add, is ignored.'],
    ['Merchants in the app but missing from this file are LEFT ALONE — an upload never deletes.'],
    ['Revenue-share terms ARE imported now — see the "Rev share guide" sheet for what each term means.'],
    ['Leave every share-terms cell blank to change nothing: an upload never clears terms already set.'],
    ['Row 3 is a worked example. It is skipped on upload, so it is safe to leave in place.'],
    [],
    ['Column', 'Header', 'Imported?', 'What it is'],
    ...COLS.map(c => [
      colLetter(c.i),
      c.head2 ? String(c.head2).replace(/\n/g, ' ') : '(unlabelled)',
      c.imp || 'yes',
      c.desc,
    ]),
  ]);
  guide['!cols'] = [{ wch: 8 }, { wch: 18 }, { wch: 12 }, { wch: 110 }];
  // A guide to the terms themselves, separate from the per-column field guide: what each term
  // means and what it pays, with a worked number. The share-terms columns are the ones people
  // get wrong, because "MG 200" being a floor rather than a bonus is not guessable.
  const money = n => n.toLocaleString('en-US');
  const termGuide = XLSX.utils.aoa_to_sheet([
    ['Revenue-share terms — what each one means'],
    [],
    ['Fill these in on the All_Merchant sheet, in the "Share terms" columns.'],
    ['Leave a term blank when it does not apply. Leaving EVERY term blank changes nothing —'],
    ['an upload never clears terms a merchant already has.'],
    [],
    ['Term', 'What it means', 'Charged', 'Example', 'That example pays'],
    ['GP %', 'A share of the revenue the machines take at that merchant.', 'Per merchant',
      '20 with 10,000 revenue', money(2000)],
    ['Placement <model>', 'A fixed rental fee for putting a machine in the location. Entered per machine model, so a site with two models can pay two rates.',
      'PER MACHINE', '500 under "Placement S5", merchant has 3 S5 machines', money(1500)],
    ['MG <model>', 'Minimum guarantee: a FLOOR, not a bonus. The merchant is paid the better of the other terms or this — never both. Only the "Whichever is higher" and "Hybrid-higher" modes use it.',
      'PER MACHINE', 'MG S8 200 vs GP% earning 150, one machine', money(200) + ' (the MG, because it is higher)'],
    ['Electricity', 'Reimbursement of the power the machines use. Never competes with anything — it is always added on top of whatever the mode settles on.',
      'Per merchant', '300, on top of a GP% of 2,000', money(2300)],
    ['Others', 'Any other lump sum. Unlike Electricity this DOES compete inside a comparison.',
      'Per merchant', '100 as a single term', money(100)],
    [],
    ['Mode', 'How the terms above combine', '', 'Example', 'That example pays'],
    ['Default', 'One term only — just pay it.', '', 'GP 20% on 10,000 revenue', money(2000)],
    ['Hybrid', 'Add every term together.', '', 'GP 20% (2,000) + Placement 500 x 1 machine', money(2500)],
    ['Whichever is higher', 'Pay the best single comparable term, or the MG, whichever wins. Electricity is added afterwards.',
      '', 'GP 20% (2,000) vs MG 2,500, plus Electricity 300', money(2800) + ' (2,500 MG + 300)'],
    ['Hybrid-higher', 'Add the comparable terms up first, THEN take the better of that total and the MG. Electricity is added afterwards.',
      '', 'GP 2,000 + Placement 500 = 2,500 vs MG 2,200', money(2500) + ' (the summed terms won)'],
    [],
    ['No payout', 'Y means this merchant is deliberately not paid at all. Every term above is ignored.', '', 'Y', money(0)],
  ]);
  termGuide['!cols'] = [{ wch: 20 }, { wch: 74 }, { wch: 14 }, { wch: 44 }, { wch: 32 }];
  XLSX.utils.book_append_sheet(wb, termGuide, 'Rev share guide');
  XLSX.utils.book_append_sheet(wb, guide, 'Field guide');
  XLSX.utils.book_append_sheet(wb, ws, 'All_Merchant');
  const written = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const modeCol = COLS.find(c => c.head2 === 'Mode');
  const out = withModeDropdown(written, 'All_Merchant', modeCol, rows.length + 3) || written;
  const url = URL.createObjectURL(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `merchant-list-${new Date().toISOString().slice(0, 10)}.xlsx`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function parseAllMerchantSheet(file) {
  const wb = await readExcel(file);
  const ws = wb.Sheets['All_Merchant'];
  if (!ws) throw new Error('Sheet "All_Merchant" not found in this workbook');
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true, blankrows: false });
  // Everything below reads by fixed column INDEX, not header name, because merged group
  // cells in row 1 make header-keyed parsing unreliable. That makes a column inserted
  // anywhere left of W silently shift every field one slot — dates become numbers, links
  // vanish, MG lands in the Electricity slot — with no error and no way to tell from the
  // "N rows read" summary. Check two fixed anchors on header row 2 before trusting any
  // index below: this is a human-maintained spreadsheet, so a column insert is a *when*.
  const groups1 = aoa[0] || [];
  const header2 = aoa[1] || [];
  // Two shapes are accepted. The GRID shape (2026-08-27) is addressed by header name, so it
  // only needs to name its columns. The LEGACY shape is positional, and keeps the two anchor
  // checks that guard it: in a position-read sheet an inserted column silently shifts every
  // field, with no error and no way to tell from the "N rows read" summary.
  const isGrid = /rev terms/i.test(header2.map(h => String(h ?? '')).join('|'));
  if (!isGrid && (!/merchant/i.test(String(header2[1] || '')) || !/link/i.test(String(header2[22] || '')))) {
    throw new Error('This workbook\'s "All_Merchant" sheet layout has changed — column positions no longer match what the importer expects. Check for inserted/removed/reordered columns before re-uploading.');
  }
  const body = aoa.slice(2);
  // Columns 0-22 are the fixed layout the anchors above guard. Anything BEYOND 22 is the
  // appended, header-named block (contacts, per-region unit columns, payout terms), so the
  // rows are no longer truncated at 23 and header row 2 travels with them — the importer
  // addresses that block by name, which is what lets its column count differ per region.
  const width = Math.max(23, header2.length, ...body.map(r => r.length));
  const rows = body
    .map(r => { const c = new Array(width).fill(null); for (let i = 0; i < width; i++) c[i] = r[i] ?? null; return c; })
    .filter(c => String(c[1] || '').trim());
  return { rows, header: header2, groups: groups1, skipped: body.length - rows.length };
}

// Overview owns two views of the same merchant list (the grid, and the read-only
// reconciliation of that list against your last weekly upload) — same in-screen-tabs pattern
// Run share and Settings already use. The nav button stays "Overview"/active for both.
// NO CALLER since 2026-09-29 — the Overview lost its tab strip when Reconcile was removed
// from it. Kept with renderReconcileTab and classifyDifferences, which are still pinned by
// tests/reconcile-classifier (552 lines) and tests/reconcile-day-grouping: the classifier is the
// only thing that knows how to explain a rename or a brand group, and the Upload page's
// adjustments are likely to want it back. Delete the whole family together or not at all.
function merchantHead(active) {
  return subTabsHtml([{ id: 'merchants', label: 'Merchants' },
                      { id: 'reconcile', label: `Reconcile${RECONCILE_COUNT ? ` (${RECONCILE_COUNT})` : ''}` }],
                     active);
}

function wireMerchantTabs() {
  wireSubTabs(document.getElementById('main'),
    id => id === 'reconcile' ? renderReconcileTab() : renderContractsScreen());
}

async function renderContractsScreen() {
  const el = document.getElementById('main');
  // setActiveNav already bumped the token when this came from the nav; the sub-tab and boot paths
  // do not go through it, so take one here too — the last paint started is the one that wins.
  const token = newPaintToken();
  el.classList.add('main-wide');   // also covers the boot path, which doesn't go via setActiveNav
  el.innerHTML = `<h1>Overview</h1><p class="muted">Loading…</p>`;
  const [contracts, machineModels, rosterBrands, lastUpload] = await Promise.all([
    api('/contracts'), api('/machine-models'),
    // The file's own branch and machine counts. Never fatal: without it the grid falls back to
    // the stored columns, which is what it showed before.
    api('/roster/brands').catch(() => null),
    // Never fatal: the grid is worth showing without the marks, so an older backend or a
    // failed read just means no ⦿ column-marker this paint.
    api('/contracts/last-upload').catch(() => null)
  ]);
  CONTRACTS = contracts;
  MACHINE_MODELS_CACHE = machineModels;
  if (rosterBrands && rosterBrands.brands) ROSTER_BRANDS = rosterBrands;
  LAST_UPLOAD = lastUpload && lastUpload.names && lastUpload.names.length ? lastUpload : null;
  await loadEntities();
  if (!paintIsCurrent(token)) return;   // the user is somewhere else now — do not paint over it
  refreshContractGridColumns();
  el.innerHTML = `
    <div class="page-head" style="margin-bottom:6px;align-items:center;">
      <h1 style="margin:0;">Overview</h1>
      ${can('manageMerchants') ? '<button type="button" id="ct-add" class="btn btn-primary">+ Add merchants</button>' : ''}
    </div>
    <div class="ct-toolbar">
      <input id="ct-search" class="input" placeholder="Search merchant…" style="max-width:240px">
      ${!ENTITIES.length ? '' : `
      <input id="ct-entity" class="input" list="ct-entities" style="max-width:240px"
             placeholder="Filter by contract entity…"
             title="One entity can cover several brands. Type any part of the name, or pick from the list.">
      <datalist id="ct-entities">${ENTITIES.map(e => {
        const n = contracts.filter(c => !c.archived && c.entityId === e.entityId).length;
        return `<option value="${escape(e.name)}">${n ? `${n} brand${n === 1 ? '' : 's'}` : ''}</option>`;
      }).join('')}</datalist>`}
      <select id="ct-status" class="input" style="max-width:230px">
        <option value="">Merchant alert</option>
        <option value="needs">◆ Needs terms</option>
        <option value="due">⚠ Contract due or overdue</option>
        ${LAST_UPLOAD ? '<option value="missing">⦿ Not in latest upload</option>' : ''}
      </select>

      <span class="muted" id="ct-count"></span>
    </div>
    <div class="ct-scroll"><table class="ct-table"><thead>${contractHeadHtml()}</thead>
      <tbody id="ct-body"></tbody></table></div>`;
  ['ct-search', 'ct-status', 'ct-entity'].forEach(id =>
    el.querySelector('#' + id)?.addEventListener('input', paintContracts));
  // Delegated on <thead>, which survives its own innerHTML being replaced on every toggle.
  el.querySelector('.ct-table thead').addEventListener('click', ev => {
    const th = ev.target.closest('[data-group]');
    if (th) toggleContractGroup(th.dataset.group);
  });
  paintContracts();
  el.querySelector('#ct-body').addEventListener('click', ev => {
    if (ev.target.closest('a')) return;          // let the contract link open normally
    const peBtn = ev.target.closest('.ct-pe-btn');
    if (peBtn) { openContractEditor(peBtn.dataset.id); return; }
    const branch = ev.target.closest('.ct-branch');
    if (branch) { openBranchList(branch.dataset.brand); return; }
    const terms = ev.target.closest('.ct-terms');
    if (terms) { openTermsView(terms.closest('tr').dataset.id); return; }
    const delBtn = ev.target.closest('.ct-del-btn');
    if (delBtn) { deleteContractRow(delBtn.dataset.id); return; }
    const archBtn = ev.target.closest('.ct-arch-btn');
    if (archBtn) { setContractArchived(archBtn.dataset.id, true); return; }
    // Nothing else. The table is read-only: clicking a cell does not edit, and does not open
    // the editor either. The row's Edit button is the only way in, so nothing is ever changed
    // by a click that was meant to select text or follow a link.
  });
  el.querySelector('#ct-new')?.addEventListener('click', createContractRow);
  el.querySelector('#ct-add')?.addEventListener('click', openAddMerchants);
}

// ── Reconcile tab ────────────────────────────────────────────────────────────
// READ-ONLY (Phase 2 of the reconciliation feature). classifyDifferences (above) does the actual
// comparison work; this section only renders what it returns. No action buttons anywhere here —
// the corrections (rename, merge, dismiss, link) are Task 14/Phase 3, which may never be built,
// so every row states the fix in WORDS rather than half-building a button that does nothing yet.
//
// Ordered by money, not by count: the four archived-and-earning brands matter more than the 65
// quiet ones. Each group is collapsed to its heading until opened — the same discipline the run
// detail settled on (§1i), one job per screen.
// `money: true` marks the groups whose figures come from the latest run. When that run cannot be
// loaded those figures are UNKNOWN, not zero, and the heading has to say so — see reconcileRunNote.
const RECONCILE_GROUPS = [
  { type: 'archived-in-file',   title: 'Archived, but still in your file and still earning', money: true, tone: 'loss' },
  { type: 'brand-has-branches', title: 'One brand tag, several merchant rows', money: true, tone: 'warn' },
  { type: 'likely-rename',      title: 'Looks renamed', money: true, tone: 'warn' },
  { type: 'ambiguous-rename',   title: 'Could be a rename — more than one merchant fits', money: true, tone: 'info' },
  { type: 'in-file-no-row',     title: 'In your file, no merchant row', money: true, tone: 'info' },
  { type: 'in-app-not-in-file', title: 'In your app, not in your file', tone: 'quiet' },
  // Populated starting Task 8 (machine-list-miss items carry `count`, not `names`/`contractIds`
  // the way every other type does) — the group renders, just empty, until then.
  { type: 'machine-list-miss',  title: 'Merchants the machine list could not place', tone: 'quiet', unit: 'merchants' },
];

// The two seeding batches big enough to have a name of their own — see §11's duplicate-name
// note and §1b's migration/adoption history. Everything else in this group is just "unknown"
// or a genuine week-to-week miss.
const RECONCILE_KNOWN_BATCHES = {
  '2026-08-07': 'merchant-view migration',
  '2026-08-09': 'payable-brand adoption',
};

// Repeated under every category heading rather than once at the top of the table: a header you
// have scrolled past is not a header. Sticky would be the other answer, but this table already
// sits under a sticky topbar and a sub-tab strip, and stacking a third layer to save a line per
// category is worse than the line.
const RECONCILE_COLHEAD = `<tr class="rc-colhead">
  <th class="rc-c-app">In your app</th>
  <th class="rc-c-file">In your file</th>
  <th class="rc-c-why">Why</th>
  <th class="rc-c-money">Not paid</th>
  <th class="rc-c-fix">What to do</th>
</tr>`;

// What the fix will be, in words. Phase 2 has no buttons, so this sentence is the only thing
// telling someone what to actually do about a row — an empty row with no explanation would read
// as broken, not as "not built yet".
function reconcileFix(item) {
  switch (item.type) {
    case 'archived-in-file': {
      // One fault has a one-step fix. TWO do not, and this row is the reason the feature exists:
      // `Central` is archived AND `noPayout`, with its negotiated terms sitting on branch rows no
      // roster can reach. “Unarchive it” read as complete advice, and following it pays the brand
      // zero again — 51,495 THB the next run. So the sentence is built from what is actually true
      // of THIS row, and a multi-fault row is never handed a single step.
      if (!item.noPayout && !item.branchCount)
        return 'Fix: unarchive it if the contract is genuinely still live, or ask for the brand to be dropped from next week’s file if it really ended.';
      const faults = ['the contract is archived, so a run skips it'];
      if (item.noPayout)
        faults.push('it is also marked “no revenue share”, so unarchiving alone would still pay nothing');
      if (item.branchCount)
        faults.push(`${item.branchCount} live merchant rows start with this name`
          + (item.sameTerms === false
              ? `, holding ${item.termSetCount} different term sets — the roster labels their machines with this tag, so only one set could ever be paid`
              : ', and the roster labels their machines with this tag, so a run never reaches them'));
      return 'No single fix — ' + faults.join('; ')
        + '. Check the contract and the rows above before changing anything: unarchiving on its own does not pay this brand.';
    }
    case 'likely-rename':
      // Renaming is NOT built (spec Phase 3) and the merchant name is deliberately not an
      // editable grid cell, so there is no "edit it on the Merchants tab" to point at. Saying
      // so plainly beats sending someone to look for a control that is not there.
      return 'If these are the same merchant, it has been renamed in your file. Renaming in place '
        + 'is not built yet, so nothing here will match it: a run resolves the roster by name, and '
        + 'importing would ADD the file\u2019s name as a second merchant with no terms, leaving this '
        + 'one\u2019s terms behind. Leave it for now, or set the terms up on the new merchant deliberately.';
    case 'ambiguous-rename':
      return 'Fix: more than one name could be right — needs a person to pick, not automatable.';
    case 'brand-has-branches':
      return item.sameTerms
        ? 'Fix: these rows share identical terms and could merge into one brand-level merchant.'
        : 'Fix: these rows disagree on terms — merging only picks a winner, so it needs a person to choose, '
          + 'or the roster relabelled per merchant (spec §10).';
    case 'in-file-no-row':
      return 'Fix: add this merchant — or check the "in your app, not in your file" list below for a rename first.';
    case 'in-app-not-in-file':
      return 'Fix: nothing was deleted — confirm it’s still active, or leave it if it’s just missing from this week’s file.';
    case 'machine-list-miss':
      return 'Fix: link the merchant to a brand, once linking ships.';
    default:
      return '';
  }
}

// Pure: a machine-list-miss item's names, as a plain list rather than the ' ↔ ' rename arrow
// (that separator means "these are the same thing" — wrong for a list of distinct merchants), plus a
// line naming how many were left out when the backend's 200-name cap bit. `count` is the exact
// total the item carries (§1l) — read it, never `names.length`, or a capped list silently reads
// as complete. Extracted as its own function so the truncation math has one test rather than
// being buried in a template string. (2026-09-18, fix round 1 of the Task 8 review.)
function truncatedNameListHtml(names, count) {
  const list = (names || []).filter(Boolean);
  const total = count != null ? count : list.length;
  const items = list.map(n => `<li>${escape(n)}</li>`).join('');
  const note = total > list.length
    ? `<div class="rc-item-detail muted">showing the first ${list.length} of ${total}</div>`
    : '';
  return `<ul class="rc-item-list">${items}</ul>${note}`;
}

// One difference, one row: the app's name and the file's (where both exist — some types only
// ever have one side), the detail classifyDifferences already computed, the money at stake, and
// the fix in words. No buttons — see the section comment above.
//
// machine-list-miss is the one shape that isn't a rename pair: it can hold up to 200 merchant names
// (the backend's cap) behind a `count` that is the exact total, so it gets its own name rendering
// via truncatedNameListHtml instead of the arrow-joined `rc-item-names` line below.
// One difference, one ROW. The card layout this replaced stacked five things vertically per
// finding, so sixty findings were a wall — nothing lined up and nothing could be compared down a
// column. A table reads the way the work does: what is the issue, what do I have, what does the
// file say, how much is at stake.
//
// Sides come from `appNames`/`fileNames`, never from position in `names`. Position was already
// inconsistent: one ambiguous-rename path builds [file, …app] and the other [app, …file], and a
// brand group is [tag, …merchants], which is not a pair at all.
const RECONCILE_CELL_NAMES = 8;

function reconcileNameCell(names, item) {
  const list = (names || []).filter(Boolean);
  if (!list.length) return '<span class="rc-none">—</span>';
  if (list.length === 1) return `<span class="rc-name">${escape(list[0])}</span>`;
  // `count` is the exact total even when the backend capped the names at 200 (§1l), so a row
  // that holds 49 names out of 60 still reports 60. Never `list.length` for the total.
  const total = item.count ?? list.length;
  const shown = list.slice(0, RECONCILE_CELL_NAMES);
  const hidden = total - shown.length;
  const more = hidden > 0
    ? `<li class="rc-more">…and ${hidden} more</li>` : '';
  return `<ul class="rc-cell-list">${shown.map(n => `<li>${escape(n)}</li>`).join('')}${more}</ul>`;
}

function reconcileRowHtml(item, moneyUnknown) {
  const money = moneyUnknown
    ? '<span class="rc-warn">unknown</span>'
    : (item.money ? `${fmt2(item.money)}` : '<span class="rc-none">—</span>');
  const count = item.type === 'machine-list-miss' ? (item.count ?? 0) : 0;
  return `<tr>
    <td class="rc-c-app">${reconcileNameCell(item.appNames, item)}</td>
    <td class="rc-c-file">${reconcileNameCell(item.fileNames, item)}</td>
    <td class="rc-c-why">${item.detail ? escape(item.detail) : ''}${
        count ? `${item.detail ? '<br>' : ''}${count} merchant(s)` : ''}</td>
    <td class="rc-c-money">${money}</td>
    <td class="rc-c-fix"><span class="rc-fix-text">${escape(reconcileFix(item))}</span></td>
  </tr>`;
}

// NOTE: not called since the table layout (2026-09-22) — the 'in your app, not in your file'
// rows now sit in the table with everything else. Kept, with its tests, because the batch
// grouping is still the only way the cross-script duplicates ('UDON Cher' / 'เฌอ') are
// findable, and it will be wanted again when that list gets its own view.
// Spec §5 type 5: the "in your app, not in your file" rows group by the day the contract row was
// created, because that is the axis along which this app's duplicates were created (38 from the
// 7 Aug migration, 21 from the 9 Aug adoption, a handful since). No string metric pairs 'UDON
// Cher' with 'เฌอ' — this grouping plus a human eye IS the detection mechanism for those.
function groupByAddedDay(items, contracts) {
  const byId = new Map((contracts || []).map(c => [c.contractId, c]));
  const days = new Map();
  for (const it of items) {
    const c = byId.get(it.contractIds[0]);
    const day = (c?.createdAt || '').slice(0, 10) || 'unknown';
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(it);
  }
  return [...days.entries()].sort((a, b) => b[0].localeCompare(a[0]));
}

function reconcileDayGroupsHtml(rows) {
  return groupByAddedDay(rows, CONTRACTS).map(([day, items]) => {
    const label = day === 'unknown' ? 'Unknown date'
      : new Date(day).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    const known = RECONCILE_KNOWN_BATCHES[day] ? ` (${RECONCILE_KNOWN_BATCHES[day]})` : '';
    return `<div class="rc-day"><h4>${escape(label)} — ${items.length}${escape(known)}</h4>
      ${items.map(reconcileRowHtml).join('')}</div>`;
  }).join('');
}

// Pure: what this page can and cannot say about money, from the state of the latest run fetch.
// THREE states, never two. The run payload is ~900KB and its fetch used to fall back to `null`
// on failure, which is indistinguishable from "no run yet" — every money figure silently became
// 0 and the page read as "nothing is at stake" when the truth was 51,495 THB. On a money screen
// a silent zero is worse than a visible error, so a failed load says so where the money was.
function reconcileRunNote(runState) {
  const period = runState && runState.period ? runState.period : null;
  switch (runState && runState.state) {
    case 'ok':
      return period ? `money shown is revenue that paid nothing in the ${period} run` : '';
    case 'error':
      return (period ? `The ${period} run could not be loaded` : 'The latest run could not be loaded')
        + ', so no money is shown below — this page cannot tell you what is at stake. Reload to try again.';
    default:
      return 'No run has been computed yet, so no money figures are available.';
  }
}

// The heading states the upload date and the run the money comes from, because both are facts
// the reader needs to trust a number.
function reconcileHtml(items, upload, runState) {
  if (!upload) return '<p class="muted">No weekly upload has been recorded yet. '
    + 'Upload your merchant file from <strong>+ Add merchants</strong> and this page will fill in.</p>';
  const when = upload.at ? new Date(upload.at).toLocaleDateString('en-GB',
    { day: 'numeric', month: 'short', year: 'numeric' }) : 'your last upload';
  const state = (runState && runState.state) || 'none';
  const note = reconcileRunNote(runState);
  const head = `<p class="muted" style="margin:0 0 ${state === 'ok' ? 14 : 6}px;">Compared against your `
    + `<strong>${escape(when)}</strong> upload${state === 'ok' && note ? ` · ${escape(note)}` : ''}.</p>`
    + (state === 'ok' ? ''
      : `<p class="${state === 'error' ? 'rc-warn' : 'muted'}" style="margin:0 0 14px;">${escape(note)}</p>`);
  if (!items.length) return head + '<p class="muted">Nothing to reconcile — your list and your file agree.</p>';

  // Group heading rows inside the table rather than separate sections: the ordering by money
  // still reads, but every finding shares one set of columns, which is the point of a table.
  const body = RECONCILE_GROUPS.map(g => {
    const rows = items.filter(i => i.type === g.type);
    if (!rows.length) return '';
    const moneyUnknown = !!g.money && state === 'error';
    const money = rows.reduce((sum, r) => sum + (r.money || 0), 0);
    // machine-list-miss is one row per REASON, not per merchant: `rows.length` would read "2"
    // whether 10 merchants or 5,000 could not be placed.
    const count = g.type === 'machine-list-miss'
      ? rows.reduce((sum, r) => sum + (r.count ?? (r.fileNames || []).length), 0)
      : rows.length;
    const moneyHtml = moneyUnknown ? '<span class="rc-warn">money unknown</span>'
      : money ? `${fmt2(money)} ${escape(CCY)}` : '';
    // Within a group, the largest number at stake first — the order you would work in.
    const sorted = rows.slice().sort((a, b) => (b.money || 0) - (a.money || 0));
    return `<tr class="rc-grouprow rc-tone-${g.tone || 'quiet'}"><td colspan="5">
        <span class="rc-g-title">${escape(g.title)}</span>
        <span class="rc-count">${count}${g.unit ? ` ${escape(g.unit)}` : ''}</span>
        <span class="rc-g-money">${moneyHtml}</span></td></tr>`
      + RECONCILE_COLHEAD
      + sorted.map(r => reconcileRowHtml(r, moneyUnknown)).join('');
  }).join('');

  return `<div class="rc-wrap">${head}
    <table class="ts rc-table"><tbody>${body}</tbody></table></div>`;
}

async function renderReconcileTab() {
  const main = document.getElementById('main');
  setActiveNav('nav-contracts');
  const token = newPaintToken();   // setActiveNav bumped it; this is the paint that owns it
  main.innerHTML = `<h1>Overview</h1>${merchantHead('reconcile')}<div id="rc-out"><p class="muted">Loading…</p></div>`;
  wireMerchantTabs();

  // BOTH halves: `names` lives on the cheap CONFIG row (the same one read on every Overview
  // paint for the ⦿ marks), while `brands`/`machineMisses` live in the S3 document. Fetching only
  // the pointer would leave the machine-list section permanently empty — its test would still pass.
  // The run payload (~900KB) is fetched ONLY here, when the tab is actually opened — never from
  // the Merchants tab.
  const [ptr, doc, runs] = await Promise.all([
    api('/contracts/last-upload').catch(() => null),
    api('/contracts/last-upload/rows').catch(() => null),
    api('/bulk-runs').catch(() => null),
  ]);
  if (!paintIsCurrent(token)) return;
  // /contracts/last-upload always returns an object — {at:null, names:[]} before any upload was
  // ever recorded, same as GET /me-style "empty but present" responses elsewhere in this API — so
  // "has an upload happened" is `upload.at`, never plain truthiness of `upload` itself. Mirrors
  // renderContractsScreen's own `lastUpload.names.length` check for LAST_UPLOAD, above.
  const merged = ptr ? { ...ptr, ...(doc || {}) } : null;
  const upload = merged?.at ? merged : null;

  // THREE states, not two. A failed fetch used to collapse to `latest = null`, which is exactly
  // what "no run has happened yet" looks like — so every money figure became 0 and the page said
  // nothing was at stake. The summary list carries `periodStart`, so even when the payload fails
  // the page can still name the run it could not read.
  const summaries = Array.isArray(runs) ? runs.slice() : [];
  const newest = summaries.sort((a, b) => (b.periodStart || '').localeCompare(a.periodStart || ''))[0] || null;
  let latest = null;
  let state = 'none';
  if (!Array.isArray(runs)) {
    state = 'error';                       // the run LIST itself failed; we cannot even name one
  } else if (newest) {
    latest = await api('/bulk-runs/' + newest.runId).catch(() => null);
    if (!paintIsCurrent(token)) return;
    state = latest ? 'ok' : 'error';
  }
  const runState = { state,
    period: newest?.periodStart ? periodMonth(newest.periodStart) : null };

  // GET /contracts/dismissals doesn't exist yet (Task 13) — never let its absence blank the page.
  const dismissals = await api('/contracts/dismissals').catch(() => ({ items: [] }));
  if (!paintIsCurrent(token)) return;
  // No upload yet ⇒ nothing to compare against, so don't ask classifyDifferences to treat every
  // live merchant as "not in your file" — that would badge the tab with a big, misleading number
  // right when the page itself says there's nothing to reconcile.
  const items = upload ? classifyDifferences({ contracts: CONTRACTS, upload, run: latest,
                                               dismissals: dismissals.items || [] }) : [];
  RECONCILE_COUNT = items.length;
  // Repaint the tab strip so the (N) badge reflects what was just computed, without a refetch.
  // Guarded above: `.subtabs` exists under the Merchants tab too, so repainting it after the user
  // has switched back would mark the WRONG tab active and then throw on a missing #rc-out.
  const strip = main.querySelector('.subtabs');
  if (strip) { strip.outerHTML = merchantHead('reconcile'); wireMerchantTabs(); }
  const outEl = document.getElementById('rc-out');
  if (outEl) outEl.innerHTML = reconcileHtml(items, upload, runState);
}



// ── The held upload (2026-09-29) ───────────────────────────────────────────────────────────
// An upload is not a moment, it is a piece of work: you drop the file in once and then go
// through the differences one at a time, over hours or days. So the PARSED FILE is kept, and the
// page comes back to it after a reload, after wandering off to Overview, after a deploy.
//
// The file itself cannot be kept — a browser will not let a page hold a file selection across a
// reload, which is exactly how an afternoon's work was lost once. The parsed rows can be, and
// they are all the page ever needed.
//
// IndexedDB rather than localStorage: a roster is ~2,400 rows and would crowd a 5MB quota. It is
// a CACHE, never a source of truth — the merchant list itself still lives in DynamoDB, and
// clearing this loses nothing but the convenience.
const UP_DB = 'mcrm-upload', UP_STORE = 'draft';

function upDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(UP_DB, 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(UP_STORE)) r.result.createObjectStore(UP_STORE); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

// Everything here fails SOFT. Private mode, a full disk or a blocked database must never stop
// someone uploading — the page simply stops remembering.
async function saveUploadDraft(draft) {
  try {
    const db = await upDb();
    await new Promise((res, rej) => {
      const tx = db.transaction(UP_STORE, 'readwrite');
      // `put` itself throws synchronously on a value structured-clone cannot copy, which the
      // transaction's onerror never sees — so it is caught here, not only there.
      tx.objectStore(UP_STORE).put(draft, REGION);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error);
    });
    return true;
  } catch (e) {
    // Never blocks the upload — but the page must stop claiming the file will still be here.
    console.warn('upload draft not held:', e);
    return false;
  }
}

async function loadUploadDraft() {
  try {
    const db = await upDb();
    return await new Promise((res, rej) => {
      const tx = db.transaction(UP_STORE, 'readonly');
      const q = tx.objectStore(UP_STORE).get(REGION);
      q.onsuccess = () => res(q.result || null);
      q.onerror = () => rej(q.error);
    });
  } catch { return null; }
}

async function clearUploadDraft() {
  try {
    const db = await upDb();
    await new Promise((res) => {
      const tx = db.transaction(UP_STORE, 'readwrite');
      tx.objectStore(UP_STORE).delete(REGION);
      tx.oncomplete = res; tx.onerror = res;
    });
  } catch { /* nothing to do */ }
}

// ── Upload (2026-09-29) ─────────────────────────────────────────────────────────────────────
// The weekly job, promoted out of a dialog and onto a nav page: drop in the merchant file and
// the machine list, and SEE what disagrees before anything is written.
//
// It is deliberately the same shape as Reconcile — the same table, the same coloured group
// bands, the same "In your app / In your file / Why" columns — because it answers the same
// question at a different moment. Reconcile compares your list against the file you already
// recorded; this compares it against the file in your hand.
//
// Nothing here writes on its own. Review records the file and changes no merchant row; Import
// applies it. Per-row adjustments are NOT built yet — that is the next conversation.
const UPLOAD_GROUPS = [
  // Step 1 — the two files against each other.
  { key: 'noLabel',  title: 'In your merchant file, but with no Merchant label', tone: 'warn',  unit: 'merchants' },
  { key: 'notAppr',  title: 'In your merchant file, but not Approved',           tone: 'warn',  unit: 'merchants' },
  { key: 'noBrand',  title: 'In your machine list, not in your merchant file', tone: 'loss',  unit: 'merchants' },
  { key: 'noMach',   title: 'In your merchant file, no machines recorded',     tone: 'quiet', unit: 'merchants' },
  // Step 2 — the joined set against the app.
  { key: 'added',    title: 'New merchants this file would add',        tone: 'info',  unit: 'merchants' },
  { key: 'changed',  title: 'Merchants this file would change',         tone: 'warn',  unit: 'merchants' },
  { key: 'missing',  title: 'In your list, not in this file',           tone: 'quiet', unit: 'merchants' },
  { key: 'moved',    title: 'Merchants your file moved to a different brand', tone: 'warn', unit: 'merchants' },
  { key: 'unknown',  title: 'Merchants your file names under a brand you do not carry', tone: 'warn', unit: 'merchants' },
  { key: 'unlinked', title: 'Merchants in the registry with no brand',     tone: 'warn',  unit: 'merchants' },
  { key: 'unchanged',title: 'Already up to date',                       tone: 'quiet', unit: 'merchants' },
];

let UPLOAD_STATE = { parsed: null, machines: null, diff: null, misses: null };

async function renderUploadScreen() {
  const el = document.getElementById('main');
  setActiveNav('nav-upload');
  const token = newPaintToken();
  if (!paintIsCurrent(token)) return;
  el.innerHTML = `
    <div class="page-head" style="margin-bottom:6px;align-items:center;">
      <h1 style="margin:0;">Upload</h1>
    </div>
    <p class="muted" style="margin:0 0 18px;font-size:13px;max-width:760px;">
      Your weekly files. Everything below is shown <strong>before</strong> anything is written —
      contract dates, the contract entity, finance details and revenue-share terms are never
      touched by an upload, whatever the file contains.</p>

    <div class="subtabs" id="up-tabs"></div>

    <div id="up-files">
    <div class="up-drop">
      <label class="up-file">
        <span class="up-file-t">Merchant list <span class="muted">(.xlsx)</span></span>
        <span class="muted up-file-d">One row per merchant. The brand is the <strong>Merchant label</strong>
          column; merchant names are counted. Approved rows only.</span>
        <input type="file" id="up-merchants" accept=".xlsx,.xls" class="input">
      </label>
      <label class="up-file">
        <span class="up-file-t">Machine list <span class="muted">(.xlsx) — optional</span></span>
        <span class="muted up-file-d">The platform's Machine List export. Updates machine counts
          only, matched to merchants by name.</span>
        <input type="file" id="up-machines" accept=".xlsx,.xls" class="input">
      </label>
    </div>

    <div id="up-summary"></div>
    <div id="up-filterbar" hidden style="margin:0 0 12px;">
      <input id="up-filter" class="input" style="max-width:280px"
             placeholder="Filter by brand or merchant name…"
             title="Narrows every section below. Counts show matches out of the total.">
      <span class="muted" id="up-done" style="margin-left:12px;"></span>
    </div>
    <div id="up-out"><p class="muted">Choose a file to see what would change.</p></div>
    <p class="nm-err" id="up-err" hidden></p>
    </div>

    <!-- The mismatch tabs are a SIBLING of the file block, and the file block is hidden rather
         than replaced. Rebuilding this screen's markup on a tab click would throw away a file
         someone had loaded and half worked through, which is the one thing this page must never
         do. -->
    <div id="up-mismatch" hidden></div>`;

  if (!CONTRACTS.length) await ensureContractCache().catch(() => {});
  // The file's own branch and machine counts — read from the STORED roster, so the comparison
  // works without uploading anything again.
  try {
    await refreshMismatchData();
  } catch (e) {
    console.warn('could not read the stored file counts:', e);
  }
  if (!paintIsCurrent(token)) return;
  paintUploadTabs();

  // Come back to the work in progress rather than an empty file picker.
  let held = null;
  try { held = await loadUploadDraft(); } catch { held = null; }

  // A HELD FILE OLDER THAN THE RECORDED UPLOAD IS THROWN AWAY, not shown (2026-10-01). The
  // browser keeps the last file loaded ON THIS MACHINE; a colleague uploading a newer one makes
  // it worthless, and leaving it on screen asks the person to notice and tidy up after the app.
  // Nothing is lost: whatever it had already written stays written, and the record it is behind
  // is the one every tab is reading.
  let dropped = null;
  if (held && held.at && ROSTER_BRANDS.at
      && new Date(held.at).getTime() < new Date(ROSTER_BRANDS.at).getTime()) {
    dropped = held;
    held = null;
    await clearUploadDraft().catch(() => {});
    const sum = document.getElementById('up-summary');
    if (sum) {
      const when = new Date(dropped.at).toLocaleString('en-GB',
        { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      sum.innerHTML = `<div class="up-held"><span>A file held in this browser
        (<strong>${escape(dropped.fileName || 'an earlier upload')}</strong>, read
        ${escape(when)}) was older than the ${escape(rosterDateLabel())} upload on the app, so it
        has been discarded. Everything below is from the ${escape(rosterDateLabel())}
        file.</span></div>`;
    }
  }

  if (held && (held.parsed || held.machines)) {
    if (!paintIsCurrent(token)) return;
    try {
      await restoreUploadDraft(held);
    } catch (e) {
      // A held file that cannot be put back is worth saying out loud — the alternative is a page
      // that looks like it never had one.
      console.warn('could not restore the held upload:', e);
      const out = document.getElementById('up-out');
      if (out) out.innerHTML = `<p class="rc-warn">A file you loaded earlier could not be
        restored (${escape(e.message || 'unknown error')}). Choose it again.</p>`;
    }
  }

  el.querySelector('#up-out').addEventListener('click', ev => {
    const b = ev.target.closest('.up-add-btn');
    if (b) { openAddFromFile(b.dataset.name, b); return; }
    const u = ev.target.closest('.up-upd-btn');
    if (u) { updateFromFile(u.dataset.name, u); return; }
    const ar = ev.target.closest('.up-arch-btn');
    if (ar) { archiveFromUpload(ar.dataset.id, ar); return; }
    const dl = ev.target.closest('.up-del-btn');
    if (dl) { deleteFromUpload(dl.dataset.id, dl); return; }
    const mv = ev.target.closest('.up-mov-btn');
    if (mv) repointStoreFromFile(mv.dataset.store, mv.dataset.brand, mv);
  });
  el.querySelector('#up-filter').addEventListener('input', () => refreshUploadTable());
  el.querySelector('#up-merchants').addEventListener('change', () => previewUpload(token));
  el.querySelector('#up-machines').addEventListener('change', () => previewUpload(token));
}


// Put a held upload back on screen. The differences are recomputed against the CURRENT merchant
// list, so the table reflects every adjustment made since the file was read — the "new merchants"
// count falls as you add them, without anything being re-uploaded.
async function restoreUploadDraft(held) {
  const { parsed, machines, roster } = held;
  const join = joinUploadFiles(roster, machines);
  const misses = machines ? matchMachineStores(machines.byStore, await loadRegistry(), roster, CONTRACTS) : null;
  const diff = parsed ? diffWeeklyRows(parsed, CONTRACTS) : null;
  UPLOAD_STATE = { ...held, diff, misses, join };
  const sum = document.getElementById('up-summary');
  const out = document.getElementById('up-out');
  if (!sum || !out) return;
  sum.innerHTML = heldBannerHtml(held) + uploadSummaryHtml(parsed, machines, misses, roster);
  out.innerHTML = uploadTableHtml(diff, misses, machines, join);
  const fb = document.getElementById('up-filterbar'); if (fb) fb.hidden = false;
  document.getElementById('up-forget')?.addEventListener('click', async () => {
    if (!confirm('Forget this file? Nothing that has already been added to your merchant list is undone.')) return;
    await clearUploadDraft();
    UPLOAD_STATE = { parsed: null, machines: null, diff: null, misses: null, roster: null };
    sum.innerHTML = '';
    out.innerHTML = '<p class="muted">Choose a file to see what would change.</p>';

  });
}

// Says what is on screen and where it came from, because a table that survived a reload with no
// file in the picker above it is otherwise a mystery.
// Is the file on this screen older than the one the app has already recorded? Compared on the
// time it was READ, which is what both sides store.
function fileIsStale() {
  const mine = UPLOAD_STATE.at ? new Date(UPLOAD_STATE.at).getTime() : 0;
  const theirs = ROSTER_BRANDS.at ? new Date(ROSTER_BRANDS.at).getTime() : 0;
  return !!(mine && theirs && mine < theirs);
}

function heldBannerHtml(held) {
  const when = held.at ? new Date(held.at) : null;
  const names = [held.fileName, held.machineFileName].filter(Boolean).map(escape).join(' · ');
  return `<div class="up-held">
    <span>Working from <strong>${names || 'a file you loaded earlier'}</strong>${when
      ? ` <span class="muted">· read ${escape(when.toLocaleString('en-GB',
          { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}</span>` : ''}</span>
    <button type="button" id="up-forget" class="btn-ghost">Forget this file</button>
  </div>${fileIsStale() ? `<div class="up-held" style="border-left-color:var(--warn,#e67700);">
    <span><strong>This file is older than the one already recorded.</strong> A newer upload
    (${escape(rosterDateLabel())}) is what the app is working from, so nothing on this screen is
    applied — it would undo the newer file. Forget it, or load the latest.</span></div>` : ''}`;
}

async function previewUpload(token) {
  const out = document.getElementById('up-out');
  const sum = document.getElementById('up-summary');
  const err = document.getElementById('up-err');
  const mf = document.getElementById('up-merchants').files[0];
  const kf = document.getElementById('up-machines').files[0];
  err.hidden = true;
  if (!mf && !kf) { out.innerHTML = '<p class="muted">Choose a file to see what would change.</p>'; sum.innerHTML = ''; return; }
  out.innerHTML = '<p class="muted">Reading…</p>';
  try {
    const parsed = mf ? await parseWeeklyMerchantFile(mf) : null;
    const machines = kf ? await parseMachineCountFile(kf) : null;
    // The roster view of the very same workbook — one row per station, carrying the merchant name
    // and device type a run needs. Parsed here so the page can say how many merchants a run would
    // see, and stored on Import so the run never asks for this file again.
    const roster = mf ? await parseMerchantList(mf).catch(() => null) : null;
    // The SAME matcher the import runs, so a store reported here as unplaced is exactly a store
    // the import will skip. Sharing it is what keeps the preview honest.
    // Step 1 — the two files to each other. Step 2 — that set against the app.
    const join = joinUploadFiles(roster, machines);
    const misses = machines ? matchMachineStores(machines.byStore, await loadRegistry(), roster, CONTRACTS) : null;
    // `let`, because the file's own changes are applied below and the diff is then recomputed —
    // the rows on screen are what is LEFT, not a list of buttons to press.
    let diff = parsed ? diffWeeklyRows(parsed, CONTRACTS) : null;
    // The file is the record: what it changes is written, not offered. Done before the table is
    // drawn, so the rows you see are what is left rather than a list of buttons to press.
    UPLOAD_STATE = { parsed, machines, diff, misses, roster, join,
                     fileName: mf ? mf.name : UPLOAD_STATE.fileName || null,
                     machineFileName: kf ? kf.name : UPLOAD_STATE.machineFileName || null,
                     at: new Date().toISOString() };
    // Held so the work survives a reload. The DIFF is deliberately not stored — it is recomputed
    // against the current merchant list every time, so a merchant you add during the session
    // drops out of "new" on its own rather than lingering as a stale finding.
    const heldOk = await saveUploadDraft({ parsed, machines, roster,
                      fileName: UPLOAD_STATE.fileName,
                      machineFileName: UPLOAD_STATE.machineFileName,
                      at: UPLOAD_STATE.at });
    if (token != null && !paintIsCurrent(token)) return;
    // Remember the FILE — the roster a run reads and the brand list the ⦿ marks compare against.
    // No merchant is created or changed by this; those are the buttons on each row.
    const remembered = await rememberUploadedFile(parsed, machines, roster);

    // THE FILE IS THE RECORD, so what it changes is written now rather than offered as a row of
    // buttons. Only the fields the file owns move — merchant count, machine counts, type, contact,
    // phone, sales person — and `merchantName` is never among them, being the key the row matched
    // on. Terms, entity, finance details and every past run are untouched, and the engine counts
    // roster rows at run time, so no payout can move because of this.
    const applied = await applyFileChanges().catch(e => {
      console.warn('file changes not applied:', e); return null;
    });
    if (applied && applied.done) {
      // Recompute the diff: the rows just written are no longer differences.
      UPLOAD_STATE.diff = diff = parsed ? diffWeeklyRows(parsed, CONTRACTS) : null;
    }
    if (token != null && !paintIsCurrent(token)) return;

    const warn = (msg) => `<div class="up-held" style="border-left-color:var(--warn,#e67700);">
        <span>${msg}</span></div>`;
    const appliedNote = applied && applied.stale
      ? `<div class="up-held" style="border-left-color:var(--warn,#e67700);"><span>
          <strong>Not applied.</strong> This file is older than the ${escape(rosterDateLabel())}
          one already recorded — applying it would undo the newer upload.</span></div>`
      : applied && (applied.done || applied.failed.length)
      ? `<div class="up-held"><span>${applied.done} merchant(s) updated from this file${
          applied.failed.length ? ` · <span class="rc-warn">${applied.failed.length} could not be written</span>` : ''
        }.</span></div>` : '';
    sum.innerHTML = appliedNote
      + (heldOk ? '' : warn(`This file could <strong>not</strong> be held in this browser — a
          reload will lose it and you will need to choose it again.`))
      + ((remembered.ok || !roster?.merchants?.length) ? '' : warn(`This file was read, but could
          not be recorded for Run share (${escape(remembered.error || 'unknown error')}). A run
          will still use the previous one.`))
      + uploadSummaryHtml(parsed, machines, misses, roster);
    out.innerHTML = uploadTableHtml(diff, misses, machines, join);
    const fb = document.getElementById('up-filterbar'); if (fb) fb.hidden = false;

  } catch (e) {
    out.innerHTML = '';
    err.hidden = false;
    err.textContent = e.message;
  }
}

function uploadSummaryHtml(parsed, machines, misses, roster) {
  if (!parsed && !machines) return '';
  const bits = [];
  if (parsed) {
    bits.push(`<div class="up-sum-row"><strong>${parsed.rows.length}</strong> merchant/brand(s)
      from ${parsed.branchRows.toLocaleString('en-US')} approved merchant row(s)
      <span class="muted">— sheet “${escape(parsed.sheet)}”, header row ${parsed.headerRow}</span></div>`);
    if (parsed.hasReviewColumn && parsed.skippedNotApproved) {
      bits.push(`<div class="muted up-sum-row">${parsed.skippedNotApproved.toLocaleString('en-US')} row(s) skipped — not Approved.</div>`);
    }
    if (!parsed.hasReviewColumn) {
      bits.push('<div class="muted up-sum-row">No review-state column, so every named row is included.</div>');
    }
    // The single most consequential thing this parser can get wrong — say it loudly.
    if (parsed.brandFromBranch) {
      bits.push('<div class="rc-warn up-sum-row">No <strong>Merchant label</strong> column. The merchant name is being read as the brand, so every merchant becomes its own brand.</div>');
    }
    bits.push(`<div class="up-sum-row">Columns read: ${parsed.fields.map(f => `<span class="badge badge-neutral">${escape(f)}</span>`).join(' ')}</div>`);
    if (parsed.unmapped.length) {
      bits.push(`<div class="muted up-sum-row">Ignored: ${parsed.unmapped.slice(0, 10).map(escape).join(', ')}${parsed.unmapped.length > 10 ? '…' : ''}</div>`);
    }
  }
  if (roster && roster.merchants.length) {
    // Stations, not cabinets — this is the count a payout multiplies by.
    bits.push(`<div class="up-sum-row"><strong>${roster.merchants.length.toLocaleString('en-US')}</strong>
      approved merchant row(s) would be stored as the run's merchant list
      ${roster.excluded.length ? `<span class="muted">· ${roster.excluded.length.toLocaleString('en-US')} not-Approved row(s) travel with it so a run can name them</span>` : ''}</div>`);
  }
  if (roster && machines) {
    const j = joinUploadFiles(roster, machines);
    bits.push(`<div class="up-sum-row"><strong>Your two files together:</strong>
      ${j.stores.size.toLocaleString('en-US')} merchant(s) across ${j.brands.size.toLocaleString('en-US')} brand(s)
      ${j.notApproved?.length ? `<span class="rc-warn">· ${j.notApproved.length} merchant(s) in the file but not Approved</span>` : ''}
      ${j.onlyInMachineFile.length ? `<span class="rc-warn">· ${j.onlyInMachineFile.length} merchant(s) with machines but no brand</span>` : ''}
      ${j.onlyInMerchantFile.length ? `<span class="muted">· ${j.onlyInMerchantFile.length} merchant(s) with no machines</span>` : ''}</div>`);
  }
  if (machines) {
    const placed = misses ? misses.totals.size : 0;
    bits.push(`<div class="up-sum-row"><strong>${(machines.byStore.size ?? Object.keys(machines.byStore).length).toLocaleString('en-US')}</strong>
      merchant(s) in the machine list · <strong>${placed}</strong> brand(s) would have counts updated
      ${misses?.matchedViaFile ? `<span class="muted">· ${misses.matchedViaFile} placed by your merchant file</span>` : ''}
      ${misses?.conflicts?.length ? `<span class="rc-warn">· ${misses.conflicts.length} merchant(s) moved brand</span>` : ''}</div>`);
  }
  return `<div class="up-sum">${bits.join('')}</div>`;
}

function uploadTableHtml(diff, misses, machines, join, filter) {
  // `join` alone can carry findings — the two files disagreeing needs neither a merchant diff
  // nor a placement result.
  if (!diff && !misses && !join) return '';
  // EVERY SHOP APPEARS IN EXACTLY ONE BUCKET. The first cut let a merchant fall into two — "not in
  // your merchant file" and "nothing can place" overlapped without saying so, and neither
  // contained the other, so the two counts could not be reconciled by reading them. Precedence:
  // the file-to-file gap is stated first, and the placement buckets then cover only what is left.
  const key = v => String(v ?? '').toLowerCase().trim();
  const unplaced = new Set([...(misses?.unknown || []), ...(misses?.unlinked || [])].map(x => key(x.store)));
  const noBrandKeys = new Set(!join?.bothFiles ? []
    : [...(join.onlyInMachineFile || []), ...(join.notApproved || []), ...(join.noLabelShops || [])]
        .map(x => key(x.store)));
  // Brands this file would ADD. A merchant whose brand is on that list needs no separate complaint:
  // adding the merchant places the merchant, and the action is one section up. Nagging about both
  // made the same fact appear twice with no hint they were the same fact.
  const addingBrands = new Set((diff?.added || []).map(a => key(a.name)));
  // Brands that DO exist but are archived. "There is no merchant of that name" was wrong about
  // them — the merchant is there, it is just ended, and the fix is to unarchive it, not to add
  // a second one.
  const archivedBrands = new Map((CONTRACTS || []).filter(c => c.archived)
    .map(c => [key(c.merchantName), c.merchantName]));
  // One real merchant, one row. The two files routinely spell a store with different capitals, and
  // both spellings were rendering.
  const onceByStore = (rows) => {
    const seen = new Set();
    return (rows || []).filter(x => { const k = key(x.store); if (seen.has(k)) return false; seen.add(k); return true; });
  };

  const buckets = {
    // Only meaningful when BOTH files are present — with one file there is nothing to join.
    noLabel:   !join?.bothFiles ? [] : onceByStore(join.noLabelShops).map(x => ({
                 app: '', file: escape(x.store),
                 why: `${machineCountText(x, machines)} Your file lists this merchant, but its `
                    + `<strong>Merchant label</strong> is blank — that column is the brand, so there `
                    + `is nothing to attribute the machines to. Fill it in on the platform.` })),
    notAppr:   !join?.bothFiles ? [] : onceByStore(join.notApproved).map(x => ({
                 app: '', file: escape(x.store),
                 why: `${machineCountText(x, machines)} Your file DOES list this merchant`
                    + (x.brand ? ` under <strong>${escape(x.brand)}</strong>` : '')
                    + `, but its review state is <strong>${escape(x.reviewState)}</strong> — only `
                    + `Approved rows are read, so it is not placed and its rentals are not paid. `
                    + `Approve it on the platform, or leave it if that is deliberate.` })),
    noBrand:   !join?.bothFiles ? [] : onceByStore(join.onlyInMachineFile).map(x => {
                 // Saying "these machines belong to nobody" about a merchant the registry DID place
                 // was simply false. The gap is still worth reporting; the consequence is not.
                 const stillPlaced = !unplaced.has(key(x.store));
                 // The two files name the store in different columns, so a near-miss is
                 // ordinary. Saying "your file does not list this merchant" when it lists it under a
                 // slightly different spelling is the wrong thing to tell someone.
                 const near = closestFileStore(x.store, join);
                 return { app: '', file: escape(x.store),
                   why: `${machineCountText(x, machines)} `
                      + (near
                          ? `Your merchant file has <strong>${escape(near)}</strong>, which is close `
                            + `but not the same name — the two files name the merchant in different `
                            + `columns, so the spellings differ. Match them up on the platform.`
                          : `Your file does not list this merchant.`)
                      + (stillPlaced
                          ? ` The registry still knows it, so its machines are counted.`
                          : ` Nothing else knows it either, so these machines are counted toward`
                            + ` nobody this week.`) };
               }),
    noMach:    !join?.bothFiles ? [] : (join.onlyInMerchantFile || [])
                 .filter(x => !addingBrands.has(key(x.brand)))
                 .map(x => ({
                 app: escape(x.brand), file: escape(x.store),
                 why: `Your file lists this merchant under <strong>${escape(x.brand)}</strong>, `
                    + `but the machine list records no machines at it.` })),
    added:     (diff?.added || []).map(a => ({ app: '', file: escape(a.name),
                 why: uploadAddedWhy(a, join),
                 act: `<button class="btn-ghost up-add-btn" data-name="${escape(a.name)}">Add to list…</button>` })),
    changed:   (diff?.changed || []).map(c => ({ app: escape(c.name), file: escape(c.name), why: uploadChangedWhy(c),
                 act: `<button class="btn-ghost up-upd-btn" data-name="${escape(c.name)}">Update to the list</button>` })),
    missing:   (diff?.missing || []).map(m => ({ app: escape(m.merchantName || ''), file: '',
                 why: uploadMissingWhy(m),
                 // Archive first, and in reach: the contract ended but its terms, its history
                 // and the runs that paid it all stay. Delete is beside it, second, because it
                 // is the one that cannot be undone.
                 act: `<button class="btn-ghost up-arch-btn" data-id="${escape(m.contractId)}">Archive</button>`
                    + ` <button class="btn-ghost up-del-btn" data-id="${escape(m.contractId)}" style="color:var(--loss);">Delete</button>` })),
    // Only when there ARE some — a band reading "0 merchants" is noise on a screen whose whole
    // job is to show what differs.
    unchanged: diff && diff.unchanged > 0
      ? [{ app: '', file: '', why: `${diff.unchanged} merchant(s) already match this file.`, plain: true }]
      : [],
    // matchMachineStores pushes {store, machines} OBJECTS, not strings — the comment above it
    // says so, and mapping these as strings printed "[object Object]" on every row.
    moved:     (misses?.conflicts || []).map(x => {
                 const was = (CONTRACTS.find(c => c.contractId === x.registryContractId) || {}).merchantName;
                 return { app: escape(was || '(a merchant no longer in your list)'),
                          file: escape(x.store),
                          why: `${machineCountText(x, machines)} The registry still puts this merchant `
                             + `under <strong>${escape(was || 'another merchant')}</strong>, but your `
                             + `merchant file now says <strong>${escape(x.fileBrand)}</strong>. `
                             + `The file already wins for this upload's counts — updating repoints `
                             + `the merchant itself, so every later run and assignment follows it too.`,
                          act: `<button class="btn-ghost up-mov-btn" data-store="${escape(x.store)}"`
                             + ` data-brand="${escape(x.fileBrand)}">Update with file data</button>` };
               }),
    // Already reported above as a file-to-file gap — not repeated here.
    unknown:   onceByStore(misses?.unknown)
                 .filter(x => !noBrandKeys.has(key(x.store)) && !addingBrands.has(key(x.fileBrand)))
                 .map(x => ({ app: '', file: escape(x.store),
                              why: machineMissWhy(x, machines, 'unknown', archivedBrands) })),
    // `app` is left EMPTY on purpose. It used to show the merchant name, which read as "this is in
    // your app" — and it is not: it is a row in the hidden registry, not a merchant anyone can
    // search for. Saying it in the explanation is honest; putting it in that column was not.
    unlinked:  onceByStore(misses?.unlinked)
                 .filter(x => !noBrandKeys.has(key(x.store)) && !addingBrands.has(key(x.fileBrand)))
                 .map(x => ({ app: '', file: escape(x.store),
                              why: machineMissWhy(x, machines, 'unlinked', archivedBrands) })),
  };
  // Filtering happens on the DATA, not by hiding rendered rows, so a group's count always
  // describes what is actually under it.
  const q = String(filter || '').toLowerCase().trim();
  const strip = h => String(h || '').replace(/<[^>]+>/g, '');
  const body = UPLOAD_GROUPS.map(g => {
    const all = buckets[g.key] || [];
    const rows = !q ? all
      : all.filter(r => (strip(r.app) + ' ' + strip(r.file)).toLowerCase().includes(q));
    if (!rows.length) return '';
    if (g.key === 'unchanged') {
      return `<tr class="rc-grouprow rc-tone-${g.tone}"><td colspan="4">
        <span class="rc-g-title">${escape(g.title)}</span>
        <span class="rc-count">${diff.unchanged} ${escape(g.unit)}</span></td></tr>`;
    }
    const countLabel = q && rows.length !== all.length
      ? `${rows.length} of ${all.length} ${escape(g.unit)}`
      : `${rows.length} ${escape(g.unit)}`;
    const shown = rows.slice(0, 200);
    return `<tr class="rc-grouprow rc-tone-${g.tone}"><td colspan="4">
        <span class="rc-g-title">${escape(g.title)}</span>
        <span class="rc-count">${countLabel}</span></td></tr>`
      + `<tr class="rc-colhead"><th class="rc-c-app">Your merchant list</th><th class="rc-c-file">In this file</th>`
      + `<th class="rc-c-why">What it means</th><th class="rc-c-why">Adjust</th></tr>`
      + shown.map(r => `<tr>
          <td class="rc-c-app">${r.app || '<span class="ct-empty">–</span>'}</td>
          <td class="rc-c-file">${r.file || '<span class="ct-empty">–</span>'}</td>
          <td class="rc-c-why">${r.why}</td>
          <td class="rc-c-why">${r.act || '<span class="muted">—</span>'}</td>
        </tr>`).join('')
      + (rows.length > shown.length
          ? `<tr><td colspan="4" class="muted">…and ${rows.length - shown.length} more</td></tr>` : '');
  }).join('');
  if (!body) {
    return q
      ? `<p class="muted">Nothing left matching “${escape(String(filter).trim())}”.</p>`
      : '<p class="muted">Nothing differs — this file matches your merchant list.</p>';
  }
  return `<div class="rc-wrap"><table class="ts rc-table"><tbody>${body}</tbody></table></div>`;
}




// Redraw the table from the CURRENT state of your merchant list (2026-09-29).
//
// A finished row leaves the table, because the differences are recomputed rather than annotated:
// once a merchant exists, `diffWeeklyRows` no longer calls it new; once its fields match, it is
// no longer changed; once a merchant is repointed, it is no longer moved. Marking rows "✓ done" and
// leaving them meant the counts above them slowly stopped meaning anything.
//
// Cheap enough to run after every single action — it is one pass over data already in memory,
// plus the registry, which is cached.
async function refreshUploadTable(note) {
  const { parsed, machines, roster } = UPLOAD_STATE;
  const out = document.getElementById('up-out');
  if (!out) return;
  const join = joinUploadFiles(roster, machines);
  const misses = machines
    ? matchMachineStores(machines.byStore, await loadRegistry(), roster, CONTRACTS) : null;
  const diff = parsed ? diffWeeklyRows(parsed, CONTRACTS) : null;
  UPLOAD_STATE = { ...UPLOAD_STATE, diff, misses, join };
  const filter = document.getElementById('up-filter')?.value || '';
  out.innerHTML = uploadTableHtml(diff, misses, machines, join, filter);
  const done = document.getElementById('up-done');
  if (done && note) done.textContent = note;
}

// Everything about ONE merchant that lives outside its contract row: its merchants in the store
// index, and its machine counts. Called by the row actions, so adding or updating a merchant
// brings its merchants with it — there is no bulk step doing this behind your back.
const broughtText = b => !b.shops ? ''
  : ` · ${b.shops} merchant${b.shops === 1 ? '' : 's'}${b.machines ? `, ${b.machines} machine${b.machines === 1 ? '' : 's'}` : ''}`;

async function applyShopsForBrand(brand, contractId) {
  const { roster, machines } = UPLOAD_STATE;
  const key = v => String(v ?? '').toLowerCase().trim();
  const want = key(brand);
  const shops = ((roster && roster.merchants) || [])
    .filter(r => key(r.partnerName) === want)
    .map(r => ({ name: r.name, contractId, machineModel: r.model || null,
                 externalId: r.externalId || null }));
  if (!shops.length) return { shops: 0, machines: 0 };

  try { await api('/registry', { method: 'POST', body: JSON.stringify({ shops }) }); }
  catch (e) { console.warn('registry not updated for', brand, e); }

  // Machine counts, summed over this merchant's own merchants — merchant INFORMATION, owned by the
  // file, so it follows the file rather than needing a decision of its own.
  let counted = 0;
  if (machines && machines.byStore instanceof Map) {
    const units = {};
    const lower = new Map([...machines.byStore.entries()].map(([k2, v]) => [key(k2), v]));
    for (const shop of shops) {
      // `.counts` since 2026-10-01 — the entry also carries state and binding now.
      for (const [model, n] of Object.entries((lower.get(key(shop.name)) || {}).counts || {})) {
        units[model] = (units[model] || 0) + n; counted += n;
      }
    }
    if (counted) {
      const total = Object.values(units).reduce((a, b) => a + b, 0);
      try {
        await api('/contracts/' + encodeURIComponent(contractId), {
          method: 'PUT', body: JSON.stringify({ units, installedUnits: total }) });
        const c = CONTRACTS.find(x => x.contractId === contractId);
        if (c) { c.units = units; c.installedUnits = total; }
      } catch (e) { console.warn('machine counts not applied for', brand, e); }
    }
  }
  return { shops: shops.length, machines: counted };
}


// Does your list already hold this merchant under a slightly different name? (2026-09-29)
//
// `diffWeeklyRows` matches on the exact name, so "EBISU Shoten Silom" was offered as a brand-new
// merchant while "EBISU SHOTEN" sat in the list already — and adding it would have produced two
// merchants for one merchant, with the terms on the wrong one. Reconcile's classifier knew how to
// spot this; removing that screen from the nav lost it, so the check lives here now.
//
// A candidate is never applied automatically. On live data a top-1 name match is wrong at least
// three times in five (§1o) — `Central` is a chain, `DINK`/`DRINK` is a typo. It is a question
// the page asks, never an answer it acts on.
function similarExistingMerchants(name) {
  const t = String(name || '').trim();
  if (!t) return [];
  const k = reconcileKey(t);
  const out = [];
  for (const c of CONTRACTS || []) {
    if (c.archived) continue;
    const ck = reconcileKey(c.merchantName || '');
    if (!ck || ck === k) continue;
    // Either one name contains the other — the branch-suffix case — or the strings are close.
    const contains = ck.startsWith(k + ' ') || k.startsWith(ck + ' ') || ck === k;
    const score = contains ? 1 : similarity(t, c.merchantName || '');
    if (contains || score >= 0.82) out.push({ contract: c, score });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 3);
}



// The files one send carries: the template's own, fetched ONCE for the whole batch, plus this
// send's. Shared by the typed path and the send-to-all path so the two cannot differ about what
// is attached or how big it may be. Returns null when something went wrong — the caller stops.
async function collectAttachments(template, chosen, btn, err) {
  const files = [];
  if (template.attachmentKey) {
    try {
      btn.textContent = 'Fetching the attachment…';
      const f = await api(`/mail-templates/${encodeURIComponent(template.id)}/attachment`);
      const bin = atob(f.data);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      files.push({ bytes, filename: f.name, type: f.type });
    } catch (e) {
      // Better to send nothing than a letter whose attachment silently went missing.
      err.hidden = false;
      err.textContent = `Could not fetch ${template.attachmentName}: ${e.message}. Nothing was sent.`;
      return null;
    }
  }
  if (chosen.length) {
    try {
      btn.textContent = 'Reading the files…';
      for (const f of chosen) {
        files.push({ bytes: new Uint8Array(await f.arrayBuffer()), filename: f.name,
                     type: f.type || 'application/octet-stream' });
      }
    } catch (e) {
      err.hidden = false;
      err.textContent = `Could not read the attached files: ${e.message}. Nothing was sent.`;
      return null;
    }
  }
  return files;
}

// Every merchant a period PAID, with its finance address and its share — and one send (2026-09-30).
//
// §1q said "no bulk send — one merchant at a time, deliberately". That is reversed here, at the
// user's request, for the payment schedule: it is the same letter to everyone, personalised only
// by the figures, and doing it 120 times by hand is how a month gets skipped. What that decision
// bought is kept in other form: the confirmation states the count AND the total about to be
// quoted, a failure stops the batch rather than ploughing on, and EVERY send is recorded.
//
// Pure: takes a run and the contracts, returns the three groups. No DOM, no fetch.
function schedulePlan(run, sentLog) {
  const sent = new Map((sentLog || []).map(m => [m.contractId, m]));
  const ready = [], already = [], noFinance = [], noShare = [];
  for (const r of (run?.results || []).slice().sort((a, b) => (b.payout || 0) - (a.payout || 0))) {
    // ONLY merchants with a share this month (user, 2026-09-30). A run's results can carry a
    // merchant that earned nothing — telling it a payment is on the way would be wrong.
    if (!(Number(r.payout) > 0)) { noShare.push(r); continue; }
    const to = mailRecipients(r.contractId);
    if (sent.has(r.contractId)) already.push({ ...r, to, sentAt: sent.get(r.contractId).sentAt });
    else if (to.length) ready.push({ ...r, to });
    else noFinance.push({ ...r, to: [], fallback: fallbackContact(r.contractId) });
  }
  return { ready, already, noFinance, noShare,
           total: ready.reduce((a, r) => a + (Number(r.payout) || 0), 0) };
}

async function drawSchedulePaidList(host, template, period) {
  const box = host.querySelector('#mmsg-paid');
  box.innerHTML = '<p class="muted">Loading the period…</p>';
  const runs = await api('/bulk-runs').catch(() => []);
  // `periodMonth`, NOT `periodTag` — the tag is '2026_09' with an underscore (it names files),
  // while <input type="month"> gives '2026-09'. They never matched, so a period that HAD a run
  // was reported as having none.
  const run0 = (runs || []).find(r => periodMonth(r.periodStart) === period);
  if (!run0) {
    box.innerHTML = `<p class="rc-warn">No run has been computed for <strong>${escape(period)}</strong>,
      so there are no share amounts to send. Compute the run first, or choose another period.</p>`;
    return null;
  }
  const [run, log] = await Promise.all([
    api('/bulk-runs/' + encodeURIComponent(run0.runId)),
    api(`/bulk-runs/${encodeURIComponent(run0.runId)}/mail-log`).catch(() => []),
  ]);
  // Only this template's own sends count as "already done" — a statement sent from the run page
  // is a different letter and must not hide a schedule that has not gone.
  const mine = (log || []).filter(m => m.templateId === template.id);
  const plan = schedulePlan(run, mine);
  const ccy = (run.results || [])[0]?.currency || CCY;

  const rows = (list, extra) => list.map(r => `<tr>
      <td>${escape(r.merchantName)}</td>
      <td>${r.to.length ? escape(r.to.join(', ')) : '<span class="rc-warn">no finance email</span>'}</td>
      <td class="muted">${extra(r)}</td>
    </tr>`).join('');

  box.innerHTML = `
    <div class="up-sum" style="margin:0 0 12px;">
      <div class="up-sum-row"><strong>${plan.ready.length}</strong> merchant(s) to notify —
        those with a share in ${escape(period)}
        ${plan.already.length ? `<span class="muted">· ${plan.already.length} already sent</span>` : ''}
        ${plan.noFinance.length ? `<span class="rc-warn">· ${plan.noFinance.length} with no finance email</span>` : ''}
        ${plan.noShare.length ? `<span class="muted">· ${plan.noShare.length} with no share this month, not written to</span>` : ''}</div>
      <div class="up-sum-row muted">This is a NOTICE — the figures are in the file attached to the
        template, not in the wording. Each merchant is written to on its own, so nobody sees the
        others.</div>
    </div>
    <div class="msend-scroll">
      <table class="ts"><thead><tr><th>Merchant</th><th>Finance email</th><th></th></tr></thead>
        <tbody>
          ${rows(plan.ready, () => '')}
          ${rows(plan.already, r => `sent ${escape(new Date(r.sentAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }))}`)}
          ${rows(plan.noFinance, r => r.fallback.length
              ? `only a contact address on file: ${escape(r.fallback.join(', '))}` : 'no address at all')}
        </tbody></table>
    </div>`;
  return { run, plan, ccy };
}

// Bring ONE merchant from the file into the list, terms and all (2026-09-29).
//
// The two categories stay separate here, visibly: everything the FILE says is shown as fact and
// cannot be typed over, and everything below it — contract, finance, share terms — is the one
// data set you maintain. Nothing is created until Save, so closing this leaves the list exactly
// as it was.
async function openAddFromFile(name, btn, onSaved) {
  if (!can('manageMerchants')) { alert('You do not have permission to add merchants.'); return; }
  const { parsed, diff } = UPLOAD_STATE;
  let row = (diff?.added || []).find(a => a.name === name);

  // WITHOUT A LOADED FILE, FALL BACK TO THE STORED ONE (2026-10-01). The Mismatch tabs read the
  // file on record, not one in this browser — so this used to `return` on a missing row and the
  // button did nothing at all, silently, leaving the brand sitting in the tab. The brand, its
  // merchant count and its machines are all on record; only the extra columns of a live upload
  // (type, contact, phone, sales person) are not, and those are typed in the dialog anyway.
  const stored = (ROSTER_BRANDS.brands || {})[String(name || '').trim().toLowerCase()];
  if (!row) {
    if (!stored) {
      alert(`"${name}" is not in the file on record. Re-check the page, or upload the file again.`);
      return;
    }
    row = { name: stored.label || name, vals: {} };
  }
  // The merchant count travels beside the row, not inside it.
  const idx = parsed ? parsed.rows.findIndex(r => String(r[parsed.fields.indexOf('Merchant/Brand')] ?? '').trim() === name) : -1;
  const branchCount = idx >= 0 ? (parsed.branchCounts?.[idx] ?? null)
                     : (stored ? stored.branches : null);

  const { card, close } = ctModal(760);
  const cols = CONTRACT_GRID_COLUMNS.filter(c =>
    (c.group === 'contract' || c.group === 'finance') && c.key !== 'counterParty'
    && c.type !== 'computed' && !(c.type || '').startsWith('term-'));
  const field = (col) => {
    if (col.type === 'date')   return `<label><span>${escape(col.label)}</span><input type="date" data-k="${col.key}"></label>`;
    if (col.type === 'number') return `<label><span>${escape(col.label)}</span><input type="number" data-k="${col.key}"></label>`;
    if (col.type === 'select') {
      const opts = col.key === 'autoRenewal' ? ['', 'Yes', 'No'] : ['', ...MERCHANT_TYPES];
      return `<label><span>${escape(col.label)}</span><select data-k="${col.key}">${opts.map(o =>
        `<option value="${escape(o)}">${escape(o || '—')}</option>`).join('')}</select></label>`;
    }
    return `<label><span>${escape(col.label)}</span><input type="text" data-k="${col.key}"></label>`;
  };
  const facts = Object.entries(row.vals || {}).filter(([k]) => k !== 'Merchant/Brand');

  // Your list may already hold this merchant under a slightly different name. Say so HERE,
  // where the second one would be created, not only on the row behind this dialog.
  const near = similarExistingMerchants(name);
  const suggestedEntity = near.map(n => n.contract.entityId).find(Boolean) || null;

  card.innerHTML = `
    <h3 style="margin:0 0 4px;">Add ${escape(name)}</h3>
    <p class="muted" style="margin:0 0 14px;font-size:12.5px;">
      Nothing is created until you save.</p>
    ${!near.length ? '' : `<div class="up-held" style="border-left-color:var(--warn,#e67700);margin-bottom:14px;">
      <span>Your merchant list already has
        ${near.map(n => `<strong>${escape(n.contract.merchantName)}</strong>`).join(' and ')}.
        If this is the same merchant, <strong>close this and update that one instead</strong> —
        adding it here creates a second merchant, and its terms would live on only one of them.</span>
    </div>`}

    <h4 class="ct-ed-h">From your file — not editable</h4>
    <div class="up-sum" style="margin:0 0 4px;">
      <div class="up-sum-row"><strong>${escape(name)}</strong>${branchCount != null
        ? ` <span class="muted">· ${branchCount} merchant${branchCount === 1 ? '' : 's'}</span>` : ''}</div>
      ${facts.length ? facts.map(([k, v]) =>
        `<div class="up-sum-row muted">${escape(k)}: ${escape(v)}</div>`).join('')
        : '<div class="up-sum-row muted">No other details in the file.</div>'}
    </div>

    <h4 class="ct-ed-h">Contract</h4>
    <div class="mail-form">
      ${entityPickerHtml('af-entity', suggestedEntity)}
      ${!suggestedEntity ? '' : `<p class="mail-hint" style="margin:-8px 0 12px;">Taken from
        <strong>${escape((near.find(n => n.contract.entityId) || {}).contract.merchantName)}</strong>,
        which looks like the same merchant. Clear it if that is wrong.</p>`}
      ${cols.filter(c => c.group === 'contract').map(field).join('')}
    </div>

    <h4 class="ct-ed-h">Finance</h4>
    <div class="mail-form">${cols.filter(c => c.group === 'finance').map(field).join('')}</div>

    <h4 class="ct-ed-h">Share terms</h4>
    <div style="display:flex;gap:16px;align-items:flex-start;margin-bottom:12px;flex-wrap:wrap;">
      <label style="font-size:12.5px;color:var(--ink-soft);">Aggregation
        <select id="af-agg" class="input" style="min-width:230px;display:block;margin-top:4px;">
          <option value="whole">Whole — one calculation across all merchants</option>
          <option value="per_store">Per merchant — calculate each merchant separately</option>
        </select></label>
      <label class="nopay-toggle" style="display:flex;gap:8px;align-items:center;font-size:13px;margin-top:22px;">
        <input type="checkbox" id="af-nopay"> No revenue share — not paid</label>
    </div>
    <div id="af-rule"></div>

    <p class="nm-err" id="af-err" hidden></p>
    <div class="mail-actions">
      <button id="af-cancel" class="btn-ghost">Cancel</button>
      <button id="af-save" class="btn-primary">Save — add to merchant list</button>
    </div>`;

  const ruleBox = card.querySelector('#af-rule');
  const editor = renderStructuredRuleEditor(ruleBox, null, MACHINE_MODELS_CACHE, { readOnly: false });
  const nopay = card.querySelector('#af-nopay');
  const dim = () => { ruleBox.style.opacity = nopay.checked ? '.45' : '1'; ruleBox.style.pointerEvents = nopay.checked ? 'none' : ''; };
  nopay.addEventListener('change', dim); dim();
  card.querySelector('#af-cancel').addEventListener('click', close);

  card.querySelector('#af-save').addEventListener('click', async () => {
    const save = card.querySelector('#af-save'), err = card.querySelector('#af-err');
    save.disabled = true; err.hidden = true;
    try {
      let rule = null;
      if (!nopay.checked) {
        try { rule = editor.getRule(); } catch (e) { throw new Error('Invalid terms: ' + e.message); }
      }
      // The file's own columns, mapped through the same table the weekly diff uses — so what is
      // created here is exactly what an import would have created, plus the terms you just set.
      const body = { merchantName: name };
      for (const [label, v] of Object.entries(row.vals || {})) {
        const key = WEEKLY_FIELD_KEY[label];
        if (key && key !== 'merchantName') body[key] = v;
      }
      if (branchCount != null) body.branchCount = branchCount;
      card.querySelectorAll('[data-k]').forEach(el => {
        const raw = String(el.value || '').trim();
        if (raw) body[el.dataset.k] = el.type === 'number' ? Number(raw) : raw;
      });
      const entityId = await resolveEntityInput(card.querySelector('#af-entity').value);
      if (entityId) body.entityId = entityId;
      body.aggregationMode = card.querySelector('#af-agg').value;
      body.noPayout = nopay.checked;
      if (rule) body.rule = rule;

      const created = await api('/contracts', { method: 'POST', body: JSON.stringify(body) });
      CONTRACTS.push(created);
      // Its merchants and its machines come with it — that is what the bulk Import used to do for
      // every merchant at once, now done for the one you chose.
      const brought = await applyShopsForBrand(name, created.contractId);
      close();
      // The Mismatch tabs have no loaded file to refresh, so they say so themselves.
      if (onSaved) await onSaved(`✓ Added ${name}${broughtText(brought)}`);
      else await refreshUploadTable(`✓ Added ${name}${broughtText(brought)}`);
    } catch (e) {
      save.disabled = false; err.hidden = false; err.textContent = e.message;
    }
  });
}


// Apply ONE merchant's differences, exactly the ones the row states (2026-09-29).
//
// This is the only place in the app that writes merchant INFORMATION, and it is safe to do so
// because those columns are the file's to own: brand, type, merchant count, contacts, sales
// person. It cannot reach contract dates, the contract entity, finance details or share terms —
// the weekly file carries no such columns, and the body is built from the row's own diff list,
// so what is written is precisely what the row said would be written.
// Applies every CHANGED row the loaded file carries — the same fields the per-row button writes.
// The file is the record (user, 2026-10-01: "just update... you don't have to ask me to initiate
// it"), so a page of buttons for differences the file has already settled is work the app does.
//
// `merchantName` is never written: it is the key the row was matched on, not a change.
async function applyFileChanges() {
  if (!can('manageMerchants')) return null;
  // NEVER APPLY A FILE OLDER THAN THE ONE ALREADY RECORDED. The browser holds the last file
  // someone loaded here, which can be days behind what a colleague has since uploaded — on
  // 2026-10-01 the held pair was 29 Sept while the server's roster was that morning's. Writing
  // the older file's numbers would undo the newer upload without a word, which is the exact
  // shape of "an improvement overwrote existing data".
  if (fileIsStale()) return { done: 0, failed: [], stale: true };
  const rows = (UPLOAD_STATE.diff?.changed || []);
  if (!rows.length) return null;
  let done = 0; const failed = [];
  for (const row of rows) {
    const c = CONTRACTS.find(x => !x.archived
      && String(x.merchantName || '').toLowerCase().trim() === String(row.name).toLowerCase().trim());
    if (!c) continue;
    const body = {};
    for (const d of row.diffs || []) {
      const key = WEEKLY_FIELD_KEY[d.field];
      if (!key || key === 'merchantName') continue;
      body[key] = key === 'branchCount' ? (Number(d.to) || 0) : d.to;
    }
    if (!Object.keys(body).length) continue;
    try {
      const saved = await api('/contracts/' + encodeURIComponent(c.contractId), {
        method: 'PUT', body: JSON.stringify(body) });
      Object.assign(c, saved || body);
      await applyShopsForBrand(row.name, c.contractId).catch(() => null);
      done++;
    } catch (e) { failed.push(`${row.name}: ${e.message}`); }
  }
  return { done, failed };
}

async function updateFromFile(name, btn) {
  if (fileIsStale()) {
    alert(`This file is older than the one already recorded (${rosterDateLabel()}).\n\n`
      + `Applying it would undo the newer upload. Load the latest file instead.`);
    return;
  }
  const { diff } = UPLOAD_STATE;
  const row = (diff?.changed || []).find(c => c.name === name);
  if (!row) return;
  if (!can('manageMerchants')) { alert('You do not have permission to change merchants.'); return; }
  const c = CONTRACTS.find(x => !x.archived
    && String(x.merchantName || '').toLowerCase().trim() === name.toLowerCase().trim());
  if (!c) { alert('That merchant is no longer in your list.'); return; }

  const body = {};
  for (const d of row.diffs || []) {
    const key = WEEKLY_FIELD_KEY[d.field];
    if (!key || key === 'merchantName') continue;      // the name is the match key, never a change
    body[key] = key === 'branchCount' ? (Number(d.to) || 0) : d.to;
  }
  if (!Object.keys(body).length) return;

  const was = btn.textContent;
  btn.disabled = true; btn.textContent = 'Updating…';
  try {
    const saved = await api('/contracts/' + encodeURIComponent(c.contractId), {
      method: 'PUT', body: JSON.stringify(body) });
    Object.assign(c, saved || body);
    const brought = await applyShopsForBrand(name, c.contractId);
    await refreshUploadTable(`✓ Updated ${name}${broughtText(brought)}`);
  } catch (e) {
    btn.disabled = false; btn.textContent = was;
    alert('Could not update: ' + e.message);
  }
}


// A merchant your file no longer mentions. The row says what is actually at stake, because
// "not in this file" covers two very different situations: a contract that genuinely ended, and
// a merchant that is simply absent from one week's export.
function uploadMissingWhy(m) {
  const bits = ['Nothing has been deleted — an import never removes a merchant.'];
  if (!ruleIsAbsent(m.rule) || m.noPayout) bits.push('It has revenue-share terms set.');
  if (m.endDate) bits.push(`Contract end: <strong>${escape(m.endDate)}</strong>.`);
  if (m.branchCount) bits.push(`${m.branchCount} merchant${m.branchCount === 1 ? '' : 's'} recorded.`);
  return bits.join(' ');
}

// Archive — the soft exit. The row, its terms and its store links all stay; it simply stops
// being paid, and `payoutDecision` skips it before it looks at any rule. Reversible from the
// Archived screen.
async function archiveFromUpload(contractId, btn) {
  const c = CONTRACTS.find(x => x.contractId === contractId);
  if (!c) { alert('That merchant is no longer in your list.'); return; }
  if (!can('manageMerchants')) { alert('You do not have permission to archive merchants.'); return; }
  if (!confirm(`Archive "${c.merchantName}"?\n\nIt stops being paid from the next run. Its terms, `
    + `its history and every run that already paid it are kept, and you can unarchive it from `
    + `the Archived screen.`)) return;
  const was = btn.textContent;
  btn.disabled = true; btn.textContent = 'Archiving…';
  try {
    const saved = await api('/contracts/' + encodeURIComponent(contractId), {
      method: 'PUT', body: JSON.stringify({ archived: true }) });
    Object.assign(c, saved || { archived: true });
    await refreshUploadTable(`✓ Archived ${c.merchantName}`);
  } catch (e) {
    btn.disabled = false; btn.textContent = was;
    alert('Could not archive: ' + e.message);
  }
}

// Unarchive — the brand already exists, so this brings it back rather than creating a second one.
// It says whether terms come back with it, because that is the whole reason not to re-add it.
async function unarchiveFromUpload(contractId, btn) {
  const c = CONTRACTS.find(x => x.contractId === contractId);
  if (!c) { alert('That brand is no longer in your list.'); return; }
  if (!can('manageMerchants')) { alert('You do not have permission to change merchants.'); return; }
  const hasTerms = !!(c.rule && ruleHasValue(c.rule));
  if (!confirm(`Unarchive "${c.merchantName}"?\n\n`
    + `It is paid again from the next run. ${hasTerms
        ? 'Its existing share terms come back with it.'
        : 'It carries no share terms, so set them before the next run.'}`
    + `${c.noPayout ? '\n\nIt is also marked "no revenue share", so it still would not be paid '
        + 'until you clear that in Edit terms.' : ''}`)) return;
  const was = btn.textContent;
  btn.disabled = true; btn.textContent = 'Unarchiving…';
  try {
    const saved = await api('/contracts/' + encodeURIComponent(contractId), {
      method: 'PUT', body: JSON.stringify({ archived: false }) });
    Object.assign(c, saved || { archived: false });
    delete c.archivedAt;
  } catch (e) {
    btn.disabled = false; btn.textContent = was;
    alert('Could not unarchive: ' + e.message);
  }
}

// Delete — permanent, and says exactly what goes with it. A merchant carrying terms is the
// costly case: those terms exist nowhere else, and a past run keeps its own frozen snapshot but
// nothing can recreate the row.
async function deleteFromUpload(contractId, btn) {
  const c = CONTRACTS.find(x => x.contractId === contractId);
  if (!c) { alert('That merchant is no longer in your list.'); return; }
  if (!can('manageMerchants')) { alert('You do not have permission to delete merchants.'); return; }
  const hasTerms = !ruleIsAbsent(c.rule) || c.noPayout;
  if (!confirm(`Delete "${c.merchantName}" permanently?\n\n`
    + (hasTerms ? 'This also deletes its revenue-share terms, which exist nowhere else.\n\n' : '')
    + 'This cannot be undone. Archive keeps the row and simply stops paying it.')) return;
  const was = btn.textContent;
  btn.disabled = true; btn.textContent = 'Deleting…';
  try {
    await api('/contracts/' + encodeURIComponent(contractId), { method: 'DELETE' });
    const gone = c.merchantName;
    CONTRACTS = CONTRACTS.filter(x => x.contractId !== contractId);
    await refreshUploadTable(`✓ Deleted ${gone}`);
  } catch (e) {
    btn.disabled = false; btn.textContent = was;
    alert('Could not delete: ' + e.message);
  }
}



// Why a merchant could not be placed — and crucially, whether the merchant FILE knows it. Three
// different answers needing three different responses:
//   • the file names a brand you do not carry  -> add that merchant, and the merchant places itself
//   • the file does not mention the merchant        -> it is not on this week's list at all
//   • in the registry but linked to nobody      -> rentals here are paid to no one
function machineMissWhy(x, machines, kind, archivedBrands) {
  const head = machineCountText(x, machines);
  const archived = archivedBrands && x.fileBrand
    ? archivedBrands.get(String(x.fileBrand).toLowerCase().trim()) : null;
  if (archived) {
    return `${head} Your file says this merchant belongs to <strong>${escape(archived)}</strong>, `
      + `which IS in your list but is <strong>archived</strong> — an archived merchant is not paid, `
      + `so its merchants are not placed. Unarchive it from the Archived screen if it is trading again.`;
  }
  if (x.fileBrand) {
    return `${head} Your file says this merchant belongs to `
      + `<strong>${escape(x.fileBrand)}</strong>, but there is no merchant of that name in your `
      + `list — add it above and this merchant places itself.`;
  }
  if (kind === 'unlinked') {
    return `${head} The merchant IS in the registry, but its row carries no brand — its rentals `
      + `are not paid to anybody. Your merchant file does not name it either.`;
  }
  return `${head} Neither your file nor the registry mentions this merchant. `
    + `A run will not fix it — runs are left exactly as they were computed. Add the merchant to your `
    + `merchant file, or accept that these machines belong to nobody this week.`;
}



// Repoint a merchant at the merchant its file says it belongs to (2026-09-29).
//
// The file already wins for THIS upload's machine counts — the matcher sees to that. What it
// cannot do is change the merchant itself: the registry row still names the old merchant, so the
// Assign button, the next machine-list upload and anything else reading the registry keep
// following a link the file has already contradicted. This makes the move real.
//
// Every registry row for that merchant name is updated, not just the first: a store routinely has
// several rows (§1c), and leaving siblings pointing at the old merchant is how a merchant comes to
// answer two ways at once — the exact fault that made Mixue look like it had moved.
async function repointStoreFromFile(store, brand, btn, onDone) {
  if (!can('manageMerchants')) { alert('You do not have permission to change the registry.'); return; }
  const target = CONTRACTS.find(c => !c.archived
    && String(c.merchantName || '').toLowerCase().trim() === String(brand || '').toLowerCase().trim());
  if (!target) { alert(`There is no merchant called "${brand}" in your list yet. Add it first — the merchant can then point at it.`); return; }

  const registry = await loadRegistry().catch(() => null);
  if (!registry) { alert('Could not read the registry.'); return; }
  const k = String(store || '').toLowerCase().trim();
  const rows = registry.filter(r => String(r.name || '').toLowerCase().trim() === k);
  if (!rows.length) { alert('That merchant is no longer in the registry.'); return; }
  const moving = rows.filter(r => r.contractId !== target.contractId);
  if (!moving.length) { await refreshUploadTable(`${store} already points at ${target.merchantName}`); return; }

  if (!confirm(`Point "${store}" at ${target.merchantName}?\n\n`
    + `${moving.length} registry row(s) change. Nothing else about the merchant is touched, and `
    + `no past run is altered — runs keep the figures they were computed with.`)) return;

  const was = btn.textContent;
  btn.disabled = true; btn.textContent = 'Updating…';
  try {
    for (const r of moving) {
      // contractId ONLY. The route merges over the stored row, so every other field — the store's
      // name, its externalId, its machine model — is carried through untouched.
      await api('/merchants/' + encodeURIComponent(r.merchantId), {
        method: 'PUT', body: JSON.stringify({ contractId: target.contractId }) });
      r.contractId = target.contractId;
    }
    REGISTRY_CACHE = null;                    // it was just changed underneath us
    // The Mismatch tab has no loaded file, so it cannot refresh the upload table — it repaints
    // itself instead. Default stays the upload flow's own behaviour.
    if (onDone) await onDone(`✓ ${store} now under ${target.merchantName}`);
    else await refreshUploadTable(`✓ ${store} now under ${target.merchantName}`);
  } catch (e) {
    btn.disabled = false; btn.textContent = was;
    alert('Could not update the registry: ' + e.message);
  }
}

// STEP 1 of the upload: join the two files to each other (2026-09-29).
//
// The merchant file gives store -> brand. The machine file gives store -> machines. Joined on the
// merchant name they make ONE merchant-information set — brand, merchants, machines — which is the
// week you are holding. Only then is that set mapped against the app (step 2).
//
// The join is also where the first real mismatch lives, and it was missing: a merchant in one file
// and not the other. Machines whose store the merchant file never names cannot be attributed to
// anybody, and a merchant the merchant file lists with no machines recorded is worth knowing about
// too. Neither is visible once the two are merged, so both are reported here.
//
// Pure: no globals, no fetch. Both files in, one set and its gaps out.
function joinUploadFiles(roster, machines) {
  const key = v => String(v ?? '').toLowerCase().trim();
  const byStore = machines && machines.byStore instanceof Map ? machines.byStore : new Map();

  // The merchant file's own view: store -> brand. APPROVED ROWS ONLY — `parseMerchantList`
  // filters on the review state, which is correct for a payout but means the join must also
  // know about the rows it dropped, or a merchant your file plainly lists is reported as absent
  // from it. Live case: "Kliff Beach Bistro & Bar" was in the file, not Approved, and the page
  // said the file did not list it.
  const brandOf = new Map();
  // A row with a name but NO `Merchant label` used to be skipped entirely, so a merchant your file
  // plainly lists read as absent from it. It is kept, with an empty brand, and reported as its
  // own thing — the fix is to give it a label, not to add a merchant.
  const noLabel = new Map();
  for (const r of (roster && roster.merchants) || []) {
    const k = key(r.name);
    if (!k) continue;
    const brand = String(r.partnerName ?? '').trim();
    if (brand) { if (!brandOf.has(k)) brandOf.set(k, { store: String(r.name).trim(), brand }); }
    else if (!noLabel.has(k)) noLabel.set(k, { store: String(r.name).trim() });
  }
  // In the file, but held back by its review state.
  const heldBack = new Map();
  for (const r of (roster && roster.excluded) || []) {
    const k = key(r.name);
    if (k && !brandOf.has(k) && !heldBack.has(k)) {
      heldBack.set(k, { store: String(r.name).trim(), brand: String(r.label ?? '').trim(),
                        reviewState: String(r.reviewState ?? '').trim() || 'Not approved' });
    }
  }

  // The machine file's own view: store -> counts.
  const machinesOf = new Map();
  for (const [store, entry] of byStore) {
    const k = key(store);
    if (!k) continue;
    const counts = (entry && entry.counts) || {};
    const n = Object.values(counts).reduce((a, b) => a + b, 0);
    machinesOf.set(k, { store, counts: counts || {}, machines: n });
  }

  const stores = new Map();
  const onlyInMerchantFile = [], onlyInMachineFile = [];
  for (const [k, m] of brandOf) {
    const mc = machinesOf.get(k);
    if (mc) stores.set(k, { store: m.store, brand: m.brand, machines: mc.machines, counts: mc.counts });
    else { stores.set(k, { store: m.store, brand: m.brand, machines: 0, counts: {} });
           onlyInMerchantFile.push({ store: m.store, brand: m.brand }); }
  }
  const notApproved = [], noLabelShops = [];
  for (const [k, mc] of machinesOf) {
    if (brandOf.has(k)) continue;
    if (noLabel.has(k)) {
      noLabelShops.push({ store: mc.store, machines: mc.machines, counts: mc.counts });
      continue;
    }
    const held = heldBack.get(k);
    if (held) {
      // The file DOES list it. A different fix from "nobody has heard of this merchant": approve it
      // on the platform, or accept that it is deliberately not being paid.
      notApproved.push({ store: mc.store, machines: mc.machines, counts: mc.counts,
                         brand: held.brand, reviewState: held.reviewState });
      continue;
    }
    onlyInMachineFile.push({ store: mc.store, machines: mc.machines, counts: mc.counts });
  }

  // The merchant-information set the app is then compared against: one entry per brand.
  const brands = new Map();
  for (const v of stores.values()) {
    const bk = key(v.brand);
    const acc = brands.get(bk) || { brand: v.brand, stores: 0, machines: 0, counts: {} };
    acc.stores++; acc.machines += v.machines;
    for (const [model, c] of Object.entries(v.counts)) acc.counts[model] = (acc.counts[model] || 0) + c;
    brands.set(bk, acc);
  }
  // Every merchant name the merchant file carries, whatever state it is in — so the page can tell
  // you the CLOSE name it found rather than claiming the file does not list a merchant at all. The
  // two files name the store in different columns ('merchant name.' vs 'Business name'), so a
  // near-miss is ordinary, not exceptional.
  const fileStoreNames = [...new Set([
    ...[...brandOf.values()].map(v => v.store),
    ...[...heldBack.values()].map(v => v.store),
    ...[...noLabel.values()].map(v => v.store),
  ])];
  return { stores, brands, onlyInMerchantFile, onlyInMachineFile, notApproved,
           noLabelShops, fileStoreNames,
           bothFiles: (brandOf.size + heldBack.size + noLabel.size) > 0 && machinesOf.size > 0 };
}


// The nearest merchant name the merchant FILE carries, when the machine list's spelling does not
// match it exactly. The two exports name the store in different columns — `merchant name.` and
// `Business name` — so differing spellings are ordinary and worth showing rather than reporting
// the merchant as absent from a file that lists it.
function closestFileStore(store, join) {
  const names = (join && join.fileStoreNames) || [];
  if (!names.length) return null;
  let best = null, bestScore = 0;
  for (const n of names) {
    const sc = similarity(store, n);
    if (sc > bestScore) { bestScore = sc; best = n; }
  }
  return bestScore >= 0.72 ? best : null;
}

// What is actually at this store, so the row can be found in the machine list you just uploaded.
// The models matter as much as the count — "S8 x2" is the line to look for.
function machineCountText(miss, machines) {
  const n = Number(miss.machines) || 0;
  const entry = machines?.byStore instanceof Map ? machines.byStore.get(miss.store) : null;
  const counts = entry && entry.counts;
  const models = counts
    ? Object.entries(counts).filter(([, c]) => c > 0)
        .map(([m, c]) => `${escape(m)} ×${c}`).join(', ')
    : '';
  return `<strong>${n} machine${n === 1 ? '' : 's'}</strong>${models ? ` (${models})` : ''}.`;
}

// A new merchant is the costly mistake in this file — one wrong brand column turns 2,357 merchants
// into 2,357 merchants — so the row says what it would arrive with.
function uploadAddedWhy(a, join) {
  const vals = Object.entries(a.vals || {}).filter(([k]) => k !== 'Merchant/Brand');
  const head = vals.length
    ? 'Would be created with ' + vals.map(([k, v]) => `${escape(k)} <strong>${escape(v)}</strong>`).join(', ')
    : 'Would be created with no other details.';
  // The merchants and machines it brings with it, from the two files joined. This is why the machine
  // list no longer complains separately about those merchants — adding the merchant places them.
  // The costly mistake this file can make is a SECOND merchant for one you already have.
  const near = similarExistingMerchants(a.name);
  const warn = near.length
    ? ` <span class="rc-warn">Your list already has `
      + near.map(n => `<strong>${escape(n.contract.merchantName)}</strong>`).join(' and ')
      + ` — check this is not the same merchant before adding.</span>`
    : '';
  const b = join?.brands?.get(String(a.name ?? '').toLowerCase().trim());
  if (!b) return head + warn;
  const models = Object.entries(b.counts || {}).filter(([, c]) => c > 0)
    .map(([m, c]) => `${escape(m)} ×${c}`).join(', ');
  return `${head} Brings <strong>${b.stores} merchant${b.stores === 1 ? '' : 's'}</strong>`
    + (b.machines ? ` and ${b.machines} machine${b.machines === 1 ? '' : 's'}${models ? ` (${models})` : ''}` : ' and no machines')
    + ' from your files.' + warn;
}

function uploadChangedWhy(c) {
  return (c.diffs || []).map(d =>
    `${escape(d.field)}: <span class="muted">${escape(d.from || '—')}</span> → <strong>${escape(d.to)}</strong>`
  ).join('<br>');
}

// Remember the file (2026-09-29). NOT an import: no merchant row is created, changed or
// deleted here. Two things are recorded, and both are about the FILE rather than your list:
//
//   • the roster — the merchant rows a run reads, so Run share never asks for this file again
//   • the upload record — what the ⦿ marks on the Overview compare against
//
// It runs when the file is read, because a file you are working through IS your latest file, and
// making you press a button to say so was a second answer to a question the page already asked.
// Every change to a merchant is a row you click, one at a time.
async function rememberUploadedFile(parsed, machines, roster) {
  const out = { ok: false, error: null };
  try {
    // EITHER file is worth recording. Gating on the merchant list meant a machine-list-only
    // upload sent nothing at all: parsed, shown on screen, and dropped (2026-10-01).
    if (roster?.merchants?.length || machines?.byStore?.size) {
      const nameIdx = parsed ? parsed.fields.indexOf('Merchant/Brand') : -1;
      const names = nameIdx >= 0
        ? parsed.rows.map(r => String(r[nameIdx] ?? '').trim()).filter(Boolean) : [];
      const res = await api('/roster', { method: 'PUT', body: JSON.stringify({
        merchants: roster?.merchants || [],
        names,
        excluded: roster?.excluded || [],
        machinesAt: machines ? new Date().toISOString() : null,
        machineStoreCount: machines ? machines.byStore.size : null,
        machineCount: machines ? machines.counted : null,
        machinesUnbound: machines ? (machines.unbound || 0) : null,
        // THE MACHINE ROWS THEMSELVES. `putRosterRoute` has always accepted a `machines` array
        // and nothing ever sent one, so every upload kept the COUNT and threw the file away —
        // 2,401 merchants reduced to the number 2,401. Asked afterwards how many machines a brand
        // has, the answer could only come from the merchant grid's stored column, which is a
        // different thing from what the file said. Per merchant: the merchant name and its per-model
        // cabinet counts, which is the whole of what the file is read into. ~150 KB for 2,401
        // merchants, against a 10 MB request ceiling.
        machines: machines ? [...machines.byStore].map(([store, e]) => ({
          store, counts: e.counts, deployed: e.deployed, total: e.total, businessId: e.businessId,
        })) : [],
      }) });
      if (res?.lastUpload?.names?.length) LAST_UPLOAD = res.lastUpload;
    }
    out.ok = true;
  } catch (e) {
    out.error = e.message;
  }
  return out;
}

// ── Adding merchants ───────────────────────────────────────────────────────
// Two ways in: one at a time, or a weekly file. The batch path deliberately routes through the
// same /contracts/import the sheet used, because buildImportPlan already guarantees the thing
// that matters most here — a field the file does not mention is LEFT ALONE. So a weekly upload
// carrying only names, types and contacts can never disturb contract dates or revenue-share
// terms, no matter what a merchant already has.
//
// Columns are matched by header NAME with aliases, and the mapping is shown before anything is
// sent: a file from outside this app will not use our exact wording, and a silently mis-mapped
// column is far worse than an unrecognised one.
const WEEKLY_ALIASES = [
  // The BRAND is the merchant label — the same column a run resolves a roster row by, so a
  // merchant created here is one a run can actually find. The per-merchant name is a BRANCH of it:
  // counted, never stored as a merchant of its own. Reading the merchant name as the brand is what
  // would turn 2,357 merchants into 2,357 "merchants".
  { field: 'Merchant/Brand', names: ['merchant label', 'brand', 'merchant/brand', 'ka name', 'ka'] },
  { field: '_branch',        names: ['merchant name.', 'merchant name', 'store', 'store name', 'branch', 'ชื่อร้าน'] },
  { field: 'Type',           names: ['type', 'merchant type', 'merchant type.', 'category'] },
  // NO 'Contract entity' alias, on purpose (2026-09-18). It was the one column that both a file
  // and the app could write: an editable grid cell in the Contract group AND a recognised weekly
  // header, so a file carrying it silently won over what someone had typed. The legal entity on
  // the contract is maintained here, not in the platform export, so the app owns it outright and
  // a file mentioning it is listed as ignored rather than applied. Everything else this list
  // names is read-only in the grid — that is the rule these two halves keep:
  // a column is writable by a file, or by hand, never both. Pinned by tests/weekly-upload-ownership.test.mjs.
  { field: 'Sales person',   names: ['sales person', 'salesperson', 'sales', 'sales employee', 'person in charge', 'pic', 'owner'] },
  { field: 'Contact',        names: ['contact', 'contact person', 'contact name', 'ผู้ติดต่อ'] },
  { field: 'Phone',          names: ['phone', 'tel', 'telephone', 'contact number', 'mobile', 'เบอร์โทร'] },
  { field: 'Email',          names: ['email', 'e-mail', 'contact email'] },
  // Not imported — read only so non-Approved rows can be dropped before anything else happens.
  { field: '_review',        names: ['merchant review state', 'review state', 'status', 'approval status'] },
];
const APPROVED = /^approved$/i;
const hkey = v => String(v ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

// Find the header row rather than assuming row 1: these files usually carry a title or a blank
// line or two above the real headers.
function findHeaderRow(aoa) {
  let best = { row: -1, hits: 0, map: null };
  for (let r = 0; r < Math.min(aoa.length, 20); r++) {
    const map = {};
    let hits = 0;
    (aoa[r] || []).forEach((cell, c) => {
      const k = hkey(cell);
      if (!k) return;
      const hit = WEEKLY_ALIASES.find(a => a.names.includes(k));
      if (hit && !(hit.field in map)) { map[hit.field] = c; hits++; }
    });
    if (hits > best.hits) best = { row: r, hits, map };
  }
  return best;
}

async function parseWeeklyMerchantFile(file) {
  const wb = await readExcel(file);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, blankrows: false });
  const { row, hits, map } = findHeaderRow(aoa);
  // A file with no label column but a name column is taken at its word — the name IS the brand.
  // Said out loud in the preview, because it changes what a row means.
  let brandFromBranch = false;
  if (map && !('Merchant/Brand' in map) && ('_branch' in map)) {
    map['Merchant/Brand'] = map._branch; brandFromBranch = true;
  }
  if (!map || !('Merchant/Brand' in map)) {
    throw new Error('No merchant column found. The sheet needs a header row with "Merchant label" (the brand), or a merchant name column.');
  }
  const all = Object.keys(map);
  const nameAt = map['Merchant/Brand'];
  const reviewAt = map._review;
  const body = aoa.slice(row + 1).filter(r => String(r[nameAt] ?? '').trim());

  // Approved only. A file without a review column is taken at face value — every row counts —
  // rather than silently importing nothing.
  const kept = reviewAt == null ? body : body.filter(r => APPROVED.test(String(r[reviewAt] ?? '').trim()));
  const skippedNotApproved = body.length - kept.length;

  // `_review` and `_branch` are working columns, not fields to store.
  const fields = all.filter(f => f !== '_review' && f !== '_branch');
  const brandAt = map['Merchant/Brand'];
  const branchAt = brandFromBranch ? null : map._branch;

  // One row per BRAND. A brand appears once per branch in these files, so the rows are folded:
  // first value stated for each field wins, and the merchants are counted.
  const byBrand = new Map();
  for (const r of kept) {
    const brand = String(r[brandAt] ?? '').trim();
    if (!brand || brand === '-') continue;
    const key = brand.toLowerCase();
    if (!byBrand.has(key)) byBrand.set(key, { vals: fields.map(() => null), branches: new Set() });
    const acc = byBrand.get(key);
    fields.forEach((f, i) => { if (acc.vals[i] == null || String(acc.vals[i]).trim() === '') acc.vals[i] = r[map[f]] ?? null; });
    acc.branches.add(branchAt == null ? brand : String(r[branchAt] ?? '').trim() || brand);
  }
  const rows = [...byBrand.values()].map(a2 => a2.vals);
  const branchCounts = [...byBrand.values()].map(a2 => a2.branches.size);

  return { sheet: wb.SheetNames[0], headerRow: row + 1, hits, fields, rows, branchCounts,
           brandFromBranch, hasReviewColumn: reviewAt != null, skippedNotApproved,
           totalRows: body.length, branchRows: kept.length,
           unmapped: (aoa[row] || []).map(hkey).filter(h => h && !WEEKLY_ALIASES.some(a => a.names.includes(h))) };
}

// What would actually change, field by field, before anything is written.
//
// Only the columns the file carries are compared, and a BLANK cell counts as "not stated" —
// never as "clear this". That matches how the importer merges, so the preview cannot promise
// something different from what the import does.
// THIS MAP IS A LOOKUP KEY, NOT A LABEL (2026-10-01). `diffWeeklyRows` puts a field's name on
// each change, the preview PRINTS that name, and both the apply path and the backend importer
// read that same string back to decide which contract field to write. So the displayed wording
// IS the key: renaming the display alone makes `WEEKLY_FIELD_KEY[d.field]` undefined and the
// backend's `GRID_FIELDS` miss it — the row still appears in the preview and is then silently
// skipped by the write. Caught while renaming this column out of "Branch"; the new spelling is
// in all three places (here, the posted header, and GRID_FIELDS in code/contracts.mjs).
//
// `Merchants` is the one synthetic field, appended from `parsed.branchCounts` rather than read
// from a column — every other key here is a `WEEKLY_ALIASES` field name, which is what
// weekly-upload-ownership.test.mjs pins. An entry no alias can produce is dead weight that
// reads like a supported column.
const WEEKLY_FIELD_KEY = {
  'Merchant/Brand': 'merchantName', 'Type': 'merchantType',
  'Sales person': 'salesPerson', 'Contact': 'contactName', 'Phone': 'contactPhone', 'Email': 'contactEmail',
  'Merchants': 'branchCount',
};

function diffWeeklyRows(parsed, contracts) {
  const byName = new Map((contracts || []).map(c => [String(c.merchantName || '').toLowerCase().trim(), c]));
  const added = [], changed = [];
  let unchanged = 0;
  const nameIdx = parsed.fields.indexOf('Merchant/Brand');

  for (const row of parsed.rows) {
    const name = String(row[nameIdx] ?? '').trim();
    const existing = byName.get(name.toLowerCase());
    if (!existing) {
      const vals = {};
      parsed.fields.forEach((f, i) => { const v = String(row[i] ?? '').trim(); if (v) vals[f] = v; });
      added.push({ name, vals });
      continue;
    }
    const diffs = [];
    const branches = parsed.branchCounts?.[parsed.rows.indexOf(row)];
    if (branches != null && Number(existing.branchCount || 0) !== branches) {
      diffs.push({ field: 'Merchants', from: String(existing.branchCount ?? ''), to: String(branches) });
    }
    parsed.fields.forEach((f, i) => {
      const key = WEEKLY_FIELD_KEY[f];
      if (!key || key === 'merchantName') return;         // the name is the match key, not a change
      const next = String(row[i] ?? '').trim();
      if (!next) return;                                   // blank = not stated
      const now = String(existing[key] ?? '').trim();
      if (now !== next) diffs.push({ field: f, from: now, to: next });
    });
    if (diffs.length) changed.push({ name, diffs }); else unchanged++;
  }
  // The fourth bucket: merchants that exist here and are not in this file. An import never
  // deletes them, so this is the only place they would otherwise be visible. Same helper the
  // grid marks with, so the number shown before importing is the number marked after.
  const missing = missingFromUpload(contracts, parsed.rows.map(r => r[nameIdx]));
  return { added, changed, unchanged, missing };
}

// Machine file: the platform's Machine List — one row per cabinet, with the store it sits in.
async function parseMachineCountFile(file) {
  const wb = await readExcel(file);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: null });
  const name = r => String(pick(r, 'Business name') ?? '').trim();
  const model = r => parseDeviceModel(pick(r, 'Device Type'));
  if (!rows.length || !rows.some(name)) throw new Error('No "Business name" column found — is this the Machine List export?');
  // STATE AND BINDING, kept from 2026-10-01. The export carries `State` per machine and a
  // `Business ID`/`Business name` it is bound to, and the app read neither — so "this merchant is
  // approved but has no machine deployed" and "this machine is deployed under nobody" could not
  // be asked. The user's rule for what reaches the registry is Approved AND deployed AND bound,
  // so all three facts have to survive the parse.
  //
  // `Deployed` is matched loosely on purpose: the live export says `Deployed(New)`, and a value
  // the platform spells differently later must not silently read as "not deployed".
  const isDeployed = (v) => /deploy/i.test(String(v ?? ''));
  const byStore = new Map();
  const models = new Set();
  let unbound = 0;
  for (const r of rows) {
    const n = name(r); const m = model(r);
    const dep = isDeployed(pick(r, 'State'));
    if (!n) { if (dep) unbound++; continue; }      // a deployed machine bound to no shop
    if (!byStore.has(n)) {
      byStore.set(n, { counts: {}, deployed: 0, total: 0,
                       businessId: String(pick(r, 'Business ID') ?? '').trim() || null });
    }
    const e = byStore.get(n);
    e.total++;
    if (dep) e.deployed++;
    if (m) { e.counts[m] = (e.counts[m] || 0) + 1; models.add(m); }
  }
  const counted = [...byStore.values()]
    .reduce((a, e) => a + Object.values(e.counts).reduce((x, y) => x + y, 0), 0);
  return { byStore, models: [...models], counted, unbound,
           deployedTotal: [...byStore.values()].reduce((a, e) => a + e.deployed, 0) };
}

async function openAddMerchants() {
  const { card, close } = ctModal(640);
  card.innerHTML = `
    <h3 style="margin:0 0 4px;">Add merchants</h3>
    <p class="muted" style="margin:0 0 16px;font-size:12.5px;">
      Contract dates and revenue-share terms are never touched by an upload — only the merchant,
      contact and machine columns your file carries.
    </p>
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px;">
      <button type="button" id="am-one" class="btn btn-primary">Add one merchant</button>
      <button type="button" id="am-batch" class="btn">Batch — upload my file</button>
    </div>
    <div id="am-body"></div>`;

  card.querySelector('#am-one').addEventListener('click', () => { close(); createContractRow(); });
  card.querySelector('#am-batch').addEventListener('click', () => {
    card.querySelector('#am-body').innerHTML = `
      <div style="border-top:1px solid var(--line);padding-top:14px;">
        <label style="font-size:12.5px;color:var(--ink-soft);display:block;">Merchant list (.xlsx)
          <p class="muted" style="margin:2px 0 6px;font-size:12px;">
            Your own weekly file. Columns are matched by name — merchant, type, sales person,
            contact, phone, email. Anything else is ignored, including contract entity, contract
            dates and revenue-share terms: those are yours to edit here and an upload never
            touches them.
          </p>
          <input type="file" id="am-merchants" accept=".xlsx,.xls" class="input" style="display:block;">
        </label>
        <label style="font-size:12.5px;color:var(--ink-soft);display:block;margin-top:14px;">Machine list (.xlsx) — optional
          <p class="muted" style="margin:2px 0 6px;font-size:12px;">
            The platform's Machine List export. Updates the machine counts only.
          </p>
          <input type="file" id="am-machines" accept=".xlsx,.xls" class="input" style="display:block;">
        </label>
        <div id="am-preview" style="margin-top:14px;"></div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px;">
          <button type="button" id="am-cancel" class="btn-ghost">Cancel</button>
          <button type="button" id="am-review" class="btn" disabled
                  title="Record this file and show every difference on the Reconcile tab. Your merchant data is not changed.">Review only — change nothing</button>
          <button type="button" id="am-import" class="btn-primary" disabled>Import</button>
        </div>
      </div>`;
    card.querySelector('#am-cancel').addEventListener('click', close);
    let parsed = null, machines = null, diff = null;

    // Show what was recognised BEFORE anything is written. A file from outside this app will
    // not use our wording, and a column mapped to the wrong field is worse than one dropped.
    const preview = async () => {
      const box = card.querySelector('#am-preview');
      const mf = card.querySelector('#am-merchants').files[0];
      const kf = card.querySelector('#am-machines').files[0];
      if (!mf && !kf) { box.innerHTML = ''; card.querySelector('#am-import').disabled = true; return; }
      box.innerHTML = 'Reading…';
      try {
        parsed = mf ? await parseWeeklyMerchantFile(mf) : null;
        machines = kf ? await parseMachineCountFile(kf) : null;
        // Where each machine would actually land. Same matcher the import runs, so a store
        // reported here as unmatched is exactly a store the import will skip.
        const mm = machines ? matchMachineStores(machines.byStore, await loadRegistry()) : null;
        const d = diff = parsed ? diffWeeklyRows(parsed, CONTRACTS) : null;
        const row = (label, n, tone) => `<div style="display:flex;justify-content:space-between;padding:3px 0;font-size:13px;${tone || ''}"><span>${label}</span><strong>${n}</strong></div>`;
        box.innerHTML = `
          ${parsed ? `<div style="font-size:13px;">
            <strong>${parsed.rows.length} brand(s)</strong> from ${parsed.branchRows.toLocaleString('en-US')} approved merchant row(s)
            — sheet “${escape(parsed.sheet)}”, header on row ${parsed.headerRow}.
            ${parsed.hasReviewColumn
              ? (parsed.skippedNotApproved ? `<div class="muted" style="font-size:12px;">${parsed.skippedNotApproved.toLocaleString('en-US')} row(s) skipped — not Approved.</div>` : '')
              : `<div class="muted" style="font-size:12px;">No review-state column found, so every named row is included.</div>`}
            ${parsed.brandFromBranch ? `<div class="muted" style="font-size:12px;">No “Merchant label” column — the merchant name is being read as the brand, so each brand becomes one merchant.</div>` : ''}
            <div style="margin-top:6px;">Columns read: ${parsed.fields.map(f => `<span class="badge badge-neutral">${escape(f)}</span>`).join(' ')}</div>
            ${parsed.unmapped.length ? `<div class="muted" style="margin-top:4px;font-size:12px;">Ignored: ${parsed.unmapped.slice(0, 8).map(escape).join(', ')}${parsed.unmapped.length > 8 ? '…' : ''}</div>` : ''}
          </div>

          <div style="margin-top:12px;border:1px solid var(--line);border-radius:8px;padding:10px 12px;">
            <div style="font-weight:600;font-size:13px;margin-bottom:4px;">What this would change</div>
            ${row('New merchants to add', d.added.length, 'color:#2b8a3e;')}
            ${row('Existing merchants with changes', d.changed.length, 'color:#e67700;')}
            ${row('No change', d.unchanged, 'color:var(--ink-soft);')}
            ${row('In your list, not in this file', d.missing.length, 'color:var(--accent);')}
            ${d.added.length || d.changed.length || d.missing.length ? `<button type="button" id="am-detail" class="btn-ghost" style="padding:2px 0;font-size:12.5px;margin-top:4px;">Show the differences</button>
            <div id="am-detail-box" hidden style="margin-top:8px;max-height:260px;overflow:auto;">
              ${d.changed.length ? `<table style="font-size:12.5px;width:100%;">
                <thead><tr><th style="text-align:left;">Merchant</th><th style="text-align:left;">Field</th><th style="text-align:left;">Now</th><th style="text-align:left;">From file</th></tr></thead>
                <tbody>${d.changed.flatMap(c => c.diffs.map((x, i) => `<tr>
                  <td>${i === 0 ? escape(c.name) : ''}</td><td>${escape(x.field)}</td>
                  <td class="muted">${escape(x.from) || '<em>empty</em>'}</td>
                  <td><strong>${escape(x.to)}</strong></td></tr>`)).join('')}</tbody></table>` : ''}
              ${d.added.length ? `<div style="margin-top:10px;font-weight:600;font-size:12.5px;">New merchants</div>
                <ul style="font-size:12.5px;margin:4px 0 0;padding-left:18px;">${d.added.slice(0, 200).map(a2 => `<li>${escape(a2.name)}${a2.vals['Type'] ? ` <span class="muted">— ${escape(a2.vals['Type'])}</span>` : ''}</li>`).join('')}
                ${d.added.length > 200 ? `<li class="muted">…and ${d.added.length - 200} more</li>` : ''}</ul>` : ''}
              ${d.missing.length ? `<div style="margin-top:10px;font-weight:600;font-size:12.5px;">In your list, not in this file</div>
                <p class="muted" style="margin:2px 0 4px;font-size:12px;">Kept exactly as they are. After importing they are marked ⦿ in the grid, and the status filter lists just these.</p>
                <ul style="font-size:12.5px;margin:4px 0 0;padding-left:18px;">${d.missing.slice(0, 200).map(m => `<li>${escape(m.merchantName || '')}${m.branchCount ? ` <span class="muted">— ${m.branchCount} merchant(s)</span>` : ''}</li>`).join('')}
                ${d.missing.length > 200 ? `<li class="muted">…and ${d.missing.length - 200} more</li>` : ''}</ul>` : ''}
            </div>` : ''}
            <p class="muted" style="margin:8px 0 0;font-size:11.5px;">
              Only the columns above are compared. A blank cell means “not stated” and leaves the
              current value alone; contract dates and revenue-share terms are never touched.
            </p>
          </div>` : ''}
          ${machines ? `<div style="margin-top:12px;border:1px solid var(--line);border-radius:8px;padding:10px 12px;">
            <div style="font-weight:600;font-size:13px;margin-bottom:4px;">Machine list</div>
            <div style="font-size:13px;">
              <strong>${machines.counted} machine(s)</strong> across ${machines.byStore.size} store(s) — models ${machines.models.join(', ')}.
            </div>
            ${row('Merchants matched to a brand', `${mm.matchedStores} · ${mm.matchedMachines} machine(s)`, 'color:#2b8a3e;')}
            ${mm.unknown.length ? row('Merchant name not in the registry', `${mm.unknown.length} · ${mm.unknown.reduce((a, x) => a + x.machines, 0)} machine(s)`, 'color:#e67700;') : ''}
            ${mm.unlinked.length ? row('In the registry, but no brand linked', `${mm.unlinked.length} · ${mm.unlinked.reduce((a, x) => a + x.machines, 0)} machine(s)`, 'color:#e67700;') : ''}
            ${mm.unknown.length || mm.unlinked.length ? `<button type="button" id="am-mdetail" class="btn-ghost" style="padding:2px 0;font-size:12.5px;margin-top:4px;">Show the merchants that would be skipped</button>
            <div id="am-mdetail-box" hidden style="margin-top:8px;max-height:220px;overflow:auto;">
              ${[['Merchant name not in the registry', mm.unknown], ['In the registry, but no brand linked', mm.unlinked]]
                .filter(([, list]) => list.length).map(([title, list]) => `
                <div style="font-weight:600;font-size:12.5px;margin-top:6px;">${title}</div>
                <ul style="font-size:12.5px;margin:4px 0 0;padding-left:18px;">
                  ${list.slice(0, 100).map(x => `<li>${escape(x.store)} <span class="muted">— ${x.machines} machine(s)</span></li>`).join('')}
                  ${list.length > 100 ? `<li class="muted">…and ${list.length - 100} more</li>` : ''}</ul>`).join('')}
            </div>` : ''}
            <p class="muted" style="margin:8px 0 0;font-size:11.5px;">
              Matched by merchant name through the registry, which learns names from run
              rosters. Skipped merchants are never guessed at — nothing is written for them, and
              nothing is deleted. ⚠ This column counts CABINETS; a payout counts stations, so a
              4-machine station reads 4 here and 1 in a run.
            </p>
          </div>` : ''}`;
        card.querySelector('#am-mdetail')?.addEventListener('click', (ev) => {
          const mbox = card.querySelector('#am-mdetail-box');
          mbox.hidden = !mbox.hidden;
          ev.target.textContent = mbox.hidden ? 'Show the merchants that would be skipped' : 'Hide the merchants that would be skipped';
        });
        card.querySelector('#am-detail')?.addEventListener('click', (ev) => {
          const dbox = card.querySelector('#am-detail-box');
          dbox.hidden = !dbox.hidden;
          ev.target.textContent = dbox.hidden ? 'Show the differences' : 'Hide the differences';
        });
        card.querySelector('#am-import').disabled = false;
        card.querySelector('#am-review').disabled = false;
      } catch (e) {
        box.innerHTML = `<p class="form-error" style="font-size:13px;">${escape(e.message)}</p>`;
        card.querySelector('#am-import').disabled = true;
        card.querySelector('#am-review').disabled = true;
      }
    };
    card.querySelector('#am-merchants').addEventListener('change', preview);
    card.querySelector('#am-machines').addEventListener('change', preview);

    // Review and Import send the SAME parsed file through the SAME route, differing only by
    // `dryRun`. Anything else would let the review describe an import that is not what would
    // actually happen — which is the one thing a review must never do.
    const submit = async (dryRun) => {
      const btn = card.querySelector(dryRun ? '#am-review' : '#am-import');
      const was = btn.textContent;
      btn.disabled = true; btn.textContent = dryRun ? 'Reading…' : 'Importing…';
      try {
        let created = 0, updated = 0, missed = 0;
        if (parsed) {
          // Sent in the grid shape so the existing importer handles it: header names it already
          // knows, and no contract or terms columns at all, so those stay untouched.
          const fields = [...parsed.fields, 'Merchants'];
          const groups = fields.map(f => ['Contact', 'Phone', 'Email', 'Sales person'].includes(f) ? 'Contact' : 'Merchant');
          const rows = parsed.rows.map((r, i) => [...r, parsed.branchCounts[i]]);
          const res = await api('/contracts/import', { method: 'POST',
            body: JSON.stringify({ rows, header: fields, groups, links: {}, recordUpload: true,
                                   dryRun,
                                   machineMisses: machines ? await machineMissNames(machines) : null }) });
          created += dryRun ? res.wouldCreate : res.created;
          updated += dryRun ? res.wouldUpdate : res.updated;
          // Only the weekly batch sets this — see importContractsRoute. Taking it from the
          // response means the grid repaints marked without a second round trip.
          if (res.lastUpload?.names?.length) LAST_UPLOAD = res.lastUpload;
          missed = diff ? diff.missing.length : 0;
        }
        // Machine counts are merchant data too, so a review does not write them either. Their
        // unplaced merchants still travel with the upload record, so Reconcile can report them.
        if (machines && !dryRun) {
          const r = await importMachineCounts(machines);
          updated += r;
        }
        close();
        if (dryRun) {
          // The Reconcile tab this used to open is gone (2026-09-29) — the Upload page shows the
          // same differences beside the file that produced them. Send the reader there.
          await renderUploadScreen();
          return;
        }
        await renderContractsScreen();
        alert(`${created} merchant(s) added, ${updated} updated.`
          + (missed ? `\n\n${missed} merchant(s) in your list were not in this file. Nothing was `
                    + `deleted — they are marked ⦿ in the grid, and the status filter lists them.` : '')
          + `\n\nContract dates and revenue-share terms were not changed.`);
      } catch (e) {
        btn.disabled = false; btn.textContent = was;
        alert((dryRun ? 'Could not read that file: ' : 'Could not import: ') + e.message);
      }
    };
    card.querySelector('#am-import').addEventListener('click', () => submit(false));
    card.querySelector('#am-review').addEventListener('click', () => submit(true));
  });
}

// The registry: one row per merchant, carrying the merchant it belongs to. Several MB, so it
// is fetched once per dialog and reused by both the preview and the import — the preview would
// otherwise be a second copy of the same download, or (worse) a second copy of the matching.
let REGISTRY_CACHE = null;
async function loadRegistry() {
  if (!REGISTRY_CACHE) REGISTRY_CACHE = await api('/merchants').catch(() => []);
  return REGISTRY_CACHE;
}

// Machine counts arrive per STORE; a merchant's count is the sum over the merchants it owns. Store
// ownership is whatever the registry already knows, so a store this app has never seen is
// skipped rather than guessed at — but NAMED rather than skipped in silence, which is what this
// used to do. Two ways to miss, reported apart because they need different fixes:
//   `unknown`  — no registry row with that merchant name at all. The registry learns store names
//                from run rosters, so this is usually a merchant that has never been in one.
//   `unlinked` — the merchant IS in the registry but its row carries no contractId, so there is no
//                merchant to add the machines to.
// Both are dropped either way; the difference is whether the merchant or the link is missing.
// THE TWO FILES ARE MAPPED TO EACH OTHER FIRST, AND THE REGISTRY SECOND (user, 2026-09-29).
//
// The merchant file gives store -> brand; the machine file gives store -> machines. Joining them
// on the merchant name is the week you are actually holding, and it is what says whether a merchant
// should be ADDED or UPDATED. The registry is derived history — it learns store names from past
// run rosters — so it answers only for merchants this week's files do not mention.
//
// Order matters and used to be the other way round. The registry can be stale: a merchant that moved
// brand, or one whose name the platform restated (§1d), resolves to last month's contract there
// while the file in your hand says otherwise. The file wins, and the two are reported when they
// disagree rather than one silently overriding the other.
function matchMachineStores(byStore, merchants, roster, contracts) {
  // Which contracts still exist and are live. The registry outlives them: 73 rows point at a
  // DELETED contract and 103 at an archived one (measured 2026-09-29), because deleting a
  // merchant never cleans up the merchant rows that referenced it.
  const liveIds = new Set();
  for (const c of contracts || []) if (c && !c.archived && c.contractId) liveIds.add(c.contractId);
  // Without a contracts list there is no way to tell a live link from a dead one — and "I cannot
  // judge" must not mean "nothing is live", or every existing caller silently places nothing.
  // Callers that pass contracts get the check; the older two-argument form behaves as it always did.
  const knowLive = liveIds.size > 0;
  const isLive = id => !knowLive || liveIds.has(id);

  const linkedOf = new Map(), known = new Set();
  for (const m of merchants || []) {
    const k = String(m.name ?? '').toLowerCase().trim();
    if (!k) continue;
    known.add(k);
    if (!m.contractId) continue;
    // PREFER A LIVE CONTRACT. A merchant name routinely has several registry rows (§1c), and taking
    // the first one meant a dangling pointer could speak for the merchant while its live siblings
    // were ignored — which is how 'มี่เสวี่ย … เอเชียทีค' appeared to have moved away from Mixue
    // when two of its three rows said Mixue all along.
    const have = linkedOf.get(k);
    if (!have || (!isLive(have) && isLive(m.contractId))) linkedOf.set(k, m.contractId);
  }
  // merchant name -> brand, straight from the uploaded file; brand -> contract, by name.
  const brandOfStore = new Map(), fromFile = new Map();
  for (const r of (roster && roster.merchants) || []) {
    const k = String(r.name ?? '').toLowerCase().trim();
    const brand = String(r.partnerName ?? '').trim();
    if (k && brand && !brandOfStore.has(k)) brandOfStore.set(k, brand);
  }
  if (brandOfStore.size) {
    const byBrand = new Map();
    for (const c of contracts || []) {
      if (c.archived) continue;
      const k = String(c.merchantName ?? '').toLowerCase().trim();
      if (k && !byBrand.has(k)) byBrand.set(k, c.contractId);
    }
    for (const [store, brand] of brandOfStore) {
      const cid = byBrand.get(brand.toLowerCase().trim());
      if (cid) fromFile.set(store, { cid, brand });
    }
  }
  const totals = new Map();
  const unknown = [], unlinked = [];
  let matchedStores = 0, matchedMachines = 0, matchedViaFile = 0;
  const conflicts = [];
  for (const [store, entry] of byStore) {
    // `byStore` carries state and binding since 2026-10-01; this loop only needs the counts.
    const counts = (entry && entry.counts) || {};
    const n = Object.values(counts).reduce((a, b) => a + b, 0);
    const k = String(store ?? '').toLowerCase().trim();
    // Pass 1 — the two files, joined on the merchant name.
    const hit = fromFile.get(k);
    // Pass 2 — the registry, for merchants this week's files do not place.
    // A registry link to a contract that no longer exists places nothing. Counting machines
    // against a deleted merchant is not a match, it is a number with nowhere to go — and it
    // would inflate "merchants that would have counts updated" with rows nobody can see.
    const regRaw = linkedOf.get(k);
    const fromReg = regRaw && isLive(regRaw) ? regRaw : null;
    let cid = hit ? hit.cid : fromReg;
    const viaFile = hit ? hit.brand : null;
    // A disagreement only counts when BOTH sides name a merchant that still exists. A registry
    // row pointing at a deleted or archived contract is a stale link, not a competing answer —
    // reporting it as "this merchant moved merchant" would have produced a long list of findings
    // about merchants that are not there any more.
    if (hit && fromReg && fromReg !== hit.cid && isLive(fromReg)) {
      conflicts.push({ store, machines: n, fileBrand: hit.brand, registryContractId: fromReg });
    }
    if (!cid) {
      // Still unplaced — but say whether the FILE at least names the merchant, because "we have
      // never heard of this" and "we know the brand but you do not carry it" need different fixes.
      const brand = brandOfStore.get(k);
      (known.has(k) ? unlinked : unknown).push(
        brand ? { store, machines: n, fileBrand: brand } : { store, machines: n });
      continue;
    }
    matchedStores++; matchedMachines += n;
    if (viaFile) matchedViaFile++;
    const acc = totals.get(cid) || {};
    for (const [model, c] of Object.entries(counts)) acc[model] = (acc[model] || 0) + c;
    totals.set(cid, acc);
  }
  return { totals, matchedStores, matchedMachines, matchedViaFile, conflicts, unknown, unlinked };
}

// The store names a machine list could not place, by the two reasons §1l keeps apart: `unknown`
// (no registry row with that merchant name) and `unlinked` (in the registry, but its row carries no
// contractId). They need different fixes, so they must not be merged into one list.
//
// matchMachineStores pushes {store, machines} OBJECTS, not strings — mapping String over them
// would store "[object Object]" 200 times. And loadRegistry is async and several MB, so this
// reuses the fetch the dialog already made rather than pulling the registry twice.
async function machineMissNames(machines, roster) {
  const { unknown, unlinked } = matchMachineStores(machines.byStore, await loadRegistry(), roster, CONTRACTS);
  return { unknown: (unknown || []).map(x => x.store), unlinked: (unlinked || []).map(x => x.store) };
}

async function importMachineCounts(machines, roster) {
  const { totals } = matchMachineStores(machines.byStore, await loadRegistry(), roster, CONTRACTS);
  let n = 0;
  for (const [cid, units] of totals) {
    const c = CONTRACTS.find(x => x.contractId === cid);
    if (!c) continue;
    const total = Object.values(units).reduce((a, b) => a + b, 0);
    if (JSON.stringify(Object.entries(c.units || {}).sort()) === JSON.stringify(Object.entries(units).sort())
        && Number(c.installedUnits || 0) === total) continue;
    await api(`/contracts/${encodeURIComponent(cid)}`, { method: 'PUT', body: JSON.stringify({ units, installedUnits: total }) });
    n++;
  }
  return n;
}

// ── Archive ────────────────────────────────────────────────────────────────
// Archiving is the manual "this contract has ended" switch. It is not a delete: the row, its
// terms and its store links all stay. What changes is that the merchant is never paid again —
// `payoutDecision` in the backend skips an archived contract before it looks at any rule, and
// its matched revenue lands in the run's `skipped` list so the run still reconciles. The
// contract also stays in the roster name index on purpose, so a roster that still lists the
// brand resolves to this row rather than minting a fresh duplicate stub for it.
async function setContractArchived(id, archived) {
  const c = CONTRACTS.find(x => x.contractId === id);
  if (!c) return;
  if (archived && !confirm(
      `Archive "${c.merchantName}"?\n\n`
    + `It moves to the Archived page and stops being paid in every future run — its machines `
    + `may still appear in a roster, and that revenue will show up under Skipped.\n\n`
    + `Nothing is deleted, and you can unarchive it at any time.`)) return;
  const before = { archived: c.archived, archivedAt: c.archivedAt };
  try {
    const saved = await api('/contracts/' + encodeURIComponent(id), {
      method: 'PUT', body: JSON.stringify({ archived }) });
    // Take the server's row back: `archivedAt` is stamped there, not here.
    c.archived = saved.archived;
    c.archivedAt = saved.archivedAt;
  } catch (err) {
    Object.assign(c, before);
    alert('Could not ' + (archived ? 'archive' : 'unarchive') + ' that merchant: ' + err.message);
    return;
  }
  paintContracts();
  paintArchived();
}

async function renderArchivedScreen() {
  const el = document.getElementById('main');
  el.innerHTML = '<h1>Archived merchants</h1><p class="muted">Loading…</p>';
  CONTRACTS = await api('/contracts');
  el.innerHTML = `
    <h1>Archived merchants</h1>
    <p class="muted">Contracts that have ended. They keep their terms and their history, and are
      never paid in a run. Unarchive to bring one back into the Overview.</p>
    <div class="ct-toolbar">
      <input id="ar-search" class="input" placeholder="Search merchant…" style="max-width:240px">
      <span class="muted" id="ar-count"></span>
    </div>
    <table class="ts"><thead><tr>
      <th>Merchant</th><th>Type</th><th>Counter party</th>
      <th>Contract start</th><th>Contract end</th><th>Archived</th><th></th>
    </tr></thead><tbody id="ar-body"></tbody></table>`;
  el.querySelector('#ar-search').addEventListener('input', paintArchived);
  el.querySelector('#ar-body').addEventListener('click', ev => {
    const btn = ev.target.closest('.ar-unarch-btn');
    if (btn) setContractArchived(btn.dataset.id, false);
  });
  paintArchived();
}

function paintArchived() {
  const body = document.getElementById('ar-body');
  if (!body) return;                       // not the screen we're on
  const q = (document.getElementById('ar-search')?.value || '').toLowerCase().trim();
  const all = CONTRACTS.filter(c => c.archived);
  const rows = all
    .filter(c => !q || (c.merchantName || '').toLowerCase().includes(q))
    .sort((a, b) => String(b.archivedAt || '').localeCompare(String(a.archivedAt || '')));
  const dash = '<span class="ct-empty">–</span>';
  const cell = v => v == null || v === '' ? dash : escape(String(v));
  body.innerHTML = rows.length ? rows.map(c => `
    <tr>
      <td>${cell(c.merchantName)}</td>
      <td>${cell(c.merchantType)}</td>
      <td>${cell(entityName(c))}</td>
      <td>${cell(c.startDate)}</td>
      <td>${cell(c.endDate)}</td>
      <td>${cell((c.archivedAt || '').slice(0, 10))}</td>
      <td class="ct-c">${can('manageMerchants')
        ? `<button class="btn-ghost ar-unarch-btn" data-id="${escape(c.contractId)}" title="Return this merchant to the Overview">Unarchive</button>`
        : ''}</td>
    </tr>`).join('')
    : '<tr><td colspan="7" class="muted">No archived merchants yet.</td></tr>';
  const count = document.getElementById('ar-count');
  if (count) count.textContent = all.length ? `${rows.length} of ${all.length}` : '';
}

function paintContracts() {
  // No-op when the Overview screen isn't mounted — openTermsEditor calls this
  // unconditionally on save, and it's also opened from other screens (the run wizard).
  const body = document.getElementById('ct-body');
  if (!body) return;
  const q = (document.getElementById('ct-search')?.value || '').toLowerCase().trim();
  const statusSel = document.getElementById('ct-status');
  const status = statusSel?.value || '';
  // One entity covers many brands, so filtering by it answers "everything we settle with X".
  // `__none` is its own answer, not an absence of one — 185 live brands have no entity yet.
  const entity = (document.getElementById('ct-entity')?.value || '').toLowerCase().trim();
  // Each filter selects exactly the rows carrying the matching row marker, so what the
  // dropdown lists and what the ◆ / ⚠ icons mark can never drift apart.
  // Archived merchants are off this screen entirely — they live on the Archived page. Every
  // count here is over `live` for the same reason: an ended contract should not appear in a
  // total that describes work to do.
  const live = CONTRACTS.filter(c => !c.archived);
  // Recomputed here rather than cached at load: a merchant renamed in the grid stops (or starts)
  // matching the uploaded list on the very next paint, with no refetch.
  MISSING_UPLOAD = new Set(missingFromUpload(live, LAST_UPLOAD?.names).map(c => c.contractId));
  let rows = live.filter(c =>
    (!q || (c.merchantName || '').toLowerCase().includes(q)) &&
    (status !== 'needs'   || needsTerms(c)) &&
    (status !== 'due'     || !!renewalFlag(c).cls) &&
    (status !== 'missing' || MISSING_UPLOAD.has(c.contractId)) &&
    (!entity || entityName(c).toLowerCase().includes(entity)));
  rows.sort((a, b) => (a.merchantName || '').localeCompare(b.merchantName || ''));
  body.innerHTML = rows.map(contractRowHtml).join('');
  document.getElementById('ct-count').textContent = `${rows.length} of ${live.length}`;
  // Counts live in the option labels — they move as terms get set and contracts renew, so
  // they are recomputed on every paint rather than baked into the markup once.
  if (statusSel) {
    const counts = { needs:   live.filter(needsTerms).length,
                     due:     live.filter(c => renewalFlag(c).cls).length,
                     missing: MISSING_UPLOAD.size };
    for (const opt of statusSel.options) {
      if (opt.value in counts) {
        opt.textContent = opt.textContent.replace(/ \(\d+\)$/, '') + ` (${counts[opt.value]})`;
      }
    }
  }
}

// One cell at a time. Click → input; blur or Enter commits; Escape reverts.
function startCellEdit(td) {
  if (td.querySelector('input, select')) return;
  const id = td.dataset.id, key = td.dataset.key;
  const col = CONTRACT_GRID_COLUMNS.find(c => c.key === key);
  if (col && col.type === 'computed') return;   // Units is derived from the model counts
  if (!col) return;
  // Terms are not edited inline in the grid: the Rev terms cell opens a read-only view,
  // and the Edit terms dialog owns editing (same tree editor as the Rule tab), both
  // writing PUT /contracts/:id like every other cell here.
  if (col.type && col.type.startsWith('term-')) return;
  // Only the CONTRACT and share-terms columns are editable here (user, 2026-09-03). Everything
  // else on this grid — merchant, type, merchants, contacts, machine counts — arrives from the
  // weekly merchant upload, and typing over it just loses the edit at the next import: the
  // importer merges the file over the row, so a stated cell wins. Fix those in the file.
  if (!EDITABLE_GROUPS.has(col.group)) return;
  if (!can('manageMerchants')) return;
  const c = CONTRACTS.find(x => x.contractId === id);
  const cur = cellValue(c, key);

  let field;
  if (col.type === 'select') {
    const opts = key === 'merchantType' ? MERCHANT_TYPES : AUTO_RENEWAL_OPTIONS;
    // A stored value that isn't in the (necessarily incomplete — hand-maintained sheet
    // data has more variants than any hardcoded list) options must still show as itself
    // and stay selected.
    // Without this, opening the cell on such a value selects nothing, and the blur-commit
    // below would silently overwrite real data with null. Spec §3 also requires the Type
    // dropdown to accept a typed value not in the list, which this doubles as supporting.
    const known = cur == null || cur === '' || opts.includes(cur);
    field = document.createElement('select');
    field.innerHTML = '<option value=""></option>' +
      opts.map(o => `<option${o === cur ? ' selected' : ''}>${o}</option>`).join('') +
      (known ? '' : `<option value="${escape(cur)}" selected>${escape(cur)}</option>`);
  } else if (col.type === 'bool') {
    field = document.createElement('input'); field.type = 'checkbox'; field.checked = !!cur;
  } else {
    field = document.createElement('input');
    field.type = col.type === 'number' ? 'number' : (col.type === 'date' ? 'date' : 'text');
    field.value = cur == null ? '' : String(cur);
  }
  field.className = 'ct-input';
  td.innerHTML = ''; td.appendChild(field); field.focus();

  let done = false;
  const commit = async () => {
    if (done) return; done = true;
    const raw = col.type === 'bool' ? field.checked : field.value;
    const val = col.type === 'number' ? (raw === '' ? null : Number(raw))
              : (col.type === 'bool' ? raw : (String(raw).trim() || null));
    // A stray click into the cell and back out (no actual edit) must never fire a PUT —
    // most concretely for the select case above, where an untouched dropdown blurring
    // with its injected "current value" option still selected must be a true no-op.
    const before = cur == null ? null : cur;
    if (val === before) { paintContracts(); return; }
    await saveCell(id, key, val);
  };
  field.addEventListener('blur', commit);
  field.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); field.blur(); }
    if (e.key === 'Escape') { done = true; paintContracts(); }
  });
}

async function saveCell(contractId, key, value) {
  const c = CONTRACTS.find(x => x.contractId === contractId);
  if (!c) return;
  const dotted = key.includes('.');
  const beforeUnits = dotted ? { ...(c.units || {}) } : null;
  const beforeInstalled = dotted ? c.installedUnits : undefined;
  const beforeValue = dotted ? undefined : c[key];
  if (dotted) {
    const [obj, sub] = key.split('.');
    c[obj] = { ...(c[obj] || {}) };
    if (value == null) delete c[obj][sub]; else c[obj][sub] = value;
  } else {
    c[key] = value;
  }
  paintContracts();
  try {
    // Units is displayed as a computed sum, but the stored field is what any future
    // consumer (export, report, another screen) would read — keep it in step rather than
    // letting it rot at whatever the sheet last said.
    if (dotted) c.installedUnits = unitsTotal(c);
    const body = dotted ? { units: c.units, installedUnits: c.installedUnits } : { [key]: value };
    await api('/contracts/' + encodeURIComponent(contractId), { method: 'PUT', body: JSON.stringify(body) });
  } catch (err) {
    if (dotted) { c.units = beforeUnits; c.installedUnits = beforeInstalled; } else c[key] = beforeValue;
    paintContracts();
    alert('Could not save: ' + err.message);
  }
}

async function parseKaExcel(file) {
  const wb = await readExcel(file);
  const ws = wb.Sheets['Rev Share'];
  if (!ws) throw new Error('Sheet "Rev Share" not found');
  const rows = XLSX.utils.sheet_to_json(ws, { defval: null });

  const partnerMap = {};
  const merchants = [];
  const warnings = [];

  // Trigger Type 'B' = "max(GP%, MG)" — the Placement column holds the MG amount,
  // varying by device type. Otherwise the Placement column is a placement fee.
  for (const row of rows) {
    const tag        = row['Merchant label (TAG)'];
    const name       = row['merchant name.'];
    const deviceType = row['Device Type'];
    const gpPercent  = Number(row['Rev share %'] || 0) * 100;
    const triggerType= row['Trigger Type'];
    const amount     = Number(row['Placement (monthly)'] || 0);   // MG (type B) or placement fee
    const electricity= Number(row['Electricity (monthly)'] || 0);
    const externalId = row['ID'] ? String(row['ID']) : null;

    if (!tag || !name) continue;

    let machineModel = null;
    if (deviceType) {
      const m = String(deviceType).match(/-(S5|S8|S10|T8|T10|T20|T35|LL?20|LL?40)$/i);
      if (m) machineModel = m[1].toUpperCase().replace('LL', 'L');
      else warnings.push(`Unrecognised device type: "${deviceType}" for "${name}"`);
    }

    const tagKey = String(tag).toLowerCase().trim();
    if (!partnerMap[tagKey]) {
      partnerMap[tagKey] = { name: String(tag), gpPercent, electricity: 0, placementRows: [], mgRows: [], others: 0, aggregationMode: 'whole', currency: CCY };
    }
    const p = partnerMap[tagKey];
    if (gpPercent > 0 && !(p.gpPercent > 0)) p.gpPercent = gpPercent;
    if (electricity > 0) p.electricity = electricity;
    if (machineModel && amount > 0) {
      const table = triggerType === 'B' ? p.mgRows : p.placementRows;
      if (!table.some(r => r.model === machineModel)) table.push({ model: machineModel, amount });
    }

    merchants.push({ name: String(name), partnerName: String(tag), machineModel, externalId });
  }

  return { partners: Object.values(partnerMap), merchants, warnings };
}

// Run share owns two views of the same runs: the list (the month at a glance) and Analytics
// (the trend and what the payout is made of). One header, one tab strip — see §1i for what
// belongs on which. The run DETAIL is not a tab: it is a place you go from the list.
function runShareHead(tab) {
  return `<div class="page-head"><h2>Run share</h2>${
    tab === 'runs' && can('runCalcs') ? '<button id="new-bulk-run" class="btn-primary">+ New run</button>' : ''
  }</div>${subTabsHtml([{ id: 'runs', label: 'Runs' }, { id: 'analytics', label: 'Analytics' }], tab)}`;
}

function wireRunShareTabs() {
  wireSubTabs(document.getElementById('main'),
    id => id === 'analytics' ? renderRevsharePathScreen() : renderBulkRunsList());
}

async function renderBulkRunsList() {
  const main = document.getElementById('main');
  setActiveNav('nav-bulk-runs');
  main.innerHTML = `${runShareHead('runs')}<div id="bulk-runs-out">Loading…</div>`;
  wireRunShareTabs();
  document.getElementById('new-bulk-run')?.addEventListener('click', renderNewBulkRunForm);
  const runs = await api('/bulk-runs');
  const out = document.getElementById('bulk-runs-out');
  if (!runs.length) { out.innerHTML = '<p class="muted">No calculations yet.</p>'; return; }
  // The month at a glance: what came in, what went out, and what share that is. Every figure
  // here comes off the SLIM index row — no run payload is fetched to draw this list.
  //
  // Revenue means revenue that reached a paid merchant: the order report's total less the
  // revenue that matched a merchant we do not pay (skipped) and the revenue that matched
  // nothing (unmatched). That is the same base the run detail divides by, so the percentages
  // on the two screens agree. A brand count is not shown — it says nothing about the money.
  const matchedRevenue = (r) => (typeof r.totalOrderRevenue === 'number')
    ? r.totalOrderRevenue - Number(r.skippedRevenue || 0) - Number(r.unmatchedRevenue || 0)
    : null;

  out.innerHTML = `<table class="ts"><thead><tr>
      <th>Period</th><th>Uploaded</th>
      <th style="text-align:right;">Revenue</th>
      <th style="text-align:right;">Payout</th>
      <th style="text-align:right;">Payout %</th>
      <th style="text-align:right;">Unmatched</th><th></th></tr></thead>
    <tbody>${runs.map(r => {
      const rev = matchedRevenue(r);
      return `<tr data-id="${r.runId}" style="cursor:pointer;">
      <td>${escape(periodMonth(r.periodStart))}${r.archived ? ' <span class="badge badge-neutral" title="Locked — this month cannot be recomputed or deleted. Its statements and order detail are unaffected.">🔒 Locked</span>' : ''}</td>
      <td>${escape(r.uploadedAt?.split('T')[0] || '')}</td>
      <td style="text-align:right;" title="Revenue that reached a paid merchant">${rev == null ? '<span class="muted">—</span>' : fmt2(rev)}</td>
      <td style="text-align:right;"><strong>${fmt2(r.totalPayout || 0)}</strong></td>
      <td style="text-align:right;" title="Payout as a share of that revenue">${rev > 0 ? ((r.totalPayout || 0) / rev * 100).toFixed(1) + '%' : '<span class="muted">—</span>'}</td>
      <td style="text-align:right;">${Number(r.unmatchedCount || 0) > 0
        ? `<span style="color:#f03e3e;">${Number(r.unmatchedCount)}</span>`
        : '0'}</td>
      <td style="text-align:right;white-space:nowrap;">${r.archived
        ? (can('admin') ? `<button class="btn-ghost unlock-run" data-id="${r.runId}"
             title="Unlock this month so it can be recomputed or deleted again">Unlock</button>` : '')
        : `${can('runCalcs') ? `<button class="btn-ghost lock-run" data-id="${r.runId}"
             title="Lock this month: it can no longer be recomputed or deleted. The statements and the stored order detail stay.">🔒 Lock</button>` : ''}${
           can('deleteRuns') ? `<button class="btn-ghost del-run" data-id="${r.runId}" style="color:var(--loss);">Delete</button>` : ''}`}</td>
    </tr>`; }).join('')}</tbody></table>
    <p class="muted" style="margin:10px 0 0;font-size:12.5px;max-width:860px;">
      <strong>Lock</strong> a month once you have acted on it. A locked month cannot be
      recomputed or deleted — its payouts are the record. Everything else still works: the
      statements, the download and the mailing all read a locked run exactly as before.
      Only an admin can unlock.</p>`;
  out.querySelectorAll('tr[data-id]').forEach(tr => {
    tr.addEventListener('click', () => renderBulkRunDetail(tr.dataset.id));
  });
  // LOCK FROM THE LIST (2026-10-02): "give me a button to lock each month run, so we don't have
  // to recompute history months". The action already existed on the run detail under the name
  // Archive — which said nothing about what it prevents, and collided with the Archived screen
  // for merchants, which is a different thing entirely. Same route, honest name, and reachable
  // for every month from the one screen where you can see them all.
  const setLock = async (btn, locked) => {
    const id = btn.dataset.id;
    if (!confirm(locked
      ? 'Lock this month?\n\nIt can no longer be recomputed or deleted — the payouts on it '
        + 'become the record. The statements, the download and the mailing are unaffected.\n\n'
        + 'Only an admin can unlock it.'
      : 'Unlock this month?\n\nIt becomes recomputable and deletable again. A recompute reads '
        + 'today\u2019s terms, so the payouts can change.')) return;
    const was = btn.textContent;
    btn.disabled = true; btn.textContent = locked ? 'Locking…' : 'Unlocking…';
    try {
      await api(`/bulk-runs/${encodeURIComponent(id)}/${locked ? 'archive' : 'unarchive'}`, { method: 'POST' });
      renderBulkRunsList();
    } catch (e) {
      btn.disabled = false; btn.textContent = was;
      alert((locked ? 'Could not lock: ' : 'Could not unlock: ') + e.message);
    }
  };
  out.querySelectorAll('.lock-run').forEach(btn =>
    btn.addEventListener('click', ev => { ev.stopPropagation(); setLock(btn, true); }));
  out.querySelectorAll('.unlock-run').forEach(btn =>
    btn.addEventListener('click', ev => { ev.stopPropagation(); setLock(btn, false); }));

  out.querySelectorAll('.del-run').forEach(btn => {
    btn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      if (!confirm('Delete this calculation? This cannot be undone.')) return;
      btn.disabled = true; btn.textContent = 'Deleting…';
      try {
        await api('/bulk-runs/' + btn.dataset.id, { method: 'DELETE' });
        renderBulkRunsList();
      } catch (e) {
        if (e.message && e.message.includes('409')) {
          alert('This month is locked. Unlock it first (admin only) before deleting.');
        } else {
          alert('Delete failed: ' + e.message);
        }
        btn.disabled = false; btn.textContent = 'Delete';
      }
    });
  });
}

// How stale is the merchant list a run is about to use? Stated plainly, with the age, because
// "24 days ago" is the difference between a routine run and one that misses a month of new
// merchants. The machine list is reported separately — the two arrive together but mean different
// things (stations vs cabinets, §1h).
function wizRosterStatusHtml(meta) {
  if (!meta || !meta.at) {
    return '<p class="rc-warn">No merchant list stored yet. Upload one on the <strong>Upload</strong> page before running.</p>';
  }
  const when = new Date(meta.at);
  const days = Math.floor((Date.now() - when.getTime()) / 86400000);
  const age = days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
  const stale = days >= 14;
  return `<div class="up-sum" style="margin:0;">
    <div class="up-sum-row">Merchant list updated <strong>${escape(when.toLocaleDateString('en-GB',
      { day: 'numeric', month: 'short', year: 'numeric' }))}</strong>
      <span class="${stale ? 'rc-warn' : 'muted'}">· ${escape(age)}</span>
      ${meta.by ? `<span class="muted">· by ${escape(meta.by)}</span>` : ''}</div>
    <div class="up-sum-row muted">${Number(meta.rosterCount || 0).toLocaleString('en-US')} merchant row(s)
      · ${Number(meta.brandCount || 0).toLocaleString('en-US')} brand(s)
      ${meta.excludedCount ? `· ${Number(meta.excludedCount).toLocaleString('en-US')} not Approved` : ''}</div>
    ${meta.machinesAt
      ? `<div class="up-sum-row muted">Machine list updated <strong>${escape(new Date(meta.machinesAt).toLocaleDateString('en-GB',
          { day: 'numeric', month: 'short', year: 'numeric' }))}</strong>${meta.machineStoreCount
          ? ` · ${Number(meta.machineStoreCount).toLocaleString('en-US')} merchant(s)` : ''}</div>`
      : '<div class="up-sum-row muted">No machine list was uploaded with it.</div>'}
    ${stale ? '<div class="up-sum-row rc-warn">This list is more than two weeks old — merchants opened since then will not be paid.</div>' : ''}
  </div>`;
}

function renderNewBulkRunForm() {
  const now = new Date();
  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const main = document.getElementById('main');

  // Wizard state
  const wiz = { periodStart: null, periodEnd: null, merchants: null, prepare: null, orders: null, rosterMeta: null };

  function pad(n) { return String(n).padStart(2, '0'); }

  // Asked for once, up front: step 2 has to say how old the stored merchant list is before you
  // decide to run against it.
  api('/roster').then(m => { wiz.rosterMeta = m && m.at ? m : null; render(); }).catch(() => {});

  function render() {
    const step1Done = !!(wiz.periodStart && wiz.periodEnd);
    const step2Done = !!(wiz.prepare);
    const pendingTerms = (wiz.prepare?.merchantsNeedingTerms || []);
    const step3Done = step2Done && pendingTerms.length === 0;

    main.innerHTML = `
      <div class="page-head">
        <button id="wiz-back" class="btn-ghost">← Back</button>
        <h2>New run</h2>
      </div>

      <!-- Step 1: Period -->
      <div class="wizard-step" id="wiz-step1">
        <div class="wizard-step-head"><span class="wizard-step-num">1</span> Period</div>
        <div class="wizard-step-body">
          <label>Year <input type="number" id="br-year" min="2020" max="2035" value="${wiz.periodStart ? wiz.periodStart.slice(0, 4) : now.getFullYear()}" style="width:100px;margin-left:8px;"></label>
          <label style="margin-top:12px;">Month
            <select id="br-month" style="margin-left:8px;">
              ${MONTHS.map((m, i) => `<option value="${i+1}" ${(wiz.periodStart ? pad(i + 1) === wiz.periodStart.slice(5, 7) : i === now.getMonth()) ? 'selected' : ''}>${m}</option>`).join('')}
            </select>
          </label>
          <div style="margin-top:12px;">
            <button id="wiz-period-next" class="btn-primary">Next →</button>
          </div>
          ${step1Done ? `<p class="muted" style="margin-top:8px;">Period: <strong>${escape(periodMonth(wiz.periodStart))}</strong></p>` : ''}
        </div>
      </div>

      <!-- Step 2: Merchant list — STORED, not uploaded (2026-09-29) -->
      <div class="wizard-step ${!step1Done ? 'wizard-step-locked' : ''}" id="wiz-step2">
        <div class="wizard-step-head"><span class="wizard-step-num">2</span> Merchant list</div>
        <div class="wizard-step-body">
          ${!step1Done ? '<p class="muted">Complete Step 1 first.</p>' : `
          <p class="muted" style="margin:0 0 10px;font-size:13px;">
            Taken from your last upload — a run does not ask for this file again. Refresh it on
            the <strong>Upload</strong> page.</p>
          <div id="wiz-ml-status">${wizRosterStatusHtml(wiz.rosterMeta)}</div>
          ${step2Done ? `<div style="margin-top:10px;padding:12px 16px;background:#ebfbee;border:1px solid #8ce99a;border-radius:8px;font-size:13.5px;">
            <strong>Roster loaded:</strong> ${wiz.prepare.rosterCount} machines · ${wiz.prepare.merchantBrandCount} merchants
            ${wiz.prepare.newMerchants?.length ? `· <span style="color:#e67700;" title="${escape(wiz.prepare.newMerchants.slice(0, 40).join(', '))}">${wiz.prepare.newMerchants.length} brand(s) not in your merchant list</span>` : ''}
            ${wiz.prepare.unassigned?.length ? `· <span style="color:#e67700;">${wiz.prepare.unassigned.length} unassigned merchant(s)</span>` : ''}
            ${wiz.prepare.unitsDiffer?.length ? `· <span style="color:var(--ink-soft);">machine counts differ on ${wiz.prepare.unitsDiffer.length} merchant(s)</span>` : ''}
            <div class="muted" style="margin-top:4px;font-size:12px;">
              A run never changes your merchant list — it reads each merchant's terms and nothing
              else. Brands above that you don't carry are not paid and not added; their revenue is
              reported under Skipped on the run.
            </div>
          </div>` : `<div style="margin-top:10px;"><button id="wiz-ml-load" class="btn-primary">Use this merchant list →</button></div>`}
          `}
        </div>
      </div>

      <!-- Step 3: Review rules -->
      <div class="wizard-step ${!step2Done ? 'wizard-step-locked' : ''}" id="wiz-step3">
        <div class="wizard-step-head"><span class="wizard-step-num">3</span> Review rules</div>
        <div class="wizard-step-body">
          ${!step2Done ? '<p class="muted">Complete Step 2 first.</p>' : (
            pendingTerms.length === 0
              ? '<p style="color:#2b8a3e;">✓ Every brand has revenue-share terms — Step 4 is unlocked.</p>'
              : `<p style="color:#e67700;"><strong>${pendingTerms.length} brand(s) need revenue-share terms before you can run:</strong></p>
                 <div id="wiz-rule-editors"></div>`
          )}
          ${step2Done ? incompleteTermsNote() : ''}
        </div>
      </div>

      <!-- Step 4: Order list -->
      <div class="wizard-step ${!step3Done ? 'wizard-step-locked' : ''}" id="wiz-step4">
        <div class="wizard-step-head"><span class="wizard-step-num">4</span> Order list</div>
        <div class="wizard-step-body">
          ${!step3Done ? '<p class="muted">Complete Steps 1–3 first.</p>' : `
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
            <span style="font-size:12.5px;color:var(--ink-soft);">Order report (.xlsx)</span>
            <button type="button" id="wiz-ord-sample" class="btn-ghost" style="font-size:12px;padding:2px 8px;">↓ Sample file</button>
          </div>
          <input type="file" id="wiz-ord-file" accept=".xlsx" style="display:none">
          <div id="wiz-ord-zone" class="upload-zone" style="cursor:pointer;">
            <p>Choose the order report Excel file</p>
            <button type="button" id="wiz-ord-choose" class="btn">Choose file</button>
            <div id="wiz-ord-name" class="upload-hint"></div>
          </div>
          <div class="upload-hint" style="margin-top:6px;">Required columns: <code style="font-size:11px;">Order No, Rental Merchant, Discount Amount, Payment Amount, Net Amount, Payment Status</code></div>
          <div id="wiz-ord-status" style="margin-top:10px;"></div>

          <div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--line);">
            <span style="font-size:12.5px;color:var(--ink-soft);">Machine List (.xlsx) — <em>optional</em></span>
            <p class="upload-hint" style="margin:4px 0 8px;">The order report identifies a merchant only by name, so a merchant renamed in one export and not the other is paid to nobody. Upload this and any such order is recovered by machine number instead. Needs <code style="font-size:11px;">Machine No</code> and <code style="font-size:11px;">Business ID</code>.</p>
            <input type="file" id="wiz-mach-file" accept=".xlsx" style="display:none">
            <div id="wiz-mach-zone" class="upload-zone" style="cursor:pointer;padding:14px;">
              <button type="button" id="wiz-mach-choose" class="btn">Choose file</button>
              <div id="wiz-mach-name" class="upload-hint"></div>
            </div>
            <div id="wiz-mach-status" style="margin-top:8px;"></div>
          </div>
          `}
        </div>
      </div>`;

    // Bind events
    document.getElementById('wiz-back').addEventListener('click', renderBulkRunsList);

    // Step 1 next
    document.getElementById('wiz-period-next')?.addEventListener('click', () => {
      const year = Number(document.getElementById('br-year').value);
      const month = Number(document.getElementById('br-month').value);
      if (!year || !month) { alert('Select a year and month'); return; }
      wiz.periodStart = `${year}-${pad(month)}-01`;
      wiz.periodEnd = `${year}-${pad(month)}-${pad(new Date(year, month, 0).getDate())}`;
      render();
    });

    // Step 2 — the merchant list is already stored. Preparing sends NO merchants, which is the
    // signal for the backend to use the stored roster (an older tab still posting one wins, so
    // nothing that worked before breaks).
    if (step1Done && !step2Done) {
      document.getElementById('wiz-ml-load')?.addEventListener('click', async () => {
        const status = document.getElementById('wiz-ml-status');
        const btn = document.getElementById('wiz-ml-load');
        btn.disabled = true; btn.textContent = 'Preparing…';
        try {
          const prepare = await api('/bulk-runs/prepare', { method: 'POST', body: JSON.stringify({}) });
          wiz.prepare = prepare;
          wiz.merchants = null;             // the run reads the stored roster too
          render();
        } catch (e) {
          btn.disabled = false; btn.textContent = 'Use this merchant list →';
          status.innerHTML = `<p class="rc-warn">${escape(e.message)}</p>`;
        }
      });
    }

    // Step 3 rule editors (called after render if step2Done and pending terms)
    if (step2Done && pendingTerms.length > 0) {
      renderWizardRuleEditors();
    }

    // Step 4 order list
    if (step3Done) {
      document.getElementById('wiz-ord-sample')?.addEventListener('click', () => {
        const ws = XLSX.utils.aoa_to_sheet([
          ['Order No', 'Rental Merchant', 'Discount Amount', 'Payment Amount', 'Net Amount', 'Payment Status'],
          ['1001', 'Example Merchant 1', 0, 40, 40, 'Paid'],
          ['1002', 'Example Merchant 2', 0, 20, 20, 'Paid'],
          ['1003', 'Example Merchant 3', 0, 30, 30, 'Paid'],
          ['1004', 'Example Merchant 4', 5, 45, 40, 'Paid'],
        ]);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'ORDER REPORT');
        XLSX.writeFile(wb, 'order-report-sample.xlsx');
      });
      document.getElementById('wiz-ord-choose')?.addEventListener('click', () => document.getElementById('wiz-ord-file').click());
      document.getElementById('wiz-ord-zone')?.addEventListener('click', e => { if (e.target.id !== 'wiz-ord-choose') document.getElementById('wiz-ord-file').click(); });
      document.getElementById('wiz-mach-choose')?.addEventListener('click', () => document.getElementById('wiz-mach-file').click());
      document.getElementById('wiz-mach-zone')?.addEventListener('click', e => { if (e.target.id !== 'wiz-mach-choose') document.getElementById('wiz-mach-file').click(); });
      document.getElementById('wiz-mach-file')?.addEventListener('change', async e => {
        const file = e.target.files[0];
        if (!file) return;
        const nameEl = document.getElementById('wiz-mach-name');
        if (nameEl) nameEl.textContent = file.name;
        const status = document.getElementById('wiz-mach-status');
        status.innerHTML = 'Parsing machine list…';
        try {
          wiz.machines = await parseMachineList(file);
          status.innerHTML = `<span style="color:#2b8a3e;">✓ ${wiz.machines.length} machines — renamed merchants will be matched by machine number.</span>`;
        } catch (err) {
          wiz.machines = [];
          status.innerHTML = `<p style="color:#f03e3e;">Error: ${escape(err.message)}</p>`;
        }
      });

      document.getElementById('wiz-ord-file')?.addEventListener('change', async e => {
        const file = e.target.files[0];
        if (!file) return;
        const nameEl = document.getElementById('wiz-ord-name');
        if (nameEl) nameEl.textContent = file.name;
        const status = document.getElementById('wiz-ord-status');
        status.innerHTML = 'Parsing order report…';
        try {
          const orders = await parseOrderReport(file);
          wiz.orders = orders;
          status.innerHTML = `Parsed ${orders.length} orders (unpaid excluded). <button id="wiz-run" class="btn-primary" style="margin-left:8px;">Run</button>`;
          document.getElementById('wiz-run').addEventListener('click', async () => {
            const btn = document.getElementById('wiz-run');
            btn.disabled = true; btn.textContent = 'Running…';
            try {
              // Compressed: a month of orders is now well past API Gateway's 10 MB payload
              // limit uncompressed (32,277 orders ~= 13 MB in September 2026).
              const run = await postLarge('/bulk-runs', {
                periodStart: wiz.periodStart, periodEnd: wiz.periodEnd,
                // Omitted on purpose when null: the backend uses the roster stored at upload
                // time, so the run is computed from station rows exactly as before (§1h).
                ...(wiz.merchants ? { merchants: wiz.merchants } : {}),
                orders: wiz.orders,
                machines: wiz.machines || [], excluded: wiz.excluded || [],
              }, 'order report');
              renderBulkRunDetail(run.runId);
            } catch (err) {
              status.innerHTML += `<p style="color:#f03e3e;">Error: ${escape(err.message)}</p>`;
              btn.disabled = false; btn.textContent = 'Run';
            }
          });
        } catch (err) {
          status.innerHTML = `<p style="color:#f03e3e;">Error: ${escape(err.message)}</p>`;
        }
      });
    }
  }

  // List the merchants still needing revenue-share terms; each opens the Overview's
  // own terms dialog (openTermsEditor) rather than a partner-shaped editor — the row IS
  // the payout record now. That dialog reads from the CONTRACTS / MACHINE_MODELS_CACHE
  // globals, which only the Overview screen normally populates, so load them here
  // too since the wizard never renders that screen.
  async function renderWizardRuleEditors() {
    const slot = document.getElementById('wiz-rule-editors');
    if (!slot) return;
    const pendingTerms = wiz.prepare?.merchantsNeedingTerms || [];
    if (!pendingTerms.length) return;
    slot.innerHTML = 'Loading…';
    try {
      const [contracts, machineModels] = await Promise.all([api('/contracts'), api('/machine-models')]);
      CONTRACTS = contracts;
      MACHINE_MODELS_CACHE = machineModels;
      refreshContractGridColumns();
    } catch (e) {
      slot.innerHTML = `<p style="color:#f03e3e;">Could not load merchant data: ${escape(e.message)}</p>`;
      return;
    }
    slot.innerHTML = '';
    pendingTerms.forEach(({ contractId, name }) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;border:1px solid var(--border);border-radius:8px;padding:12px 16px;margin-bottom:10px;';
      row.innerHTML = `<span style="font-weight:600;">${escape(name)}</span><button type="button" class="btn-ghost wiz-set-terms">Set terms…</button>`;
      slot.appendChild(row);
      row.querySelector('.wiz-set-terms').addEventListener('click', () => {
        openTermsEditor(contractId, refreshReadiness);
      });
    });

    // Re-run prepare (idempotent) after a save so the still-needs-terms question is
    // answered by the backend's own readiness rule (ruleHasValue), not a re-derived
    // copy of it here that could drift out of sync.
    async function refreshReadiness() {
      try {
        wiz.prepare = await api('/bulk-runs/prepare', { method: 'POST',
          body: JSON.stringify(wiz.merchants ? { merchants: wiz.merchants } : {}) });
      } catch (e) {
        alert('Could not refresh readiness: ' + e.message);
        return;
      }
      render();
    }
  }

  render();
}

// API Gateway's REST payload limit is a HARD 10 MB. One month of orders passed it in September
// 2026 — 32,277 orders is ~13 MB — and the 413 that came back carried no CORS headers, so the
// browser could only say "Failed to fetch". Orders are dense repetitive JSON and gzip to about a
// tenth of that, so the body goes up compressed and index.mjs unpacks it before dispatch.
//
// Returns null when the browser has no CompressionStream, and the caller then sends the body
// uncompressed — an older browser keeps working for a normal-sized run rather than being locked
// out of the app entirely.
async function gzipBase64(text) {
  if (typeof CompressionStream !== 'function') return null;
  const packed = new Uint8Array(await new Response(
    new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
  // btoa in 32KB chunks: String.fromCharCode(...bytes) on a megabyte-sized array blows the
  // argument limit and throws RangeError, which would read as a mysterious upload failure.
  let bin = '';
  for (let i = 0; i < packed.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, packed.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

// The limit, and what the reader can do about it. The browser is the only place that can say
// this: the gateway rejects an oversized body before gateway responses apply, so its 413 never
// reaches JavaScript as anything but a network error.
const API_BODY_LIMIT = 10 * 1024 * 1024;

// BYTES, not characters. `String.length` counts UTF-16 units, and this app's merchant names are
// mostly Thai at 3 bytes per character — measuring length would undercount a real order report by
// roughly half and wave through exactly the body the gateway then rejects.
const byteLength = (s) => new TextEncoder().encode(s).length;

async function postLarge(path, payload, what) {
  const text = JSON.stringify(payload);
  const packed = await gzipBase64(text);
  const body = packed == null ? text : JSON.stringify({ gz: packed });
  if (byteLength(body) > API_BODY_LIMIT) {
    const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';
    throw new Error(
      `This ${what} is too large to send: ${mb(byteLength(body))}`
      + (packed == null ? ' (this browser cannot compress it — try Chrome, Edge or Safari 16.4+)'
                        : ` compressed, from ${mb(byteLength(text))}`)
      + `. The API accepts at most ${mb(API_BODY_LIMIT)}. Split the period and run it in two halves.`);
  }
  return api(path, { method: 'POST', body });
}

async function parseOrderReport(file) {
  const wb = await readExcel(file);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: null });
  return rows
    // Include every rental except unpaid ones (refunded rentals stay in).
    .filter(r => String(r['Payment Status'] || '').trim().toLowerCase() !== 'unpaid')
    // The extra columns exist only to reproduce the per-merchant statement the finance team
    // already uses (Rental Time … Order Status). They are carried through to the run's stored
    // inputs; runs made before 2026-09-01 have only the first three, so their download shows
    // the summary block and says the order detail was not recorded.
    .map(r => ({ merchantName: String(r['Rental Merchant'] || '').trim(),
                 netAmount: Number(r['Net Amount'] || 0),
                 // Column A of the order report. Kept from 2026-09-30 for the statement's order
                 // block; runs before that date have no order numbers and the column is blank.
                 orderNo: String(pick(r, 'Order No.') ?? '').trim(),
                 machineNo: String(pick(r, 'Rental Machine No.') ?? '').trim(),
                 rentalTime: String(r['Rental Time'] ?? '').trim(),
                 returnTime: String(r['Return Time'] ?? '').trim(),
                 returnMerchant: String(r['Return Merchant'] ?? '').trim(),
                 duration: r['Rental Duration'] == null ? null : Number(r['Rental Duration']),
                 orderStatus: String(r['Order Status'] ?? '').trim() }))
    .filter(r => r.merchantName);
}

// Header lookup that tolerates the export's irregular spacing — the order report's machine
// column is literally "Rental  Machine  No." with double spaces, and that is exactly the kind
// of thing that changes between exports without warning.
function pick(row, header) {
  if (row[header] != null) return row[header];
  const want = header.toLowerCase().replace(/\s+/g, ' ').trim();
  for (const k of Object.keys(row)) {
    if (k.toLowerCase().replace(/\s+/g, ' ').trim() === want) return row[k];
  }
  return null;
}

// Machine List (optional): machine number -> the Business ID the platform says owns it. This
// is the ONLY file linking an order to a merchant identity — the order report carries no
// merchant/store ID, only the name string, which is why a rename breaks the payout.
async function parseMachineList(file) {
  const wb = await readExcel(file);
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { defval: null })
    .map(r => ({ machineNo: String(pick(r, 'Machine No') ?? '').trim(),
                 businessId: String(pick(r, 'Business ID') ?? '').trim() }))
    .filter(r => r.machineNo && r.businessId);
}

// "2026-05-01" -> "2026_05"
function periodTag(periodStart) {
  const [y, m] = String(periodStart || '').split('-');
  return `${y || '0000'}_${m || '00'}`;
}

// "2026-05-01" -> "2026-05"
function periodMonth(periodStart) {
  return String(periodStart || '').slice(0, 7);
}

// Round up to a "nice" axis maximum (1/2/5 × 10^k).
function niceCeil(v) {
  if (v <= 0) return 1;
  const base = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / base;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nice * base;
}

// Compact money label: 1.17M, 8.5k, 420
function fmtCompact(v) {
  const n = Number(v) || 0, a = Math.abs(n);
  if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'k';
  return n.toFixed(0);
}

// Combo chart: clustered Revenue/Payout bars (left currency axis) + a revenue-share-%
// line (right % axis), with a data label on every bar and point.
// data: [{ month, revenue, payout, sharePct }]
function revsharePathChartSvg(data) {
  const W = 760, H = 380, padL = 64, padR = 54, padT = 28, padB = 66;
  const plotW = W - padL - padR, plotH = H - padT - padB, baseY = padT + plotH;
  const n = data.length, slotW = plotW / n, barW = Math.min(30, slotW * 0.30);
  const moneyMax = niceCeil(Math.max(1, ...data.map(d => Math.max(d.revenue, d.payout))));
  const pctMax = niceCeil(Math.max(1, ...data.map(d => d.sharePct)));
  const yMoney = v => baseY - plotH * (v / moneyMax);
  const yPct = v => baseY - plotH * (v / pctMax);
  const cx = i => padL + slotW * (i + 0.5);
  const REV = '#3b5bdb', PAY = '#20c997', LINE = '#f59f00', GRID = '#e5e7eb', TXT = '#64748b', INK = '#334155';
  const ticks = 4;

  let grid = '';
  for (let t = 0; t <= ticks; t++) {
    const y = baseY - plotH * (t / ticks);
    grid += `<line x1="${padL}" y1="${y}" x2="${padL + plotW}" y2="${y}" stroke="${GRID}" stroke-width="1"/>`;
    grid += `<text x="${padL - 8}" y="${y + 3}" text-anchor="end" font-size="10" fill="${TXT}">${fmtCompact(moneyMax * t / ticks)}</text>`;
    grid += `<text x="${padL + plotW + 8}" y="${y + 3}" text-anchor="start" font-size="10" fill="${LINE}">${(pctMax * t / ticks).toFixed(0)}%</text>`;
  }

  let bars = '';
  data.forEach((d, i) => {
    const c = cx(i), rx = c - barW - 2, px = c + 2;
    bars += `<rect x="${rx}" y="${yMoney(d.revenue)}" width="${barW}" height="${plotH * (d.revenue / moneyMax)}" fill="${REV}" rx="2"/>`;
    bars += `<rect x="${px}" y="${yMoney(d.payout)}" width="${barW}" height="${plotH * (d.payout / moneyMax)}" fill="${PAY}" rx="2"/>`;
    bars += `<text x="${rx + barW / 2}" y="${yMoney(d.revenue) - 4}" text-anchor="middle" font-size="9.5" fill="${REV}">${fmtCompact(d.revenue)}</text>`;
    bars += `<text x="${px + barW / 2}" y="${yMoney(d.payout) - 4}" text-anchor="middle" font-size="9.5" fill="${PAY}">${fmtCompact(d.payout)}</text>`;
    bars += `<text x="${c}" y="${baseY + 16}" text-anchor="middle" font-size="10.5" fill="${INK}">${escape(d.month)}</text>`;
  });

  let pts = '';
  data.forEach((d, i) => {
    const c = cx(i), y = yPct(d.sharePct);
    pts += `<circle cx="${c}" cy="${y}" r="3.5" fill="${LINE}"/>`;
    pts += `<text x="${c}" y="${y - 8}" text-anchor="middle" font-size="9.5" font-weight="600" fill="${LINE}">${d.sharePct.toFixed(1)}%</text>`;
  });
  const line = n > 1
    ? `<path d="${data.map((d, i) => `${i ? 'L' : 'M'}${cx(i)},${yPct(d.sharePct)}`).join(' ')}" fill="none" stroke="${LINE}" stroke-width="2"/>`
    : '';

  const ly = H - 14;
  const legend = `
    <rect x="${padL}" y="${ly - 9}" width="11" height="11" fill="${REV}" rx="2"/><text x="${padL + 16}" y="${ly}" font-size="11" fill="${INK}">Revenue</text>
    <rect x="${padL + 90}" y="${ly - 9}" width="11" height="11" fill="${PAY}" rx="2"/><text x="${padL + 106}" y="${ly}" font-size="11" fill="${INK}">Payout</text>
    <line x1="${padL + 180}" y1="${ly - 4}" x2="${padL + 196}" y2="${ly - 4}" stroke="${LINE}" stroke-width="2"/><circle cx="${padL + 188}" cy="${ly - 4}" r="3" fill="${LINE}"/><text x="${padL + 202}" y="${ly}" font-size="11" fill="${INK}">Revenue share %</text>`;

  return `<div style="overflow-x:auto;"><svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px;font-family:inherit;">
    <text x="${padL - 8}" y="${padT - 12}" text-anchor="end" font-size="10" fill="${TXT}">${CCY}</text>
    <text x="${padL + plotW + 8}" y="${padT - 12}" text-anchor="start" font-size="10" fill="${LINE}">%</text>
    ${grid}
    <line x1="${padL}" y1="${baseY}" x2="${padL + plotW}" y2="${baseY}" stroke="#cbd5e1" stroke-width="1"/>
    ${bars}${line}${pts}${legend}
  </svg></div>`;
}

// A folder name for a contract entity, or null when there is nothing usable to name one
// after. Deliberately NOT sanitizeFilename, whose empty-string fallback is the word
// "merchant" — a folder called "merchant" would look like a real entity.
function entityFolder(name) {
  return String(name ?? '').replace(/[\/\\:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ').replace(/^\.+|\.+$/g, '').trim() || null;
}

// Where each merchant's .xlsx goes inside the zip, given the run's results already sorted by
// payout. A rev-share file is settled with a COMPANY, not a brand: when one contract entity
// covers SEVERAL brands, their files go in a folder named for that entity, so whoever opens
// the zip finds one folder per company rather than five scattered files.
//
// An entity covering a single brand gets NO folder — a folder holding one file is noise — and
// neither does a merchant with no entity recorded, because there is nothing to group it under.
// The payout rank stays in the filename either way, so the ordering still reads inside a folder
// and at the root alike.
function zipEntryBases(results, entityOf) {
  const folders = (results || []).map(r => entityFolder(entityOf(r.contractId)));
  const brands = new Map();
  folders.forEach((f, i) => {
    if (!f) return;
    const set = brands.get(f) || new Set();
    set.add(String((results[i] || {}).merchantName ?? ''));
    brands.set(f, set);
  });
  const used = new Map();
  return (results || []).map((r, i) => {
    // Several brands means several DISTINCT brands: one brand appearing twice in a run is not
    // a company with a portfolio, and foldering it would bury a single file.
    const f = folders[i];
    const dir = f && brands.get(f).size > 1 ? f : '';
    let base = `${i + 1}) ${sanitizeFilename(r.merchantName)}`;
    const key = `${dir}/${base}`;
    if (used.has(key)) base = `${base} (${used.get(key)})`;
    used.set(key, (used.get(key) || 1) + 1);
    return dir ? `${dir}/${base}` : base;
  });
}

function sanitizeFilename(s) {
  return String(s).replace(/[\/\\:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim() || 'merchant';
}

// Split `total` across `weights` at 2-decimal precision so the parts sum
// EXACTLY to round(total,2). Largest-remainder method; falls back to an even
// split when all weights are zero (e.g. a partner whose revenue is all 0).
function apportion(total, weights) {
  const n = weights.length;
  if (n === 0) return [];
  const cents = Math.round(Number(total) * 100);
  const totalW = weights.reduce((a, b) => a + b, 0);
  const raw = totalW > 0
    ? weights.map(w => cents * w / totalW)
    : weights.map(() => cents / n);
  const out = raw.map(Math.floor);
  let remainder = cents - out.reduce((a, b) => a + b, 0);
  const order = raw.map((v, i) => ({ i, frac: v - Math.floor(v) })).sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < remainder; k++) out[order[k % n].i]++;
  return out.map(c => c / 100);
}

// One CSV per merchant (roster brand), ORDER REPORT format:
// Merchant name,Total rentals,Total revenue,Total share amount

// The per-merchant statement, in the shape finance already works with: one workbook per
// merchant, two blocks on one sheet.
//
//   rows 1..n   pivot per store — Rental Place, order count, paid, sharing rate, sharing amount
//               and a Grand Total row
//   row  n+3    the orders themselves — rental/return time, both merchants and their KA names,
//               duration, net amount, status
//
// The second block needs order-level columns that runs before 2026-09-01 never kept, so for
// those the sheet carries the pivot and says so rather than inventing rows.
const SHEET_SAFE = /[\\/?*\[\]:]/g;


const modelCode = v => String(v ?? '').trim();

// The contracted term, in words, with its actual numbers (2026-09-30).
//
// The statement used to print an EFFECTIVE rate — payout ÷ revenue — under a heading that says
// percent. For a merchant paid a guarantee that read as "you receive 344% of revenue", and
// because a `whole`-mode share is apportioned BY revenue it was the same number on every row,
// so it said nothing per store either. A merchant should be told what was AGREED; the amount
// beside it is what that produced.
//
// Fed the rule the RUN WAS COMPUTED WITH (`ruleSnapshots`), never today's — editing a rule must
// not rewrite a statement for a period already paid (§10.5).
//
// Pure: a rule in, a string out.
function termText(rule) {
  const money = n => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const leaf = (n) => {
    switch (n.type) {
      case 'percent': {
        const rows = (n.rows || []).filter(r => Number(r.percent) > 0);
        if (!rows.length) return '';
        return rows.map(r => r.model === 'ALL' || !r.model
          ? `GP ${money(r.percent)}%` : `GP ${modelCode(r.model)} ${money(r.percent)}%`).join(' + ');
      }
      case 'flat_per_machine': {
        const rows = (n.rows || []).filter(r => Number(r.amount) > 0);
        if (!rows.length) return '';
        const label = n._t === 'mg' ? 'MG' : n._t === 'placement' ? 'Placement' : 'Per machine';
        return rows.map(r => `${label} ${modelCode(r.model)} ${money(r.amount)}`).join(' + ');
      }
      case 'flat_per_partner_total': {
        if (!(Number(n.amount) > 0)) return '';
        const label = n._t === 'elec' ? 'Electricity' : n._t === 'others' ? 'Others' : 'Flat';
        return `${label} ${money(n.amount)}`;
      }
      case 'tiered_percent':
        return 'Tiered %';
      default:
        return '';
    }
  };
  const walk = (n) => {
    if (!n || typeof n !== 'object') return '';
    if (n.type === 'sum' || n.type === 'max' || n.type === 'min') {
      const parts = (n.children || []).map(walk).filter(Boolean);
      if (!parts.length) return '';
      if (parts.length === 1) return parts[0];
      const join = n.type === 'sum' ? ' + ' : ' , ';
      return n.type === 'sum' ? parts.join(join) : `${n.type}( ${parts.join(join)} )`;
    }
    return leaf(n);
  };
  return walk(rule) || '';
}

// ── WHICH SIDE OF THE COMPARISON WON, PER MERCHANT (2026-10-02) ──────────────────────────────
// "for brands that are using higher rev share terms, is it possible to show the report like
// this?" — with the share column reading `MG S8 200 wins` on one row and `GP 50% wins` on the
// next, instead of repeating the whole contracted term on all 1,480 of them.
//
// It is possible because THE ENGINE ALREADY RECORDS IT. `max` keeps only the branch that won
// (§1i), and in `per_store` mode it evaluates once per merchant — so `byStore[i].components` IS
// the answer for that row, frozen in the run. Nothing is recomputed and no rule is re-read:
// September's 7-Eleven says 1,139 merchants paid on the guarantee and 341 on the percentage,
// and the GP row is the one earning 935.
//
// Only for a COMPARISON, and only `per_store`:
//   • a `whole` brand is evaluated once for the whole brand, so there is no per-merchant winner
//     to report — the column keeps stating the contracted term, which is the truth for it.
//   • a rule that only ever sums has no loser, so "wins" would be noise.
// Either way it falls back to `termText`, which is what every row says today.
//
// The winning component is matched to its rule leaf by `leafType`. Measured on all 8 live
// contracts with a `max` root: no two children of one comparison share a leaf type, so this is
// unambiguous — and where it ever is ambiguous, the amounts decide.
function comparisonLeaves(rule) {
  // The `max` may be the root, or sit inside a root `sum` next to electricity, which never
  // competes (2026-08-06). Anything outside it is added on top and is not part of the contest.
  if (!rule || typeof rule !== 'object') return null;
  if (rule.type === 'max' || rule.type === 'min') return rule;
  if (rule.type === 'sum') {
    for (const c of rule.children || []) {
      const hit = comparisonLeaves(c);
      if (hit) return hit;
    }
  }
  return null;
}

function rowTermText(rule, components) {
  const cmp = comparisonLeaves(rule);
  if (!cmp || !Array.isArray(components) || !components.length) return termText(rule);

  const money = n => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const children = cmp.children || [];
  // A leaf of the comparison, labelled by what the component actually PAID on this row — the
  // model that fired, not every model the term lists. That is the difference between
  // "MG S5 150 + MG S8 200 + MG LL40 1,000" and "MG S8 200".
  const label = (comp) => {
    const leaf = children.find(c => c.type === comp.leafType) || null;
    const paid = (comp.modelRowsContributed || []).filter(r => Number(r.payout) > 0);
    switch (comp.leafType) {
      case 'percent':
        return paid.length
          ? [...new Set(paid.map(r => `GP ${money(r.percent)}%`))].join(' + ')
          : (termText(leaf) || 'GP');
      case 'flat_per_machine': {
        const name = leaf && leaf._t === 'mg' ? 'MG'
                   : leaf && leaf._t === 'placement' ? 'Placement' : 'Per machine';
        return paid.length
          ? paid.map(r => `${name} ${modelCode(r.model)} ${money(r.amount)}`).join(' + ')
          : (termText(leaf) || name);
      }
      default:
        return termText(leaf) || '';
    }
  };

  // Did this component come from inside the comparison, or from beside it?
  const inContest = (comp) => children.some(c => c.type === comp.leafType);
  const won = components.filter(c => inContest(c) && Number(c.payout) > 0);
  const beside = components.filter(c => !inContest(c) && Number(c.payout) > 0);

  // Nothing inside the comparison paid: the row earned nothing from it, so state the term
  // rather than claiming a winner.
  if (!won.length) return termText(rule);

  const head = [...new Set(won.map(label).filter(Boolean))].join(' + ') + ' wins';
  const tail = beside.map(c => termText(c.leafType === 'flat_per_partner_total'
    ? { type: 'flat_per_partner_total', amount: c.payout, _t: (rule.children || [])
        .filter(x => x.type === 'flat_per_partner_total').map(x => x._t)[0] }
    : null)).filter(Boolean);
  return [head, ...tail].join(' + ');
}

// THE STATEMENT, in the shape finance already reconciles against (Template_Revenue Share.xlsx,
// read 2026-09-30). One merchant per file, two blocks.
//
// Block 1 — a pivot per rental place, with the share split for tax:
//   Rental Place · รุ่นเครื่อง · จำนวนการยืม · ยอดรายได้ทั้งหมด · ส่วนแบ่งรายได้ ·
//   มูลค่าส่วนแบ่ง (ฐานภาษี) · ภาษี · ยอดรวม
// The share column states the TERM as contracted (see `termText`), not a computed rate.
// Block 2 — the merchant's name on its own row, then every rental:
//   Order No. · Rental Time · Rental Merchant · Rental KA Name · Return Time ·
//   Rental Duration · Net Amount · Order Status
//
// Verified against all three rows of the template: ยอดรวม is the payout, the base is that
// divided by 1.07 and the tax is the difference — i.e. THE PAYOUT IS TREATED AS VAT-INCLUSIVE.
// How a `whole`-mode payout lands on each merchant.
//
// Apportioning the WHOLE payout by revenue is right for a revenue share and WRONG for a per-machine
// fee. Siam Center is paid `Placement LL40 3,000 + Placement S8 3,000` across five merchants with
// one machine each: every row should read 3,000, and instead they read 4,064.33 / 3,267.54 /
// 2,441.52 / 3,267.54 / 1,959.07 — the fee reshuffled by how much each shop happened to rent. The
// Grand Total was right, so nothing looked broken until you read a row (2026-10-01).
//
// The engine already records what each part paid, per model, so this reads its answer rather than
// inventing one: a per-machine component goes to the machine that earned it, and only the parts
// that genuinely belong to the brand as a whole — a revenue share, a lump sum — are apportioned
// by revenue. A run from before components were recorded falls back to the old split.
function splitWholePayout(result, merchants) {
  const total = Number(result.payout) || 0;
  const weights = merchants.map(m => Math.max(0, Number(m.revenue) || 0));
  const components = result.engineResult?.byPartner?.components;
  if (!Array.isArray(components) || !components.length) return apportion(total, weights);

  const cents = merchants.map(() => 0);
  let placed = 0;
  for (const comp of components) {
    const pay = Math.round((Number(comp.payout) || 0) * 100);
    if (!pay) continue;
    if (comp.leafType === 'flat_per_machine') {
      // Each merchant earns its own model's amount. `modelRowsContributed` carries what the
      // engine actually used, so a model the rule does not name contributes nothing.
      const byModel = new Map((comp.modelRowsContributed || [])
        .map(r => [String(r.model), Math.round((Number(r.amount) || 0) * 100)]));
      let used = 0;
      merchants.forEach((m, i) => {
        const amt = byModel.get(String(m.model)) || 0;
        cents[i] += amt; used += amt;
      });
      // If the component's own total disagrees — a model counted that no merchant row carries —
      // the difference follows revenue rather than vanishing.
      if (used !== pay) apportion((pay - used) / 100, weights).forEach((v, i) => { cents[i] += Math.round(v * 100); });
      placed += pay;
      continue;
    }
    // A revenue share, a tier, a lump: nothing ties it to one merchant, so revenue decides.
    apportion(pay / 100, weights).forEach((v, i) => { cents[i] += Math.round(v * 100); });
    placed += pay;
  }

  // The rows must add to the payout exactly, whatever the components said.
  const drift = Math.round(total * 100) - cents.reduce((a, b) => a + b, 0);
  if (drift && cents.length) {
    const order = weights.map((w, i) => ({ i, w })).sort((a, b) => b.w - a.w);
    cents[order[0].i] += drift;
  }
  return cents.map(c => c / 100);
}

function buildPartnerSheet(XLSXns, result, orders, kaByStore, ordersError, ruleSnapshot, gone) {
  const merchants = result.merchants || [];
  const eng = result.engineResult || {};
  const perStore = Array.isArray(eng.byStore);

  // Per-store share: the engine's own figure in per_store mode; apportioned by revenue in whole
  // mode, where it computes one number for the merchant and no split exists.
  let shares;
  // The same byStore pass now yields the per-row COMPONENTS too, which is what lets the share
  // column say which side of a comparison won on this merchant (see rowTermText).
  const compsByStore = {};
  if (perStore) {
    const byStore = {};
    eng.byStore.forEach(x => { byStore[x.storeId] = x.payout; compsByStore[x.storeId] = x.components; });
    shares = merchants.map(m => byStore[m.merchantId] || 0);
  } else {
    shares = splitWholePayout(result, merchants);
  }

  // `(%)` is gone from this heading on purpose: the column states the agreed TERM, which is not
  // always a percentage. Printing "MG S8 4,000" under a percent sign would repeat the mistake it
  // is replacing.
  const term = termText(ruleSnapshot);
  const aoa = [['Rental Place', 'รุ่นเครื่อง', 'จำนวนการยืม', 'ยอดรายได้ทั้งหมด',
                'ส่วนแบ่งรายได้', 'มูลค่าส่วนแบ่ง (ฐานภาษี)', 'ภาษี', 'ยอดรวม']];
  let nOrders = 0, sumPaid = 0, sumShare = 0;
  merchants.forEach((m, i) => {
    const total = shares[i];
    const { base, tax } = splitTax(total);
    nOrders += m.rentals; sumPaid += m.revenue; sumShare += total;
    // C5 (2026-10-01): a merchant your latest file no longer carries is MARKED in the file the
    // partner receives, not quietly dropped. It is still paid — a run states what happened in the
    // period — and the mark is what stops the line being read as a mistake.
    const label = gone && gone.has(String(m.merchantName || '').toLowerCase().trim())
      ? `${m.merchantName} (no longer in our list)` : m.merchantName;
    // Per row where the run froze a per-merchant evaluation; the contracted term otherwise.
    const rowTerm = perStore ? rowTermText(ruleSnapshot, compsByStore[m.merchantId]) : term;
    aoa.push([label, modelLabel(m.model), m.rentals, round2(m.revenue),
              rowTerm, base, tax, round2(total)]);
  });
  if (perStore && eng.topLevel && eng.topLevel.payout) {
    const lump = eng.topLevel.payout;
    const { base, tax } = splitTax(lump);
    sumShare += lump;
    aoa.push(['(merchant-level lump sum)', '', null, null, null, base, tax, round2(lump)]);
  }
  // The total's tax is computed FROM the total, not by adding the rounded parts — which is what
  // the template itself does.
  const gt = splitTax(sumShare);
  aoa.push(['Grand Total', '', nOrders, round2(sumPaid), term, gt.base, gt.tax, round2(sumShare)]);

  aoa.push([]);
  aoa.push([result.merchantName]);
  if (orders) {
    // `Return Merchant` is kept (user, 2026-09-30) even though the template drops it — it sits
    // beside Return Time, where it belongs, and it is already on every stored order.
    aoa.push(['Order No.', 'Rental Time', 'Rental Merchant', 'Rental KA Name', 'Return Time',
              'Return Merchant', 'Rental Duration', 'Net Amount', 'Order Status']);
    for (const o of orders) {
      aoa.push([o.orderNo || '', o.rentalTime || '', o.merchantName || '', result.merchantName,
                o.returnTime || '', o.returnMerchant || '',
                o.duration ?? '', Number(o.netAmount) || 0, o.orderStatus || '']);
    }
  } else {
    // Two very different reasons, and telling them apart matters: one is a fact about an old run,
    // the other is a failure that someone must fix before this statement goes out again.
    aoa.push([ordersError && ordersError !== 'predates'
      ? `The rentals could not be loaded for this run (${ordersError}). This file is incomplete —`
        + ` do not send it until that is fixed.`
      : 'The individual rentals were not kept for this run, so they cannot be listed here.'
        + ' The totals above were calculated from the order report uploaded at the time of the'
        + ' run and are complete — only the line-by-line list is missing.']);
  }
  return XLSXns.utils.aoa_to_sheet(aoa);
}

// THE ONE PLACE TAX IS DECIDED (2026-09-30). The user: "let's do with VAT, but I might change to
// without later" — so it is a single switch, not a rule spread across the sheet builder.
//
// `mode: 'inclusive'` means the payout the engine computed already contains the tax, which is
// what the template does: base = total / 1.07, tax = total − base. To settle terms EX-tax
// instead, set mode to 'exclusive' and the total becomes payout × (1 + rate).
//
// Per REGION, because the rate is a country's, not a merchant's. If it ever needs to vary by
// merchant — a merchant not VAT-registered — this becomes a field on the contract and the
// lookup moves here; nothing else in the sheet changes.
const TAX = {
  th: { rate: 0.07, mode: 'inclusive' },
  sg: { rate: 0,    mode: 'inclusive' },
};

function splitTax(total) {
  const t = Number(total) || 0;
  const { rate, mode } = TAX[REGION] || { rate: 0, mode: 'inclusive' };
  if (!rate) return { base: round2(t), tax: 0 };
  if (mode === 'exclusive') {
    const tax = round2(t * rate);
    return { base: round2(t), tax, gross: round2(t + tax) };
  }
  const base = round2(t / (1 + rate));
  return { base, tax: round2(t - base) };
}

// The template writes the device code with a hyphen before the digits — `S-8`, `LL-40` — while
// the app merchants `S8`, `LL40`. Display only; nothing is matched on this.
function modelLabel(code) {
  const c = String(code || '').trim();
  return c ? c.replace(/^([A-Za-z]+)(\d)/, '$1-$2') : '';
}


const round2 = v => Math.round(Number(v) * 100) / 100;

// ── Settings → Mail templates ──────────────────────────────────────────────────────────────
// Editing needs `manageMailTemplates` (2026-09-29, was full `admin`), because a template is the
// wording that reaches a merchant under the company's name — privileged, but not a reason to
// hand someone user management and the run-archive lock. Everyone can read one, so anyone can
// check what is being sent.
// Mailing: its own destination, because writing to a merchant is work, not configuration.
// Two tabs for now — the templates, and what has actually gone out. The sending workspace
// (pick a period, work down the list) is the next piece and is being designed.
async function renderMailingScreen(tab = 'send') {
  const main = document.getElementById('main');
  setActiveNav('nav-mailing');
  const tabs = [{ id: 'send', label: 'Send' },
                { id: 'templates', label: 'Templates' },
                { id: 'sent', label: 'Sent' }];
  if (!tabs.some(t => t.id === tab)) tab = 'send';
  main.innerHTML = `<div class="page-head"><h2>Mailing</h2></div>
    ${subTabsHtml(tabs, tab)}
    <div id="mailing-body">Loading…</div>`;
  wireSubTabs(main, id => renderMailingScreen(id));
  const body = document.getElementById('mailing-body');
  if (tab === 'sent') await renderMailSentTab(body);
  else if (tab === 'templates') await renderMailTemplatesTab(body);
  else await renderMailSendTab(body);
}

// Everything sent, newest first, across every run. Answers "did Central get its September
// statement, and who sent it" without opening a run. Reading is open to anyone signed in —
// checking what left the company under its own name should not need a permission.
async function renderMailSentTab(host) {
  host.innerHTML = '<p class="muted">Loading…</p>';
  let runs = [];
  try { runs = await api('/bulk-runs'); } catch { /* shown as empty below */ }
  const logs = (await Promise.all((runs || []).map(r =>
    api(`/bulk-runs/${encodeURIComponent(r.runId)}/mail-log`)
      .then(l => (l || []).map(m => ({ ...m, period: periodTag(r.periodStart) })))
      .catch(() => [])))).flat();
  logs.sort((a, b) => (b.sentAt || '').localeCompare(a.sentAt || ''));
  if (!logs.length) {
    host.innerHTML = '<p class="muted">Nothing has been sent yet. Statements are sent from a run — '
      + 'open <strong>Run share</strong>, choose a month, and use the Statement column.</p>';
    return;
  }
  host.innerHTML = `<table class="ts"><thead><tr>
      <th>Sent</th><th>Period</th><th>Merchant</th><th class="rc-c-money">Payout quoted</th>
      <th>To</th><th>Cc</th><th>Attached</th><th>By</th>
    </tr></thead><tbody>${logs.map(m => `<tr>
      <td>${escape(m.sentAt ? new Date(m.sentAt).toLocaleString('en-GB',
            { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '')}</td>
      <td>${escape(m.period || '')}</td>
      <td>${escape(m.merchantName || '')}</td>
      <td class="rc-c-money">${m.payout == null ? '<span class="muted">—</span>' : escape(fmt2(m.payout))}</td>
      <td>${escape(m.to || '')}</td>
      <td>${m.cc ? escape(m.cc) : '<span class="muted">—</span>'}</td>
      <td>${escape(m.attachment || '')}${m.attachmentRows != null
            ? ` <span class="muted">(${escape(String(m.attachmentRows))} rows)</span>` : ''}</td>
      <td>${escape(m.sentBy || '')}</td>
    </tr>`).join('')}</tbody></table>`;
}

async function renderMailTemplatesTab(host) {
  const box = host || document.getElementById('main');
  let templates;
  try {
    templates = await loadMailTemplates();
  } catch (e) {
    box.innerHTML = `<p class="nm-err">Could not load templates: ${escape(e.message)}</p>`;
    return;
  }
  const mayEdit = can('manageMailTemplates');   // admin implies it (resolvePermissions)
  const help = MAIL_PLACEHOLDERS.map(([k, d]) => `<code>${escape(k)}</code> — ${escape(d)}`).join('<br>');
  box.innerHTML = `
    <p class="muted" style="margin:0 0 12px;font-size:13px;">
      The wording sent to a merchant with its statement. Placeholders are filled in per merchant
      when the mail is written; you see the finished text before anything is sent.</p>
    <div id="mt-list"></div>
    ${mayEdit ? '<button id="mt-add" class="btn" style="margin-top:12px;">+ New template</button>' : ''}
    <details style="margin-top:16px;"><summary class="muted">Placeholders</summary>
      <p class="muted" style="font-size:12.5px;line-height:1.7;">${help}</p></details>`;

  const list = document.getElementById('mt-list');
  const draw = () => {
    list.innerHTML = templates.length ? templates.map((t, i) => `
      <div class="rc-item" style="margin-bottom:10px;">
        <strong>${escape(t.name || 'Untitled')}</strong>
        <div class="muted" style="font-size:12.5px;">${escape(MAIL_KINDS[mailKind(t)].label)}
          · from ${escape(mailFromAlias(t) || '— no sender address for this region —')}
          ${mailCc(t) ? `· cc ${escape(mailCc(t))}` : ''}
          ${t.attachmentName ? `· attaches ${escape(t.attachmentName)} (${escape(fileSizeLabel(t.attachmentSize))})` : ''}</div>
        <div style="font-size:13px;margin-top:4px;">${escape(t.subject || '')}</div>
        ${mayEdit ? `<div style="margin-top:6px;display:flex;gap:6px;">
          <button class="btn-ghost mt-edit" data-i="${i}">Edit</button>
          <button class="btn-ghost mt-del" data-i="${i}">Delete</button></div>` : ''}
      </div>`).join('') : '<p class="muted">No templates yet.</p>';
    list.querySelectorAll('.mt-edit').forEach(b =>
      b.addEventListener('click', () => editMailTemplate(templates[b.dataset.i])));
    list.querySelectorAll('.mt-del').forEach(b => b.addEventListener('click', async () => {
      const t = templates[b.dataset.i];
      if (!confirm(`Delete the template "${t.name || 'Untitled'}"? Mail already sent is unaffected.`)) return;
      await api('/mail-templates/' + encodeURIComponent(t.id), { method: 'DELETE' });
      renderMailingScreen('templates');
    }));
  };
  draw();
  document.getElementById('mt-add')?.addEventListener('click', () => editMailTemplate(null));
}

function editMailTemplate(t) {
  const { card, close } = ctModal(700);
  card.innerHTML = `
    <h3 style="margin:0 0 14px;">${t ? 'Edit' : 'New'} mail template</h3>
    <div class="mail-form">
      <div class="mail-row">
        <label><span>Name</span><input id="mt-name" value="${escape(t?.name || '')}"
          placeholder="Monthly statement"></label>
        <label><span>Kind</span><select id="mt-kind">${Object.entries(MAIL_KINDS).map(([k, v]) =>
          `<option value="${k}"${mailKind(t) === k ? ' selected' : ''}>${escape(v.label)}</option>`).join('')}</select></label>
      </div>
      <p class="mail-hint" id="mt-kind-help"></p>
      <div class="mail-row">
        <label><span>Send from</span><input id="mt-from"
          value="${escape(t ? (t.fromAlias || '') : (DEFAULT_FROM_ALIAS[REGION] || ''))}"
          placeholder="${escape(DEFAULT_FROM_ALIAS[REGION] || 'no group address set for this region')}"></label>
      </div>
      <p class="mail-hint">Defaults to the partner group. It must be an address the person
        sending has verified in Gmail under “Send mail as”, or Gmail refuses the message.</p>
      <div class="mail-row">
        <label><span>Always Cc</span><input id="mt-cc"
          value="${escape(t ? (t.cc || '') : (FINANCE_CC[REGION] || ''))}"
          placeholder="${escape(FINANCE_CC[REGION] || 'no finance address set for this region')}"></label>
      </div>
      <p class="mail-hint">Copied on every message this template sends — finance, for the mail
        that quotes money. Leave it blank to copy nobody. Separate several with commas.</p>
      <label><span>Subject</span><input id="mt-subject" value="${escape(t?.subject || '')}"
        placeholder="ChargeSpot revenue share — {{merchant}} — {{period}}"></label>
      <div id="mt-attach-row"${mailKind(t) === 'message' ? '' : ' hidden'}>
        <label><span>Attachment</span>
          <div style="display:flex;gap:8px;align-items:center;">
            <input type="file" id="mt-file" style="flex:1;">
            ${t?.attachmentName ? `<button type="button" id="mt-file-clear" class="btn-ghost">Remove</button>` : ''}
          </div></label>
        <p class="mail-hint" id="mt-attach-now">${t?.attachmentName
          ? `Currently sending <strong>${escape(t.attachmentName)}</strong>
             (${escape(fileSizeLabel(t.attachmentSize))}). Choose a file to replace it.`
          : 'Optional. Sent with every message using this template. Up to 5 MB.'}</p>
      </div>
      <label><span>Message</span><textarea id="mt-body"
        placeholder="Dear {{entity}},&#10;&#10;Please find attached the revenue-share statement for {{period}}.">${escape(t?.body || '')}</textarea></label>
      <details style="margin:-4px 0 14px;"><summary class="muted" style="font-size:12.5px;">Placeholders</summary>
        <p class="muted" id="mt-placeholders" style="font-size:12.5px;line-height:1.7;"></p></details>
      <p class="nm-err" id="mt-err" hidden></p>
      <div class="mail-actions">
        <button id="mt-cancel" class="btn-ghost">Cancel</button>
        <button id="mt-save" class="btn-primary">Save</button>
      </div>
    </div>`;
  // The help under Kind, and the placeholder list, both follow the choice — a message must not
  // advertise {{payout}}, which it has no run to fill in.
  const kindHelp = () => {
    const k = card.querySelector('#mt-kind').value;
    card.querySelector('#mt-kind-help').textContent = MAIL_KINDS[k].help;
    const ph = card.querySelector('#mt-placeholders');
    if (ph) ph.innerHTML = MAIL_PLACEHOLDERS
      .filter(([key]) => k === 'statement' || !MAIL_RUN_PLACEHOLDERS.includes(key.slice(2, -2)))
      .map(([key, d]) => `<code>${escape(key)}</code> — ${escape(d)}`).join('<br>');
  };
  card.querySelector('#mt-kind').addEventListener('change', () => {
    kindHelp();
    // A statement already attaches the merchant's own figures; a second fixed file would raise
    // the question of which one matters.
    const row = card.querySelector('#mt-attach-row');
    if (row) row.hidden = card.querySelector('#mt-kind').value !== 'message';
  });
  kindHelp();

  let clearAttachment = false;
  card.querySelector('#mt-file-clear')?.addEventListener('click', () => {
    clearAttachment = true;
    card.querySelector('#mt-file').value = '';
    card.querySelector('#mt-attach-now').innerHTML =
      'Will be removed when you save. Choose a file to keep one instead.';
  });

  card.querySelector('#mt-cancel').addEventListener('click', close);
  card.querySelector('#mt-save').addEventListener('click', async () => {
    const err = card.querySelector('#mt-err');
    const show = (m) => { err.hidden = false; err.textContent = m; };
    // The WHOLE handler is guarded, not just the request. Building the payload outside a try
    // meant a missing field element threw before anything was sent: the button did nothing, no
    // error appeared, and the template silently stayed as it was — which is exactly how an
    // edit to "Rev share" was lost on 2026-09-25. A save either happens or says why.
    try {
      const val = (sel) => {
        const el = card.querySelector(sel);
        if (!el) throw new Error(`This dialog is out of date (${sel} is missing) — reload the page and try again.`);
        return el.value;
      };
      const payload = {
        id: t?.id,
        name: val('#mt-name').trim(),
        kind: val('#mt-kind'),
        fromAlias: val('#mt-from').trim(),
        cc: val('#mt-cc').trim(),
        subject: val('#mt-subject').trim(),
        body: val('#mt-body'),
      };
      if (!payload.subject) return show('A subject is required.');

      // The template must exist before a file can hang off it, so save first and upload after.
      // A failed upload therefore leaves the wording saved and the old file in place, which is
      // the better half to keep.
      const saved = await api('/mail-templates', { method: 'PUT', body: JSON.stringify(payload) });

      const file = card.querySelector('#mt-file')?.files?.[0];
      if (file && payload.kind === 'message') {
        if (file.size > 5 * 1024 * 1024) {
          return show(`That file is ${fileSizeLabel(file.size)}. The limit is 5 MB.`);
        }
        show('Uploading the attachment…');
        const bytes = new Uint8Array(await file.arrayBuffer());
        const meta = await api(`/mail-templates/${encodeURIComponent(saved.id)}/attachment`, {
          method: 'PUT',
          body: JSON.stringify({ name: file.name, type: file.type, data: base64Std(bytes) }),
        });
        await api('/mail-templates', { method: 'PUT', body: JSON.stringify({ ...saved, ...meta }) });
      } else if (clearAttachment) {
        await api('/mail-templates', { method: 'PUT', body: JSON.stringify({
          ...saved, attachmentKey: null, attachmentName: null,
          attachmentSize: null, attachmentType: null }) });
      }
      // Confirm the server kept what was sent. A PUT that answers 200 with different text is
      // not a save, and this screen must not report one.
      if (!saved || saved.subject !== payload.subject || saved.body !== payload.body) {
        return show('The server did not store this text unchanged. Nothing has been saved — try again.');
      }
      close();
      renderMailingScreen('templates');
    } catch (e) {
      show(e.message || 'Could not save.');
    }
  });
}

// A statement goes to its merchant's finance address. It can instead go to an ASSIGNED
// address, chosen once at the top of the screen — a per-row button was tried and made the
// table unreadable, 106 identical buttons deep.
//
// Reset on every visit to this screen. An assignment left on from yesterday, silently
// redirecting a real send, is the one thing this must never do — so it cannot outlive the
// visit that set it.
let MAIL_ASSIGNED = [];

function effectiveRecipients(contractId) {
  return MAIL_ASSIGNED.length ? MAIL_ASSIGNED.slice() : mailRecipients(contractId);
}

// ── Mailing → Send: the monthly job on one screen ──────────────────────────────────────────
// Pick a month, pick a template, work down the list. Three groups, because they need three
// different things from you: Ready is work, Already sent is a record, and No address is a gap
// in the merchant list that no amount of mailing will fix — 266 of 304 merchants today.
//
// Still ONE MERCHANT AT A TIME. The list makes the job findable; it does not make it bulk.
async function renderMailSendTab(host) {
  host.innerHTML = '<p class="muted">Loading…</p>';
  let templates;
  try {
    templates = await loadMailTemplates();
  } catch (e) {
    host.innerHTML = `<p class="nm-err">Could not load this screen: ${escape(e.message)}</p>`;
    return;
  }
  if (!templates.length) {
    host.innerHTML = '<p class="muted">No mail template yet. Add one under <strong>Templates</strong> — '
      + 'the template decides what is sent and what this screen needs to ask you.</p>';
    return;
  }
  // STEP ONE, on its own. What the template IS decides everything below it: a statement needs a
  // period because it attaches one merchant's figures for that period; a plain message needs
  // neither, and asking for a period there is noise.
  host.innerHTML = `
    <div class="mail-form" style="max-width:420px;">
      <label><span>1 · Template</span><select id="msend-tpl">
        <option value="" selected>Choose a template…</option>
        ${templates.map((t, i) =>
        `<option value="${i}">${escape(t.name || t.subject || 'Untitled')} — ${escape(MAIL_KINDS[mailKind(t)].label)}</option>`).join('')}</select></label>
    </div>
    <div id="msend-step2"></div>`;
  // Nothing is chosen for you. What the template IS decides whether a period is even
  // meaningful, so until one is picked there is nothing honest to show — an auto-selected
  // first template would also mean one click from landing on this screen to sending a real
  // merchant a real statement.
  const onTemplate = () => {
    const step2 = document.getElementById('msend-step2');
    const raw = document.getElementById('msend-tpl').value;
    if (raw === '') {
      step2.innerHTML = '<p class="muted">Choose a template to continue. '
        + 'What it is decides what comes next — a statement needs a period, a plain message does not.</p>';
      return;
    }
    const t = templates[Number(raw)];
    if (mailKind(t) === 'message') renderMessageSend(step2, t);
    else renderStatementSend(step2, t);
  };
  host.querySelector('#msend-tpl').addEventListener('change', onTemplate);
  onTemplate();
}

// A STATEMENT: attaches each merchant's own figures, so it needs a period, and the list is the
// merchants that run paid.
async function renderStatementSend(host, template) {
  host.innerHTML = '<p class="muted">Loading…</p>';
  const runs = await api('/bulk-runs').catch(() => []);
  if (!runs.length) {
    host.innerHTML = '<p class="muted">This template attaches a statement, and no run has been '
      + 'computed yet — so there is nothing to attach.</p>';
    return;
  }
  runs.sort((a, b) => (b.periodStart || '').localeCompare(a.periodStart || ''));
  MAIL_ASSIGNED = [];
  host.innerHTML = `
    <div class="mail-form" style="display:grid;grid-template-columns:1fr 1.4fr;gap:0 14px;max-width:760px;">
      <label><span>2 · Period</span><select id="msend-run">${runs.map(r =>
        `<option value="${escape(r.runId)}">${escape(periodTag(r.periodStart))}</option>`).join('')}</select></label>
      <label><span>3 · Send to</span><select id="msend-mode">
        <option value="merchant">Each merchant’s own finance address</option>
        <option value="assigned">An assigned address…</option>
      </select></label>
    </div>
    <div id="msend-assign" hidden>
      <div class="mail-form" style="max-width:760px;">
        <label><span>Assigned address</span>
          <input id="msend-addr" placeholder="one or more addresses, separated by commas — every statement goes here"></label>
      </div>
    </div>
    <div id="msend-banner"></div>
    <div id="msend-progress"></div>
    <div id="msend-list">Loading…</div>`;
  const draw = () => drawMailSendList(document.getElementById('msend-run').value, template);
  host.querySelector('#msend-run').addEventListener('change', draw);
  host.querySelector('#msend-mode').addEventListener('change', (ev) => {
    const on = ev.target.value === 'assigned';
    document.getElementById('msend-assign').hidden = !on;
    if (!on) { MAIL_ASSIGNED = []; document.getElementById('msend-addr').value = ''; }
    draw();
  });
  host.querySelector('#msend-addr').addEventListener('input', (ev) => {
    MAIL_ASSIGNED = splitAddresses(ev.target.value);
    draw();
  });
  draw();
}

// A PLAIN MESSAGE: no attachment, no run, no period. Just who it goes to and what it says. Each
// recipient gets their OWN message — one mail addressed to thirty merchants would show every
// one of them the others' addresses.
async function renderMessageSend(host, template) {
  await ensureContractCache().catch(() => {});
  const cc = mailCc(template);
  const entities = entityOptions(CONTRACTS, ENTITIES);
  // The subject a payment schedule wants carries {{period}}, and this path has no run to read one
  // from — so it is asked for. Defaults to LAST month: a schedule or a statement is written about
  // a period that has closed, never the one still running.
  const lastMonth = (() => {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  })();
  host.innerHTML = `
    <div class="mail-form" style="max-width:760px;">
      <div class="mail-row">
        <label><span>2 · Period</span><input type="month" id="mmsg-period" value="${escape(lastMonth)}"></label>
        <label><span>Send to</span><select id="mmsg-mode">
          <option value="typed">The addresses I type</option>
          <option value="paid">Every merchant paid in this period</option>
        </select></label>
      </div>
      <div id="mmsg-typed">
      <div class="mail-row">
        <label><span>3 · Contract entity</span>
          <input id="mmsg-entity" list="mmsg-entities" placeholder="type to filter, or leave blank">
          <datalist id="mmsg-entities">${entities.map(e =>
            `<option value="${escape(e)}"></option>`).join('')}</datalist></label>
      </div>
      <p class="mail-hint" id="mmsg-entity-note" style="margin:-4px 0 12px;">Pick an entity to fill
        in its finance addresses below, or just type the addresses yourself.</p>
      <label><span>4 · Addresses</span>
        <input id="mmsg-to" placeholder="one or more addresses, separated by commas"></label>
      <p class="mail-meta" id="mmsg-count" style="margin:-9px 0 14px;"></p>
      </div>
      <label><span>5 · Subject</span><input id="mmsg-subject" value=""></label>
      <label><span>Message</span><textarea id="mmsg-body"></textarea></label>
      <label><span>Attach files</span><input type="file" id="mmsg-files" multiple></label>
      <p class="mail-hint" id="mmsg-files-note" style="margin:-4px 0 12px;">Optional, for this send
        only — nothing is saved to the template. Up to ${escape(fileSizeLabel(MAX_SEND_ATTACHMENTS))} in total.</p>
      <p class="mail-meta">From ${escape(mailFromAlias(template) || '— no sender address —')}
        ${cc ? `· cc <strong>${escape(cc)}</strong>` : ''}
        · ${template.attachmentName
            ? `attaching <strong>${escape(template.attachmentName)}</strong> (${escape(fileSizeLabel(template.attachmentSize))})`
            : 'no attachment from the template'}
        · each recipient gets their own copy, so nobody sees the others.</p>
      <p class="nm-err" id="mmsg-err" hidden></p>
    </div>
    <div id="mmsg-paid" hidden style="max-width:760px;"></div>
    <div class="mail-actions" style="max-width:760px;">
      <button id="mmsg-send" class="btn-primary" disabled>Send</button>
    </div>`;

  // Subject and body are regenerated from the template as the period/entity change, but ONLY
  // while they still hold what we last generated. The moment someone edits either by hand, their
  // wording wins — re-rendering over a typed correction is the rude version of being helpful.
  const subjEl = host.querySelector('#mmsg-subject'), bodyEl = host.querySelector('#mmsg-body');
  const modeEl = host.querySelector('#mmsg-mode');
  const isPaidMode = () => modeEl.value === 'paid';
  let lastGen = { subject: null, body: null };
  const fillText = () => {
    // SENDING TO EVERY PAID MERCHANT, the message is rendered once PER RECIPIENT, so {{merchant}}
    // has a different answer for each of them and no single answer here. Leaving those two out of
    // `vars` makes renderTemplate leave the tokens alone (its rule for an unknown placeholder),
    // so the box shows `เรียน {{merchant}}` — which is the truth — instead of `เรียน` followed by
    // nothing, which read as a template that had lost the name.
    //
    // They are still filled for a typed list, where one wording goes to everyone named.
    const entity = host.querySelector('#mmsg-entity').value.trim();
    const vars = isPaidMode()
      ? { period: host.querySelector('#mmsg-period').value.trim() }
      : {
      merchant: entity,
      entity: entity,
      period: host.querySelector('#mmsg-period').value.trim(),
    };
    const nextSubject = renderTemplate(template.subject, vars);
    const nextBody = renderTemplate(template.body || '', vars);
    if (subjEl.value === (lastGen.subject ?? '')) subjEl.value = nextSubject;
    if (bodyEl.value === (lastGen.body ?? '')) bodyEl.value = nextBody;
    lastGen = { subject: nextSubject, body: nextBody };
  };
  fillText();

  // Choosing an entity ADDS its addresses; it never clears what is already typed. The merchants
  // under it with no finance address are named, because "3 of 5 addressed" is the useful fact and
  // silently sending to three is not.
  const onEntity = () => {
    const note = host.querySelector('#mmsg-entity-note');
    const name = host.querySelector('#mmsg-entity').value.trim();
    fillText();
    if (!name) {
      note.textContent = 'Pick an entity to fill in its finance addresses below, or just type the addresses yourself.';
      return;
    }
    const { addresses, withAddress, withoutAddress } = addressesForEntity(CONTRACTS, name, ENTITIES);
    const toEl = host.querySelector('#mmsg-to');
    const already = new Set(splitAddresses(toEl.value).map(a => a.toLowerCase()));
    const added = addresses.filter(a => !already.has(a.toLowerCase()));
    if (added.length) toEl.value = [...splitAddresses(toEl.value), ...added].join(', ');
    refresh();
    if (!withAddress.length && !withoutAddress.length) {
      note.innerHTML = `<span class="rc-warn">No live merchant is under “${escape(name)}”.</span>`;
      return;
    }
    note.innerHTML = `${withAddress.length} merchant${withAddress.length === 1 ? '' : 's'} `
      + `under “${escape(name)}” with a finance address`
      + (added.length ? ` — added ${added.length}` : ' — already listed')
      + (withoutAddress.length
          ? `. <span class="rc-warn">${withoutAddress.length} with none: `
            + `${escape(withoutAddress.slice(0, 6).join(', '))}`
            + `${withoutAddress.length > 6 ? `, and ${withoutAddress.length - 6} more` : ''}.</span>`
          : '.');
  };

  // Whatever is typed, restated as the app reads it — an address it rejected (a space in it,
  // say) would otherwise look accepted right up to the moment nothing arrives.
  const typed = () => splitAddresses(host.querySelector('#mmsg-to').value);
  const refresh = () => {
    const list = typed();
    const raw = host.querySelector('#mmsg-to').value.trim();
    const dropped = raw ? raw.split(/[;,]/).map(a => a.trim()).filter(Boolean).length - list.length : 0;
    host.querySelector('#mmsg-count').innerHTML = list.length
      ? `${list.length} recipient${list.length === 1 ? '' : 's'}: ${escape(list.join(', '))}`
        + (dropped ? ` · <span class="rc-warn">${dropped} entr${dropped === 1 ? 'y is' : 'ies are'} not a valid address and will be ignored</span>` : '')
      : (raw ? '<span class="rc-warn">none of that is a valid address</span>' : 'nobody yet');
    host.querySelector('#mmsg-send').disabled = !list.length;
  };
  let paid = null;                 // { run, plan, ccy } once a period with a run is chosen

  async function onMode() {
    const on = isPaidMode();
    host.querySelector('#mmsg-typed').hidden = on;
    host.querySelector('#mmsg-paid').hidden = !on;
    const btn = host.querySelector('#mmsg-send');
    if (!on) { paid = null; refresh(); btn.textContent = 'Send'; return; }
    btn.disabled = true; btn.textContent = 'Loading…';
    paid = await drawSchedulePaidList(host, template, host.querySelector('#mmsg-period').value);
    const n = paid?.plan.ready.length || 0;
    btn.disabled = !n;
    btn.textContent = n ? `Send to all ${n}` : 'Nothing to send';
  }

  host.querySelector('#mmsg-to').addEventListener('input', refresh);
  host.querySelector('#mmsg-entity').addEventListener('change', onEntity);
  modeEl.addEventListener('change', () => { fillText(); onMode(); });
  host.querySelector('#mmsg-period').addEventListener('change', () => { fillText(); if (isPaidMode()) onMode(); });
  // States the total as files are chosen, and refuses over the cap HERE rather than after the
  // Gmail token has been asked for — being told the file is too big is not a reason to have
  // granted send permission first.
  host.querySelector('#mmsg-files').addEventListener('change', () => {
    const chosen = [...(host.querySelector('#mmsg-files').files || [])];
    const note = host.querySelector('#mmsg-files-note');
    const total = chosen.reduce((n, f) => n + f.size, 0);
    if (!chosen.length) {
      note.innerHTML = `Optional, for this send only — nothing is saved to the template. `
        + `Up to ${escape(fileSizeLabel(MAX_SEND_ATTACHMENTS))} in total.`;
    } else if (total > MAX_SEND_ATTACHMENTS) {
      note.innerHTML = `<span class="rc-warn">${chosen.length} file(s), ${escape(fileSizeLabel(total))} `
        + `— over the ${escape(fileSizeLabel(MAX_SEND_ATTACHMENTS))} limit. Remove something before sending.</span>`;
    } else {
      note.innerHTML = `Attaching ${chosen.length} file(s), ${escape(fileSizeLabel(total))}: `
        + escape(chosen.map(f => f.name).join(', '));
    }
    refresh();
  });
  refresh();

  host.querySelector('#mmsg-send').addEventListener('click', async () => {
    const btn = host.querySelector('#mmsg-send'), err = host.querySelector('#mmsg-err');
    const was = btn.textContent;
    const list = typed();
    const from = mailFromAlias(template);
    if (!from) { err.hidden = false; err.textContent = 'This template has no sender address.'; return; }

    // Checked before the token is requested, and against the files about to be read rather than
    // what the note last rendered.
    const chosen = [...(host.querySelector('#mmsg-files').files || [])];
    const chosenTotal = chosen.reduce((n, f) => n + f.size, 0);
    if (chosenTotal > MAX_SEND_ATTACHMENTS) {
      err.hidden = false;
      err.textContent = `Those ${chosen.length} file(s) come to ${fileSizeLabel(chosenTotal)}. `
        + `The limit is ${fileSizeLabel(MAX_SEND_ATTACHMENTS)}.`;
      return;
    }
    // Asked for while the click is still live — see gmailToken.
    const tokenReady = gmailToken();

    // ── Send to every merchant a period paid ──────────────────────────────────────────────
    if (isPaidMode()) {
      if (!paid?.plan.ready.length) return;
      const { run, plan, ccy } = paid;
      // The first line as the first recipient will actually read it. The box shows the token,
      // which is honest but not legible — this is the one place to see the rendered thing before
      // 58 people get it.
      const sampleVars = mailVarsFor(plan.ready[0], run);
      const sample = renderTemplate(bodyEl.value, sampleVars).split('\n').find(l => l.trim()) || '';
      if (!confirm(
          `Send this notice to ${plan.ready.length} merchant(s)?\n\n`
          + `Period:   ${periodMonth(run.periodStart)}\n`
          + `Opens:    "${sample.trim().slice(0, 70)}"  — filled in per recipient\n`
          + `Who:      every merchant with a share that month — ${fmt2(plan.total)} ${ccy} between them\n`
          + `To:       each merchant's own finance address${cc ? `, copying ${cc}` : ''}\n`
          + `Attached: ${template.attachmentName || 'NOTHING — the template has no file'}${chosen.length ? ` + ${chosen.length} file(s)` : ''}\n\n`
          + `Each merchant is written to on its own. This cannot be unsent.`)) return;
      try { await tokenReady; } catch (e) { err.hidden = false; err.textContent = e.message; return; }
      btn.disabled = true; err.hidden = true;
      const files = await collectAttachments(template, chosen, btn, err);
      if (!files) { btn.disabled = false; btn.textContent = was; return; }

      let n = 0;
      for (const r of plan.ready) {
        btn.textContent = `Sending ${n + 1} of ${plan.ready.length}…`;
        // From the BOX, not the stored template: whatever is on screen is what goes out. This
        // read `template.body`, so a correction typed before pressing Send was dropped without
        // a word. The box keeps its {{merchant}} token (see fillText), so it is still a template
        // and still renders per recipient.
        const vars = mailVarsFor(r, run);
        const subject = renderTemplate(subjEl.value, vars);
        const body = renderTemplate(bodyEl.value, vars);
        try {
          const sent = await sendGmail(buildMimeMessage({
            from, to: r.to, cc, subject, body, attachments: files }));
          // Recorded BEFORE moving on, so a batch that stops half way leaves an accurate trail.
          await api(`/bulk-runs/${encodeURIComponent(run.runId)}/mail-log`, { method: 'POST',
            body: JSON.stringify({ contractId: r.contractId, merchantName: r.merchantName,
              to: r.to.join(', '), cc: cc || null, subject,
              attachment: template.attachmentName || null, gmailId: sent.id, fromAlias: from,
              templateId: template.id, period: periodTag(run.periodStart),
              payout: Number(r.payout) || 0 }) }).catch(() => {});
          n++;
        } catch (e) {
          err.hidden = false;
          err.textContent = `Sent ${n} of ${plan.ready.length}. Stopped at ${r.merchantName}: ${e.message}`;
          btn.disabled = false; btn.textContent = was;
          await onMode();
          return;
        }
      }
      btn.textContent = `Sent ${n}`;
      await onMode();
      return;
    }

    if (!confirm(`Send this message to ${list.length} recipient(s)`
        + `${cc ? `, copying ${cc}` : ''}`
        + `${chosen.length ? `, attaching ${chosen.length} file(s)` : ''}? It cannot be unsent.`)) return;
    try {
      await tokenReady;
    } catch (e) {
      err.hidden = false; err.textContent = e.message;
      return;
    }
    btn.disabled = true; err.hidden = true;

    const files = await collectAttachments(template, chosen, btn, err);
    if (!files) { btn.disabled = false; btn.textContent = was; return; }

    let sentCount = 0;
    for (const to of list) {
      btn.textContent = `Sending ${sentCount + 1} of ${list.length}…`;
      try {
        await sendGmail(buildMimeMessage({
          from, to: [to], cc,
          subject: host.querySelector('#mmsg-subject').value,
          body: host.querySelector('#mmsg-body').value,
          attachments: files,
        }));
        sentCount++;
      } catch (e) {
        // Stop at the first failure rather than ploughing on: the rest can be retried, and a
        // half-sent batch nobody was told about is worse than a short one.
        err.hidden = false;
        err.textContent = `Sent ${sentCount} of ${list.length}. Stopped at ${to}: ${e.message}`;
        btn.disabled = false; btn.textContent = 'Send';
        return;
      }
    }
    btn.textContent = `Sent to ${sentCount}`;
  });
}

// Groups a run's results into what actually gets POSTED: one letter per contract entity, every
// brand under it listed, every statement attached. Keyed on the entity NAME because that is what
// is settled with — two brands linked to the same ENTITY record resolve to the same name.
//
// A brand with no entity is its own group: merging those on a blank key would put unrelated
// companies in one envelope, which is the one mistake this must never make.
//
// "Already sent" is true only when EVERY brand in the group has been sent, so a group half-sent
// by an earlier partial run still appears, with the rest to go.
const groupKey = (g) => g.results.map(r => r.contractId).join(',');

function groupResultsForMail(results, sent) {
  const groups = new Map();
  for (const r of results.slice().sort((a, b) => b.payout - a.payout)) {
    const entity = contractEntityFor(r.contractId) || '';
    const key = entity ? 'e:' + entity.toLowerCase() : 'c:' + r.contractId;
    if (!groups.has(key)) {
      groups.set(key, { entity, brands: [], results: [], payout: 0, to: [], gone: [],
                        sentAt: null, unsent: [] });
    }
    const g = groups.get(key);
    g.brands.push(r.merchantName);
    g.results.push(r);
    g.payout += Number(r.payout) || 0;
    if (brandIsGone(r.merchantName)) g.gone.push(r.merchantName);
    const m = sent.get(r.contractId);
    if (m) { if (!g.sentAt || m.sentAt > g.sentAt) g.sentAt = m.sentAt; }
    else g.unsent.push(r);
    for (const a of effectiveRecipients(r.contractId)) {
      if (!g.to.some(x => x.toLowerCase() === a.toLowerCase())) g.to.push(a);
    }
  }
  // Half-sent is not sent: the brands still owed a statement keep the group in the list.
  for (const g of groups.values()) if (g.unsent.length) g.sentAt = null;
  return [...groups.values()].sort((a, b) => b.payout - a.payout);
}

async function drawMailSendList(runId, template) {
  const box = document.getElementById('msend-list');
  if (!box) return;
  box.innerHTML = '<p class="muted">Loading…</p>';
  const [run, log] = await Promise.all([
    api('/bulk-runs/' + encodeURIComponent(runId)),
    api(`/bulk-runs/${encodeURIComponent(runId)}/mail-log`).catch(() => []),
  ]);
  await ensureContractCache().catch(() => {});
  const sent = new Map((log || []).map(m => [m.contractId, m]));

  const banner = document.getElementById('msend-banner');
  if (banner) {
    const assignedOn = !document.getElementById('msend-assign')?.hidden;
    banner.innerHTML = !assignedOn ? '' : MAIL_ASSIGNED.length
      ? `<p class="mail-warn" style="max-width:920px;">Every statement below goes to
          <strong>${escape(MAIL_ASSIGNED.join(', '))}</strong> — not to the merchants.</p>`
      : `<p class="mail-warn" style="max-width:920px;">No assigned address yet. Type one above,
          or switch back to each merchant’s own address.</p>`;
  }

  // C5b (2026-10-01): "when mailing rev share, send by entity instead of brand name, but when I
  // select, note the brands name after each entity." A payout is settled with the entity, and one
  // entity holding eight brands used to mean eight separate letters to the same finance team.
  //
  // One row per entity, carrying every brand under it and every statement with it. A brand with
  // no entity stands alone — nothing is merged on a blank, which would put unrelated companies in
  // one envelope.
  const grouped = groupResultsForMail(run.results || [], sent);

  const ready = [], done = [], noFinance = [];
  for (const g of grouped) {
    if (g.sentAt) done.push(g);
    else if (g.to.length) ready.push(g);
    else noFinance.push(g);
  }

  const row = (g, extra, actions = '') => `<tr>
    <td><strong>${escape(g.entity || g.brands[0])}</strong>${g.entity ? '' :
        ' <span class="muted" title="No contract entity is set, so this brand is written to on its own">no entity</span>'}</td>
    <td>${g.brands.map(b => escape(b)).join('<br>')}${g.gone.length
        ? ` <span class="rc-warn" title="Your latest file no longer carries ${escape(g.gone.join(', '))}">gone</span>` : ''}</td>
    <td class="rc-c-money">${fmt2(g.payout)}</td>
    <td class="msend-to">${extra}</td>
    <td class="msend-actions">${actions}</td></tr>`;

  // What is left, in one line, so the state of the month is readable without counting rows.
  const progress = document.getElementById('msend-progress');
  if (progress) {
    const total = ready.length + done.length + noFinance.length;
    progress.innerHTML = `<p class="msend-progress">
      <strong>${done.length} of ${total} sent</strong> for ${escape(periodTag(run.periodStart))}
      · <strong>${ready.length}</strong> still to send
      ${noFinance.length ? `· <strong>${noFinance.length}</strong> cannot be sent yet` : ''}
      ${ready.length === 0 && done.length ? '· <span class="msend-done">this period is complete</span>' : ''}
    </p>`;
  }

  const section = (title, rows, tone, body, action = '') => rows.length ? `
    <section style="margin-top:18px;">
      <h3 style="display:flex;align-items:baseline;gap:10px;margin:0 0 6px;font-size:14px;">
        ${escape(title)} <span class="rc-count">${rows.length}</span>${action}</h3>
      <table class="ts msend-table"><thead><tr>
        <th>Contract entity</th><th>Brands</th><th class="rc-c-money">Payout</th>
        <th>${escape(tone)}</th><th></th>
      </tr></thead><tbody>${body}</tbody></table>
    </section>` : '';

  box.innerHTML =
    section('Ready to send', ready, 'To', ready.map(g => row(g,
      escape(g.to.join(', ')),
      `<button class="btn-ghost mprev-btn" data-cids="${escape(groupKey(g))}">Preview</button>
       <button class="btn-ghost msend-btn" data-cids="${escape(groupKey(g))}">Send…</button>`)).join(''),
      `<button id="msend-all" class="btn-primary" style="margin-left:auto;font-size:13px;"
         title="Send every letter in this section, one after another. Each one is checked exactly as a single send is.">Send all…</button>`)
    + section('Already sent', done, 'Sent', done.map(g => {
        const m = sent.get(g.results[0].contractId) || {};
        return row(g,
          `${escape(g.sentAt ? new Date(g.sentAt).toLocaleString('en-GB',
             { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '')}
           to ${escape(m.to || g.to.join(', '))} <span class="muted">by ${escape(m.sentBy || '')}</span>`,
          `<button class="btn-ghost mprev-btn" data-cids="${escape(groupKey(g))}">Preview</button>
           <button class="btn-ghost msend-btn" data-cids="${escape(groupKey(g))}">Send again…</button>`);
      }).join(''))
    + section('No finance email', noFinance, 'What is on file', noFinance.map(g => {
        const r = g.results[0];
        const other = fallbackContact(r.contractId);
        const broken = [...malformedAddresses((CONTRACTS.find(x => x.contractId === r.contractId) || {}).financeContactEmail),
                        ...malformedAddresses((CONTRACTS.find(x => x.contractId === r.contractId) || {}).contactEmail)];
        // The button belongs INSIDE the row's last cell. Appending it after row(...) put it
        // after the closing </tr>, and a browser hoists non-cell content out of a table — so
        // 106 loose buttons rendered as a grid and took their rows with them.
        const why = broken.length
          ? `<span class="rc-warn">${escape(broken.join(', '))} is not a valid address — fix it on the Overview</span>`
          : other.length
          ? `<span class="muted">contact email: ${escape(other.join(', '))} — copy it into
             <strong>Finance email</strong> on the Overview if that is the right person</span>`
          : '<span class="muted">no address at all — add a finance email on the Overview</span>';
        return row(g, why);
      }).join(''))
    + (ready.length || done.length || noFinance.length ? '' : '<p class="muted">This run paid nobody.</p>');

  const groupOf = (b) => {
    const ids = String(b.dataset.cids || '').split(',').filter(Boolean);
    return grouped.find(g => g.results.length === ids.length
                          && g.results.every(r => ids.includes(r.contractId)));
  };
  const sendAllBtn = box.querySelector('#msend-all');
  if (sendAllBtn) sendAllBtn.addEventListener('click', () => sendAllReady(
    ready, run, template, () => drawMailSendList(runId, template)));

  box.querySelectorAll('.msend-btn').forEach(b => b.addEventListener('click', () => {
    const g = groupOf(b);
    if (g) mailSendDialog(g, run, g.sentAt, template);
  }));
  box.querySelectorAll('.mprev-btn').forEach(b => b.addEventListener('click', () => {
    // Preview shows the letter, which is written once per entity — so the first brand's figures
    // stand in for the wording and the rest are named beside it.
    const g = groupOf(b);
    if (g) mailPreviewDialog(g.results[0], run, template, g.sentAt);
  }));
}

// The orders behind a run, attributed to the merchant that was paid for them — the input the
// per-merchant statement needs for its rental-by-rental block. Extracted so the EMAILED
// statement and the DOWNLOADED one are built from the same thing: the mail used to pass `null`
// here and attach a summary-only sheet while its own wording promised "every rental in the
// period". A merchant comparing the file to the letter would have found the letter wrong.
//
// Several MB, so it is fetched once per run and kept. A run created before 2026-09-01 stored no
// order detail (§1j) and returns null orders — the sheet then carries the summary block and
// says so, which is a fact about that run rather than a fault here.
const RUN_ORDER_INDEX = new Map();

async function runOrderIndex(run) {
  if (RUN_ORDER_INDEX.has(run.runId)) return RUN_ORDER_INDEX.get(run.runId);
  let orders = null, ordersError = null;
  try {
    // PAGED, because a month of orders is ~10 MB and API Gateway's response ceiling is 10 MB.
    // `total` comes back on every page, so a short read is an error rather than a quietly
    // incomplete statement.
    const PAGE = 5000;
    const got = [];
    let total = 0;
    for (let offset = 0; ; offset += PAGE) {
      const page = await api(`/bulk-runs/${encodeURIComponent(run.runId)}/inputs`
                             + `?offset=${offset}&limit=${PAGE}`);
      total = Number(page?.total) || 0;
      const rows = Array.isArray(page?.orders) ? page.orders : [];
      // The parser kept no rental times before 2026-09-01, so those runs have orders but nothing
      // to list per rental. One page is enough to know — don't fetch 28,000 rows to find out.
      if (!offset && total && !rows.some(o => o.rentalTime != null)) { got.length = 0; break; }
      got.push(...rows);
      if (!rows.length || got.length >= total) break;
    }
    if (total && got.length && got.length < total) {
      throw new Error(`only ${got.length} of ${total} rentals could be loaded`);
    }
    if (got.length) orders = got;
    else ordersError = 'predates';        // a real run from before the detail was kept
  } catch (e) {
    // NOT the same thing as an old run, and saying so is what went wrong: September's inputs
    // were 10.4 MB, the request failed, and every statement claimed the run was too old.
    ordersError = /409|no_stored_inputs/.test(e.message || '')
      ? 'predates'
      : (e.message || e.name || 'unknown error');
    console.warn('order detail unavailable for', run.runId, e);
  }

  const contractOfStore = new Map();
  const kaByStore = new Map();
  for (const r of run.results || []) {
    for (const m of r.merchants || []) {
      const k = String(m.merchantName || '').toLowerCase().trim();
      if (!k) continue;
      contractOfStore.set(k, r.contractId);
      kaByStore.set(k, r.merchantName);
    }
  }
  for (const m of run.matchedByMachine || []) {
    const to = contractOfStore.get(String(m.rosterName || '').toLowerCase().trim());
    if (to) contractOfStore.set(String(m.orderName || '').toLowerCase().trim(), to);
  }
  for (const m of run.matchedByAlias || []) {
    contractOfStore.set(String(m.name || '').toLowerCase().trim(), m.contractId);
  }

  const ordersByContract = new Map();
  for (const o of orders || []) {
    const cid = contractOfStore.get(String(o.merchantName || '').toLowerCase().trim());
    if (!cid) continue;                      // unmatched — it belongs to no merchant statement
    if (!ordersByContract.has(cid)) ordersByContract.set(cid, []);
    ordersByContract.get(cid).push(o);
  }
  // Frozen at run time (§10.5). Editing a merchant's terms must not rewrite a statement for a
  // period that has already been paid.
  const index = { orders, ordersError, ordersByContract, kaByStore,
                  ruleSnapshots: run.ruleSnapshots || {} };
  if (!ordersError || ordersError === 'predates') RUN_ORDER_INDEX.set(run.runId, index);
  return index;
}

// One merchant's statement as a file, identical whether it is emailed or downloaded.
function statementWorkbook(result, index) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,
    buildPartnerSheet(XLSX, result, index.orders ? (index.ordersByContract.get(result.contractId) || []) : null,
                      index.kaByStore, index.ordersError,
                      (index.ruleSnapshots || {})[result.contractId],
                      goneMerchants(result)),
    sanitizeFilename(result.merchantName).replace(SHEET_SAFE, '-').slice(0, 31));
  return new Uint8Array(XLSX.write(wb, { bookType: 'xlsx', type: 'array' }));
}

// Nothing here is recoverable: a statement sent to the wrong merchant cannot be recalled, and
// the merchant who receives someone else's payout figures is the one who tells you about it.
// So the checks below run at the moment of sending, against the values actually about to be
// used — not against what the screen showed a minute ago.
//
// Returns a list of reasons this send must NOT happen. Empty means go.
// `allowed` is every address this LETTER may legitimately go to. For a single brand that is its
// own finance addresses; for an entity letter it is the union across the brands under it —
// `บริษัท เอ็มแอนด์ เอ็ม 2007 จำกัด` covers Song Wat Coffee and Someday in Copenhagen, and the
// address on file for one of them is the right address for the letter that carries both.
//
// It was NOT passed when entity grouping landed (2026-10-01), so each brand was checked against
// its own addresses while the recipients were the union — and any entity whose brands did not
// list identical addresses blocked itself. One did on the live September run, and under Send all
// it would have been skipped with only a line in the closing summary to say so.
function statementSendBlockers(result, run, recipients, attachmentFor, assigned, allowed) {
  const problems = [];

  // 1. The file must belong to the merchant named in the letter. Both come from `result`, so
  //    this can only fail if some future change threads a different row into one of them —
  //    which is exactly the change that would otherwise ship silently.
  if (attachmentFor !== result.contractId) {
    problems.push(`The attached file was built for a different merchant (${attachmentFor || 'unknown'}).`);
  }

  // 2. Unless this send was deliberately assigned elsewhere, every recipient must be one of
  //    THIS merchant's own finance addresses. Sending 7-Eleven's payout to IMPACT is the worst
  //    thing this screen could do, so the addresses are compared here rather than trusted from
  //    the row that was clicked.
  if (!assigned) {
    const own = new Set((allowed || mailRecipients(result.contractId)).map(a => a.toLowerCase()));
    const strangers = recipients.filter(a => !own.has(a.toLowerCase()));
    if (strangers.length) {
      problems.push(`${strangers.join(', ')} is not a finance address for `
        + `${allowed ? 'this letter' : result.merchantName}.`);
    }
  }

  if (!recipients.length) problems.push('There is no recipient.');
  if (!run || !run.runId) problems.push('This send is not attached to a run.');
  return problems;
}

// Exactly what this merchant would receive, with nothing to press by accident. The send dialog
// shows the same text, but it is a form with a Send button — reading fourteen of those to check
// the wording means fourteen chances to send one early. This is the reading view; Send is
// reached deliberately from it.
function mailPreviewDialog(result, run, template, sentAlready) {
  const vars = mailVarsFor(result, run);
  const to = mailRecipients(result.contractId);
  const subject = renderTemplate(template.subject, vars);
  const body = renderTemplate(template.body, vars);
  const unfilled = [...new Set((subject + '\n' + body).match(/\{\{\w+\}\}/g) || [])];
  const { card, close } = ctModal(760);
  card.innerHTML = `
    <h3 style="margin:0 0 4px;">Preview — ${escape(result.merchantName)}</h3>
    <p class="muted" style="margin:0 0 12px;font-size:12.5px;">Nothing is sent from this view.</p>
    ${sentAlready ? `<p class="mail-warn">Already sent ${escape(sentAlready)}.</p>` : ''}
    ${unfilled.length ? `<p class="mail-warn">This template still contains
      ${escape(unfilled.join(', '))} — the merchant would receive it literally. Fix the template
      before sending.</p>` : ''}
    <div class="mail-preview">
      <dl class="mail-preview-head">
        <dt>From</dt><dd>${escape(mailFromAlias(template) || '— no sender address —')}</dd>
        ${statementCc ? `<dt>Cc</dt><dd>${escape(statementCc)}</dd>` : ''}
        <dt>To</dt><dd>${to.length ? escape(to.join(', ')) : '<span class="rc-warn">nobody</span>'}</dd>
        <dt>Subject</dt><dd><strong>${escape(subject)}</strong></dd>
        <dt>Attached</dt><dd>${escape(sanitizeFilename(result.merchantName))}.xlsx
          <span class="muted">— this merchant’s statement for ${escape(vars.period)}</span>
          <div class="muted" id="mp-attach" style="font-size:12px;">checking what it contains…</div></dd>
      </dl>
      <pre class="mail-preview-body">${escape(body)}</pre>
    </div>
    <div class="mail-actions">
      <button id="mp-close" class="btn-ghost">Close</button>
      ${to.length ? '<button id="mp-send" class="btn-primary">Send this…</button>' : ''}
    </div>`;
  // Whether the file will carry the rental-by-rental block depends on the run: one created
  // before 2026-09-01 stored no order detail (§1j). Saying so here stops a covering letter
  // promising rows the file does not have.
  runOrderIndex(run).then((index) => {
    const el = card.querySelector('#mp-attach');
    if (!el) return;
    const rows = index.orders ? (index.ordersByContract.get(result.contractId) || []).length : 0;
    el.textContent = index.orders
      ? `summary plus ${rows} rental row${rows === 1 ? '' : 's'}`
      : 'summary only — this run predates stored order detail, so there are no rental rows';
  }).catch(() => {});

  card.querySelector('#mp-close').addEventListener('click', close);
  card.querySelector('#mp-send')?.addEventListener('click', () => {
    close();
    mailSendDialog(result, run, sentAlready, template);
  });
}

// ── Sending one merchant its statement ─────────────────────────────────────────────────────
// Deliberately ONE merchant at a time. Sending is outward-facing and cannot be undone, so the
// dialog shows the exact message — final subject, final body, every recipient, the attachment
// by name — and the operator presses Send on that, not on a list. A "send all" would be a
// different feature with a different confirmation, and is not built.
let MAIL_TEMPLATES = [];

// Throws rather than swallowing. The first version caught everything and returned [], so a
// backend fault rendered as "No templates yet" — indistinguishable from an empty list, and it
// hid a real 500 (a missing TableName) behind a sentence saying nothing was wrong.
async function loadMailTemplates() {
  MAIL_TEMPLATES = await api('/mail-templates');
  return MAIL_TEMPLATES;
}

// Who a statement comes from, by region. Every Thai template sends as the partner group, so it
// is the default rather than something to retype — a per-template field only because a Thai
// partner note and a Singapore one need not share a sender, not because anyone wants the choice
// each time. Singapore has no group address yet; a template there must name one or it cannot
// send, which is the right failure — silently borrowing Thailand's would put the wrong company
// in a merchant's inbox.
//
// Whoever is SIGNED IN is the account that sends; the alias only decides what the merchant
// sees. Both ozzie.wang@ and pavarisa.t@ have verified partner.th, so either produces identical
// mail. Gmail rejects an alias the signed-in account has not verified, and says so verbatim.
const DEFAULT_FROM_ALIAS = { th: 'partner.th@inforich.com', sg: '' };

// Finance is copied on the mail that quotes money — the rev-share statement and the payment
// schedule (user, 2026-09-29). Same shape as DEFAULT_FROM_ALIAS and for the same reason: SG has
// no agreed finance address yet, so it stays BLANK rather than borrowing Thailand's and quietly
// copying Bangkok on Singapore's mail. Only a NEW template is prefilled from this; an existing
// template's stored `cc` is used verbatim, so a blank one copies nobody.
const FINANCE_CC = { th: 'finance.th@inforich.com', sg: '' };

// Per-send attachments (2026-09-29). Gmail accepts ~25 MB of attachments, and base64 inflates the
// raw message by a third, so 15 MB of files is ~20 MB on the wire — comfortably inside, and far
// past anything finance actually sends. Nothing reaches API Gateway: the browser posts straight to
// Gmail, so the 10 MB limit of §1p does not apply here.
const MAX_SEND_ATTACHMENTS = 15 * 1024 * 1024;

// Falls back to the region default, so a template saved before the default existed — or one
// where the field was cleared — still sends rather than failing at the last step.
const mailFromAlias = (t) => ((t && t.fromAlias) || DEFAULT_FROM_ALIAS[REGION] || '').trim();

// Deliberately does NOT fall back to FINANCE_CC: a template with no `cc` copies nobody. Falling
// back would have copied finance on every plain message including the test one, and "always CC"
// means the two templates that quote money, not every mail the app can send.
function mailCc(t) {
  return String((t && t.cc) || '').trim();
}

// Takes a GROUP — one contract entity and every brand under it (C5b, 2026-10-01). A payout is
// settled with the entity, so one letter carries every statement it is owed; `Central Department
// Store` is one mail with eight files, not eight mails to the same finance team.
//
// A brand with no entity arrives here as a group of one, so the single-brand case is not a
// separate path that could drift from this one.
// ── SEND ALL (2026-10-02) ────────────────────────────────────────────────────────────────────
// "please add a button to send to all in ready to send section."
//
// The dangerous button on this screen. Every rule the single send follows is followed here, by
// going through the SAME prepare/deliver pair — one definition of what a letter is, so this
// cannot quietly send something the dialog would have refused.
//
// What it does differently, and on purpose:
//   • ONE confirmation up front, naming the count, the total payout and the period. Asking per
//     letter would defeat the button; asking nothing would be reckless.
//   • The Gmail token is taken on the CLICK, before any await — a browser only allows Google's
//     permission window while the gesture is live.
//   • The order index is fetched ONCE for the batch. It is several MB; per letter it would be
//     a hundred downloads.
//   • Sent one at a time, not in parallel: the progress line has to mean something, and a
//     failure must stop the rest rather than race them.
//   • A letter that is BLOCKED is skipped and named — the batch carries on. One merchant with
//     no finance email must not strand the other ninety.
//   • It stops on the first DELIVERY failure. A blocked letter is a known state; a failed send
//     is not, and continuing past it would make "how far did it get" unanswerable.
// Nothing is re-sent: the list it works from is `ready`, which already excludes everything in
// the mail log.
async function sendAllReady(ready, run, template, redraw) {
  // Read AT CLICK TIME, exactly as the dialog reads it when it opens — not captured when the
  // list was drawn. The list does redraw when the assigned address changes, so this is not a
  // live bug; it is one that a future refactor of that redraw would quietly create.
  const assign = MAIL_ASSIGNED.length > 0;
  const progress = document.getElementById('msend-progress');
  const btn = document.getElementById('msend-all');
  if (!ready.length) return;

  const total = ready.reduce((a, g) => a + (Number(g.payout) || 0), 0);
  const letters = ready.length;
  const brands = ready.reduce((a, g) => a + g.brands.length, 0);
  const ok = confirm(
    (assign ? `Send ALL ${letters} statements to an ASSIGNED address?\n`
            + `(not to the merchants themselves)\n\n`
            : `Send all ${letters} statements?\n\n`)
    + `Period:     ${periodTag(run.periodStart)}\n`
    + `Letters:    ${letters} (one per contract entity)\n`
    + `Brands:     ${brands}\n`
    + `Payout:     ${fmt2(total)} in total\n`
    + `To:         ${assign ? MAIL_ASSIGNED.join(', ') : 'each merchant\u2019s own finance address'}\n\n`
    + `They go out one after another and CANNOT BE UNSENT.`);
  if (!ok) return;

  // Before any await, while the click is still live.
  const tokenReady = gmailToken();
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
  const say = (html) => { if (progress) progress.innerHTML = `<p class="msend-progress">${html}</p>`; };

  const skipped = [], unlogged = [];
  let done = 0;
  try {
    await tokenReady;
    const index = await runOrderIndex(run);
    for (const g of ready) {
      const who = escape(g.entity || g.brands[0]);
      say(`Sending <strong>${done + 1} of ${letters}</strong> — ${who}…`);
      const recipients = assign ? MAIL_ASSIGNED : g.to;
      const vars = mailVarsForGroup(g, run);
      const subject = renderTemplate(template.subject, vars);
      const body = renderTemplate(template.body, vars);
      const letter = prepareStatementLetter({ group: g, run, template, index,
                                              subject, body, recipients, assign });
      if (letter.blockers.length) {
        skipped.push(`${g.entity || g.brands[0]} — ${letter.blockers.join(' ')}`);
        continue;
      }
      const out = await deliverStatementLetter({ group: g, run, template, letter,
                                                 subject, body, recipients, assign });
      if (out.unlogged.length) unlogged.push(...out.unlogged);
      done++;
    }
  } catch (e) {
    // Stop here, and say exactly how far it got — the rest have NOT gone out.
    say(`<span class="rc-warn">Stopped after ${done} of ${letters}</span> — ${escape(e.message)}.
         The remaining ${letters - done - skipped.length} have not been sent.`);
    alert(`Sending stopped after ${done} of ${letters}.\n\n${e.message}\n\n`
      + `The rest have NOT been sent. The list below shows what is left.`);
    await redraw();
    return;
  }
  if (btn) { btn.disabled = false; btn.textContent = 'Send all…'; }
  await redraw();
  // SAID FIRST, and on its own. These letters ARE with the merchant; the app simply failed to
  // write them down, so the list below will offer them again. Resending delivers a second copy.
  if (unlogged.length) {
    alert(`⚠ ${unlogged.length} statement(s) WERE SENT but could not be recorded:\n\n`
      + unlogged.slice(0, 20).join('\n')
      + (unlogged.length > 20 ? `\n…and ${unlogged.length - 20} more` : '')
      + `\n\nThey will still appear under "Ready to send". DO NOT send them again —`
      + ` the merchant already has them.`);
  }
  if (skipped.length) {
    alert(`Sent ${done} of ${letters}.\n\n${skipped.length} could not be sent:\n\n`
      + skipped.slice(0, 15).join('\n')
      + (skipped.length > 15 ? `\n…and ${skipped.length - 15} more` : ''));
  }
}

// ── ONE DEFINITION OF A STATEMENT LETTER (2026-10-02) ────────────────────────────────────────
// Two things can send: the per-entity dialog, and "Send all" on the Ready list. They must agree
// on every part of what goes out — the attachments, the blockers, the recipients, what lands in
// the mail log. A second copy of this would drift, and the drift would only be visible in a
// merchant's inbox.
//
// So: `prepareStatementLetter` works out what WOULD be sent and why it might not be, and sends
// nothing. `deliverStatementLetter` sends exactly that and records it. The confirmation in
// between belongs to the caller — the dialog asks per letter, Send all asks once.

// The placeholders for one entity's letter. Every figure that spans brands is the GROUP's:
// `mailVarsFor` answers for one brand, and this letter covers the whole entity.
function mailVarsForGroup(group, run) {
  const first = group.results[0];
  const groupRevenue = group.results.reduce((a, r) => a + (Number(r.revenue) || 0), 0);
  return { ...mailVarsFor(first, run),
           merchant: group.brands.join(', '),
           entity: group.entity || first.merchantName,
           revenue: fmt2(groupRevenue),
           sharePct: groupRevenue > 0 ? (group.payout / groupRevenue * 100).toFixed(1) + '%' : '—',
           payout: fmt2(group.payout) };
}

// `index` is the run's orders, fetched ONCE by the caller — it is several MB, so a loop over 100
// entities must not refetch it per letter.
function prepareStatementLetter({ group, run, template, index, subject, body, recipients, assign }) {
  const results = group.results;
  const from = mailFromAlias(template);
  const cc = mailCc(template);
  // One file per brand — the same workbook the download produces, from the same function.
  const files = results.map(r => ({
    filename: `${sanitizeFilename(r.merchantName)}.xlsx`,
    bytes: statementWorkbook(r, index),
  }));
  // Checked against what is about to be sent, for EVERY brand, so one unsendable statement stops
  // the letter rather than going out beside the others.
  // Every address any brand under this entity lists — the letter is addressed to the entity,
  // which owns all of them. A stranger from a DIFFERENT entity is still refused.
  const allowed = [...new Set(results.flatMap(r => mailRecipients(r.contractId)))];
  const blockers = results.flatMap(r =>
    statementSendBlockers(r, run, recipients, r.contractId, !!assign, allowed));
  if (!recipients.length) blockers.push('No recipient.');
  if (!from) blockers.push('This template has no sender alias. Set one under Mailing → Templates.');
  // An incomplete file must not be SENDABLE, not merely carry a warning inside it. The September
  // run's 10.4 MB inputs failed to load and statements went out with no rentals at all — the
  // letter promising "every rental in the period" is then simply untrue.
  if (index.ordersError && index.ordersError !== 'predates') {
    blockers.push(`The rentals could not be loaded for this run (${index.ordersError}),`
      + ` so the file would go out with no rental detail.`);
  }
  if (!String(subject || '').trim()) blockers.push('The subject is empty.');
  if (!String(body || '').trim()) blockers.push('The message is empty.');

  const rows = index.orders
    ? results.reduce((a, r) => a + (index.ordersByContract.get(r.contractId) || []).length, 0) : 0;
  return { files, filenames: files.map(f => f.filename).join(', '), rows, blockers, from, cc };
}

async function deliverStatementLetter({ group, run, template, letter, subject, body, recipients, assign }) {
  const sent = await sendGmail(buildMimeMessage({
    from: letter.from, to: recipients, cc: letter.cc, subject,
    // `filename` and `type`, which is what buildMimeMessage reads — `name` would have gone out as
    // `attachment` labelled application/octet-stream, unopenable as a spreadsheet.
    body, attachments: letter.files.map(f => ({
      filename: f.filename, bytes: f.bytes,
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })),
  }));
  // ONE LOG ROW PER BRAND, even though it was one letter: "already sent" is answered per brand,
  // and a group whose membership changes next month must not hide a brand that was never
  // written to.
  //
  // THE LOG WRITE MUST NEVER THROW (2026-10-02). Gmail has already accepted the message by this
  // line — the letter is OUT. If recording it then failed, the old code threw: the group came
  // back as unsent, and a retry delivered a SECOND copy to a real merchant. Over a batch of 66
  // one transient API error was enough.
  //
  // So it is retried, and if it still cannot be written the fact is RETURNED, not raised. The
  // callers say "sent but not recorded — do not resend", which is the only honest thing to say.
  const unlogged = [];
  for (const r of group.results) {
    const row = {
      // Enough to reconcile the Sent log against the run itself: which merchant, which period,
      // and what figure the letter quoted. Without the amount, "we sent it" cannot be checked
      // against "we sent the right one".
      contractId: r.contractId, merchantName: r.merchantName,
      entity: group.entity || null,
      to: recipients.join(', '), cc: letter.cc || null, subject,
      attachment: `${sanitizeFilename(r.merchantName)}.xlsx`,
      gmailId: sent.id, fromAlias: letter.from,
      period: periodTag(run.periodStart), payout: Number(r.payout) || 0,
      attachmentRows: letter.rows, assigned: !!assign,
    };
    let wrote = false;
    for (let attempt = 0; attempt < 3 && !wrote; attempt++) {
      try {
        await api(`/bulk-runs/${encodeURIComponent(run.runId)}/mail-log`,
                  { method: 'POST', body: JSON.stringify(row) });
        wrote = true;
      } catch (e) {
        console.warn('mail log write failed', r.merchantName, 'attempt', attempt + 1, e);
        if (attempt < 2) await new Promise(res => setTimeout(res, 400 * (attempt + 1)));
      }
    }
    if (!wrote) unlogged.push(r.merchantName);
  }
  return { sent, unlogged };
}

function mailSendDialog(group, run, sentAlready, template) {
  const results = group.results;
  const result = results[0];                 // what the wording is written from
  // Recipients come from the screen's one choice: the brands' own finance addresses, or the
  // assigned address typed at the top. Reading it here rather than taking it as an argument
  // means the dialog cannot disagree with the banner above it.
  const ownAddresses = group.to;
  const assign = MAIL_ASSIGNED.length > 0;
  const recipients = assign ? MAIL_ASSIGNED : group.to;
  const statementCc = mailCc(template);
  const { card, close } = ctModal(720);
  // EVERY TOTAL IN THIS LETTER IS THE ENTITY'S (2026-10-01). `mailVarsFor` answers for ONE brand,
  // and this letter covers the whole entity — so each figure that spans brands is recomputed over
  // the group. `payout` was already; `revenue` and `sharePct` were not, so an entity holding eight
  // brands would have stated the entity's payout against the FIRST brand's revenue, and the share
  // percentage of a letter that is not about one brand. No live template reads those two, which is
  // the only reason nothing went out wrong. Same shape as the statement bug of this morning: a
  // total that reconciles over one part and nothing else.
  const vars = mailVarsForGroup(group, run);

  if (!MAIL_TEMPLATES.length) {
    card.innerHTML = `<h3 style="margin:0 0 8px;">No mail template yet</h3>
      <p class="muted">An admin can add one under <strong>Settings → Mail templates</strong>.
      A template holds the subject and the wording; this dialog fills in the merchant, the
      period and the numbers.</p>
      <div style="text-align:right;margin-top:14px;"><button id="ms-close" class="btn">Close</button></div>`;
    card.querySelector('#ms-close').addEventListener('click', close);
    return;
  }

  // AN EMPTY FORM IS NOT A LETTER (2026-10-02). The dialog renders its subject and body from the
  // template; with no template it rendered two empty boxes and a live Send button, and the only
  // thing that said anything was wrong was that they were blank. One caller — the redraw after a
  // successful send — had been passing none, so the FIRST letter went out correct and every one
  // after it offered to go out empty.
  //
  // Refused here rather than papered over, because a blank subject reaching a merchant is worse
  // than a dialog that will not open.
  if (!template || !(String(template.subject || '').trim() || String(template.body || '').trim())) {
    card.innerHTML = `<h3 style="margin:0 0 8px;">The template did not load</h3>
      <p class="muted" style="font-size:13px;max-width:560px;">This letter would go out with no
      subject and no message. Close this and pick the template again at the top of the screen —
      nothing has been sent.</p>
      <div style="text-align:right;margin-top:14px;"><button id="ms-close" class="btn">Close</button></div>`;
    card.querySelector('#ms-close').addEventListener('click', close);
    return;
  }


  card.innerHTML = `
    <h3 style="margin:0 0 4px;">Send statement — ${escape(group.entity || result.merchantName)}</h3>
    <p class="muted" style="margin:0 0 10px;font-size:12.5px;">${escape(group.brands.join(' · '))}${
      group.brands.length > 1 ? ` — ${group.brands.length} statements, one letter` : ''}</p>
    <p class="muted" style="margin:0 0 12px;font-size:12.5px;">This goes to the merchant. It cannot be unsent.</p>
    ${sentAlready ? `<p class="mail-warn">Already sent ${escape(sentAlready)} — sending again delivers a second copy.</p>` : ''}
    <div class="mail-form">
      <fieldset class="mail-to">
        <legend>To</legend>
        <p style="margin:0;font-size:13px;">${escape(recipients.join(', ')) || '<span class="rc-warn">nobody</span>'}</p>
        <p class="mail-meta" style="margin:6px 0 0;">${assign
          ? `<span class="rc-warn">Assigned</span> — ${escape(group.entity || result.merchantName)}’s statement goes here
             instead of ${escape(ownAddresses.join(', ') || 'its own address, which is not set')}.
             Change it with “Send to” above.`
          : 'This merchant’s own finance address. Change it with “Send to” above.'}</p>
      </fieldset>
      <label><span>Subject</span><input id="ms-subject"></label>
      <label><span>Message</span><textarea id="ms-body"></textarea></label>
      <p class="mail-meta" id="ms-meta"></p>
      <p class="nm-err" id="ms-err" hidden></p>
      <div class="mail-actions">
        <button id="ms-cancel" class="btn-ghost">Cancel</button>
        <button id="ms-send" class="btn-primary">Send</button>
      </div>
    </div>`;

  const $ = (id) => card.querySelector(id);
  $('#ms-subject').value = renderTemplate(template.subject, vars);
  $('#ms-body').value = renderTemplate(template.body, vars);
  $('#ms-meta').textContent =
    `From ${mailFromAlias(template) || '(no sender address on this template)'}`
    + (statementCc ? ` · cc ${statementCc}` : '')
    // EVERY file, not `results[0]` — the send attaches one per brand, and this line promising a
    // single statement under an entity holding two was simply wrong about what was going out.
    + ` · attaching ${results.map(r => `${sanitizeFilename(r.merchantName)}.xlsx`).join(', ')}`;

  $('#ms-cancel').addEventListener('click', close);

  $('#ms-send').addEventListener('click', async () => {
    const btn = $('#ms-send'), err = $('#ms-err');
    const from = mailFromAlias(template);
    const fail = (m) => { err.hidden = false; err.textContent = m; btn.disabled = false; btn.textContent = 'Send'; };
    btn.disabled = true; btn.textContent = 'Sending…'; err.hidden = true;
    if (!recipients.length) return fail('No recipient chosen. Tick an address, or type one above.');
    if (!from) return fail('This template has no sender alias. Set one under Mailing → Templates.');
    // FIRST, before any await: this opens Google's permission window the first time, and a
    // browser only permits that while the click is still live.
    const tokenReady = gmailToken();
    try {
      await tokenReady;
      // Several MB. Fetched once here; "Send all" fetches it once for the whole batch.
      const index = await runOrderIndex(run);
      const subject = $('#ms-subject').value, body = $('#ms-body').value;
      const letter = prepareStatementLetter({ group, run, template, index,
                                              subject, body, recipients, assign });
      if (letter.blockers.length) return fail('Not sent — ' + letter.blockers.join(' '));

      const ok = confirm(
        (assign ? `Send to an ASSIGNED address?\n(not ${group.entity || result.merchantName}'s own)\n\n`
                : `Send this statement?\n\n`)
        + `Entity:     ${group.entity || '(none — this brand stands alone)'}\n`
        + `Brands:     ${group.brands.join(', ')}\n`
        + `Period:     ${periodTag(run.periodStart)}\n`
        + `Payout:     ${fmt2(group.payout)} ${vars.currency}\n`
        + `To:         ${recipients.join(', ')}\n`
        + (letter.cc ? `Cc:         ${letter.cc}\n` : '')
        + `From:       ${letter.from}\n`
        + `Attached:   ${letter.filenames} (${letter.rows ? letter.rows + ' rental rows' : 'summary only'})\n\n`
        + `This cannot be unsent.`);
      if (!ok) { btn.disabled = false; btn.textContent = 'Send'; return; }

      const out = await deliverStatementLetter({ group, run, template, letter,
                                                 subject, body, recipients, assign });
      if (out.unlogged.length) {
        alert(`⚠ This statement WAS SENT, but could not be recorded (${out.unlogged.join(', ')}).`
          + `\n\nIt will still appear under "Ready to send". Do not send it again —`
          + ` the merchant already has it.`);
      }
      close();
      // WITH THE TEMPLATE (2026-10-02). Without it every dialog opened after the first send had
      // an empty subject and an empty message — and nothing stopped you sending one.
      drawMailSendList(run.runId, template);
    } catch (e) {
      fail(e.message);
    }
  });
}

// ── Mail: templates, MIME, and sending through the operator's own Gmail (2026-09-25) ───────
// The app sends nothing server-side. The signed-in user's browser calls the Gmail API with
// `From:` set to a group address they have verified as a "send mail as" alias, so the mail
// genuinely comes from partner.th@inforich.com, lands in that person's Sent folder, and
// replies reach the whole group. No SES, no stored credentials, no domain verification.
//
// Gmail rejects a From: that is not a verified alias on that account — there is no app-side
// workaround, and that rejection is reported verbatim rather than translated.
function fileSizeLabel(bytes) {
  const n = Number(bytes) || 0;
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.send';

// A template's KIND decides what the send screen needs. A statement attaches one merchant's
// figures, so it needs a period and can use the run's numbers. A message attaches nothing and
// knows nothing about a run — asking for a period there is noise, and offering {{payout}} is a
// promise that cannot be kept.
const MAIL_KINDS = {
  statement: {
    label: 'Revenue-share statement',
    help: 'Attaches that merchant’s statement for a period, and can use the run’s figures.',
    needsPeriod: true,
  },
  message: {
    label: 'Plain message',
    help: 'No attachment and no period — just a note to the addresses you choose.',
    needsPeriod: false,
  },
};
const mailKind = (t) => (t && MAIL_KINDS[t.kind]) ? t.kind : 'statement';

// Placeholders a template may use. Kept as an explicit list because it is also the help text
// shown in the editor: an undocumented placeholder is one nobody uses. The run-derived ones are
// only offered to a statement — a message has no run to read them from.
const MAIL_RUN_PLACEHOLDERS = ['period', 'payout', 'revenue', 'sharePct', 'currency'];
const MAIL_PLACEHOLDERS = [
  ['{{merchant}}',  "the merchant's name"],
  ['{{entity}}',    'the contract entity the payout is settled with'],
  ['{{period}}',    'the run period, e.g. 2026-09'],
  ['{{payout}}',    'the payout amount, formatted'],
  ['{{revenue}}',   'revenue for the period, formatted'],
  ['{{sharePct}}',  'revenue share as a percentage'],
  ['{{currency}}',  "the merchant's currency"],
];

// Substitution is literal and total: an unknown placeholder is LEFT AS IT IS rather than
// replaced with a blank. A merchant receiving "{{payout}}" is embarrassing; a merchant
// receiving "Your payout is  THB" looks like a system that lost the number.
function renderTemplate(text, vars) {
  return String(text ?? '').replace(/\{\{(\w+)\}\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(vars || {}, key) ? String(vars[key] ?? '') : whole);
}

// The variables for one merchant in one run. Read from the frozen run result plus the merchant
// record, so it says what was actually paid.
function mailVarsFor(result, run) {
  const rev = Number(result.revenue) || 0;
  const pay = Number(result.payout) || 0;
  const c = CONTRACTS.find(x => x.contractId === result.contractId);
  return {
    merchant: result.merchantName || '',
    entity: contractEntityFor(result.contractId) || result.merchantName || '',
    period: periodTag(run.periodStart) || '',
    payout: fmt2(pay),
    revenue: fmt2(rev),
    sharePct: rev > 0 ? (pay / rev * 100).toFixed(1) + '%' : '—',
    currency: (c && c.currency) || CCY,
  };
}

// Where a revenue-share statement goes: the FINANCE email column, and only that (user,
// 2026-09-25). It used to fall back to the ordinary contact, which quietly sent a remittance
// advice to whoever happened to be on file — an ops contact, a marketing address. A statement
// is a financial document and goes to the person who handles money, or it does not go.
//
// The cost is visible rather than hidden: 17 merchants in the August run have a contact email
// but no finance one, QSNCC (28,180) and IMPACT (9,070) among them. They now appear under
// "No finance email" WITH the address that is on file, so the gap reads as a to-do list.
//
// Several addresses in one field is normal here (IMPACT carries two), so commas and semicolons
// both split.
function mailRecipients(contractId) {
  const c = CONTRACTS.find(x => x.contractId === contractId);
  return splitAddresses(c && c.financeContactEmail);
}

// The contract entities worth offering in the send picker: the distinct `counterParty` values
// over LIVE contracts. Archived ones are excluded for the same reason payoutDecision skips them —
// an ended contract is not someone to send this month's schedule to.
function entityOptions(contracts, entities) {
  const seen = new Map();
  for (const c of (contracts || [])) {
    if (!c || c.archived) continue;
    const name = entityNameOf(c, entities);
    if (name && !seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

// Everyone to write to for one entity, and — just as important — the merchants under it that
// carry NO finance address. Returning the gap rather than silently dropping those merchants is
// what lets the screen say "3 of 5 have an address" instead of quietly addressing three.
function addressesForEntity(contracts, entity, entities) {
  const want = String(entity || '').trim().toLowerCase();
  const addresses = [], withAddress = [], withoutAddress = [];
  if (!want) return { addresses, withAddress, withoutAddress };
  const seen = new Set();
  for (const c of (contracts || [])) {
    if (!c || c.archived) continue;
    if (entityNameOf(c, entities).toLowerCase() !== want) continue;
    const mine = splitAddresses(c.financeContactEmail);
    if (!mine.length) { withoutAddress.push(c.merchantName || '(unnamed)'); continue; }
    withAddress.push(c.merchantName || '(unnamed)');
    for (const a of mine) {
      const k = a.toLowerCase();
      if (!seen.has(k)) { seen.add(k); addresses.push(a); }
    }
  }
  return { addresses, withAddress, withoutAddress };
}

// What else is known about a merchant with no finance email — so the row can say what to do
// rather than only that something is missing.
function fallbackContact(contractId) {
  const c = CONTRACTS.find(x => x.contractId === contractId);
  return splitAddresses(c && c.contactEmail);
}

// A function declaration, not an arrow const: the tests extract by `function name(`, and an
// arrow is invisible to them — which showed up as three unrelated tests failing at once.
// An address has no spaces, and no stray separators. The first check here was /.+@.+\..+/,
// where `.` matches a space — so 'baanying mkt@gmail.com' (a real entry on BAANYING and
// Oranuch) passed as valid, would have been offered as a recipient, and would have made Gmail
// reject the entire message at the moment of sending. Something that cannot be delivered must
// not be presented as a choice.
const VALID_ADDRESS = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

function splitAddresses(raw) {
  return String(raw ?? '').split(/[;,]/).map(a => a.trim()).filter(a => VALID_ADDRESS.test(a));
}

// The entries that LOOK like an address but cannot be one, so a merchant with a broken address
// reads as broken rather than as having none at all.
function malformedAddresses(raw) {
  return String(raw ?? '').split(/[;,]/).map(a => a.trim())
    .filter(a => a && a.includes('@') && !VALID_ADDRESS.test(a));
}

// Every address the app knows for a merchant, each labelled with WHERE it came from — so
// picking one is an informed choice rather than a guess between two similar strings. Finance
// first, because that is who a remittance advice is for, and the finance ones are what the
// dialog ticks by default.
function knownAddresses(contractId) {
  const c = CONTRACTS.find(x => x.contractId === contractId) || {};
  const out = [];
  for (const a of splitAddresses(c.financeContactEmail)) out.push({ address: a, source: 'finance contact' });
  for (const a of splitAddresses(c.contactEmail)) {
    if (!out.some(x => x.address.toLowerCase() === a.toLowerCase())) {
      out.push({ address: a, source: 'contact' });
    }
  }
  return out;
}

// RFC 2047 encoding for a header that is not ASCII. Thai merchant names in a Subject: arrive as
// mojibake without this, and "?????" in a subject line reads as a broken system.
function encodeHeaderWord(text) {
  const s = String(text ?? '');
  if (/^[\x20-\x7E]*$/.test(s)) return s;
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(s)));
  return `=?UTF-8?B?${b64}?=`;
}

// Standard base64 with padding, for MIME parts and for uploading a file. base64Url below is
// only for Gmail's `raw` field, which wants the URL-safe alphabet and no padding.
function base64Std(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function base64Url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// A multipart/mixed message: the note, then the statement. Built by hand because the whole
// message is three headers and a base64 blob, and a library for that would be more code than
// this is. The boundary is random so it cannot appear in the attachment by coincidence.
// Plain parameter, destructured inside: a destructured PARAMETER breaks the test extractor,
// whose brace matcher closes on the parameter's brace instead of the body. Same convention
// as classifyDifferences, and for the same reason.
function buildMimeMessage(opts) {
  const { from, to, subject, body, filename, attachment } = opts;
  const contentType = opts.contentType
    || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const boundary = 'mcrm_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  // Cc is emitted ONLY when there is one — an empty `Cc:` header is malformed, and Gmail's API
  // rejects the whole message rather than ignoring it. Accepts a string or a list so a caller
  // can pass a template's raw field without splitting first.
  const ccList = (Array.isArray(opts.cc) ? opts.cc : splitAddresses(opts.cc));
  const head = [
    `From: ${from}`,
    `To: ${to.join(', ')}`,
    ...(ccList.length ? [`Cc: ${ccList.join(', ')}`] : []),
    `Subject: ${encodeHeaderWord(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '', '',
  ].join('\r\n');
  const text = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '', base64Std(new TextEncoder().encode(body)),
    '',
  ].join('\r\n');
  // Any number of files, each with its own type — a statement is an .xlsx, a template's file
  // could be anything. The type used to be hard-coded to spreadsheet, which would have labelled
  // a PDF as an Excel file and left the recipient unable to open it.
  const parts = [];
  if (attachment) parts.push({ bytes: attachment, filename, type: contentType });
  for (const f of (opts.attachments || [])) parts.push(f);
  const files = parts.map(f => [
    `--${boundary}`,
    `Content-Type: ${f.type || 'application/octet-stream'}`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${String(f.filename || 'attachment').replace(/"/g, '')}"`,
    '', base64Std(f.bytes),
    '',
  ].join('\r\n')).join('');
  return head + text + files + `--${boundary}--\r\n`;
}

// One access token per session, requested the first time someone sends. The app's sign-in gives
// an ID token only — proof of who you are, not permission to act as you — so sending needs its
// own consent. Internal Workspace app, so no unverified-app warning.
let GMAIL_TOKEN = null;

// MUST be called synchronously from the click that wants to send. Asking Google for a token
// opens a popup, and a browser only allows that during a user gesture — after the first `await`
// the gesture is spent and the popup is blocked with "Failed to open popup window". That is
// what happened on the first real send: the handler fetched the run's orders, built the file
// and showed a confirm before asking, by which point the click was long over.
function gmailToken() {
  if (GMAIL_TOKEN && GMAIL_TOKEN.expires > Date.now() + 60000) return Promise.resolve(GMAIL_TOKEN.value);
  return new Promise((resolve, reject) => {
    if (!window.google?.accounts?.oauth2) return reject(new Error('Google sign-in is not loaded — reload the page.'));
    const client = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: GMAIL_SCOPE,
      callback: (r) => {
        if (r.error) return reject(new Error(r.error_description || r.error));
        GMAIL_TOKEN = { value: r.access_token, expires: Date.now() + (Number(r.expires_in) || 3600) * 1000 };
        resolve(GMAIL_TOKEN.value);
      },
      error_callback: (e) => {
        const m = e?.message || '';
        reject(new Error(/popup/i.test(m)
          // Say what to do. "Failed to open popup window" on its own reads as a fault in the app.
          ? 'Your browser blocked the Google permission window. Allow pop-ups for this site, then press Send again.'
          : (m || 'Permission to send mail was not granted.')));
      },
    });
    client.requestAccessToken();
  });
}

async function sendGmail(mime) {
  const token = await gmailToken();
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ raw: base64Url(new TextEncoder().encode(mime)) }),
  });
  if (!res.ok) {
    const detail = await res.text();
    // Gmail's own words. The commonest failure is an unverified From: alias, and translating
    // that into something friendlier would hide the one thing that tells you how to fix it.
    throw new Error(`Gmail refused this message (${res.status}): ${detail.slice(0, 300)}`);
  }
  return res.json();
}

async function downloadRevshareZip(run) {
  const tag = periodTag(run.periodStart);
  // Entities come from the merchant records, not the run. Harmless if already cached.
  await ensureContractCache().catch(() => {});
  const results = (run.results || []).slice().sort((a, b) => b.payout - a.payout);

  // Orders live in the run's stored inputs, not its payload — one fetch of several MB, only
  // when someone actually downloads. Shared with the mail, so the two cannot drift.
  const index = await runOrderIndex(run);
  const orders = index.orders;
  const ordersByContract = index.ordersByContract;
  const kaByStore = index.kaByStore;

  // Grouped into a folder per contract entity where that entity covers more than one brand.
  const bases = zipEntryBases(results, contractEntityFor);
  const files = results.map((r, i) => {
    const base = bases[i];
    const wb = XLSX.utils.book_new();
    // Excel caps a sheet name at 31 characters and rejects \ / ? * [ ] : — and the base may now
    // carry a folder, whose slash is exactly one of those.
    const sheetName = base.split('/').pop().replace(SHEET_SAFE, '-').slice(0, 31);
    // EVERY argument. This call was four long while `statementWorkbook` passed seven, so the zip
    // carried no contracted term, no "gone" marks and no reason when the rentals failed to load —
    // the mail's attachment had all three. Two call sites, one updated (2026-10-01).
    XLSX.utils.book_append_sheet(wb, buildPartnerSheet(
      XLSX, r,
      orders ? (ordersByContract.get(r.contractId) || []) : null,
      kaByStore,
      index.ordersError,
      (index.ruleSnapshots || {})[r.contractId],
      goneMerchants(r),
    ), sheetName);
    return { name: `${base}.xlsx`, data: new Uint8Array(XLSX.write(wb, { bookType: 'xlsx', type: 'array' })) };
  });

  const blob = SimpleZip.makeZip(files);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${tag}_revshare.zip`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

const LEAF_LABELS = {
  flat_per_machine: 'Per machine',
  flat_per_partner_total: 'Lump sum',
  percent: 'Revenue share',
  tiered_percent: 'Tiered share',
};

// ── Reading a stored run ──────────────────────────────────────────────────
// Every run freezes both the rule it used (ruleSnapshots) and the engine's own arithmetic
// (engineResult). These read that stored detail back; they never recompute anything.
//
// The run detail deliberately does NOT use them — it shows the payout tables and nothing else
// (user, 2026-08-27: "other insights and why, we leave it to analytics page"). They feed the
// Analytics page's payout-composition chart.

// The engine reports `byPartner` for `whole` aggregation and `byStore` for `per_store`.
function engineComponents(engineResult) {
  if (!engineResult) return [];
  if (engineResult.byPartner) return engineResult.byPartner.components || [];
  return (engineResult.byStore || []).flatMap(s => s.components || []);
}

// One row per leaf and model, summed across merchants: "S8 x26 @ 4,000 = 104,000".
// Rates are carried per model because a rule can price each one differently.
function payoutBreakdown(engineResult) {
  const rows = new Map();
  for (const c of engineComponents(engineResult)) {
    const contributed = c.modelRowsContributed || [];
    if (!contributed.length) {
      // percent / lump leaves have no per-model rows — keep them as a single line.
      const k = `${c.leafType}|`;
      const r = rows.get(k) || { leafType: c.leafType, model: null, count: null, amount: null, payout: 0 };
      r.payout += Number(c.payout) || 0;
      rows.set(k, r);
      continue;
    }
    for (const m of contributed) {
      if (!m.count && !m.payout) continue;          // a model priced but not present
      const k = `${c.leafType}|${m.model}`;
      const r = rows.get(k) || { leafType: c.leafType, model: m.model, count: 0, amount: m.amount, payout: 0 };
      r.count += Number(m.count) || 0;
      r.payout += Number(m.payout) || 0;
      rows.set(k, r);
    }
  }
  return [...rows.values()].filter(r => r.payout || r.count).sort((a, b) => b.payout - a.payout);
}

// Was this merchant paid its minimum guarantee rather than its revenue share?
//
// The engine records only the branch of a `max` that WON, so the tell is simple and needs no
// re-derivation: the rule has a GP percentage, the method compares against an MG, and yet no
// `percent` leaf contributed anything. `shareWouldBe` is what the revenue share alone would
// have paid — the gap is what the guarantee is costing above it.
function guaranteeInfo(result, ruleSnapshot) {
  const form = decompileRule(ruleSnapshot);
  const comparesAgainstMg = (form.method === 'higher' || form.method === 'hybrid-higher')
    && (form.mgRows || []).some(r => Number(r.amount) > 0);
  if (!comparesAgainstMg || !(Number(form.gpPercent) > 0)) return null;

  const comps = engineComponents(result.engineResult);
  const percentPaid = comps.filter(c => c.leafType === 'percent').reduce((a, c) => a + (Number(c.payout) || 0), 0);
  const stores = (result.engineResult?.byStore || []).length;
  const storesOnMg = stores
    ? result.engineResult.byStore.filter(s => !(s.components || []).some(c => c.leafType === 'percent')).length
    : (percentPaid > 0 ? 0 : 1);

  if (!storesOnMg) return null;
  const shareWouldBe = (Number(result.revenue) || 0) * Number(form.gpPercent) / 100;
  return {
    gpPercent: form.gpPercent,
    shareWouldBe,
    gap: (Number(result.payout) || 0) - shareWouldBe,
    storesOnMg,
    storesTotal: stores || 1,
    everyStore: !stores || storesOnMg === stores,
  };
}

// The legal entity a payout is settled with. A rev-share file goes to the KA as one company,
// not to each brand or branch, so this is the column finance reconciles against.
//
// It is read from the merchant record AS IT IS TODAY, not from the run. Runs are frozen
// snapshots of what was paid and have never stored the entity, so there is nothing historical
// to read — and for its actual use, "who do we send this to now" is the right answer anyway.
// A merchant deleted since the run, or one that never had an entity typed in, reads "—" rather
// than guessing.
function contractEntityFor(contractId) {
  if (!contractId) return null;
  const c = CONTRACTS.find(x => x.contractId === contractId);
  // Through entityName, NOT the raw string: once a contract is linked to an ENTITY record the
  // record is the name, and `counterParty` is only the fallback for a row nobody has linked.
  // Reading the string directly meant renaming an entity left the OLD name on the send table,
  // on the run detail, and — worst — on the folder names inside the per-merchant zip.
  return (c ? entityName(c) : '') || null;
}

async function renderBulkRunDetail(runId) {
  const main = document.getElementById('main');
  main.innerHTML = `<div class="page-head">
      <div style="display:flex;align-items:baseline;gap:14px;"><button id="back" class="btn-ghost">← Back</button><h2 id="br-title">Run share</h2></div>
      <div id="br-actions"></div>
    </div><div id="br-detail">Loading…</div>`;
  document.getElementById('back').addEventListener('click', renderBulkRunsList);
  const run = await api('/bulk-runs/' + runId);
  // A run freezes what it PAID (§10.5) — the contract entity is not part of that, so it is
  // resolved live from the merchant record. See contractEntityFor for what that means.
  await ensureContractCache().catch(() => {});
  await loadEntities().catch(() => {});
  // C5: marking a brand or merchant as GONE needs the latest file's own list. Never fatal —
  // without it `brandIsGone` claims nothing rather than marking everything.
  if (!Object.keys(ROSTER_BRANDS.brands || {}).length) {
    const rb = await api('/roster/brands').catch(() => null);
    if (rb && rb.brands) ROSTER_BRANDS = rb;
  }
  // No mail from this screen, by decision (2026-09-25): every statement leaves from Mailing,
  // so there is one place where sending happens and one place that records it. A run detail
  // reports what was CALCULATED.
  const el = document.getElementById('br-detail');
  const totalRevenue = (run.results || []).reduce((s, r) => s + (r.revenue || 0), 0);
  const totalSharePct = totalRevenue > 0 ? ((run.totalPayout || 0) / totalRevenue * 100).toFixed(1) + '%' : '—';
  const isArchived = !!run.archived;

  // Reconciliation: every order either matched a roster row that got paid (totalRevenue),
  // matched one that was skipped (skippedRevenue), or matched nothing (unmatchedRevenue) — no
  // other bucket exists, so these three must sum to the order report's total revenue. Show
  // the check rather than assuming it holds, so a future gap shows up here instead of only
  // in a finance reconciliation weeks later.
  const skippedRevenue = Number(run.skippedRevenue ?? (run.skipped || []).reduce((s, r) => s + (r.revenue || 0), 0));
  const unmatchedRevenue = Number(run.unmatchedRevenue || 0);
  const reconciledTotal = totalRevenue + skippedRevenue + unmatchedRevenue;
  const hasOrderTotal = typeof run.totalOrderRevenue === 'number';
  const reconciles = hasOrderTotal ? Math.abs(reconciledTotal - run.totalOrderRevenue) < 0.01 : null;

  // The period belongs in the title: with the description line gone it is the only thing that
  // says which run you are looking at.
  const titleEl = document.getElementById('br-title');
  if (titleEl) titleEl.textContent = `Run share · ${periodMonth(run.periodStart)}`;

  // Lock / Unlock / Delete — rendered into the header, opposite the title.
  //
  // "Lock", not "Archive" (2026-10-02). The stored field is still `archived` and the routes are
  // still /archive and /unarchive — renaming those would be a migration for no gain — but the
  // word on screen now matches what the thing does, and stops colliding with the Archived screen
  // for merchants, which means something else.
  const archiveBar = (() => {
    const parts = [];
    if (isArchived) {
      parts.push(`<span class="badge badge-neutral" style="font-size:13px;"
        title="This month cannot be recomputed or deleted. Its statements and stored order detail are unaffected.">🔒 Locked</span>`);
      if (can('admin')) {
        parts.push(`<button id="br-unarchive" class="btn-ghost" style="margin-left:10px;">Unlock</button>`);
      }
      // Delete is hidden/disabled when locked
    } else {
      if (can('runCalcs')) {
        parts.push(`<button id="br-archive" class="btn-ghost"
          title="Lock this month: it can no longer be recomputed or deleted">🔒 Lock</button>`);
      }
      if (can('deleteRuns')) {
        parts.push(`<button id="br-delete" class="btn-ghost" style="color:var(--loss);">Delete</button>`);
      }
    }
    return parts.join('');
  })();
  const actionsEl = document.getElementById('br-actions');
  if (actionsEl) actionsEl.innerHTML = archiveBar;

  // Everything that is NOT a payout answers one question — where did the rest of the revenue
  // go? It used to be six separate coloured panels stacked around the payout table: skipped,
  // not-approved, unmatched, two recovery notices and the reconciliation banner, in five
  // different colours. One topic, one section, ranked by size. Colour is spent once, on
  // whether the run reconciles.
  const notPaidTotal = skippedRevenue + unmatchedRevenue;
  const naDetail = (run.unmatchedDetail || []).filter(u => u.reviewState);
  const unknownDetail = (run.unmatchedDetail?.length
    ? run.unmatchedDetail.filter(u => !u.reviewState)
    : (run.unmatched || []).map(n => ({ name: n, orders: null, revenue: null })));
  const naRevenue = Number(run.notApprovedRevenue || 0);
  const num = v => v == null ? '<span class="muted">—</span>' : Number(v).toLocaleString('en-US');

  // C3 (2026-10-01): "Show run results by entity name and then brand name, because there will be
  // multiple brands under the same entity." One entity, one block, its brands beneath it with a
  // subtotal — that is how finance reads it, and it is what the statement zip already folders by.
  //
  // Brands with no entity are not scattered through the list: they gather in their own block at
  // the end, by the user's decision, so the gap is visible as one thing to fix rather than 174
  // dashes. Every brand appears exactly once.
  //
  // C5: a brand the latest file no longer carries is marked GONE here — it is still paid, because
  // merchants come and go and the run computes what actually happened.
  function runRowsByEntity(run) {
    const results = (run.results || []).slice().sort((a, b) => b.payout - a.payout);
    const groups = new Map();
    for (const r of results) {
      const name = contractEntityFor(r.contractId) || '';
      const key = name ? name.toLowerCase() : '\u0000none';
      if (!groups.has(key)) groups.set(key, { name, rows: [] });
      groups.get(key).rows.push(r);
    }
    const sum = (rows, f) => rows.reduce((a, r) => a + (Number(f(r)) || 0), 0);
    const ordered = [...groups.values()]
      .sort((a, b) => (a.name ? 0 : 1) - (b.name ? 0 : 1)   // the no-entity block goes last
                   || sum(b.rows, r => r.payout) - sum(a.rows, r => r.payout));

    return ordered.map(g => {
      const rev = sum(g.rows, r => r.revenue), pay = sum(g.rows, r => r.payout);
      const head = `<tr class="run-ent"><td colspan="7">
          <strong>${g.name ? escape(g.name) : 'No contract entity'}</strong>
          <span class="muted"> · ${g.rows.length} brand${g.rows.length === 1 ? '' : 's'}
            · ${fmt2(rev)} revenue · <strong>${fmt2(pay)}</strong> payout</span>
          ${g.name ? '' : ' <span class="rc-warn">set one on each brand</span>'}</td></tr>`;
      return head + g.rows.map(r => {
        const gone = brandIsGone(r.merchantName);
        return `<tr>
        <td class="muted">${g.name ? '' : '—'}</td>
        <td><button type="button" class="run-brand" data-cid="${escape(r.contractId)}"
              title="Show this brand's merchants, exactly as the download does">${escape(r.merchantName)}</button>${
            gone ? ' <span class="rc-warn" title="Your latest file no longer carries this brand. It is still paid for what it earned this period.">gone</span>' : ''}</td>
        <td>${r.merchantCount}</td>
        <td>${r.rentals}</td>
        <td>${Number(r.revenue).toFixed(2)}</td>
        <td><strong>${Number(r.payout).toFixed(2)}</strong></td>
        <td>${r.revenue > 0 ? (r.payout / r.revenue * 100).toFixed(1) + '%' : '—'}</td>
      </tr>`; }).join('');
    }).join('');
  }

  // One row of the "revenue not paid" table: a headline, and a panel it expands into.
  const npRow = (key, label, count, unit, revenue, body, note) => !count ? '' : `
    <tr class="np-row" data-np="${key}">
      <td style="width:60%;"><button type="button" class="btn-ghost np-toggle" data-np="${key}" style="padding:0;font-size:13.5px;">▸ ${label}</button>
        ${note ? `<div class="muted" style="font-size:12px;margin-top:2px;">${note}</div>` : ''}</td>
      <td style="text-align:right;white-space:nowrap;">${count} ${escape(unit)}</td>
      <td style="text-align:right;"><strong>${fmt2(revenue)}</strong></td>
    </tr>
    <tr id="np-${key}" hidden><td colspan="3" style="background:var(--bg-soft);padding:12px 14px;">${body}</td></tr>`;

  // C5, the half that was computed and never shown (2026-10-01): a merchant whose rentals the
  // period's orders name but which TODAY'S file no longer carries is looked up in the earlier
  // uploads, so its revenue reaches its brand instead of scattering into unmatched. The run has
  // recorded that all along in `recoveredFromArchive` and nothing read it — so the one thing it
  // explains, "where did this row come from if my file has no such merchant", went unsaid.
  // The merchant itself is marked `gone` in the table, the expanded view and the download.
  // A merchant in this run that your APPROVED list does not carry: a machine is deployed against
  // it, or the period's orders name it. A run does not read a review state (2026-10-02), so this
  // is where you see which merchants that brought in — and under which brand they were paid.
  const added = [...(run.addedByMachine || []), ...(run.addedByOrder || [])];
  const addedNote = !added.length ? '' : `
    <p class="muted" style="margin:0 0 10px;font-size:12.5px;max-width:900px;">
      ${added.length} merchant${added.length === 1 ? '' : 's'} in this run
      ${added.length === 1 ? 'is' : 'are'} not on the Approved list — a machine is deployed
      against ${added.length === 1 ? 'it' : 'them'}, or this period's orders name
      ${added.length === 1 ? 'it' : 'them'}. A run does not read a review state, so
      ${added.length === 1 ? 'it is' : 'they are'} paid under
      ${added.length === 1 ? 'its' : 'their'} brand like any other:
      ${added.slice(0, 10).map(a => `<strong>${escape(a.name)}</strong>${
        a.brand ? ` <span class="muted">(${escape(a.brand)})</span>` : ''}`).join(', ')}${
        added.length > 10 ? ` and ${added.length - 10} more` : ''}.</p>`;

  const recovered = run.recoveredFromArchive || [];
  const recoveredNote = !recovered.length ? '' : `
    <p class="muted" style="margin:0 0 10px;font-size:12.5px;max-width:900px;">
      ${recovered.length} merchant${recovered.length === 1 ? '' : 's'} earned in this period but
      ${recovered.length === 1 ? 'is' : 'are'} no longer in your latest file, so
      ${recovered.length === 1 ? 'it was' : 'they were'} read from an earlier upload and
      ${recovered.length === 1 ? 'its' : 'their'} revenue still reaches
      ${recovered.length === 1 ? 'its' : 'their'} brand:
      ${recovered.slice(0, 12).map(r => `<strong>${escape(r.name)}</strong>${
        r.brand ? ` <span class="muted">(${escape(r.brand)})</span>` : ''}`).join(', ')}${
        recovered.length > 12 ? ` and ${recovered.length - 12} more` : ''}.
      ${recovered.length === 1 ? 'It is' : 'They are'} marked <span class="rc-warn">gone</span> below.</p>`;

  el.innerHTML = `
    ${(run.results?.length) ? `<p><a href="#" id="dl-revshare-zip" class="zip-link">↓ ${escape(periodTag(run.periodStart))}_revshare</a></p>` : ''}
    ${addedNote}
    ${recoveredNote}

    <table class="ts"><thead><tr>
      <th title="The company a payout is settled with, read from the brand record as it is today — a run does not store it">Contract entity</th>
      <th>Brand</th><th>Merchants</th><th>Rentals</th><th>Revenue</th><th>Payout</th><th>Share %</th></tr></thead>
    <tbody>${runRowsByEntity(run)}</tbody>
    <tfoot><tr>
      <td>Total</td><td></td><td></td><td></td>
      <td>${totalRevenue.toFixed(2)}</td>
      <td>${Number(run.totalPayout || 0).toFixed(2)}</td>
      <td>${totalSharePct}</td>
    </tr></tfoot>
    </table>



    ${notPaidTotal || run.matchedByMachine?.length || run.matchedByAlias?.length ? `
    <section style="margin-top:28px;">
      <h3 style="margin:0 0 4px;font-size:15px;">Revenue not paid</h3>
      <p class="muted" style="margin:0 0 10px;font-size:13px;">
        ${fmt2(notPaidTotal)} of the order report's ${fmt2(run.totalOrderRevenue || 0)}. Every order either paid a
        merchant, matched one that is not paid, or matched nothing at all — these are the last two.
      </p>
      ${(run.matchedByMachine?.length || run.matchedByAlias?.length) ? `
        <p style="margin:0 0 10px;font-size:13px;color:#1971c2;">
          ↔ Recovered: ${[
            run.matchedByMachine?.length ? `${run.matchedByMachine.length} merchant(s) by machine number` : '',
            run.matchedByAlias?.length ? `${run.matchedByAlias.length} name(s) by manual assignment` : '',
          ].filter(Boolean).join(' · ')} — these ARE paid.
          <button type="button" class="btn-ghost np-toggle" data-np="recovered" style="padding:0 4px;font-size:12.5px;">show</button>
        </p>
        <div id="np-recovered" hidden style="background:var(--bg-soft);padding:12px 14px;border-radius:8px;margin-bottom:10px;">
          <table style="font-size:13px;width:100%;">
            <thead><tr><th style="text-align:left;">Order report name</th><th style="text-align:left;">Paid to</th><th style="text-align:left;">How</th><th style="text-align:right;">Orders</th><th style="text-align:right;">Revenue</th></tr></thead>
            <tbody>
              ${(run.matchedByMachine || []).map(m => `<tr><td>${escape(m.orderName || '')}</td><td>${escape(m.rosterName || '')}</td><td>machine number</td><td style="text-align:right;">${num(m.orders)}</td><td style="text-align:right;">${fmt2(m.revenue)}</td></tr>`).join('')}
              ${(run.matchedByAlias || []).map(m => { const paidTo = (run.results || []).find(r => r.contractId === m.contractId);
                return `<tr><td>${escape(m.name || '')}</td><td>${escape(paidTo?.merchantName || m.contractId || '')}</td><td>manual assignment</td><td style="text-align:right;">${num(m.orders)}</td><td style="text-align:right;">${fmt2(m.revenue)}</td></tr>`; }).join('')}
            </tbody>
          </table>
        </div>` : ''}

      <table class="ts"><tbody>
        ${npRow('skipped', 'Skipped — matched a merchant that is not paid', (run.skipped || []).length, 'brands', skippedRevenue,
          `<table style="font-size:13px;width:100%;">
            <thead><tr><th style="text-align:left;">Brand</th><th style="text-align:right;">Merchants</th><th style="text-align:right;">Rentals</th><th style="text-align:right;">Revenue</th><th style="text-align:left;">Reason</th></tr></thead>
            <tbody>${(run.skipped || []).slice().sort((a2,b2) => b2.revenue - a2.revenue).map(sk => `<tr>
              <td>${escape(sk.merchantName || '')}</td><td style="text-align:right;">${sk.merchantCount}</td>
              <td style="text-align:right;">${sk.rentals}</td><td style="text-align:right;">${fmt2(sk.revenue)}</td>
              <td class="muted">${escape(sk.reason || '')}</td></tr>`).join('')}</tbody></table>`,
          'Their orders matched, but the merchant is marked no-payout, archived, or has no usable terms.')}

        ${npRow('notapproved', 'Not Approved in the merchant list', naDetail.length, 'merchants', naRevenue,
          `<p class="muted" style="margin:0 0 8px;font-size:13px;">The platform knows these merchants; they were excluded because their review state is not Approved. A merchant marked Disapproved can still have a live machine.</p>
           <table style="font-size:13px;width:100%;">
            <thead><tr><th style="text-align:left;">Merchant</th><th style="text-align:left;">Review state</th><th style="text-align:left;">Would be paid under</th><th style="text-align:right;">Orders</th><th style="text-align:right;">Revenue</th></tr></thead>
            <tbody>${naDetail.map(u => `<tr><td>${escape(u.name || '')}</td>
              <td><span style="color:#d9480f;font-weight:600;">${escape(u.reviewState)}</span></td>
              <td>${escape(u.label || '—')}</td><td style="text-align:right;">${num(u.orders)}</td>
              <td style="text-align:right;">${fmt2(u.revenue)}</td></tr>`).join('')}</tbody></table>`,
          'Fix the review state in ChargeSpot, or assign the name to a merchant below.')}

        ${npRow('unknown', 'Unmatched — no such merchant anywhere', unknownDetail.length, 'names', unmatchedRevenue - naRevenue,
          `<div style="display:flex;justify-content:flex-end;margin-bottom:6px;"><button id="dl-unmatched" class="btn-ghost" style="color:var(--accent);font-size:12.5px;">↓ Download list (CSV)</button></div>
           <table style="font-size:13px;width:100%;">
            <thead><tr><th style="text-align:left;">Merchant name in order report</th><th style="text-align:right;">Orders</th><th style="text-align:right;">Revenue</th><th></th></tr></thead>
            <tbody>${unknownDetail.map(u => `<tr>
              <td>${escape(u.name || '')}</td><td style="text-align:right;">${num(u.orders)}</td>
              <td style="text-align:right;">${u.revenue == null ? '<span class="muted">—</span>' : fmt2(u.revenue)}</td>
              <td style="text-align:right;white-space:nowrap;">${can('manageMerchants') ? `
                <button type="button" class="btn-ghost um-assign" data-name="${escape(u.name || '')}" style="font-size:12px;padding:2px 8px;">Assign→</button>
                <button type="button" class="btn-ghost um-add" data-name="${escape(u.name || '')}" style="font-size:12px;padding:2px 8px;">+ Add merchant</button>` : ''}</td>
            </tr>`).join('')}</tbody></table>`,
          'These names are in the order report but nowhere in the merchant list.')}
      </tbody></table>

      ${hasOrderTotal ? `
        <p style="margin:12px 0 0;font-size:13px;color:${reconciles ? '#2b8a3e' : '#c92a2a'};">
          <strong>${reconciles ? '✓ Reconciles' : '✗ Does NOT reconcile'}:</strong>
          paid ${fmt2(totalRevenue)} + skipped ${fmt2(skippedRevenue)} + unmatched ${fmt2(unmatchedRevenue)} = ${fmt2(reconciledTotal)}
          ${reconciles ? `— matches the order report's total.` : `vs. the order report's ${fmt2(run.totalOrderRevenue)}. Investigate before treating totals as final.`}
        </p>` : ''}
    </section>` : ''}`;

  el.querySelector('#dl-revshare-zip')?.addEventListener('click', async (ev) => {
    ev.preventDefault();
    const link = ev.currentTarget;
    const label = link.textContent;
    link.textContent = 'Preparing…';
    try { await downloadRevshareZip(run); }
    catch (e) { alert(`Could not build the download: ${e.message}`); }
    finally { link.textContent = label; }
  });
  // The "revenue not paid" rows expand in place.
  // C4: clicking a brand opens its own merchants, exactly as the download states them.
  el.querySelectorAll('.run-brand').forEach(b => b.addEventListener('click', () =>
    openRunBrandDetail(run, b.dataset.cid)));

  el.querySelectorAll('.np-toggle').forEach(b => b.addEventListener('click', () => {
    const row = el.querySelector('#np-' + CSS.escape(b.dataset.np));
    if (!row) return;
    row.hidden = !row.hidden;
    b.textContent = b.textContent.startsWith('▸') ? b.textContent.replace('▸', '▾')
      : b.textContent.startsWith('▾') ? b.textContent.replace('▾', '▸')
      : (row.hidden ? 'show' : 'hide');
  }));

  el.querySelector('#dl-unmatched')?.addEventListener('click', () => downloadUnmatchedCsv(run));
  bindUnmatchedActions(el, run);

  main.querySelector('#br-archive')?.addEventListener('click', async () => {
    if (!confirm('Lock this month?\n\nIt can no longer be recomputed or deleted — the payouts on '
      + 'it become the record. The statements, the download and the mailing are unaffected.\n\n'
      + 'Only an admin can unlock it.')) return;
    const btn = main.querySelector('#br-archive');
    btn.disabled = true; btn.textContent = 'Locking…';
    try {
      await api('/bulk-runs/' + runId + '/archive', { method: 'POST' });
      renderBulkRunDetail(runId);
    } catch (e) {
      alert('Could not lock: ' + e.message);
      btn.disabled = false; btn.textContent = '🔒 Lock';
    }
  });

  main.querySelector('#br-unarchive')?.addEventListener('click', async () => {
    if (!confirm('Unlock this month?\n\nIt becomes recomputable and deletable again. A recompute '
      + 'reads today\u2019s terms, so the payouts can change.')) return;
    const btn = main.querySelector('#br-unarchive');
    btn.disabled = true; btn.textContent = 'Unlocking…';
    try {
      await api('/bulk-runs/' + runId + '/unarchive', { method: 'POST' });
      renderBulkRunDetail(runId);
    } catch (e) {
      alert('Could not unlock: ' + e.message);
      btn.disabled = false; btn.textContent = 'Unlock';
    }
  });

  main.querySelector('#br-delete')?.addEventListener('click', async () => {
    if (!confirm('Delete this calculation? This cannot be undone.')) return;
    const btn = main.querySelector('#br-delete');
    btn.disabled = true; btn.textContent = 'Deleting…';
    try {
      await api('/bulk-runs/' + runId, { method: 'DELETE' });
      renderBulkRunsList();
    } catch (e) {
      if (e.message && e.message.includes('409')) {
        alert('This month is locked. An admin must unlock it first.');
      } else {
        alert('Delete failed: ' + e.message);
      }
      btn.disabled = false; btn.textContent = 'Delete';
    }
  });
}

function downloadUnmatchedCsv(run) {
  const q = s => `"${String(s).replace(/"/g, '""')}"`;
  const csv = 'Merchant name\n' + (run.unmatched || []).map(q).join('\n') + '\n';
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `unmatched-merchants-${periodMonth(run.periodStart)}.csv`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function renderStructuredRuleEditor(container, initialRule, machineModels, { readOnly = false } = {}) {
  let form = decompileRule(initialRule);
  let method = form.method;   // one of PAYOUT_METHODS
  let rawMode = false;
  let rawJson = JSON.stringify(initialRule || { type: 'sum', children: [] }, null, 2);

  function d(cond) { return (readOnly || cond) ? 'disabled' : ''; }

  function syncPlacement() {
    const models = container.querySelectorAll('.pl-model');
    const amts   = container.querySelectorAll('.pl-amt');
    form.placementRows = Array.from(models).map((sel, i) => ({
      model: sel.value,
      amount: Number(amts[i]?.value || 0)
    }));
  }

  function draw() {
    // A minimum guarantee is only consulted by the two comparing methods — compileRule leaves it
    // out of `default` and `hybrid` entirely (2026-09-30: PMCU is `hybrid`, someone typed an MG,
    // the save returned success and the value was silently discarded).
    const mgUsed = method === 'higher' || method === 'hybrid-higher';
    container.innerHTML = `
      ${(() => {
        return `
      <div class="rule-form">
        <div class="section-label">Payout method</div>
        <div class="model-options model-options-4">
          ${PAYOUT_METHOD_META.map(({ val, title, desc }) => `
            <label class="model-opt">
              <input type="radio" name="rf-method" value="${val}" ${method === val ? 'checked' : ''} ${d(rawMode)}>
              <span><strong>${title}</strong><br><span class="muted">${desc}</span></span>
            </label>`).join('')}
        </div>
        <div class="formula-box">Payout = <strong>${escape(payoutFormula(form))}</strong></div>
        <details class="method-help">
          <summary>How payout methods work — example</summary>
          <div class="mh-body">
            <p class="muted" style="margin:0 0 4px;">Example — a month where GP share = 3,000, Placement = 2,000, MG = 4,000:</p>
            <table class="mh-table">
              <tr><td>Default</td><td>single term (e.g. just GP)</td><td><strong>3,000</strong></td></tr>
              <tr><td>Hybrid</td><td>3,000 + 2,000</td><td><strong>5,000</strong></td></tr>
              <tr><td>Whichever is higher</td><td>max(3,000, 2,000, MG 4,000)</td><td><strong>4,000</strong></td></tr>
              <tr><td>Hybrid-higher</td><td>max(3,000 + 2,000, MG 4,000)</td><td><strong>5,000</strong></td></tr>
            </table>
            <p class="muted" style="margin-top:6px;">MG is only used by <em>Whichever is higher</em> and <em>Hybrid-higher</em>.</p>
          </div>
        </details>

        <div class="section-label" style="margin-top:18px;">Share terms</div>
        <div class="rf-row"><label>GP Share %</label>
          <input id="rf-gp" type="number" min="0" max="100" step="0.1" value="${form.gpPercent}" ${d(rawMode)}></div>
        <div class="rf-row"><label>Electricity fee (${CCY}/month)</label>
          <input id="rf-elec" type="number" min="0" value="${form.electricity}" ${d(rawMode)}></div>
        <div class="rf-row"><label>Others (${CCY}/month)</label>
          <input id="rf-others" type="number" min="0" value="${form.others}" ${d(rawMode)}></div>
        <div class="term-table-head"><label style="font-size:12.5px;color:var(--ink-soft);">Placement fee — per machine type</label></div>
        <table class="row-form">
          <thead><tr>
            <th style="width:50%">Device type</th>
            <th style="width:35%">Amount (${CCY}/month)</th>
            ${readOnly ? '' : '<th style="width:15%"></th>'}
          </tr></thead>
          <tbody>
            ${(form.placementRows || []).map((r, i) => `<tr>
              <td><select class="pl-model" data-i="${i}" ${d(rawMode)}>
                <option value="">— select —</option>
                ${(machineModels || []).map(m => `<option value="${escape(m.code)}" ${r.model===m.code?'selected':''}>${escape(m.displayName)}</option>`).join('')}
              </select></td>
              <td><input class="pl-amt" data-i="${i}" type="number" min="0" value="${r.amount||0}" ${d(rawMode)}></td>
              ${readOnly ? '' : `<td style="text-align:center"><button class="pl-del btn-ghost" data-i="${i}" style="color:var(--loss);padding:4px 8px;font-size:13px;" ${rawMode?'disabled':''}>✕</button></td>`}
            </tr>`).join('')}
            ${(!readOnly && !rawMode) ? '<tr><td colspan="3" style="padding-top:4px"><button id="pl-add" class="add-row-btn">+ Add device type</button></td></tr>' : ''}
          </tbody>
        </table>

        <div class="section-label" style="margin-top:18px;">Minimum guarantee <span style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--ink-faint);">— optional floor (per machine type), paid whichever is higher</span></div>
        ${mgUsed ? '' : `<p class="mg-inert">A minimum guarantee is a <strong>floor</strong>, so it only
          means anything when it is compared against something. The payout method above is
          <strong>${escape((PAYOUT_METHOD_META.find(m => m.val === method) || {}).title || method)}</strong>, which adds the terms up —
          so anything entered here is <strong>not used and will not be saved</strong>. Choose
          <em>Whichever is higher</em> or <em>Hybrid-higher</em> to use one.</p>`}
        <table class="row-form">
          <thead><tr>
            <th style="width:50%">Device type</th>
            <th style="width:35%">Amount (${CCY}/machine/month)</th>
            ${readOnly ? '' : '<th style="width:15%"></th>'}
          </tr></thead>
          <tbody>
            ${(form.mgRows || []).map((r, i) => `<tr>
              <td><select class="mg-model" data-i="${i}" ${d(rawMode || !mgUsed)}>
                <option value="">— select —</option>
                <option value="ALL" ${r.model === 'ALL' ? 'selected' : ''}>All device types</option>
                ${(machineModels || []).map(m => `<option value="${escape(m.code)}" ${r.model===m.code?'selected':''}>${escape(m.displayName)}</option>`).join('')}
              </select></td>
              <td><input class="mg-amt" data-i="${i}" type="number" min="0" value="${r.amount||0}" ${d(rawMode || !mgUsed)}></td>
              ${readOnly ? '' : `<td style="text-align:center"><button class="mg-del btn-ghost" data-i="${i}" style="color:var(--loss);padding:4px 8px;font-size:13px;" ${rawMode?'disabled':''}>✕</button></td>`}
            </tr>`).join('')}
            ${(!readOnly && !rawMode && mgUsed) ? '<tr><td colspan="3" style="padding-top:4px"><button id="mg-add" class="add-row-btn">+ Add device type</button></td></tr>' : ''}
          </tbody>
        </table>

        ${readOnly ? '' : `<details ${rawMode?'open':''}>
          <summary style="cursor:pointer;color:#868e96;font-size:13px;">Advanced (raw JSON)</summary>
          <textarea id="rf-json" rows="10" style="width:100%;font-family:monospace;font-size:12px;">${escape(rawJson)}</textarea>
          <label style="font-size:13px;"><input id="rf-raw-mode" type="checkbox" ${rawMode?'checked':''}> Use raw JSON (overrides form above)</label>
        </details>`}
      </div>`;
      })()}`;

    if (readOnly) return;

    container.querySelectorAll('input[name="rf-method"]').forEach(radio => radio.addEventListener('change', e => {
      captureInputs();
      method = e.target.value;
      form.method = method;
      draw();
    }));
    container.querySelector('#rf-raw-mode')?.addEventListener('change', e => {
      captureInputs();
      rawMode = e.target.checked;
      if (!rawMode) {
        try { form = decompileRule(JSON.parse(container.querySelector('#rf-json').value)); } catch(_) {}
      }
      draw();
    });
    container.querySelector('#pl-add')?.addEventListener('click', () => {
      captureInputs();
      form.placementRows.push({ model: '', amount: 0 });
      draw();
    });
    container.querySelectorAll('.pl-del').forEach(btn => btn.addEventListener('click', e => {
      captureInputs();
      form.placementRows.splice(+e.target.dataset.i, 1);
      draw();
    }));
    container.querySelector('#mg-add')?.addEventListener('click', () => {
      captureInputs();
      form.mgRows.push({ model: '', amount: 0 });
      draw();
    });
    container.querySelectorAll('.mg-del').forEach(btn => btn.addEventListener('click', e => {
      captureInputs();
      form.mgRows.splice(+e.target.dataset.i, 1);
      draw();
    }));
  }

  function syncMg() {
    const models = container.querySelectorAll('.mg-model');
    const amts = container.querySelectorAll('.mg-amt');
    form.mgRows = Array.from(models).map((sel, i) => ({ model: sel.value, amount: Number(amts[i]?.value || 0) }));
  }

  // Read current input values into `form` so a redraw doesn't lose edits.
  function captureInputs() {
    const gp = container.querySelector('#rf-gp');     if (gp) form.gpPercent   = Number(gp.value || 0);
    const el = container.querySelector('#rf-elec');   if (el) form.electricity = Number(el.value || 0);
    const ot = container.querySelector('#rf-others'); if (ot) form.others      = Number(ot.value || 0);
    form.method = method;
    syncPlacement();
    syncMg();
  }

  draw();

  return {
    getRule() {
      if (rawMode) {
        const ta = container.querySelector('#rf-json');
        return JSON.parse(ta.value);
      }
      captureInputs();
      return compileRule(form);
    },
    // What this save would silently drop. The greying above should make it unreachable, but a
    // rule loaded with an MG and then switched to `hybrid` still holds the values — and losing
    // a guarantee without being told is how a merchant quietly stops being paid its floor.
    droppedTerms() {
      if (rawMode) return [];
      captureInputs();
      const mgUsed = form.method === 'higher' || form.method === 'hybrid-higher';
      const mg = (form.mgRows || []).filter(r => r.model && Number(r.amount) > 0);
      return (!mgUsed && mg.length)
        ? [`the minimum guarantee (${mg.map(r => `${r.model} ${r.amount}`).join(', ')})`]
        : [];
    }
  };
}

function escape(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// Boot
boot();

// ── Live auto-update: pick up new deploys without a manual hard-refresh ──
// version.json (written by deploy-frontend.sh, served no-cache) carries the build stamp.
// A background tab reloads itself silently on a new build; a focused tab shows a
// click-to-update banner and reloads on its next blur. (Reload re-runs boot(); the stored
// token keeps the user signed in.)
(function liveUpdate() {
  let loaded = null, pending = false;
  const get = () => fetch('/version.json?_=' + Date.now(), { cache: 'no-store' }).then(r => r.ok ? r.json() : null).then(j => j && j.v).catch(() => null);
  function banner() {
    if (document.getElementById('update-banner')) return;
    const b = document.createElement('div');
    b.id = 'update-banner';
    b.style.cssText = 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:3000;background:#1f2937;color:#fff;padding:9px 16px;border-radius:8px;font-size:13px;box-shadow:0 6px 22px rgba(0,0,0,.25);cursor:pointer';
    b.textContent = '↻ New version available — click to update';
    b.onclick = () => location.reload();
    document.body.appendChild(b);
  }
  async function check() {
    const v = await get(); if (!v) return;
    if (loaded == null) { loaded = v; return; }
    if (v !== loaded) { pending = true; if (document.hidden) location.reload(); else banner(); }
  }
  check();
  setInterval(check, 60000);
  document.addEventListener('visibilitychange', () => { if (document.hidden) { if (pending) location.reload(); } else check(); });
})();


// ── Fixing unmatched merchants from a run ─────────────────────────────────
// An unmatched name is a store the order report knows about but the merchant list does not,
// so no amount of re-uploading fixes it — the roster is authoritative and simply lacks the
// name. These two actions write an ORDER ALIAS onto a contract, which is the matcher's third
// pass: the name is then paid to that merchant, this run and every future one.
//
// Per the 2026-08-24 decision an alias ADDS a store row to the merchant rather than merging
// into an existing one, so it also counts as a machine wherever the rule pays per machine.
// That is why the dialog spells out the per-machine cost before you confirm.
async function ensureContractCache(force) {
  if (!force && CONTRACTS.length && MACHINE_MODELS_CACHE.length) return;
  const [contracts, machineModels] = await Promise.all([api('/contracts'), api('/machine-models')]);
  CONTRACTS = contracts;
  MACHINE_MODELS_CACHE = machineModels;
  refreshContractGridColumns();
}

// What does one more machine cost under this rule? Walks the tree for the per-machine terms,
// because those are the ones an added store row silently increases.
function perMachineTerms(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (node.type === 'flat_per_machine') {
    for (const r of node.rows || []) if (Number(r.amount) > 0) out.push({ model: r.model, amount: Number(r.amount) });
  }
  (node.children || []).forEach(c => perMachineTerms(c, out));
  return out;
}

function bindUnmatchedActions(el, run) {
  el.querySelectorAll('.um-assign').forEach(b =>
    b.addEventListener('click', () => openAssignDialog(b.dataset.name, run)));
  el.querySelectorAll('.um-add').forEach(b =>
    b.addEventListener('click', () => addMerchantForUnmatched(b.dataset.name, run)));
}

async function openAssignDialog(orderName, run) {
  try { await ensureContractCache(); }
  catch (e) { alert(`Could not load merchants: ${e.message}`); return; }

  const live = CONTRACTS.filter(c => !c.archived)
    .sort((a, b) => (a.merchantName || '').localeCompare(b.merchantName || ''));
  const models = (MACHINE_MODELS_CACHE.length ? MACHINE_MODELS_CACHE.map(m => m.code) : ['S5','S8','S10','T8','T10','T20','T35','L20','L40','M10']);
  const { card, close } = ctModal(560);
  card.innerHTML = `
    <h3 style="margin:0 0 4px;">Assign to a merchant</h3>
    <p class="muted" style="margin:0 0 14px;font-size:12.5px;">
      Orders named <strong>${escape(orderName)}</strong> will be paid to the merchant you pick,
      in this run and in future runs.
    </p>
    <label style="font-size:12.5px;color:var(--ink-soft);">Merchant
      <select id="um-contract" class="input" style="display:block;margin-top:4px;width:100%;">
        ${live.map(c => `<option value="${escape(c.contractId)}">${escape(c.merchantName || '(unnamed)')}</option>`).join('')}
      </select>
    </label>
    <label style="font-size:12.5px;color:var(--ink-soft);display:block;margin-top:12px;">Machine model
      <select id="um-model" class="input" style="display:block;margin-top:4px;width:160px;">
        ${models.map(m => `<option value="${m}"${m === 'S8' ? ' selected' : ''}>${m}</option>`).join('')}
      </select>
    </label>
    <div id="um-impact" style="margin-top:14px;"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:18px;">
      <button type="button" id="um-cancel" class="btn-ghost">Cancel</button>
      <button type="button" id="um-save" class="btn-primary">Assign</button>
    </div>`;

  // Wire the controls FIRST. Anything below can throw while rendering; if it does, the dialog
  // must still be closable and submittable rather than silently inert.
  card.querySelector('#um-cancel').addEventListener('click', close);
  card.querySelector('#um-save').addEventListener('click', async () => {
    const btn = card.querySelector('#um-save');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      await addAliasToContract(card.querySelector('#um-contract').value, orderName, card.querySelector('#um-model').value);
      close();
      await offerRecompute(run);
    } catch (e) {
      btn.disabled = false; btn.textContent = 'Assign';
      alert(`Could not assign: ${e.message}`);
    }
  });

  const impact = () => {
    const c = CONTRACTS.find(x => x.contractId === card.querySelector('#um-contract').value);
    const model = card.querySelector('#um-model').value;
    const box = card.querySelector('#um-impact');
    const terms = perMachineTerms(c?.rule).filter(t => t.model === model || t.model === 'ALL');
    box.innerHTML = terms.length
      ? `<div style="padding:10px 12px;background:#fff9db;border:1px solid #ffe066;border-radius:8px;font-size:12.5px;">
           <strong>This adds a merchant to ${escape(c.merchantName)}.</strong> Its rule pays per machine
           (${terms.map(t => `${escape(t.model)}: ${fmt2(t.amount)}`).join(', ')}), so the payout increases by that
           amount on top of any revenue share.
         </div>`
      : `<p class="muted" style="font-size:12.5px;margin:0;">Adds a merchant to this brand. Its rule has no
           per-machine term, so only the revenue moves.</p>`;
  };
  card.querySelector('#um-contract').addEventListener('change', impact);
  card.querySelector('#um-model').addEventListener('change', impact);
  impact();

}

async function addAliasToContract(contractId, orderName, machineModel) {
  const c = CONTRACTS.find(x => x.contractId === contractId);
  const existing = (c?.orderAliases || []).filter(a => (a.name || '').toLowerCase().trim() !== orderName.toLowerCase().trim());
  const orderAliases = [...existing, { name: orderName, machineModel, addedAt: new Date().toISOString() }];
  const updated = await api(`/contracts/${encodeURIComponent(contractId)}`, { method: 'PUT', body: JSON.stringify({ orderAliases }) });
  const i = CONTRACTS.findIndex(x => x.contractId === contractId);
  if (i >= 0) CONTRACTS[i] = updated;
  return updated;
}

async function addMerchantForUnmatched(orderName, run) {
  try { await ensureContractCache(); }
  catch (e) { alert(`Could not load merchants: ${e.message}`); return; }
  const name = prompt('New merchant name', orderName);
  if (!name || !name.trim()) return;
  const clash = CONTRACTS.find(c => !c.archived && (c.merchantName || '').toLowerCase().trim() === name.toLowerCase().trim());
  if (clash && !confirm(`"${name.trim()}" already exists. Assign the orders to it instead?`)) return;
  try {
    let contract = clash;
    if (!contract) {
      // No terms yet: nobody has agreed a rate, so it will surface in the run wizard's
      // "needs terms" step rather than being paid a number no one chose.
      contract = await api('/contracts', { method: 'POST', body: JSON.stringify({
        merchantName: name.trim(), units: {}, notes: '', rule: null,
        aggregationMode: 'per_store', noPayout: false }) });
      CONTRACTS.push(contract);
    }
    await addAliasToContract(contract.contractId, orderName, 'S8');
    alert(`Created "${contract.merchantName}" and assigned "${orderName}" to it.\n\nSet its revenue-share terms in Overview — until then it has no terms and will not be paid.`);
    await offerRecompute(run);
  } catch (e) {
    alert(`Could not add merchant: ${e.message}`);
  }
}

// Assignments only show up in a run once it is recomputed from its stored inputs. Runs created
// before 2026-08-24 have no stored inputs and cannot be; the backend says so and we relay it.
async function offerRecompute(run) {
  if (!confirm('Assignment saved.\n\nRecompute this run now so it reflects the change?')) return;
  try {
    const fresh = await api(`/bulk-runs/${encodeURIComponent(run.runId)}/recompute`, { method: 'POST' });
    alert('Run recomputed.');
    renderBulkRunDetail(fresh.runId);
  } catch (e) {
    alert(`Could not recompute: ${e.message}\n\nThe assignment is saved and will apply to the next run.`);
  }
}

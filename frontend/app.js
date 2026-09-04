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
    if (col === 'merchant name.') return 'Example Store';
    if (col === 'merchant name (English)') return 'Example Store';
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
  return res.status === 204 ? null : res.json();
}
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
  renderContractsScreen();   // Merchant view is the first tab, so it is also the landing screen
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
  // Four destinations. Analytics reads the same runs Run share lists, and Device types / Users
  // are both configuration, so each pair is one screen with tabs rather than its own nav slot.
  // Run share is NOT gated on runCalcs: reads are open backend-side, and gating the nav here
  // was also hiding Analytics from read-only users. Creating a run is still gated, on the
  // + New run button.
  nav.innerHTML = `
    <button id="nav-contracts" class="nav-btn active">Merchant view</button>
    <button id="nav-bulk-runs" class="nav-btn">Run share</button>
    <button id="nav-archived" class="nav-btn">Archived</button>
    <button id="nav-settings" class="nav-btn">Settings</button>`;
  nav.querySelector('#nav-archived').addEventListener('click', () => { setActiveNav('nav-archived'); renderArchivedScreen(); });
  nav.querySelector('#nav-bulk-runs').addEventListener('click', () => { setActiveNav('nav-bulk-runs'); renderBulkRunsList(); });
  nav.querySelector('#nav-contracts').addEventListener('click', () => { setActiveNav('nav-contracts'); renderContractsScreen(); });
  nav.querySelector('#nav-settings').addEventListener('click', () => { setActiveNav('nav-settings'); renderSettingsScreen(); });
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

function setActiveNav(id) {
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.id === id));
  // The merchant grid is ~2400px of columns; the app's 1100px content column hides most
  // of them behind a scrollbar. Let this one screen use the whole window.
  document.getElementById('main')?.classList.toggle('main-wide', id === 'nav-contracts');
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

const PERM_LABELS = { editPartners:'Edit partners & rules', runCalcs:'Run calcs', deleteRuns:'Delete runs', manageMerchants:'Manage merchants', manageDeviceTypes:'Device types', admin:'Admin' };
async function renderUsersScreen(host) {
  const main = host || document.getElementById('main');
  main.innerHTML = `${host ? '' : '<h2>Users</h2>'}<p class="muted">Grant per-feature access. Anyone with a company Google account can sign in (read-only) until granted more.</p><div id="users-out">Loading…</div>`;
  const users = await api('/users');
  const keys = Object.keys(PERM_LABELS);
  const rowHtml = u => `<tr data-email="${escape(u.email)}"><td>${escape(u.email)}</td>${keys.map(k => `<td style="text-align:center"><input type="checkbox" data-perm="${k}" ${u.permissions?.[k] ? 'checked' : ''}></td>`).join('')}<td><button class="btn-primary" data-save>Save</button> <button data-del>Remove</button></td></tr>`;
  document.getElementById('users-out').innerHTML = `
    <div style="margin:10px 0;"><input id="new-user-email" placeholder="email@inforich.com" style="width:240px"> <button id="add-user" class="btn-primary">Add user</button></div>
    <table class="ts"><thead><tr><th>Email</th>${keys.map(k => `<th>${escape(PERM_LABELS[k])}</th>`).join('')}<th></th></tr></thead>
    <tbody>${users.map(rowHtml).join('') || '<tr><td colspan="9" class="muted">No granted users yet.</td></tr>'}</tbody></table>`;
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
        machine columns the Merchant view shows, and which models a run will accept.
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
let MISSING_UPLOAD = new Set();

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
    { key: 'merchantName',          label: 'Merchant/Brand', type: 'text',  width: 165 , group: 'id' },
    { key: 'merchantType',          label: 'Type',          type: 'select', width: 120 , group: 'id' },
    // How many branches this brand has. Set by the weekly upload, which counts the store rows
    // sharing a merchant label — so it is as current as the last file.
    { key: 'branchCount',           label: 'Branch',        type: 'number', width: 70  , group: 'id' },
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
const CONTRACT_GROUPS = [
  { key: 'contact',  label: 'Contact'  },
  { key: 'machines', label: 'Machines' },
  { key: 'contract', label: 'Contract' },
  { key: 'finance',  label: 'Finance Information' },
  { key: 'terms',    label: 'Share terms' },
];
// The screen OPENS COLLAPSED (2026-09-04). Six groups spread is ~2,900px, well past a laptop,
// so the honest default is the compact list — merchant, type, branch, and one narrow stub per
// group, each of which reopens it. Someone who wants a column spends one click, instead of
// everyone paying a horizontal scrollbar.
//
// The storage key is VERSIONED because the old default was all-open and was already saved in
// every returning browser — keeping the key would have shipped a new default that nobody using
// the screen could see. The cost is one deliberate reset of a low-stakes preference; choices
// made from here on persist as before.
const CT_GROUPS_KEY = 'rs_ct_groups_v2';
let CONTRACT_GROUPS_ON = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(CT_GROUPS_KEY) || 'null');
    if (saved && typeof saved === 'object') return saved;
  } catch { /* corrupt or unavailable storage — fall through to all-collapsed */ }
  return Object.fromEntries(CONTRACT_GROUPS.map(g => [g.key, false]));
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
    const key = col.group || 'id';
    let seg = segs[segs.length - 1];
    if (!seg || seg.key !== key) {
      const g = CONTRACT_GROUPS.find(x => x.key === key);
      segs.push(seg = { key, label: g ? g.label : '', toggleable: !!g,
                        open: !g || groupOpen(key), cols: [] });
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
  colRow.push('<th class="ct-gsep" style="min-width:135px">Edit terms</th><th style="min-width:96px"></th>');

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
const UNIT_MODEL_KEYS = ['S5', 'S8', 'M10', 'L20', 'L40'];
const unitsTotal = c => UNIT_MODEL_KEYS.reduce((a, m) => a + (Number((c.units || {})[m]) || 0), 0);

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

// A merchant needs terms when it is meant to be paid but nothing says how much. This is the
// same condition the run's step-3 gate uses, so what is flagged here is exactly what will
// block a run.
const needsTerms = c => !c.archived && !c.noPayout && !ruleHasValue(c.rule);

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
    const v = cellValue(c, col.key);
    let disp;
    if (col.type && col.type.startsWith('term-')) disp = termCellHtml(c, col);
    else if (col.type === 'computed') disp = `<span class="ct-computed" title="Sum of the per-model counts — edit those instead">${unitsTotal(c)}</span>`;
    else if (col.type === 'bool') disp = v ? '✓' : '';
    else if (col.type === 'url') {
      disp = !v ? ''
        : (/^https?:\/\//i.test(v)
            ? `<a href="${escape(v)}" target="_blank" rel="noopener">open ↗</a>`
            : escape(String(v)));
    }
    // `suffix` is display-only — the editor still shows the bare number, so typing and
    // saving are unaffected.
    else disp = v == null || v === '' ? '' : escape(String(v)) + (col.suffix ? `<span class="ct-unit">${escape(col.suffix)}</span>` : '');
    // The End-date highlight only helps if that column is on screen; the Merchant column is
    // frozen, so the icon rides there and the row stays spottable however far you scroll.
    // Say why a cell does not open, rather than letting a click do nothing unexplained.
    const editable = EDITABLE_GROUPS.has(col.group) && col.type !== 'computed';
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
    ? `<button class="btn-ghost ct-pe-btn" data-id="${escape(c.contractId)}">${ruleIsAbsent(c.rule) && !c.noPayout ? 'Set terms…' : 'Edit…'}</button>`
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

// ── Merchant view: add / delete / link ─────────────────────────────────────

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
      <button type="button" id="ct-tv-close" class="btn">Close</button>
    </div>
    <div id="ct-tv-rule" style="margin-top:16px;"></div>
    <p class="muted" style="margin:14px 0 0;font-size:12px;">Read-only. Use <strong>Edit terms</strong> at the end of the row to change these.</p>`;
  renderStructuredRuleEditor(card.querySelector('#ct-tv-rule'), c.rule, MACHINE_MODELS_CACHE, { readOnly: true });
  card.querySelector('#ct-tv-close').addEventListener('click', close);
}

// Add/update the revenue-share terms on a merchant row: aggregation mode, whether it is
// paid at all, and its full rule — edited with the same tree editor as the partner Rule
// tab rather than the flattened cells this grid used to carry. The row IS the payout
// record now; there is no partner to create or link.
// `onSaved(saved)` is optional and fires only after a successful save (not on cancel) —
// callers outside the Merchant view screen (e.g. the run wizard) use it to know when to
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
          <option value="whole"${c.aggregationMode !== 'per_store' ? ' selected' : ''}>Whole — one calculation across all stores</option>
          <option value="per_store"${c.aggregationMode === 'per_store' ? ' selected' : ''}>Per store — calculate each store separately</option>
        </select>
      </label>
      <label class="nopay-toggle" style="display:flex;gap:8px;align-items:center;font-size:13px;margin-top:22px;">
        <input type="checkbox" id="ct-pe-nopay"${c.noPayout ? ' checked' : ''}> No revenue share — not paid
      </label>
    </div>
    <p class="muted" style="margin:-6px 0 14px;font-size:11.5px;">
      Per store matters when a minimum guarantee should apply to each store on its own — under
      Whole the guarantee collapses to the merchant total and small stores lose their floor.
    </p>
    <div id="ct-pe-rule"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:18px;">
      <button type="button" id="ct-pe-cancel" class="btn">Cancel</button>
      <button type="button" id="ct-pe-save" class="btn btn-primary">Save</button>
    </div>`;
  const ruleBox = card.querySelector('#ct-pe-rule');
  const editor = renderStructuredRuleEditor(ruleBox, c.rule, MACHINE_MODELS_CACHE, { readOnly: false });
  const nopay = card.querySelector('#ct-pe-nopay');
  const agg = card.querySelector('#ct-pe-agg');
  const dim = () => { ruleBox.style.opacity = nopay.checked ? '.45' : '1'; ruleBox.style.pointerEvents = nopay.checked ? 'none' : ''; };
  nopay.addEventListener('change', dim); dim();
  card.querySelector('#ct-pe-cancel').addEventListener('click', close);

  card.querySelector('#ct-pe-save').addEventListener('click', async ev => {
    const btn = ev.target; btn.disabled = true; btn.textContent = 'Saving…';
    try {
      let rule;
      try { rule = editor.getRule(); } catch (e) { alert('Invalid rule: ' + e.message); return; }
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
// The merchant sheet is the Merchant view grid, in the same column ORDER, with row 1 carrying
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
    col('Merchant', 'Merchant/Brand', c => c.merchantName ?? null,
      'REQUIRED — the brand name, and the key an upload matches on. An existing name updates that merchant; a new one creates it. '
      + 'Editing a name here therefore ADDS a merchant rather than renaming one. It should also match the "Merchant label" in the '
      + 'ChargeSpot roster, or the brand\u2019s machines will not be found when a run is prepared. A row with this cell empty is skipped.'),
    col('Merchant', 'Type', c => c.merchantType ?? null, 'Category. One of: ' + MERCHANT_TYPES.join(', ') + '.'),
    col('Merchant', 'Branch', c => c.branchCount ?? null,
      'How many branches this brand has, counted from the last weekly upload.'),

    col('Contact', 'Sales person', c => c.salesPerson ?? null, 'Who at ChargeSpot owns this relationship.'),
    col('Contact', 'Contact', c => c.contactName ?? null, 'Contact name at the merchant.'),
    col('Contact', 'Phone', c => c.contactPhone ?? null, 'Contact phone. Kept exactly as typed.'),
    col('Contact', 'Email', c => c.contactEmail ?? null, 'Contact email.'),
    col('Machines', 'Units', c => (c.installedUnits ?? (unitsTotal(c) || null)),
      'Total machines installed. Should equal the eight model columns to its right; the app shows the sum of those, so a mismatch is visible.'),
    ...slots.map(model => col('Machines', model,
      c => model ? ((c.units || {})[model] ?? null) : null,
      'A machine model. Put the model code in this header row (S5, S8, LL20, S10-A \u2026) and the count below it. '
      + 'Eight slots are provided; blank ones are ignored, so a column with no model code in its header imports nothing.')),
    col('Contract', 'Contract entity', c => c.counterParty ?? null,
      'The legal entity named on the contract. Free text; may differ from the brand name.'),
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
    ['Upload this file with "Upload sheet" on the Merchant view.'],
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

async function renderContractsScreen() {
  const el = document.getElementById('main');
  el.classList.add('main-wide');   // also covers the boot path, which doesn't go via setActiveNav
  el.innerHTML = '<h1>Merchant view</h1><p class="muted">Loading…</p>';
  const [contracts, machineModels, lastUpload] = await Promise.all([
    api('/contracts'), api('/machine-models'),
    // Never fatal: the grid is worth showing without the marks, so an older backend or a
    // failed read just means no ⦿ column-marker this paint.
    api('/contracts/last-upload').catch(() => null)
  ]);
  CONTRACTS = contracts;
  MACHINE_MODELS_CACHE = machineModels;
  LAST_UPLOAD = lastUpload && lastUpload.names && lastUpload.names.length ? lastUpload : null;
  refreshContractGridColumns();
  el.innerHTML = `
    <h1>Merchant view</h1>
    <div class="ct-toolbar">
      <input id="ct-search" class="input" placeholder="Search merchant…" style="max-width:240px">
      <select id="ct-status" class="input" style="max-width:230px">
        <option value="">All merchants</option>
        <option value="needs">◆ Needs terms</option>
        <option value="due">⚠ Contract due or overdue</option>
        ${LAST_UPLOAD ? '<option value="missing">⦿ Not in latest upload</option>' : ''}
      </select>
      ${can('manageMerchants') ? '<button type="button" id="ct-add" class="btn btn-primary">+ Add merchants</button>' : ''}
      <button type="button" id="ct-template" class="btn" title="Download the current merchant list as .xlsx, in the exact format Upload sheet reads — edit it and upload it back">Download sheet</button>
      <span class="muted" id="ct-count"></span>
    </div>
    <div class="ct-scroll"><table class="ct-table"><thead>${contractHeadHtml()}</thead>
      <tbody id="ct-body"></tbody></table></div>`;
  ['ct-search', 'ct-status'].forEach(id =>
    el.querySelector('#' + id).addEventListener('input', paintContracts));
  // Delegated on <thead>, which survives its own innerHTML being replaced on every toggle.
  el.querySelector('.ct-table thead').addEventListener('click', ev => {
    const th = ev.target.closest('[data-group]');
    if (th) toggleContractGroup(th.dataset.group);
  });
  paintContracts();
  el.querySelector('#ct-body').addEventListener('click', ev => {
    if (ev.target.closest('a')) return;          // let the contract link open normally
    const peBtn = ev.target.closest('.ct-pe-btn');
    if (peBtn) { openTermsEditor(peBtn.dataset.id); return; }
    const terms = ev.target.closest('.ct-terms');
    if (terms) { openTermsView(terms.closest('tr').dataset.id); return; }
    const delBtn = ev.target.closest('.ct-del-btn');
    if (delBtn) { deleteContractRow(delBtn.dataset.id); return; }
    const archBtn = ev.target.closest('.ct-arch-btn');
    if (archBtn) { setContractArchived(archBtn.dataset.id, true); return; }
    const td = ev.target.closest('td.ct-cell');
    if (td && td.dataset.key) startCellEdit(td);
  });
  el.querySelector('#ct-new')?.addEventListener('click', createContractRow);
  el.querySelector('#ct-template')?.addEventListener('click', downloadMerchantTemplate);
  el.querySelector('#ct-add')?.addEventListener('click', openAddMerchants);
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
  // merchant created here is one a run can actually find. The per-store name is a BRANCH of it:
  // counted, never stored as a merchant of its own. Reading the store name as the brand is what
  // would turn 2,357 shops into 2,357 "merchants".
  { field: 'Merchant/Brand', names: ['merchant label', 'brand', 'merchant/brand', 'ka name', 'ka'] },
  { field: '_branch',        names: ['merchant name.', 'merchant name', 'store', 'store name', 'branch', 'ชื่อร้าน'] },
  { field: 'Type',           names: ['type', 'merchant type', 'merchant type.', 'category'] },
  { field: 'Contract entity',names: ['contract entity', 'counter party', 'counterparty', 'legal entity', 'company'] },
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
    throw new Error('No merchant column found. The sheet needs a header row with "Merchant label" (the brand), or a merchant/store name column.');
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
  // first value stated for each field wins, and the branches are counted.
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
const WEEKLY_FIELD_KEY = {
  'Merchant/Brand': 'merchantName', 'Type': 'merchantType', 'Contract entity': 'counterParty',
  'Sales person': 'salesPerson', 'Contact': 'contactName', 'Phone': 'contactPhone', 'Email': 'contactEmail',
  'Branch': 'branchCount',
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
      diffs.push({ field: 'Branch', from: String(existing.branchCount ?? ''), to: String(branches) });
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
  const byStore = new Map();
  const models = new Set();
  for (const r of rows) {
    const n = name(r); const m = model(r);
    if (!n || !m) continue;
    if (!byStore.has(n)) byStore.set(n, {});
    const c = byStore.get(n);
    c[m] = (c[m] || 0) + 1;
    models.add(m);
  }
  return { byStore, models: [...models], counted: [...byStore.values()].reduce((a, c) => a + Object.values(c).reduce((x, y) => x + y, 0), 0) };
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
            Your own weekly file. Columns are matched by name — merchant, type, contract entity,
            sales person, contact, phone, email. Anything else is ignored.
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
            <strong>${parsed.rows.length} merchant/brand(s)</strong> from ${parsed.branchRows.toLocaleString('en-US')} approved store row(s)
            — sheet “${escape(parsed.sheet)}”, header on row ${parsed.headerRow}.
            ${parsed.hasReviewColumn
              ? (parsed.skippedNotApproved ? `<div class="muted" style="font-size:12px;">${parsed.skippedNotApproved.toLocaleString('en-US')} row(s) skipped — not Approved.</div>` : '')
              : `<div class="muted" style="font-size:12px;">No review-state column found, so every named row is included.</div>`}
            ${parsed.brandFromBranch ? `<div class="muted" style="font-size:12px;">No “Merchant label” column — the store name is being read as the brand, so each row becomes its own merchant.</div>` : ''}
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
                <ul style="font-size:12.5px;margin:4px 0 0;padding-left:18px;">${d.missing.slice(0, 200).map(m => `<li>${escape(m.merchantName || '')}${m.branchCount ? ` <span class="muted">— ${m.branchCount} branch(es)</span>` : ''}</li>`).join('')}
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
            ${row('Stores matched to a merchant', `${mm.matchedStores} · ${mm.matchedMachines} machine(s)`, 'color:#2b8a3e;')}
            ${mm.unknown.length ? row('Store name not in the registry', `${mm.unknown.length} · ${mm.unknown.reduce((a, x) => a + x.machines, 0)} machine(s)`, 'color:#e67700;') : ''}
            ${mm.unlinked.length ? row('In the registry, but no merchant linked', `${mm.unlinked.length} · ${mm.unlinked.reduce((a, x) => a + x.machines, 0)} machine(s)`, 'color:#e67700;') : ''}
            ${mm.unknown.length || mm.unlinked.length ? `<button type="button" id="am-mdetail" class="btn-ghost" style="padding:2px 0;font-size:12.5px;margin-top:4px;">Show the stores that would be skipped</button>
            <div id="am-mdetail-box" hidden style="margin-top:8px;max-height:220px;overflow:auto;">
              ${[['Store name not in the registry', mm.unknown], ['In the registry, but no merchant linked', mm.unlinked]]
                .filter(([, list]) => list.length).map(([title, list]) => `
                <div style="font-weight:600;font-size:12.5px;margin-top:6px;">${title}</div>
                <ul style="font-size:12.5px;margin:4px 0 0;padding-left:18px;">
                  ${list.slice(0, 100).map(x => `<li>${escape(x.store)} <span class="muted">— ${x.machines} machine(s)</span></li>`).join('')}
                  ${list.length > 100 ? `<li class="muted">…and ${list.length - 100} more</li>` : ''}</ul>`).join('')}
            </div>` : ''}
            <p class="muted" style="margin:8px 0 0;font-size:11.5px;">
              Matched by store name through the store registry, which learns store names from run
              rosters. Skipped stores are never guessed at — nothing is written for them, and
              nothing is deleted. ⚠ This column counts CABINETS; a payout counts stations, so a
              4-machine station reads 4 here and 1 in a run.
            </p>
          </div>` : ''}`;
        card.querySelector('#am-mdetail')?.addEventListener('click', (ev) => {
          const mbox = card.querySelector('#am-mdetail-box');
          mbox.hidden = !mbox.hidden;
          ev.target.textContent = mbox.hidden ? 'Show the stores that would be skipped' : 'Hide the stores that would be skipped';
        });
        card.querySelector('#am-detail')?.addEventListener('click', (ev) => {
          const dbox = card.querySelector('#am-detail-box');
          dbox.hidden = !dbox.hidden;
          ev.target.textContent = dbox.hidden ? 'Show the differences' : 'Hide the differences';
        });
        card.querySelector('#am-import').disabled = false;
      } catch (e) {
        box.innerHTML = `<p class="form-error" style="font-size:13px;">${escape(e.message)}</p>`;
        card.querySelector('#am-import').disabled = true;
      }
    };
    card.querySelector('#am-merchants').addEventListener('change', preview);
    card.querySelector('#am-machines').addEventListener('change', preview);

    card.querySelector('#am-import').addEventListener('click', async () => {
      const btn = card.querySelector('#am-import');
      btn.disabled = true; btn.textContent = 'Importing…';
      try {
        let created = 0, updated = 0, missed = 0;
        if (parsed) {
          // Sent in the grid shape so the existing importer handles it: header names it already
          // knows, and no contract or terms columns at all, so those stay untouched.
          const fields = [...parsed.fields, 'Branch'];
          const groups = fields.map(f => ['Contact', 'Phone', 'Email', 'Sales person'].includes(f) ? 'Contact' : 'Merchant');
          const rows = parsed.rows.map((r, i) => [...r, parsed.branchCounts[i]]);
          const res = await api('/contracts/import', { method: 'POST',
            body: JSON.stringify({ rows, header: fields, groups, links: {}, recordUpload: true }) });
          created += res.created; updated += res.updated;
          // Only the weekly batch sets this — see importContractsRoute. Taking it from the
          // response means the grid repaints marked without a second round trip.
          if (res.lastUpload?.names?.length) LAST_UPLOAD = res.lastUpload;
          missed = diff ? diff.missing.length : 0;
        }
        if (machines) {
          const r = await importMachineCounts(machines);
          updated += r;
        }
        close();
        await renderContractsScreen();
        alert(`${created} merchant(s) added, ${updated} updated.`
          + (missed ? `\n\n${missed} merchant(s) in your list were not in this file. Nothing was `
                    + `deleted — they are marked ⦿ in the grid, and the status filter lists them.` : '')
          + `\n\nContract dates and revenue-share terms were not changed.`);
      } catch (e) {
        btn.disabled = false; btn.textContent = 'Import';
        alert('Could not import: ' + e.message);
      }
    });
  });
}

// The store registry: one row per shop, carrying the merchant it belongs to. Several MB, so it
// is fetched once per dialog and reused by both the preview and the import — the preview would
// otherwise be a second copy of the same download, or (worse) a second copy of the matching.
let REGISTRY_CACHE = null;
async function loadRegistry() {
  if (!REGISTRY_CACHE) REGISTRY_CACHE = await api('/merchants').catch(() => []);
  return REGISTRY_CACHE;
}

// Machine counts arrive per STORE; a merchant's count is the sum over the stores it owns. Store
// ownership is whatever the registry already knows, so a store this app has never seen is
// skipped rather than guessed at — but NAMED rather than skipped in silence, which is what this
// used to do. Two ways to miss, reported apart because they need different fixes:
//   `unknown`  — no registry row with that store name at all. The registry learns store names
//                from run rosters, so this is usually a shop that has never been in one.
//   `unlinked` — the shop IS in the registry but its row carries no contractId, so there is no
//                merchant to add the machines to.
// Both are dropped either way; the difference is whether the shop or the link is missing.
function matchMachineStores(byStore, merchants) {
  const linkedOf = new Map(), known = new Set();
  for (const m of merchants || []) {
    const k = String(m.name ?? '').toLowerCase().trim();
    if (!k) continue;
    known.add(k);
    if (m.contractId && !linkedOf.has(k)) linkedOf.set(k, m.contractId);
  }
  const totals = new Map();
  const unknown = [], unlinked = [];
  let matchedStores = 0, matchedMachines = 0;
  for (const [store, counts] of byStore) {
    const n = Object.values(counts).reduce((a, b) => a + b, 0);
    const k = String(store ?? '').toLowerCase().trim();
    const cid = linkedOf.get(k);
    if (!cid) { (known.has(k) ? unlinked : unknown).push({ store, machines: n }); continue; }
    matchedStores++; matchedMachines += n;
    const acc = totals.get(cid) || {};
    for (const [model, c] of Object.entries(counts)) acc[model] = (acc[model] || 0) + c;
    totals.set(cid, acc);
  }
  return { totals, matchedStores, matchedMachines, unknown, unlinked };
}

async function importMachineCounts(machines) {
  const { totals } = matchMachineStores(machines.byStore, await loadRegistry());
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
      never paid in a run. Unarchive to bring one back into the Merchant view.</p>
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
      <td>${cell(c.counterParty)}</td>
      <td>${cell(c.startDate)}</td>
      <td>${cell(c.endDate)}</td>
      <td>${cell((c.archivedAt || '').slice(0, 10))}</td>
      <td class="ct-c">${can('manageMerchants')
        ? `<button class="btn-ghost ar-unarch-btn" data-id="${escape(c.contractId)}" title="Return this merchant to the Merchant view">Unarchive</button>`
        : ''}</td>
    </tr>`).join('')
    : '<tr><td colspan="7" class="muted">No archived merchants yet.</td></tr>';
  const count = document.getElementById('ar-count');
  if (count) count.textContent = all.length ? `${rows.length} of ${all.length}` : '';
}

function paintContracts() {
  // No-op when the Merchant view screen isn't mounted — openTermsEditor calls this
  // unconditionally on save, and it's also opened from other screens (the run wizard).
  const body = document.getElementById('ct-body');
  if (!body) return;
  const q = (document.getElementById('ct-search')?.value || '').toLowerCase().trim();
  const statusSel = document.getElementById('ct-status');
  const status = statusSel?.value || '';
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
    (status !== 'missing' || MISSING_UPLOAD.has(c.contractId)));
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
  // else on this grid — merchant, type, branches, contacts, machine counts — arrives from the
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
      <td>${escape(periodMonth(r.periodStart))}${r.archived ? ' <span class="badge badge-neutral" title="Archived — cannot be deleted without unarchiving">🔒 Locked</span>' : ''}</td>
      <td>${escape(r.uploadedAt?.split('T')[0] || '')}</td>
      <td style="text-align:right;" title="Revenue that reached a paid merchant">${rev == null ? '<span class="muted">—</span>' : fmt2(rev)}</td>
      <td style="text-align:right;"><strong>${fmt2(r.totalPayout || 0)}</strong></td>
      <td style="text-align:right;" title="Payout as a share of that revenue">${rev > 0 ? ((r.totalPayout || 0) / rev * 100).toFixed(1) + '%' : '<span class="muted">—</span>'}</td>
      <td style="text-align:right;">${Number(r.unmatchedCount || 0) > 0
        ? `<span style="color:#f03e3e;">${Number(r.unmatchedCount)}</span>`
        : '0'}</td>
      <td style="text-align:right;">${(!r.archived && can('deleteRuns')) ? `<button class="btn-ghost del-run" data-id="${r.runId}" style="color:var(--loss);">Delete</button>` : ''}</td>
    </tr>`; }).join('')}</tbody></table>`;
  out.querySelectorAll('tr[data-id]').forEach(tr => {
    tr.addEventListener('click', () => renderBulkRunDetail(tr.dataset.id));
  });
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
          alert('Unarchive first before deleting this run.');
        } else {
          alert('Delete failed: ' + e.message);
        }
        btn.disabled = false; btn.textContent = 'Delete';
      }
    });
  });
}

function renderNewBulkRunForm() {
  const now = new Date();
  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const main = document.getElementById('main');

  // Wizard state
  const wiz = { periodStart: null, periodEnd: null, merchants: null, prepare: null, orders: null };

  function pad(n) { return String(n).padStart(2, '0'); }

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

      <!-- Step 2: Merchant list -->
      <div class="wizard-step ${!step1Done ? 'wizard-step-locked' : ''}" id="wiz-step2">
        <div class="wizard-step-head"><span class="wizard-step-num">2</span> Merchant list (Businessmen list)</div>
        <div class="wizard-step-body">
          ${!step1Done ? '<p class="muted">Complete Step 1 first.</p>' : `
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
            <span style="font-size:12.5px;color:var(--ink-soft);">Businessmen list (.xlsx)</span>
            <button type="button" id="wiz-ml-sample" class="btn-ghost" style="font-size:12px;padding:2px 8px;">↓ Sample file</button>
          </div>
          <input type="file" id="wiz-ml-file" accept=".xlsx" style="display:none">
          <div id="wiz-ml-zone" class="upload-zone" style="cursor:pointer;">
            <p>Choose the Businessmen list Excel file</p>
            <button type="button" id="wiz-ml-choose" class="btn">Choose file</button>
            <div id="wiz-ml-name" class="upload-hint"></div>
          </div>
          <div id="wiz-ml-status" style="margin-top:10px;"></div>
          ${step2Done ? `<div style="margin-top:10px;padding:12px 16px;background:#ebfbee;border:1px solid #8ce99a;border-radius:8px;font-size:13.5px;">
            <strong>Roster loaded:</strong> ${wiz.prepare.rosterCount} machines · ${wiz.prepare.merchantBrandCount} merchants
            ${wiz.prepare.newMerchants?.length ? `· <span style="color:#e67700;" title="${escape(wiz.prepare.newMerchants.slice(0, 40).join(', '))}">${wiz.prepare.newMerchants.length} brand(s) not in your merchant list</span>` : ''}
            ${wiz.prepare.unassigned?.length ? `· <span style="color:#e67700;">${wiz.prepare.unassigned.length} unassigned store(s)</span>` : ''}
            ${wiz.prepare.unitsDiffer?.length ? `· <span style="color:var(--ink-soft);">machine counts differ on ${wiz.prepare.unitsDiffer.length} merchant(s)</span>` : ''}
            <div class="muted" style="margin-top:4px;font-size:12px;">
              A run never changes your merchant list — it reads each merchant's terms and nothing
              else. Brands above that you don't carry are not paid and not added; their revenue is
              reported under Skipped on the run.
            </div>
          </div>` : ''}
          `}
        </div>
      </div>

      <!-- Step 3: Review rules -->
      <div class="wizard-step ${!step2Done ? 'wizard-step-locked' : ''}" id="wiz-step3">
        <div class="wizard-step-head"><span class="wizard-step-num">3</span> Review rules</div>
        <div class="wizard-step-body">
          ${!step2Done ? '<p class="muted">Complete Step 2 first.</p>' : (
            pendingTerms.length === 0
              ? '<p style="color:#2b8a3e;">✓ All merchants have revenue-share terms — Step 4 is unlocked.</p>'
              : `<p style="color:#e67700;"><strong>${pendingTerms.length} merchant(s) need revenue-share terms before you can run:</strong></p>
                 <div id="wiz-rule-editors"></div>`
          )}
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
            <p class="upload-hint" style="margin:4px 0 8px;">The order report identifies a store only by name, so a store renamed in one export and not the other is paid to nobody. Upload this and any such order is recovered by machine number instead. Needs <code style="font-size:11px;">Machine No</code> and <code style="font-size:11px;">Business ID</code>.</p>
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

    // Step 2 merchant list
    if (step1Done) {
      document.getElementById('wiz-ml-sample')?.addEventListener('click', downloadMerchantListSample);
      document.getElementById('wiz-ml-choose')?.addEventListener('click', () => document.getElementById('wiz-ml-file').click());
      document.getElementById('wiz-ml-zone')?.addEventListener('click', e => { if (e.target.id !== 'wiz-ml-choose') document.getElementById('wiz-ml-file').click(); });
      document.getElementById('wiz-ml-file')?.addEventListener('change', async e => {
        const file = e.target.files[0];
        if (!file) return;
        const nameEl = document.getElementById('wiz-ml-name');
        if (nameEl) nameEl.textContent = file.name;
        const status = document.getElementById('wiz-ml-status');
        status.innerHTML = 'Parsing merchant list…';
        try {
          const { merchants, excluded } = await parseMerchantList(file);
          if (!merchants.length) { status.innerHTML = '<p style="color:#f03e3e;">No Approved merchants found in file.</p>'; return; }
          status.innerHTML = `Parsed ${merchants.length} merchants${excluded.length ? ` (${excluded.length} not Approved, excluded)` : ''}. Preparing…`;
          wiz.merchants = merchants;
          wiz.excluded = excluded;
          const prepare = await api('/bulk-runs/prepare', { method: 'POST', body: JSON.stringify({ merchants }) });
          wiz.prepare = prepare;
          render();
          // Populate rule editors after render
          renderWizardRuleEditors();
        } catch (err) {
          status.innerHTML = `<p style="color:#f03e3e;">Error: ${escape(err.message)}</p>`;
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
          ['1001', 'Example Store 1', 0, 40, 40, 'Paid'],
          ['1002', 'Example Store 2', 0, 20, 20, 'Paid'],
          ['1003', 'Example Store 3', 0, 30, 30, 'Paid'],
          ['1004', 'Example Store 4', 5, 45, 40, 'Paid'],
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
          status.innerHTML = `<span style="color:#2b8a3e;">✓ ${wiz.machines.length} machines — renamed stores will be matched by machine number.</span>`;
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
              const run = await api('/bulk-runs', {
                method: 'POST',
                body: JSON.stringify({ periodStart: wiz.periodStart, periodEnd: wiz.periodEnd, merchants: wiz.merchants, orders: wiz.orders, machines: wiz.machines || [], excluded: wiz.excluded || [] })
              });
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

  // List the merchants still needing revenue-share terms; each opens the Merchant view's
  // own terms dialog (openTermsEditor) rather than a partner-shaped editor — the row IS
  // the payout record now. That dialog reads from the CONTRACTS / MACHINE_MODELS_CACHE
  // globals, which only the Merchant view screen normally populates, so load them here
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
        wiz.prepare = await api('/bulk-runs/prepare', { method: 'POST', body: JSON.stringify({ merchants: wiz.merchants }) });
      } catch (e) {
        alert('Could not refresh readiness: ' + e.message);
        return;
      }
      render();
    }
  }

  render();
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
//   row  n+3    the orders themselves — rental/return time, both stores and their KA names,
//               duration, net amount, status
//
// The second block needs order-level columns that runs before 2026-09-01 never kept, so for
// those the sheet carries the pivot and says so rather than inventing rows.
const SHEET_SAFE = /[\\/?*\[\]:]/g;

function buildPartnerSheet(XLSXns, result, orders, kaByStore) {
  const merchants = result.merchants || [];
  const eng = result.engineResult || {};
  const perStore = Array.isArray(eng.byStore);

  // Per-store share: the engine's own figure in per_store mode; apportioned by revenue in whole
  // mode, where it computes one number for the merchant and no split exists.
  let shares;
  if (perStore) {
    const byStore = {};
    eng.byStore.forEach(x => { byStore[x.storeId] = x.payout; });
    shares = merchants.map(m => byStore[m.merchantId] || 0);
  } else {
    shares = apportion(result.payout || 0, merchants.map(m => Math.max(0, Number(m.revenue) || 0)));
  }

  // The amount columns carry the currency. The source format omits it because it only ever
  // described one country; with two regions sharing this download, a statement of bare numbers
  // is ambiguous. Taken from the merchant's own stored currency, not the region, so a run can
  // never label a merchant with a currency it is not paid in.
  const ccy = result.currency || '';
  const money = (label) => ccy ? `${label} (${ccy})` : label;
  const aoa = [['Rental Place', 'Count of order number', money('Sum of Paid'), 'Max of Sharing Rate', money('Sum of Sharing Amount')]];
  let nOrders = 0, sumPaid = 0, sumShare = 0, maxRate = 0;
  merchants.forEach((m, i) => {
    const rate = m.revenue > 0 ? shares[i] / m.revenue : 0;
    nOrders += m.rentals; sumPaid += m.revenue; sumShare += shares[i];
    maxRate = Math.max(maxRate, rate);
    aoa.push([m.merchantName, m.rentals, round2(m.revenue), round4(rate), round2(shares[i])]);
  });
  if (perStore && eng.topLevel && eng.topLevel.payout) {
    sumShare += eng.topLevel.payout;
    aoa.push(['(merchant-level lump sum)', null, null, null, round2(eng.topLevel.payout)]);
  }
  aoa.push(['Grand Total', nOrders, round2(sumPaid), round4(maxRate), round2(sumShare)]);

  aoa.push([], []);
  if (orders) {
    aoa.push(['Rental Time', 'Rental Merchant', 'Rental KA Name', 'Return Time', 'Return Merchant',
              'Return KA Name', 'Rental Duration', money('Net Amount'), 'Order Status']);
    for (const o of orders) {
      aoa.push([o.rentalTime || '', o.merchantName || '', result.merchantName,
                o.returnTime || '', o.returnMerchant || '',
                // The brand that owns the RETURN store, which is often a different merchant —
                // and blank when it is a store this run never saw.
                kaByStore.get(String(o.returnMerchant || '').toLowerCase().trim()) || R().notFound,
                o.duration ?? '', Number(o.netAmount) || 0, o.orderStatus || '']);
    }
  } else {
    aoa.push(['Order detail was not recorded for this run.']);
  }

  const ws = XLSXns.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 46 }, { wch: 20 }, { wch: 14 }, { wch: 18 }, { wch: 20 },
                 { wch: 46 }, { wch: 16 }, { wch: 14 }, { wch: 14 }];
  return ws;
}

const round2 = v => Math.round(Number(v) * 100) / 100;
const round4 = v => Math.round(Number(v) * 10000) / 10000;

async function downloadRevshareZip(run) {
  const tag = periodTag(run.periodStart);
  const results = (run.results || []).slice().sort((a, b) => b.payout - a.payout);

  // Orders live in the run's stored inputs, not its payload — one fetch of several MB, only
  // when someone actually downloads. A run without them still produces the summary block.
  let orders = null;
  try {
    const inputs = await api(`/bulk-runs/${encodeURIComponent(run.runId)}/inputs`);
    if (Array.isArray(inputs?.orders) && inputs.orders.some(o => o.rentalTime != null)) orders = inputs.orders;
  } catch { /* older run, or inputs gone — fall back to the summary block alone */ }

  // Which merchant does an order belong to? Every store name this run paid, plus the names
  // recovered by machine number or manual assignment, mapped to the merchant that was paid.
  const contractOfStore = new Map();
  const kaByStore = new Map();
  for (const r of results) {
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

  const used = {};
  const files = results.map((r, i) => {
    const label = `${i + 1}) ${sanitizeFilename(r.merchantName)}`;
    let base = label;
    if (used[base]) { base = `${base} (${used[base]++})`; } else { used[base] = 1; }
    const wb = XLSX.utils.book_new();
    // Excel caps a sheet name at 31 characters and rejects \ / ? * [ ] :
    const sheetName = base.replace(SHEET_SAFE, '-').slice(0, 31);
    XLSX.utils.book_append_sheet(wb, buildPartnerSheet(XLSX, r, orders ? (ordersByContract.get(r.contractId) || []) : null, kaByStore), sheetName);
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

// One row per leaf and model, summed across stores: "S8 x26 @ 4,000 = 104,000".
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

async function renderBulkRunDetail(runId) {
  const main = document.getElementById('main');
  main.innerHTML = `<div class="page-head">
      <div style="display:flex;align-items:baseline;gap:14px;"><button id="back" class="btn-ghost">← Back</button><h2 id="br-title">Run share</h2></div>
      <div id="br-actions"></div>
    </div><div id="br-detail">Loading…</div>`;
  document.getElementById('back').addEventListener('click', renderBulkRunsList);
  const run = await api('/bulk-runs/' + runId);
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

  // Archive / Unarchive / Delete — rendered into the header, opposite the title.
  const archiveBar = (() => {
    const parts = [];
    if (isArchived) {
      parts.push(`<span class="badge badge-neutral" style="font-size:13px;">🔒 Locked (archived)</span>`);
      if (can('admin')) {
        parts.push(`<button id="br-unarchive" class="btn-ghost" style="margin-left:10px;">Unarchive</button>`);
      }
      // Delete is hidden/disabled when archived
    } else {
      if (can('runCalcs')) {
        parts.push(`<button id="br-archive" class="btn-ghost">Archive</button>`);
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

  // One row of the "revenue not paid" table: a headline, and a panel it expands into.
  const npRow = (key, label, count, unit, revenue, body, note) => !count ? '' : `
    <tr class="np-row" data-np="${key}">
      <td style="width:60%;"><button type="button" class="btn-ghost np-toggle" data-np="${key}" style="padding:0;font-size:13.5px;">▸ ${label}</button>
        ${note ? `<div class="muted" style="font-size:12px;margin-top:2px;">${note}</div>` : ''}</td>
      <td style="text-align:right;white-space:nowrap;">${count} ${escape(unit)}</td>
      <td style="text-align:right;"><strong>${fmt2(revenue)}</strong></td>
    </tr>
    <tr id="np-${key}" hidden><td colspan="3" style="background:var(--bg-soft);padding:12px 14px;">${body}</td></tr>`;

  el.innerHTML = `
    ${(run.results?.length) ? `<p><a href="#" id="dl-revshare-zip" class="zip-link">↓ ${escape(periodTag(run.periodStart))}_revshare</a></p>` : ''}

    <table class="ts"><thead><tr><th>Merchant</th><th>Stores</th><th>Rentals</th><th>Revenue</th><th>Payout</th><th>Share %</th></tr></thead>
    <tbody>${(run.results || []).sort((a,b) => b.payout - a.payout).map(r => `<tr>
      <td>${escape(r.merchantName)}</td>
      <td>${r.merchantCount}</td>
      <td>${r.rentals}</td>
      <td>${Number(r.revenue).toFixed(2)}</td>
      <td><strong>${Number(r.payout).toFixed(2)}</strong></td>
      <td>${r.revenue > 0 ? (r.payout / r.revenue * 100).toFixed(1) + '%' : '—'}</td>
    </tr>`).join('')}</tbody>
    <tfoot><tr>
      <td>Total</td><td></td><td></td>
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
            run.matchedByMachine?.length ? `${run.matchedByMachine.length} store(s) by machine number` : '',
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
            <thead><tr><th style="text-align:left;">Merchant</th><th style="text-align:right;">Stores</th><th style="text-align:right;">Rentals</th><th style="text-align:right;">Revenue</th><th style="text-align:left;">Reason</th></tr></thead>
            <tbody>${(run.skipped || []).slice().sort((a2,b2) => b2.revenue - a2.revenue).map(sk => `<tr>
              <td>${escape(sk.merchantName || '')}</td><td style="text-align:right;">${sk.merchantCount}</td>
              <td style="text-align:right;">${sk.rentals}</td><td style="text-align:right;">${fmt2(sk.revenue)}</td>
              <td class="muted">${escape(sk.reason || '')}</td></tr>`).join('')}</tbody></table>`,
          'Their orders matched, but the merchant is marked no-payout, archived, or has no usable terms.')}

        ${npRow('notapproved', 'Not Approved in the merchant list', naDetail.length, 'stores', naRevenue,
          `<p class="muted" style="margin:0 0 8px;font-size:13px;">The platform knows these stores; they were excluded because their review state is not Approved. A store marked Disapproved can still have a live machine.</p>
           <table style="font-size:13px;width:100%;">
            <thead><tr><th style="text-align:left;">Store</th><th style="text-align:left;">Review state</th><th style="text-align:left;">Would be paid under</th><th style="text-align:right;">Orders</th><th style="text-align:right;">Revenue</th></tr></thead>
            <tbody>${naDetail.map(u => `<tr><td>${escape(u.name || '')}</td>
              <td><span style="color:#d9480f;font-weight:600;">${escape(u.reviewState)}</span></td>
              <td>${escape(u.label || '—')}</td><td style="text-align:right;">${num(u.orders)}</td>
              <td style="text-align:right;">${fmt2(u.revenue)}</td></tr>`).join('')}</tbody></table>`,
          'Fix the review state in ChargeSpot, or assign the name to a merchant below.')}

        ${npRow('unknown', 'Unmatched — no such store anywhere', unknownDetail.length, 'names', unmatchedRevenue - naRevenue,
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
    if (!confirm('Archive this run? It will be locked and cannot be deleted until unarchived.')) return;
    const btn = main.querySelector('#br-archive');
    btn.disabled = true; btn.textContent = 'Archiving…';
    try {
      await api('/bulk-runs/' + runId + '/archive', { method: 'POST' });
      renderBulkRunDetail(runId);
    } catch (e) {
      alert('Archive failed: ' + e.message);
      btn.disabled = false; btn.textContent = 'Archive';
    }
  });

  main.querySelector('#br-unarchive')?.addEventListener('click', async () => {
    if (!confirm('Unarchive this run? It will no longer be locked.')) return;
    const btn = main.querySelector('#br-unarchive');
    btn.disabled = true; btn.textContent = 'Unarchiving…';
    try {
      await api('/bulk-runs/' + runId + '/unarchive', { method: 'POST' });
      renderBulkRunDetail(runId);
    } catch (e) {
      alert('Unarchive failed: ' + e.message);
      btn.disabled = false; btn.textContent = 'Unarchive';
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
        alert('Unarchive first before deleting this run.');
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
        <table class="row-form">
          <thead><tr>
            <th style="width:50%">Device type</th>
            <th style="width:35%">Amount (${CCY}/machine/month)</th>
            ${readOnly ? '' : '<th style="width:15%"></th>'}
          </tr></thead>
          <tbody>
            ${(form.mgRows || []).map((r, i) => `<tr>
              <td><select class="mg-model" data-i="${i}" ${d(rawMode)}>
                <option value="">— select —</option>
                <option value="ALL" ${r.model === 'ALL' ? 'selected' : ''}>All device types</option>
                ${(machineModels || []).map(m => `<option value="${escape(m.code)}" ${r.model===m.code?'selected':''}>${escape(m.displayName)}</option>`).join('')}
              </select></td>
              <td><input class="mg-amt" data-i="${i}" type="number" min="0" value="${r.amount||0}" ${d(rawMode)}></td>
              ${readOnly ? '' : `<td style="text-align:center"><button class="mg-del btn-ghost" data-i="${i}" style="color:var(--loss);padding:4px 8px;font-size:13px;" ${rawMode?'disabled':''}>✕</button></td>`}
            </tr>`).join('')}
            ${(!readOnly && !rawMode) ? '<tr><td colspan="3" style="padding-top:4px"><button id="mg-add" class="add-row-btn">+ Add device type</button></td></tr>' : ''}
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
async function ensureContractCache() {
  if (CONTRACTS.length && MACHINE_MODELS_CACHE.length) return;
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
           <strong>This adds a store to ${escape(c.merchantName)}.</strong> Its rule pays per machine
           (${terms.map(t => `${escape(t.model)}: ${fmt2(t.amount)}`).join(', ')}), so the payout increases by that
           amount on top of any revenue share.
         </div>`
      : `<p class="muted" style="font-size:12.5px;margin:0;">Adds a store to this merchant. Its rule has no
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
    alert(`Created "${contract.merchantName}" and assigned "${orderName}" to it.\n\nSet its revenue-share terms in Merchant view — until then it has no terms and will not be paid.`);
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

// === API / region ===
// One site, two backends. Both API URLs are public (no auth). Switching region
// persists to localStorage and reloads (see switchRegion) so no TH/SG state bleeds.
const REGIONS = {
  th: { name: 'Thailand',  api: 'https://7z269nmx74.execute-api.ap-southeast-7.amazonaws.com/prod', ccy: 'THB', sym: '฿'  },
  sg: { name: 'Singapore', api: 'https://4qcyojfg79.execute-api.ap-southeast-7.amazonaws.com/prod', ccy: 'SGD', sym: 'S$' },
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
const RS_MODELS = ['S5','S8','S10','T8','T10','T20','T35','L20','L40'];

function parseDeviceModel(deviceType) {
  const s = String(deviceType || '').toUpperCase();
  // trailing model code, e.g. "ADVERTISING PLAYER-S5" -> S5
  const hit = RS_MODELS.filter(m => s.endsWith(m) || s.includes('-' + m) || s.includes(' ' + m));
  return hit.length ? hit.sort((a, b) => b.length - a.length)[0] : null;
}

async function parseMerchantList(file) {
  const wb = await readExcel(file);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: null });
  return rows
    .filter(r => String(r['Merchant Review State'] || '').trim().toLowerCase() === 'approved')
    .map(r => ({
      name: String(r['merchant name.'] || '').trim(),
      nameEn: String(r['merchant name (English)'] || '').trim(),
      partnerName: String(r['Merchant label'] || '').trim(),
      model: parseDeviceModel(r['device type.']),
      externalId: String(r['ID'] || '').trim(),
    }))
    .filter(r => r.name);
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
async function boot() {
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

function renderNav() {
  const nav = document.getElementById('topnav');
  nav.innerHTML = `
    <button id="nav-contracts" class="nav-btn active">Merchant view</button>
    ${can('runCalcs') ? '<button id="nav-bulk-runs" class="nav-btn">Run share</button>' : ''}
    <button id="nav-revshare-path" class="nav-btn">Analytics</button>
    <button id="nav-device-types" class="nav-btn">Device Types</button>
    <button id="nav-archived" class="nav-btn">Archived</button>
    ${can('admin') ? '<button id="nav-users" class="nav-btn">Users</button>' : ''}`;
  nav.querySelector('#nav-archived').addEventListener('click', () => { setActiveNav('nav-archived'); renderArchivedScreen(); });
  nav.querySelector('#nav-bulk-runs')?.addEventListener('click', () => { setActiveNav('nav-bulk-runs'); renderBulkRunsList(); });
  nav.querySelector('#nav-revshare-path').addEventListener('click', () => { setActiveNav('nav-revshare-path'); renderRevsharePathScreen(); });
  nav.querySelector('#nav-device-types').addEventListener('click', () => { setActiveNav('nav-device-types'); renderDeviceTypesScreen(); });
  nav.querySelector('#nav-contracts').addEventListener('click', () => { setActiveNav('nav-contracts'); renderContractsScreen(); });
  nav.querySelector('#nav-users')?.addEventListener('click', () => { setActiveNav('nav-users'); renderUsersScreen(); });
}

function setActiveNav(id) {
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.id === id));
  // The merchant grid is ~2400px of columns; the app's 1100px content column hides most
  // of them behind a scrollbar. Let this one screen use the whole window.
  document.getElementById('main')?.classList.toggle('main-wide', id === 'nav-contracts');
}


const PERM_LABELS = { editPartners:'Edit partners & rules', runCalcs:'Run calcs', deleteRuns:'Delete runs', manageMerchants:'Manage merchants', manageDeviceTypes:'Device types', admin:'Admin' };
async function renderUsersScreen() {
  const main = document.getElementById('main');
  main.innerHTML = '<h2>Users</h2><p class="muted">Grant per-feature access. Anyone with a company Google account can sign in (read-only) until granted more.</p><div id="users-out">Loading…</div>';
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
    renderUsersScreen();
  };
}

async function renderRevsharePathScreen() {
  const main = document.getElementById('main');
  main.innerHTML = `<div class="page-head"><h2>Analytics</h2></div>
    <div style="max-width:340px;margin-bottom:8px;">
      <input id="rp-search" class="search-input" list="rp-options" placeholder="Search merchant… (or Total)" autocomplete="off">
      <datalist id="rp-options"></datalist>
    </div>
    <div id="rp-title" class="muted" style="margin:4px 0 10px;font-size:13px;"></div>
    <div id="rp-chart">Loading…</div>`;

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
  }

  document.getElementById('rp-search').addEventListener('input', e => show(e.target.value));
  show('Total');   // default
}

async function renderDeviceTypesScreen() {
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head">
      <h2>Device Types</h2>
      ${can('manageDeviceTypes') ? '<button id="add-model-btn" class="btn-primary">+ Add device type</button>' : ''}
    </div>
    <div id="model-form-slot"></div>
    <div id="models-out">Loading…</div>`;

  document.getElementById('add-model-btn')?.addEventListener('click', showAddModelForm);

  async function loadModels() {
    const out = document.getElementById('models-out');
    if (!out) return;
    const models = await api('/machine-models');
    if (!models.length) { out.innerHTML = '<p class="muted">No device types yet.</p>'; return; }
    out.innerHTML = `
      <table class="ts">
        <thead><tr><th>Display Name</th><th>Code</th><th></th></tr></thead>
        <tbody>
          ${models.map(m => `
            <tr id="model-row-${escape(m.code)}">
              <td>${escape(m.displayName)}</td>
              <td><span class="badge badge-neutral">${escape(m.code)}</span></td>
              <td>
                ${can('manageDeviceTypes') ? `<button class="btn-ghost edit-model" data-code="${escape(m.code)}" data-dn="${escape(m.displayName)}">Edit</button>` : ''}
                ${can('manageDeviceTypes') ? `<button class="btn-ghost del-model" data-code="${escape(m.code)}" style="color:var(--loss)">Delete</button>` : ''}
              </td>
            </tr>`).join('')}
        </tbody>
      </table>`;
    out.querySelectorAll('.edit-model').forEach(btn => {
      btn.addEventListener('click', () => showEditModelForm(btn.dataset.code, btn.dataset.dn));
    });
    out.querySelectorAll('.del-model').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm(`Delete device type "${btn.dataset.code}"? Merchants with this model will keep their existing value.`)) return;
        await api('/machine-models/' + btn.dataset.code, { method: 'DELETE' });
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

const CONTRACT_GRID_COLUMNS = [
  { key: 'merchantName',          label: 'Merchant',      type: 'text',   width: 165 , group: 'id' },
  { key: 'merchantType',          label: 'Type',          type: 'select', width: 120 , group: 'id' },
  { key: 'counterParty',          label: 'Counter party', type: 'text',   width: 175 , group: 'id' },
  { key: 'contactName',           label: 'Contact',       type: 'text',   width: 125 , group: 'contact' },
  { key: 'contactPhone',          label: 'Phone',         type: 'text',   width: 110 , group: 'contact' },
  { key: 'contactEmail',          label: 'Email',         type: 'text',   width: 160 , group: 'contact' },
  { key: 'installedUnits',        label: 'Units',         type: 'computed', width: 55 , group: 'machines' },
  { key: 'units.S5',              label: 'S5',            type: 'number', width: 46  , group: 'machines' },
  { key: 'units.S8',              label: 'S8',            type: 'number', width: 46  , group: 'machines' },
  { key: 'units.M10',             label: 'M10',           type: 'number', width: 50  , group: 'machines' },
  { key: 'units.L20',             label: 'L20',           type: 'number', width: 46  , group: 'machines' },
  { key: 'units.L40',             label: 'L40',           type: 'number', width: 46  , group: 'machines' },
  { key: 'startDate',             label: 'Start',         type: 'date',   width: 108 , group: 'contract' },
  { key: 'endDate',               label: 'End',           type: 'date',   width: 108 , group: 'contract' },
  { key: 'terminationNoticeDays', label: 'Notice',        type: 'number', width: 84  , group: 'contract', suffix: ' days' },
  { key: 'declineToRenew',        label: 'Decline',       type: 'bool',   width: 62  , group: 'contract' },
  { key: 'autoRenewal',           label: 'Auto-renewal',  type: 'select', width: 135 , group: 'contract' },
  { key: 'contractLink',          label: 'Contract',      type: 'url',    width: 80  , group: 'contract' },
  { key: 'term.method',      label: 'Mode',         type: 'term-mode',    width: 130, group: 'terms' },
  { key: 'term.summary',     label: 'Rev terms',    type: 'term-summary', width: 230, group: 'terms' },
];

// 23 columns is ~2400px — more than a laptop can show at once even full-width. Rather than
// hiding data behind a horizontal scrollbar, let the user switch whole groups off. `id` has
// no toggle: the merchant is what identifies the row.
const CONTRACT_GROUPS = [
  { key: 'contact',  label: 'Contact'  },
  { key: 'machines', label: 'Machines' },
  { key: 'contract', label: 'Contract' },
  { key: 'terms',    label: 'Share terms' },
];
let CONTRACT_GROUPS_ON = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem('rs_ct_groups') || 'null');
    if (saved && typeof saved === 'object') return saved;
  } catch { /* corrupt or unavailable storage — fall through to all-on */ }
  return Object.fromEntries(CONTRACT_GROUPS.map(g => [g.key, true]));
})();
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
                        open: !g || CONTRACT_GROUPS_ON[key] !== false, cols: [] });
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
  CONTRACT_GROUPS_ON = { ...CONTRACT_GROUPS_ON, [key]: CONTRACT_GROUPS_ON[key] === false };
  try { localStorage.setItem('rs_ct_groups', JSON.stringify(CONTRACT_GROUPS_ON)); } catch { /* private mode */ }
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
    if (i === 0) {
      // Two independent row-level flags ride the frozen Merchant column so they stay visible
      // however far right the grid is scrolled: renewal risk, and "this will block a run".
      if (needsTerms(c)) {
        disp = '<span class="ct-alert ct-alert-terms" title="No terms that pay anything — this merchant will block Step 4 of a run until its terms are set, or it is marked None">◆</span>' + disp;
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
    const tip = col.key === 'endDate' && rf.title ? ` title="${escape(rf.title)}"` : '';
    return `<td class="ct-cell ${cls}${flag}" data-id="${escape(c.contractId)}" data-key="${col.key}"${tip}>${disp}</td>`;
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

async function createContractRow() {
  const name = (prompt('Merchant name') || '').trim();
  if (!name) return;
  const clash = CONTRACTS.find(c => (c.merchantName || '').toLowerCase().trim() === name.toLowerCase());
  if (clash && !confirm(`"${clash.merchantName}" is already in the list. Add a second row with the same name?\n\nA sheet re-import matches on merchant name, so two rows sharing one name will be merged into one on the next import.`)) return;
  try {
    const created = await api('/contracts', { method: 'POST', body: JSON.stringify({ merchantName: name }) });
    CONTRACTS.push(created);
    document.getElementById('ct-search').value = name;   // filter to it so it isn't lost in 208 rows
    paintContracts();
  } catch (err) { alert('Could not create: ' + err.message); }
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
  const header2 = aoa[1] || [];
  if (!/merchant/i.test(String(header2[1] || '')) || !/link/i.test(String(header2[22] || ''))) {
    throw new Error('This workbook\'s "All_Merchant" sheet layout has changed — column positions no longer match what the importer expects. Check for inserted/removed/reordered columns before re-uploading.');
  }
  const body = aoa.slice(2);
  const rows = body
    .map(r => { const c = new Array(23).fill(null); for (let i = 0; i < 23; i++) c[i] = r[i] ?? null; return c; })
    .filter(c => String(c[1] || '').trim());
  return { rows, skipped: body.length - rows.length };
}

async function renderContractsScreen() {
  const el = document.getElementById('main');
  el.classList.add('main-wide');   // also covers the boot path, which doesn't go via setActiveNav
  el.innerHTML = '<h1>Merchant view</h1><p class="muted">Loading…</p>';
  const [contracts, machineModels] = await Promise.all([
    api('/contracts'), api('/machine-models')
  ]);
  CONTRACTS = contracts;
  MACHINE_MODELS_CACHE = machineModels;
  el.innerHTML = `
    <h1>Merchant view</h1>
    <div class="ct-toolbar">
      <input id="ct-search" class="input" placeholder="Search merchant…" style="max-width:240px">
      <select id="ct-status" class="input" style="max-width:230px">
        <option value="">All merchants</option>
        <option value="needs">◆ Needs terms</option>
        <option value="due">⚠ Contract due or overdue</option>
      </select>
      ${can('manageMerchants') ? '<button type="button" id="ct-new" class="btn btn-primary">+ New merchant</button>' : ''}
      ${can('manageMerchants') ? '<button type="button" id="ct-file-choose" class="btn">Upload sheet</button><input type="file" id="ct-file" accept=".xlsx" style="display:none">' : ''}
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
  el.querySelector('#ct-file-choose')?.addEventListener('click', () => el.querySelector('#ct-file').click());
  el.querySelector('#ct-file')?.addEventListener('change', async ev => {
    const file = ev.target.files[0]; if (!file) return;
    ev.target.value = '';
    // Import straight in — no match-review step. Rows whose merchant name happens to match
    // an existing partner record still get that link noted on the row (informational only
    // — it does not carry terms); the rest simply arrive unlinked. Revenue-share terms are
    // set per row via Edit terms, so making linking a gate in front of the import only
    // stood between the user and their data.
    const btn = el.querySelector('#ct-file-choose');
    const label = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Importing…'; }
    try {
      const { rows } = await parseAllMerchantSheet(file);
      const r = await api('/contracts/import', { method: 'POST', body: JSON.stringify({ rows, links: {} }) });
      await renderContractsScreen();
      alert(`Imported ${rows.length} rows from the sheet.\n\n`
          + `${r.created} added, ${r.updated} updated.\n`
          + `${r.linked} matched an existing partner record by name; ${CONTRACTS.length - r.linked} did not.\n\n`
          + `Use Edit terms on a row to set its revenue-share terms.`);
    } catch (err) {
      alert('Could not import that file: ' + err.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = label; }
    }
  });
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
  let rows = live.filter(c =>
    (!q || (c.merchantName || '').toLowerCase().includes(q)) &&
    (status !== 'needs' || needsTerms(c)) &&
    (status !== 'due'   || !!renewalFlag(c).cls));
  rows.sort((a, b) => (a.merchantName || '').localeCompare(b.merchantName || ''));
  body.innerHTML = rows.map(contractRowHtml).join('');
  document.getElementById('ct-count').textContent = `${rows.length} of ${live.length}`;
  // Counts live in the option labels — they move as terms get set and contracts renew, so
  // they are recomputed on every paint rather than baked into the markup once.
  if (statusSel) {
    const counts = { needs: live.filter(needsTerms).length,
                     due:   live.filter(c => renewalFlag(c).cls).length };
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

async function renderBulkRunsList() {
  const main = document.getElementById('main');
  main.innerHTML = `<div class="page-head"><h2>Run share</h2>${can('runCalcs') ? '<button id="new-bulk-run" class="btn-primary">+ New run</button>' : ''}</div><div id="bulk-runs-out">Loading…</div>`;
  document.getElementById('new-bulk-run')?.addEventListener('click', renderNewBulkRunForm);
  const runs = await api('/bulk-runs');
  const out = document.getElementById('bulk-runs-out');
  if (!runs.length) { out.innerHTML = '<p class="muted">No calculations yet.</p>'; return; }
  out.innerHTML = `<table class="ts"><thead><tr><th>Period</th><th>Uploaded</th><th>Merchants</th><th>Total payout</th><th>Unmatched</th><th></th></tr></thead>
    <tbody>${runs.map(r => `<tr data-id="${r.runId}" style="cursor:pointer;">
      <td>${escape(periodMonth(r.periodStart))}${r.archived ? ' <span class="badge badge-neutral" title="Archived — cannot be deleted without unarchiving">🔒 Locked</span>' : ''}</td>
      <td>${escape(r.uploadedAt?.split('T')[0] || '')}</td>
      <td>${r.paidBrandCount}${r.rosterBrandCount > r.paidBrandCount ? ` <span class="muted" style="font-size:11.5px;">of ${r.rosterBrandCount}</span>` : ''}</td>
      <td>${(r.totalPayout || 0).toFixed(2)}</td>
      <td>${r.unmatchedCount > 0 ? `<span style="color:#f03e3e;">${r.unmatchedCount}</span>` : '0'}</td>
      <td style="text-align:right;">${(!r.archived && can('deleteRuns')) ? `<button class="btn-ghost del-run" data-id="${r.runId}" style="color:var(--loss);">Delete</button>` : ''}</td>
    </tr>`).join('')}</tbody></table>`;
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
            ${wiz.prepare.newMerchants?.length ? `· <span style="color:#2b8a3e;">${wiz.prepare.newMerchants.length} new merchant(s) created</span>` : ''}
            ${wiz.prepare.unassigned?.length ? `· <span style="color:#e67700;">${wiz.prepare.unassigned.length} unassigned store(s)</span>` : ''}
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
          const merchants = await parseMerchantList(file);
          if (!merchants.length) { status.innerHTML = '<p style="color:#f03e3e;">No Approved merchants found in file.</p>'; return; }
          status.innerHTML = `Parsed ${merchants.length} merchants. Preparing…`;
          wiz.merchants = merchants;
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
                body: JSON.stringify({ periodStart: wiz.periodStart, periodEnd: wiz.periodEnd, merchants: wiz.merchants, orders: wiz.orders })
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
    .map(r => ({ merchantName: String(r['Rental Merchant'] || '').trim(), netAmount: Number(r['Net Amount'] || 0) }))
    .filter(r => r.merchantName);
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
function buildPartnerCsv(result) {
  const q = s => `"${String(s).replace(/"/g, '""')}"`;
  const n2 = v => (Math.round(Number(v) * 100) / 100).toFixed(2);
  const header = 'Merchant name,Total rentals,Total revenue,Total share amount';

  const eng = result.engineResult || {};
  const perStore = Array.isArray(eng.byStore);
  const merchants = result.merchants || [];

  // Per-merchant share: real per-store payout (per_store mode), or apportioned
  // by revenue from the partner total (whole mode — engine gives no split).
  let shares;
  if (perStore) {
    const byStore = {};
    eng.byStore.forEach(s => { byStore[s.storeId] = s.payout; });
    shares = merchants.map(m => byStore[m.merchantId] || 0);
  } else {
    shares = apportion(result.payout || 0, merchants.map(m => Math.max(0, Number(m.revenue) || 0)));
  }

  let sumRentals = 0, sumRevenue = 0, sumShare = 0;
  const rows = merchants.map((m, i) => {
    sumRentals += m.rentals;
    sumRevenue += m.revenue;
    sumShare += shares[i];
    return [q(m.merchantName), m.rentals, n2(m.revenue), n2(shares[i])].join(',');
  });

  // per_store top-level lump sum (flat_per_partner_total) — not tied to any one merchant
  if (perStore && eng.topLevel && eng.topLevel.payout) {
    sumShare += eng.topLevel.payout;
    rows.push([q('(merchant-level lump sum)'), '', '', n2(eng.topLevel.payout)].join(','));
  }

  const totalRow = [q('Total'), sumRentals, n2(sumRevenue), n2(sumShare)].join(',');
  return [header, ...rows, totalRow].join('\n') + '\n';
}

function downloadRevshareZip(run) {
  const tag = periodTag(run.periodStart);
  const enc = new TextEncoder();
  const used = {};
  const files = (run.results || []).map(r => {
    let base = `${sanitizeFilename(r.merchantName)}_${tag}`;
    if (used[base]) { base = `${base} (${used[base]++})`; } else { used[base] = 1; }
    return { name: `${base}.csv`, data: enc.encode('﻿' + buildPartnerCsv(r)) };
  });
  const blob = SimpleZip.makeZip(files);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${tag}_revshare.zip`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function renderBulkRunDetail(runId) {
  const main = document.getElementById('main');
  main.innerHTML = `<div class="page-head"><button id="back" class="btn-ghost">← Back</button><h2>Run share</h2></div><div id="br-detail">Loading…</div>`;
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
  const fmt2 = v => Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const skippedRevenue = Number(run.skippedRevenue ?? (run.skipped || []).reduce((s, r) => s + (r.revenue || 0), 0));
  const unmatchedRevenue = Number(run.unmatchedRevenue || 0);
  const reconciledTotal = totalRevenue + skippedRevenue + unmatchedRevenue;
  const hasOrderTotal = typeof run.totalOrderRevenue === 'number';
  const reconciles = hasOrderTotal ? Math.abs(reconciledTotal - run.totalOrderRevenue) < 0.01 : null;

  // Archive / Unarchive / Delete action bar
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
    return parts.length ? `<div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">${parts.join('')}</div>` : '';
  })();

  el.innerHTML = `
    ${archiveBar}
    <p class="muted">Period: <strong>${escape(periodMonth(run.periodStart))}</strong> · Uploaded: ${escape(run.uploadedAt?.split('T')[0])} · ${run.orderCount} orders · ${run.paidBrandCount} merchant(s) paid${run.rosterBrandCount > run.paidBrandCount ? ` of ${run.rosterBrandCount} in roster` : ''}</p>
    ${(run.results?.length) ? `<p><a href="#" id="dl-revshare-zip" class="zip-link">↓ ${escape(periodTag(run.periodStart))}_revshare</a> <span class="muted" style="font-size:12px;">(zip · one CSV per merchant)</span></p>` : ''}
    ${run.unmatchedOrderCount ? `
      <div style="margin:8px 0 4px;padding:12px 16px;background:#fff5f5;border:1px solid #ffa8a8;border-radius:8px;font-size:13.5px;">
        <strong style="color:#c92a2a;">⚠ ${Number(run.unmatchedOrderCount).toLocaleString('en-US')} order(s) dropped</strong>
        — ${Number(run.unmatchedCount).toLocaleString('en-US')} unrecognized merchant name(s), revenue not counted:
        <strong>${Number(run.unmatchedRevenue || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>.
        Matched <strong>${Number((run.orderCount || 0) - run.unmatchedOrderCount).toLocaleString('en-US')}</strong> of ${Number(run.orderCount || 0).toLocaleString('en-US')} paid orders.
      </div>` : ''}
    ${run.warnings?.length ? `<p style="color:#e67700;">${run.warnings.map(escape).join('<br>')}</p>` : ''}
    <table class="ts"><thead><tr><th>Merchant</th><th>Merchants</th><th>Rentals</th><th>Revenue</th><th>Payout</th><th>Revenue share %</th></tr></thead>
    <tbody>${(run.results || []).sort((a,b) => b.payout - a.payout).map(r => `<tr>
      <td>${escape(r.merchantName)}</td>
      <td>${r.merchantCount}</td>
      <td>${r.rentals}</td>
      <td>${Number(r.revenue).toFixed(2)}</td>
      <td><strong>${Number(r.payout).toFixed(2)}</strong></td>
      <td>${r.revenue > 0 ? (r.payout / r.revenue * 100).toFixed(1) + '%' : '—'}</td>
    </tr>`).join('')}</tbody>
    <tfoot><tr>
      <td>Total</td>
      <td></td>
      <td></td>
      <td>${totalRevenue.toFixed(2)}</td>
      <td>${Number(run.totalPayout || 0).toFixed(2)}</td>
      <td>${totalSharePct}</td>
    </tr></tfoot>
    </table>
    ${run.skipped?.length ? `
      <div style="margin-top:24px;padding:16px;background:#fff9db;border-radius:8px;border:1px solid #ffe066;">
        <strong style="color:#e67700;">⚠ ${run.skipped.length} merchant(s) skipped — matched orders, not paid</strong>
        <p style="color:#868e96;font-size:13px;">These merchants' stores were in the roster and had matching orders, but were not paid this run (no revenue share, no usable terms, or a calculation error). Their revenue is not in the Payout total above — it's accounted for here instead.</p>
        <table class="ts" style="margin-top:8px;">
          <thead><tr><th>Merchant</th><th>Stores</th><th>Rentals</th><th>Revenue</th><th>Reason</th></tr></thead>
          <tbody>${run.skipped.map(s => `<tr>
            <td>${escape(s.merchantName || s.contractId)}</td>
            <td>${s.merchantCount}</td>
            <td>${s.rentals}</td>
            <td>${Number(s.revenue).toFixed(2)}</td>
            <td style="font-size:12.5px;color:#868e96;">${escape(s.reason || '')}</td>
          </tr>`).join('')}</tbody>
          <tfoot><tr><td>Total</td><td></td><td></td><td>${skippedRevenue.toFixed(2)}</td><td></td></tr></tfoot>
        </table>
      </div>` : ''}
    ${run.unmatched?.length ? `
      <div style="margin-top:24px;padding:16px;background:#fff5f5;border-radius:8px;border:1px solid #ffa8a8;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
          <strong style="color:#c92a2a;">⚠ ${run.unmatched.length} unmatched merchant(s)</strong>
          <button id="dl-unmatched" class="btn-ghost" style="color:var(--accent);">↓ Download list (CSV)</button>
        </div>
        <p style="color:#868e96;font-size:13px;">These names were in the order report but not found in the merchant registry. Add them under the correct merchant and re-run.</p>
        <ul style="font-size:13px;">${run.unmatched.map(n => `<li>${escape(n)}</li>`).join('')}</ul>
      </div>` : ''}
    ${hasOrderTotal ? `
      <div style="margin-top:24px;padding:12px 16px;border-radius:8px;font-size:13px;${reconciles ? 'background:#ebfbee;border:1px solid #8ce99a;color:#2b8a3e;' : 'background:#fff5f5;border:1px solid #ffa8a8;color:#c92a2a;'}">
        <strong>${reconciles ? '✓ Reconciles' : '✗ Does NOT reconcile'}:</strong>
        paid ${fmt2(totalRevenue)} + skipped ${fmt2(skippedRevenue)} + unmatched ${fmt2(unmatchedRevenue)}
        = ${fmt2(reconciledTotal)} ${reconciles ? '' : `vs. total order revenue ${fmt2(run.totalOrderRevenue)} — `}
        ${reconciles ? `matches the order report's total revenue (${fmt2(run.totalOrderRevenue)}).` : 'this run does not account for all order revenue — investigate before treating totals as final.'}
      </div>` : ''}`;

  el.querySelector('#dl-revshare-zip')?.addEventListener('click', (ev) => {
    ev.preventDefault();
    downloadRevshareZip(run);
  });
  el.querySelector('#dl-unmatched')?.addEventListener('click', () => downloadUnmatchedCsv(run));

  el.querySelector('#br-archive')?.addEventListener('click', async () => {
    if (!confirm('Archive this run? It will be locked and cannot be deleted until unarchived.')) return;
    const btn = el.querySelector('#br-archive');
    btn.disabled = true; btn.textContent = 'Archiving…';
    try {
      await api('/bulk-runs/' + runId + '/archive', { method: 'POST' });
      renderBulkRunDetail(runId);
    } catch (e) {
      alert('Archive failed: ' + e.message);
      btn.disabled = false; btn.textContent = 'Archive';
    }
  });

  el.querySelector('#br-unarchive')?.addEventListener('click', async () => {
    if (!confirm('Unarchive this run? It will no longer be locked.')) return;
    const btn = el.querySelector('#br-unarchive');
    btn.disabled = true; btn.textContent = 'Unarchiving…';
    try {
      await api('/bulk-runs/' + runId + '/unarchive', { method: 'POST' });
      renderBulkRunDetail(runId);
    } catch (e) {
      alert('Unarchive failed: ' + e.message);
      btn.disabled = false; btn.textContent = 'Unarchive';
    }
  });

  el.querySelector('#br-delete')?.addEventListener('click', async () => {
    if (!confirm('Delete this calculation? This cannot be undone.')) return;
    const btn = el.querySelector('#br-delete');
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

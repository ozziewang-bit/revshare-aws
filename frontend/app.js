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

const CURRENCIES = ['TWD', 'USD', 'HKD', 'JPY', 'IDR', 'THB', 'SGD'];

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

// Share-terms CSV: amounts only. The payout model lives in the partner page.
const SHARE_TERMS_CSV_HEADER = `Partner Name,Merchant Name,Device Type,GP (%),Electricity (${CCY}/month),Placement (${CCY}/month),Others (${CCY}/month),Min Guarantee (${CCY}/machine/month),Payout Method`;

function shareTermsCsvRow(q, partnerName, m, machineModels, form) {
  const modelDisplay = m.machineModel
    ? (machineModels.find(mm => mm.code === m.machineModel)?.displayName || m.machineModel)
    : '';
  const placement = (form.placementRows || []).find(r => r.model === m.machineModel || r.model === 'ALL')?.amount ?? 0;
  const mg = (form.mgRows || []).find(r => r.model === m.machineModel || r.model === 'ALL')?.amount ?? 0;
  return [q(partnerName), q(m.name), q(modelDisplay), form.gpPercent, form.electricity, placement, form.others ?? 0, mg, q(methodToName(form.method))].join(',');
}

// Map share-terms CSV columns by header name (robust to extra/reordered columns).
function csvHeaderIndex(headerLine) {
  const cols = parseCsvLine(headerLine).map(c => c.trim().toLowerCase());
  const has = sub => cols.findIndex(c => c.includes(sub));
  return {
    partner: has('partner'),
    name: has('merchant'),
    model: cols.findIndex(c => c.includes('device') || c.includes('model')),
    gp: has('gp'),
    elec: has('electricity'),
    place: has('placement'),
    others: has('others'),
    mg: cols.findIndex(c => c.includes('guarantee') || c.includes('mg')),
    method: has('method'),
  };
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

// Friendly display labels + descriptions for the four leaf types.
// Used by the rule-editor type pill and the add-component picker.
const LEAF_META = {
  flat_per_machine:       { label: 'Per-machine fee',     desc: 'Pay a fixed amount per machine deployed (vary by model).' },
  flat_per_partner_total: { label: 'Lump-sum fee',        desc: 'One flat amount per period — admin fees, minimum floors.' },
  percent:                { label: 'Flat percent',        desc: 'A fixed % of revenue (vary by model).' },
  tiered_percent:         { label: 'Tiered percent',      desc: 'Brackets on rentals or revenue with rising %s.' },
};

const COMBINATOR_META = {
  max: { label: 'Whichever is higher', desc: 'Pay the largest of two or more branches — a minimum-guarantee floor.' },
};

// Presets — shortcuts that add multiple leaves at once. The underlying rule
// shape is still a sum of leaves; this is just a one-click convenience.
const PRESET_META = {
  fix_plus_percent: {
    label: 'Per-machine fee + Revenue share',
    desc: 'A fixed fee per machine plus a flat % of revenue — added together, neither tiered.',
    leaves: ['flat_per_machine', 'percent']
  }
};
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
  renderPartnersList();
}

function switchRegion(rk) {
  if (!(rk in REGIONS) || rk === REGION) return;
  try { localStorage.setItem('rs_region', rk); } catch {}
  location.reload();   // full reset — partner/run/merchant state is per-backend
}

async function renderPartnersList() {
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head">
      <h2>Partners</h2>
      ${can('editPartners') ? '<button id="new-partner" class="btn-primary">+ New partner</button>' : ''}
    </div>
    <input id="partner-search" class="search-input" placeholder="Search partners…" autocomplete="off">
    <div id="partners-out">Loading…</div>`;
  document.getElementById('new-partner')?.addEventListener('click', () => renderNewPartnerForm());
  try {
    const [partners, merchants] = await Promise.all([api('/partners'), api('/merchants')]);
    const countByPartner = {};
    merchants.forEach(m => { countByPartner[m.partnerId] = (countByPartner[m.partnerId] || 0) + 1; });
    // Flag partners with no usable rule: missing/untyped, OR an effectively-empty
    // placeholder (e.g. GP 0% with no fees/MG) that would pay nothing. These get
    // skipped or pay zero in a bulk run, so finance needs to spot them at a glance.
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
    const noRule = p => !p.rule || !p.rule.type || !ruleHasValue(p.rule);

    function sortPartners(arr) {
      function grp(name) {
        const c = (name || '').trim().charCodeAt(0);
        if (c >= 0x30 && c <= 0x39) return 0;             // 0–9
        if ((c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A)) return 1; // A–Z a–z
        if (c >= 0x0E00 && c <= 0x0E7F) return 2;          // Thai
        return 1;                                            // other → English group
      }
      return [...arr].sort((a, b) => {
        const ga = grp(a.name), gb = grp(b.name);
        if (ga !== gb) return ga - gb;
        return a.name.localeCompare(b.name, ga === 2 ? 'th' : 'en', { numeric: true, sensitivity: 'base' });
      });
    }

    function renderTable(list) {
      const out = document.getElementById('partners-out');
      const sorted = sortPartners(list);
      if (!sorted.length) {
        const q = document.getElementById('partner-search')?.value;
        out.innerHTML = `<p class="muted">${q ? 'No partners match your search.' : 'No partners yet.'}</p>`;
        return;
      }
      const missing = partners.filter(p => noRule(p) && !p.noPayout).length;
      const banner = missing
        ? `<p class="muted" style="margin:0 0 8px;"><span class="badge badge-danger">No rule</span> ${missing} partner(s) have no rule set — they are skipped in bulk runs.</p>`
        : '';
      out.innerHTML = `${banner}
        <table class="ts">
          <thead><tr><th>Name</th><th>Currency</th><th>Aggregation</th><th>Merchants</th></tr></thead>
          <tbody>${sorted.map(p => `
            <tr class="row-clickable${noRule(p) && !p.noPayout ? ' row-norule' : ''}" data-id="${escape(p.partnerId)}">
              <td>${escape(p.name)}${p.noPayout ? ' <span class="badge badge-neutral">No payout</span>' : (noRule(p) ? ' <span class="badge badge-danger">No rule</span>' : '')}</td>
              <td><span class="badge badge-neutral">${escape(p.currency)}</span></td>
              <td>${escape(p.aggregationMode)}</td>
              <td>${countByPartner[p.partnerId] || 0}</td>
            </tr>`).join('')}
          </tbody>
        </table>`;
      out.querySelectorAll('.row-clickable').forEach(tr => {
        tr.addEventListener('click', () => renderPartnerDetail(tr.dataset.id));
      });
    }

    renderTable(partners);

    document.getElementById('partner-search').addEventListener('input', e => {
      const q = e.target.value.toLowerCase();
      renderTable(q ? partners.filter(p => p.name.toLowerCase().includes(q)) : partners);
    });

  } catch (e) {
    document.getElementById('partners-out').innerHTML = `<p class="error">${escape(e.message)}</p>`;
  }
}

function renderNav() {
  const nav = document.getElementById('topnav');
  nav.innerHTML = `
    <button id="nav-partners" class="nav-btn active">Partners</button>
    ${can('runCalcs') ? '<button id="nav-bulk-runs" class="nav-btn">Run share</button>' : ''}
    <button id="nav-revshare-path" class="nav-btn">Analytics</button>
    <button id="nav-device-types" class="nav-btn">Device Types</button>
    <button id="nav-contracts" class="nav-btn">Contracts</button>
    ${can('admin') ? '<button id="nav-users" class="nav-btn">Users</button>' : ''}`;
  nav.querySelector('#nav-partners').addEventListener('click', () => { setActiveNav('nav-partners'); renderPartnersList(); });
  nav.querySelector('#nav-bulk-runs')?.addEventListener('click', () => { setActiveNav('nav-bulk-runs'); renderBulkRunsList(); });
  nav.querySelector('#nav-revshare-path').addEventListener('click', () => { setActiveNav('nav-revshare-path'); renderRevsharePathScreen(); });
  nav.querySelector('#nav-device-types').addEventListener('click', () => { setActiveNav('nav-device-types'); renderDeviceTypesScreen(); });
  nav.querySelector('#nav-contracts').addEventListener('click', () => { setActiveNav('nav-contracts'); renderContractsScreen(); });
  nav.querySelector('#nav-users')?.addEventListener('click', () => { setActiveNav('nav-users'); renderUsersScreen(); });
}

function setActiveNav(id) {
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.id === id));
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
      <input id="rp-search" class="search-input" list="rp-options" placeholder="Search partner… (or Total)" autocomplete="off">
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
  const partnerSeries = {};
  months.forEach(m => (byMonth[m].results || []).forEach(r => {
    (partnerSeries[r.partnerName] = partnerSeries[r.partnerName] || []).push({ month: m, revenue: r.revenue || 0, payout: r.payout || 0, sharePct: pct(r.payout || 0, r.revenue || 0) });
  }));
  const names = Object.keys(partnerSeries).sort((a, b) => a.localeCompare(b));
  const byLower = {}; names.forEach(n => { byLower[n.toLowerCase()] = n; });

  document.getElementById('rp-options').innerHTML = ['Total', ...names].map(n => `<option value="${escape(n)}"></option>`).join('');

  function show(sel) {
    const titleEl = document.getElementById('rp-title');
    const chartEl = document.getElementById('rp-chart');
    const key = (sel || '').trim().toLowerCase();
    let label, data;
    if (!key || key === 'total') { label = 'Total — all partners'; data = totalSeries; }
    else if (byLower[key]) { label = byLower[key]; data = partnerSeries[byLower[key]]; }
    else { titleEl.textContent = ''; chartEl.innerHTML = `<p class="muted">No partner matching “${escape(sel)}”.</p>`; return; }
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

const CONTRACT_GRID_COLUMNS = [
  { key: 'merchantName',          label: 'Merchant',      type: 'text',   width: 190 },
  { key: 'merchantType',          label: 'Type',          type: 'select', width: 150 },
  { key: 'counterParty',          label: 'Counter party', type: 'text',   width: 220 },
  { key: 'installedUnits',        label: 'Units',         type: 'number', width: 70  },
  { key: 'units.S5',              label: 'S5',            type: 'number', width: 60  },
  { key: 'units.S8',              label: 'S8',            type: 'number', width: 60  },
  { key: 'units.M10',             label: 'M10',           type: 'number', width: 60  },
  { key: 'units.L20',             label: 'L20',           type: 'number', width: 60  },
  { key: 'units.L40',             label: 'L40',           type: 'number', width: 60  },
  { key: 'startDate',             label: 'Start',         type: 'date',   width: 120 },
  { key: 'endDate',               label: 'End',           type: 'date',   width: 120 },
  { key: 'terminationNoticeDays', label: 'Notice (d)',    type: 'number', width: 90  },
  { key: 'declineToRenew',        label: 'Decline',       type: 'bool',   width: 80  },
  { key: 'autoRenewal',           label: 'Auto-renewal',  type: 'select', width: 170 },
  { key: 'contractLink',          label: 'Contract',      type: 'url',    width: 110 },
];

const MERCHANT_TYPES = ['F&B', 'Hospitality', 'Lifestyle', 'Shopping Malls', 'Nightlife',
                        'Exhibition Center', 'Convenience Store', 'other'];
const AUTO_RENEWAL_OPTIONS = ['Yes', 'No (Need to contact)'];

const cellValue = (c, key) => key.includes('.')
  ? (c[key.split('.')[0]] || {})[key.split('.')[1]]
  : c[key];

// Days until the contract ends; null when there is no end date.
function daysToEnd(c) {
  if (!c.endDate) return null;
  return Math.round((new Date(c.endDate) - new Date()) / 86400000);
}

function contractRowHtml(c) {
  const d = daysToEnd(c);
  const cls = d == null ? '' : (d < 0 ? 'ct-expired' : (d <= 60 ? 'ct-soon' : ''));
  const cells = CONTRACT_GRID_COLUMNS.map((col, i) => {
    const v = cellValue(c, col.key);
    let disp;
    if (col.type === 'bool') disp = v ? '✓' : '';
    else if (col.type === 'url') {
      disp = !v ? ''
        : (/^https?:\/\//i.test(v)
            ? `<a href="${escape(v)}" target="_blank" rel="noopener">open ↗</a>`
            : escape(String(v)));
    }
    else disp = v == null || v === '' ? '' : escape(String(v));
    const sticky = i === 0 ? ' ct-sticky' : '';
    const flag = col.key === 'endDate' ? ` ${cls}` : '';
    return `<td class="ct-cell${sticky}${flag}" data-id="${escape(c.contractId)}" data-key="${col.key}">${disp}</td>`;
  }).join('');
  const link = c.partnerId ? '' : '<span class="badge badge-warn">unlinked</span>';
  return `<tr data-id="${escape(c.contractId)}">${cells}<td class="ct-cell">${link}</td></tr>`;
}

async function renderContractsScreen() {
  const el = document.getElementById('main');
  el.innerHTML = '<h1>Contracts</h1><p class="muted">Loading…</p>';
  CONTRACTS = await api('/contracts');
  const head = CONTRACT_GRID_COLUMNS
    .map((c, i) => `<th style="min-width:${c.width}px"${i === 0 ? ' class="ct-sticky"' : ''}>${c.label}</th>`)
    .join('') + '<th>Link</th>';
  el.innerHTML = `
    <h1>Contracts</h1>
    <div class="ct-toolbar">
      <input id="ct-search" class="input" placeholder="Search merchant…" style="max-width:240px">
      <select id="ct-type" class="input" style="max-width:200px">
        <option value="">All types</option>
        ${MERCHANT_TYPES.map(t => `<option>${t}</option>`).join('')}
      </select>
      <select id="ct-sort" class="input" style="max-width:200px">
        <option value="name">Sort: merchant</option>
        <option value="end">Sort: contract end</option>
      </select>
      <span class="muted" id="ct-count"></span>
    </div>
    <div class="ct-scroll"><table class="ct-table"><thead><tr>${head}</tr></thead>
      <tbody id="ct-body"></tbody></table></div>`;
  ['ct-search', 'ct-type', 'ct-sort'].forEach(id =>
    el.querySelector('#' + id).addEventListener('input', paintContracts));
  paintContracts();
}

function paintContracts() {
  const q = (document.getElementById('ct-search')?.value || '').toLowerCase().trim();
  const type = document.getElementById('ct-type')?.value || '';
  const sort = document.getElementById('ct-sort')?.value || 'name';
  let rows = CONTRACTS.filter(c =>
    (!q || (c.merchantName || '').toLowerCase().includes(q)) &&
    (!type || c.merchantType === type));
  rows.sort(sort === 'end'
    ? (a, b) => (a.endDate || '9999').localeCompare(b.endDate || '9999')
    : (a, b) => (a.merchantName || '').localeCompare(b.merchantName || ''));
  document.getElementById('ct-body').innerHTML = rows.map(contractRowHtml).join('');
  document.getElementById('ct-count').textContent = `${rows.length} of ${CONTRACTS.length}`;
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
  out.innerHTML = `<table class="ts"><thead><tr><th>Period</th><th>Uploaded</th><th>Partners</th><th>Total payout</th><th>Unmatched</th><th></th></tr></thead>
    <tbody>${runs.map(r => `<tr data-id="${r.runId}" style="cursor:pointer;">
      <td>${escape(periodMonth(r.periodStart))}${r.archived ? ' <span class="badge badge-neutral" title="Archived — cannot be deleted without unarchiving">🔒 Locked</span>' : ''}</td>
      <td>${escape(r.uploadedAt?.split('T')[0] || '')}</td>
      <td>${r.partnerCount}</td>
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
    const pendingRules = (wiz.prepare?.partnersNeedingRules || []);
    const step3Done = step2Done && pendingRules.length === 0;

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
            <strong>Roster loaded:</strong> ${wiz.prepare.rosterCount} machines · ${wiz.prepare.partnerCount} partners
            ${wiz.prepare.newPartners?.length ? `· <span style="color:#2b8a3e;">${wiz.prepare.newPartners.length} new partner(s) created</span>` : ''}
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
            pendingRules.length === 0
              ? '<p style="color:#2b8a3e;">✓ All partners have rules — Step 4 is unlocked.</p>'
              : `<p style="color:#e67700;"><strong>${pendingRules.length} partner(s) need a rule before you can run:</strong></p>
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

    // Step 3 rule editors (called after render if step2Done and pending rules)
    if (step2Done && pendingRules.length > 0) {
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

  // Render inline rule editors for each partner needing a rule (Task 11)
  async function renderWizardRuleEditors() {
    const slot = document.getElementById('wiz-rule-editors');
    if (!slot) return;
    const pendingRules = wiz.prepare?.partnersNeedingRules || [];
    if (!pendingRules.length) return;
    slot.innerHTML = '';
    for (const { partnerId, name } of pendingRules) {
      const card = document.createElement('div');
      card.dataset.partnerId = partnerId;
      card.style.cssText = 'border:1px solid var(--border);border-radius:8px;padding:16px;margin-bottom:16px;';
      card.innerHTML = `<div style="font-weight:600;margin-bottom:12px;">${escape(name)}</div><div class="re-slot"></div>`;
      slot.appendChild(card);
      const editorSlot = card.querySelector('.re-slot');
      let partner;
      try {
        partner = await api('/partners/' + partnerId);
      } catch (e) {
        editorSlot.innerHTML = `<p style="color:#f03e3e;">Could not load partner: ${escape(e.message)}</p>`;
        continue;
      }
      await renderRuleEditorInto(editorSlot, partner, () => {
        // Drop this partner from pending list and re-check unlock
        wiz.prepare.partnersNeedingRules = wiz.prepare.partnersNeedingRules.filter(p => p.partnerId !== partnerId);
        card.innerHTML = `<p style="color:#2b8a3e;">✓ ${escape(name)} — rule saved</p>`;
        // Check if all done → re-render to unlock step 4
        if (wiz.prepare.partnersNeedingRules.length === 0) {
          render();
        }
      });
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
  return String(s).replace(/[\/\\:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim() || 'partner';
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

// One CSV per partner, ORDER REPORT format:
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
    rows.push([q('(partner-level lump sum)'), '', '', n2(eng.topLevel.payout)].join(','));
  }

  const totalRow = [q('Total'), sumRentals, n2(sumRevenue), n2(sumShare)].join(',');
  return [header, ...rows, totalRow].join('\n') + '\n';
}

function downloadRevshareZip(run) {
  const tag = periodTag(run.periodStart);
  const enc = new TextEncoder();
  const used = {};
  const files = (run.results || []).map(r => {
    let base = `${sanitizeFilename(r.partnerName)}_${tag}`;
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
    <p class="muted">Period: <strong>${escape(periodMonth(run.periodStart))}</strong> · Uploaded: ${escape(run.uploadedAt?.split('T')[0])} · ${run.orderCount} orders · ${run.partnerCount} partners</p>
    ${(run.results?.length) ? `<p><a href="#" id="dl-revshare-zip" class="zip-link">↓ ${escape(periodTag(run.periodStart))}_revshare</a> <span class="muted" style="font-size:12px;">(zip · one CSV per partner)</span></p>` : ''}
    ${run.unmatchedOrderCount ? `
      <div style="margin:8px 0 4px;padding:12px 16px;background:#fff5f5;border:1px solid #ffa8a8;border-radius:8px;font-size:13.5px;">
        <strong style="color:#c92a2a;">⚠ ${Number(run.unmatchedOrderCount).toLocaleString('en-US')} order(s) dropped</strong>
        — ${Number(run.unmatchedCount).toLocaleString('en-US')} unrecognized merchant name(s), revenue not counted:
        <strong>${Number(run.unmatchedRevenue || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>.
        Matched <strong>${Number((run.orderCount || 0) - run.unmatchedOrderCount).toLocaleString('en-US')}</strong> of ${Number(run.orderCount || 0).toLocaleString('en-US')} paid orders.
      </div>` : ''}
    ${run.warnings?.length ? `<p style="color:#e67700;">${run.warnings.map(escape).join('<br>')}</p>` : ''}
    <table class="ts"><thead><tr><th>Partner</th><th>Merchants</th><th>Rentals</th><th>Revenue</th><th>Payout</th><th>Revenue share %</th></tr></thead>
    <tbody>${(run.results || []).sort((a,b) => b.payout - a.payout).map(r => `<tr>
      <td>${escape(r.partnerName)}</td>
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
    ${run.unmatched?.length ? `
      <div style="margin-top:24px;padding:16px;background:#fff5f5;border-radius:8px;border:1px solid #ffa8a8;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
          <strong style="color:#c92a2a;">⚠ ${run.unmatched.length} unmatched merchant(s)</strong>
          <button id="dl-unmatched" class="btn-ghost" style="color:var(--accent);">↓ Download list (CSV)</button>
        </div>
        <p style="color:#868e96;font-size:13px;">These names were in the order report but not found in the merchant registry. Add them under the correct partner and re-run.</p>
        <ul style="font-size:13px;">${run.unmatched.map(n => `<li>${escape(n)}</li>`).join('')}</ul>
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

async function renderNewPartnerForm() {
  const main = document.getElementById('main');
  main.innerHTML = `
    <button class="back-link" id="back">← Partners</button>
    <h2>New partner</h2>
    <p class="muted" style="margin-bottom:18px;">Currency and aggregation mode are fixed once set.</p>
    <form id="new-partner-form">
      <label>Name <input name="name" required></label>
      <label>Currency
        <select name="currency">${CURRENCIES.map(c => `<option ${c === CCY ? 'selected' : ''}>${c}</option>`).join('')}</select>
      </label>
      <label>Aggregation mode
        <select name="aggregationMode"><option value="per_store">per store (one calc per store, summed)</option><option value="whole">whole partner (one calc over all rows)</option></select>
      </label>
      <div style="border-top:1px solid var(--border);margin-top:18px;padding-top:16px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-faint);margin-bottom:14px;">Revenue rule <span style="font-weight:400;text-transform:none;letter-spacing:0;">(optional — can be set later)</span></div>
        <label class="nopay-toggle"><input type="checkbox" name="noPayout"><span><span class="t1">🚫 No revenue share — not paid</span><span class="t2">This partner is excluded from all payouts and skipped in bulk runs.</span></span></label>
        <div id="new-rule-container"></div>
      </div>
      <div>
        <button type="submit" class="btn-primary">Create partner</button>
        <button type="button" id="cancel-new">Cancel</button>
      </div>
    </form>`;
  document.getElementById('back').addEventListener('click', renderPartnersList);
  document.getElementById('cancel-new').addEventListener('click', renderPartnersList);

  const machineModels = await api('/machine-models');
  const editor = renderStructuredRuleEditor(
    document.getElementById('new-rule-container'),
    null,
    machineModels
  );

  const npCb = document.querySelector('#new-partner-form input[name="noPayout"]');
  const npContainer = document.getElementById('new-rule-container');
  if (npCb && npContainer) { const lab = npCb.closest('.nopay-toggle'); const dim = () => { if (lab) lab.classList.toggle('on', npCb.checked); npContainer.style.opacity = npCb.checked ? '.45' : '1'; npContainer.style.pointerEvents = npCb.checked ? 'none' : ''; }; npCb.addEventListener('change', dim); dim(); }

  document.getElementById('new-partner-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    let rule;
    try { rule = editor.getRule(); } catch(e) { alert('Invalid rule JSON: ' + e.message); return; }
    const body = { name: fd.get('name'), currency: fd.get('currency'), aggregationMode: fd.get('aggregationMode'), rule, noPayout: fd.get('noPayout') === 'on' };
    try {
      const p = await api('/partners', { method: 'POST', body: JSON.stringify(body) });
      renderPartnerDetail(p.partnerId);
    } catch (e) { alert(e.message); }
  });
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

// Reusable inline rule editor: renders the full share-terms + payout-method
// form into `container`, with its own Save button; calls `onSaved()` on success.
// Used by both the partner Rule tab (via showRuleEdit) and the wizard Step 3.
async function renderRuleEditorInto(container, partner, onSaved) {
  const machineModels = await api('/machine-models');
  const editor = renderStructuredRuleEditor(container, partner.rule, machineModels, { readOnly: false });

  // noPayout toggle (mirrored from showRuleEdit)
  const npDiv = document.createElement('div');
  npDiv.style.cssText = 'margin-bottom:12px;';
  npDiv.innerHTML = `<label class="nopay-toggle"><input type="checkbox" id="re-nopay-cb" ${partner.noPayout ? 'checked' : ''}><span><span class="t1">🚫 No revenue share — not paid</span><span class="t2">This partner is excluded from all payouts and skipped in bulk runs.</span></span></label>`;
  container.insertBefore(npDiv, container.firstChild);

  const cb = npDiv.querySelector('#re-nopay-cb');
  const lab = npDiv.querySelector('.nopay-toggle');
  const ruleArea = container.querySelector('.rule-form') || container.children[1];
  const dim = () => {
    if (lab) lab.classList.toggle('on', cb.checked);
    if (ruleArea) { ruleArea.style.opacity = cb.checked ? '.45' : '1'; ruleArea.style.pointerEvents = cb.checked ? 'none' : ''; }
  };
  cb.addEventListener('change', dim); dim();

  const actBar = document.createElement('div');
  actBar.style.cssText = 'margin-top:14px;display:flex;gap:8px;';
  actBar.innerHTML = `<button id="re-save-btn" class="btn-primary">Save rule</button>`;
  container.appendChild(actBar);

  actBar.querySelector('#re-save-btn').addEventListener('click', async () => {
    let rule;
    try { rule = editor.getRule(); } catch (e) { alert('Invalid rule JSON: ' + e.message); return; }
    const noPayout = !!container.querySelector('#re-nopay-cb')?.checked;
    const btn = actBar.querySelector('#re-save-btn');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      await api('/partners/' + partner.partnerId, { method: 'PUT', body: JSON.stringify({ rule, noPayout }) });
      partner.rule = rule; partner.noPayout = noPayout;
      onSaved();
    } catch (e) {
      alert('Save failed: ' + e.message);
      btn.disabled = false; btn.textContent = 'Save rule';
    }
  });
}

async function renderPartnerDetail(partnerId) {
  const main = document.getElementById('main');
  main.innerHTML = '<p>Loading partner…</p>';
  const p = await api('/partners/' + partnerId);

  main.innerHTML = `
    <div class="page-head">
      <div>
        <button id="back" class="btn-ghost" style="padding:0;margin-bottom:6px;">← Partners</button>
        <h2>${escape(p.name)}</h2>
      </div>
    </div>
    <p class="muted" style="margin-bottom:18px;">Currency: ${escape(p.currency)} · Aggregation: ${escape(p.aggregationMode)}</p>
    <div class="tabs">
      <button id="tab-merchants" class="tab active">Merchants (<span id="merchant-count">…</span>)</button>
      <button id="tab-rule" class="tab">Rule</button>
      <button id="tab-runs" class="tab">Analytics</button>
    </div>
    <div id="tab-merchants-content">
      <div id="merchants-tab-content">Loading…</div>
    </div>
    <div id="tab-rule-content" style="display:none">
      <div id="nopay-row" style="margin-bottom:12px;"></div>
      <div id="rule-edit-bar" style="display:flex;justify-content:flex-end;margin-bottom:14px;"></div>
      <div id="rule-editor-container"></div>
    </div>
    <div id="tab-runs-content" style="display:none">
      <div id="runs-history"></div>
    </div>`;

  document.getElementById('back').addEventListener('click', renderPartnersList);

  ['rule','merchants','runs'].forEach(t => {
    document.getElementById(`tab-${t}`).addEventListener('click', () => {
      ['rule','merchants','runs'].forEach(x => {
        document.getElementById(`tab-${x}`).classList.toggle('active', x === t);
        document.getElementById(`tab-${x}-content`).style.display = x === t ? '' : 'none';
      });
      if (t === 'merchants') renderMerchantsTab(partnerId);
      if (t === 'rule') renderRuleTab();
      if (t === 'runs') renderRunsHistory();
    });
  });

  renderMerchantsTab(partnerId);

  async function renderRuleTab() {
    const machineModels = await api('/machine-models');
    showRuleView(machineModels);
  }

  function showRuleView(machineModels) {
    const bar = document.getElementById('rule-edit-bar');
    const ruleContainer = document.getElementById('rule-editor-container');
    if (!bar || !ruleContainer) return;
    bar.innerHTML = `
      <span style="display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--ink-soft);background:var(--surface-muted);border:1px solid var(--border);border-radius:99px;padding:4px 12px;margin-right:8px;">👁 View only</span>
      ${can('editPartners') ? '<button id="edit-rule-btn" class="btn-primary" style="padding:6px 14px;font-size:12.5px;">Edit rule</button>' : ''}`;
    renderStructuredRuleEditor(ruleContainer, p.rule, machineModels, { readOnly: true });
    const npRow = document.getElementById('nopay-row');
    if (npRow) npRow.innerHTML = p.noPayout
      ? `<span class="badge badge-neutral">No payout</span> <span class="muted" style="font-size:12.5px;">This partner has no revenue share — not paid in runs.</span>`
      : '';
    document.getElementById('edit-rule-btn')?.addEventListener('click', () => showRuleEdit(machineModels));
  }

  function showRuleEdit(machineModels) {
    const bar = document.getElementById('rule-edit-bar');
    const ruleContainer = document.getElementById('rule-editor-container');
    if (!bar || !ruleContainer) return;
    const editor = renderStructuredRuleEditor(ruleContainer, p.rule, machineModels, { readOnly: false });
    const npRow = document.getElementById('nopay-row');
    if (npRow) {
      npRow.innerHTML = `<label class="nopay-toggle"><input type="checkbox" id="nopay-cb" ${p.noPayout ? 'checked' : ''}><span><span class="t1">🚫 No revenue share — not paid</span><span class="t2">This partner is excluded from all payouts and skipped in bulk runs.</span></span></label>`;
      const cb = document.getElementById('nopay-cb');
      const lab = npRow.querySelector('.nopay-toggle');
      const dim = () => { if (lab) lab.classList.toggle('on', cb.checked); ruleContainer.style.opacity = cb.checked ? '.45' : '1'; ruleContainer.style.pointerEvents = cb.checked ? 'none' : ''; };
      cb.addEventListener('change', dim); dim();
    }
    bar.innerHTML = `
      <button id="cancel-rule-btn" class="btn-ghost" style="margin-right:6px;">Cancel</button>
      <button id="save-rule-btn" class="btn-primary" style="padding:6px 14px;font-size:12.5px;">Save rule</button>`;
    document.getElementById('cancel-rule-btn').addEventListener('click', () => showRuleView(machineModels));
    document.getElementById('save-rule-btn').addEventListener('click', async () => {
      let rule;
      try { rule = editor.getRule(); } catch(e) { alert('Invalid JSON: ' + e.message); return; }
      const noPayout = !!document.getElementById('nopay-cb')?.checked;
      const btn = document.getElementById('save-rule-btn');
      btn.disabled = true; btn.textContent = 'Saving…';
      await api('/partners/' + partnerId, { method: 'PUT', body: JSON.stringify({ rule, noPayout }) });
      p.rule = rule; p.noPayout = noPayout;
      showRuleView(machineModels);
    });
  }

  api('/merchants').then(all => {
    const el = document.getElementById('merchant-count');
    if (el) el.textContent = all.filter(m => m.partnerId === partnerId).length;
  });

  // Nested closure — renders this partner's monthly revshare path (from bulk runs)
  async function renderRunsHistory() {
    const runsHistory = document.getElementById('runs-history');
    runsHistory.innerHTML = '<p class="muted">Loading…</p>';
    const list = await api('/bulk-runs');
    const fulls = await Promise.all(list.map(r => api('/bulk-runs/' + r.runId)));
    // One data point per month (latest run wins on duplicates).
    const byMonth = {};
    fulls.forEach(run => {
      const res = (run.results || []).find(x => x.partnerId === partnerId);
      if (!res) return;
      const month = periodMonth(run.periodStart);
      const prev = byMonth[month];
      if (!prev || (run.uploadedAt || '') > (prev.uploadedAt || '')) {
        byMonth[month] = { month, revenue: res.revenue || 0, payout: res.payout || 0, uploadedAt: run.uploadedAt };
      }
    });
    const data = Object.values(byMonth)
      .sort((a, b) => a.month.localeCompare(b.month))
      .map(d => ({ ...d, sharePct: d.revenue > 0 ? d.payout / d.revenue * 100 : 0 }));

    runsHistory.innerHTML = `<h3 style="margin-top:30px;">Analytics</h3>${
      data.length
        ? revsharePathChartSvg(data)
        : '<p class="muted">No Share Calculations include this partner yet. Run one to populate this chart.</p>'
    }`;
  }
}

async function renderMerchantsTab(partnerId) {
  const container = document.getElementById('merchants-tab-content');
  container.innerHTML = 'Loading…';
  const [all, machineModels] = await Promise.all([api('/merchants'), api('/machine-models')]);
  const merchants = all.filter(m => m.partnerId === partnerId);
  container.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
      <div style="display:flex;align-items:center;gap:10px;">
        <span>${merchants.length} merchant${merchants.length !== 1 ? 's' : ''}</span>
        ${merchants.length > 0 ? `<button id="export-terms-btn" class="btn" style="font-size:12px;padding:5px 12px;">↓ Export terms</button>` : ''}
      </div>
      ${can('manageMerchants') ? `<div style="display:flex;gap:6px;">
        <button id="batch-csv-btn" class="btn">↑ CSV upload</button>
        <button id="batch-rows-btn" class="btn">+ Add rows</button>
        <button id="add-merchant-btn" class="btn-primary">+ Add one</button>
      </div>` : ''}
    </div>
    <div id="batch-panel-slot"></div>
    ${merchants.length === 0 ? '<p class="muted">No merchants yet. Add one or import from Excel.</p>' : `
    <table class="ts"><thead><tr><th>Name</th><th>Model</th><th></th></tr></thead><tbody>
      ${merchants.map(m => `
        <tr>
          <td>${escape(m.name)}</td>
          <td>${m.machineModel ? `<span class="badge badge-neutral">${escape(machineModels.find(mm => mm.code === m.machineModel)?.displayName || m.machineModel)}</span>` : '—'}</td>
          <td>
            ${can('manageMerchants') ? `<button class="btn-ghost edit-m" data-id="${m.merchantId}">Edit</button>` : ''}
            ${can('manageMerchants') ? `<button class="btn-ghost del-m" data-id="${m.merchantId}">Delete</button>` : ''}
          </td>
        </tr>`).join('')}
    </tbody></table>`}
    <div id="merchant-form-slot"></div>`;

  container.querySelector('#add-merchant-btn')?.addEventListener('click', () => {
    showMerchantForm(partnerId, null, machineModels, () => renderMerchantsTab(partnerId));
  });

  container.querySelector('#export-terms-btn')?.addEventListener('click', async () => {
    const partner = await api('/partners/' + partnerId);
    const form = decompileRule(partner.rule);
    const q = s => `"${String(s).replace(/"/g, '""')}"`;

    const header = SHARE_TERMS_CSV_HEADER;
    const rows = merchants.map(m => shareTermsCsvRow(q, partner.name, m, machineModels, form));

    const csv = [header, ...rows].join('\n') + '\n';
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${partner.name}-share-terms.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  const batchSlot = container.querySelector('#batch-panel-slot');
  container.querySelector('#batch-csv-btn')?.addEventListener('click', () => {
    const isOpen = batchSlot.dataset.panel === 'csv';
    batchSlot.dataset.panel = isOpen ? '' : 'csv';
    isOpen ? (batchSlot.innerHTML = '') : showBatchCsvPanel(partnerId, machineModels, () => renderMerchantsTab(partnerId));
  });
  container.querySelector('#batch-rows-btn')?.addEventListener('click', () => {
    const isOpen = batchSlot.dataset.panel === 'rows';
    batchSlot.dataset.panel = isOpen ? '' : 'rows';
    isOpen ? (batchSlot.innerHTML = '') : showBatchRowsPanel(partnerId, machineModels, () => renderMerchantsTab(partnerId));
  });

  container.querySelectorAll('.edit-m').forEach(btn => {
    btn.addEventListener('click', () => {
      const m = merchants.find(x => x.merchantId === btn.dataset.id);
      showMerchantForm(partnerId, m, machineModels, () => renderMerchantsTab(partnerId));
    });
  });
  container.querySelectorAll('.del-m').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this merchant?')) return;
      await api('/merchants/' + btn.dataset.id, { method: 'DELETE' });
      renderMerchantsTab(partnerId);
    });
  });
}

function showMerchantForm(partnerId, existing, machineModels, onDone) {
  const slot = document.getElementById('merchant-form-slot');
  slot.innerHTML = `
    <div class="modal-bg"><div class="modal">
      <h3>${existing ? 'Edit' : 'Add'} merchant</h3>
      <label>Name<input id="mf-name" value="${escape(existing?.name || '')}"></label>
      <label>Machine model
        <select id="mf-model">
          <option value="">— select —</option>
          ${machineModels.map(m => `<option ${existing?.machineModel===m.code?'selected':''} value="${m.code}">${escape(m.displayName)}</option>`).join('')}
        </select>
      </label>
      <div style="margin-top:16px;display:flex;gap:8px;">
        <button id="mf-save" class="btn-primary">${existing ? 'Save' : 'Create'}</button>
        <button id="mf-cancel" class="btn-ghost">Cancel</button>
      </div>
    </div></div>`;
  slot.querySelector('#mf-cancel').addEventListener('click', () => { slot.innerHTML = ''; });
  slot.querySelector('#mf-save').addEventListener('click', async () => {
    const name  = slot.querySelector('#mf-name').value.trim();
    const model = slot.querySelector('#mf-model').value || null;
    if (!name) { alert('Name is required'); return; }
    if (existing) {
      await api('/merchants/' + existing.merchantId, { method: 'PUT', body: JSON.stringify({ name, machineModel: model, partnerId }) });
    } else {
      await api('/merchants', { method: 'POST', body: JSON.stringify({ name, machineModel: model, partnerId }) });
    }
    slot.innerHTML = '';
    onDone();
  });
}

function parseCsvLine(line) {
  const fields = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; continue; }
    if (c === ',' && !inQ) { fields.push(cur); cur = ''; continue; }
    cur += c;
  }
  fields.push(cur);
  return fields;
}

function parseMerchantCsv(text, validCodes, machineModels) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const MODELS_SET = validCodes instanceof Set ? validCodes : new Set(['S5','S8','S10','T8','T10','T20','T35','L20','L40','M10']);
  const displayToCode = {};
  if (machineModels) machineModels.forEach(m => { displayToCode[m.displayName.toLowerCase()] = m.code; });
  const hasHeader = lines[0].toLowerCase().includes('name');
  const idx = hasHeader ? csvHeaderIndex(lines[0]) : { name: 0, model: 1 };
  const ni = idx.name >= 0 ? idx.name : 0;
  const mi = idx.model >= 0 ? idx.model : 1;
  const dataLines = hasHeader ? lines.slice(1) : lines;
  return dataLines
    .map(line => {
      const fields = parseCsvLine(line);
      const name = (fields[ni] || '').trim();
      const modelInput = (fields[mi] || '').trim();
      const modelUpper = modelInput.toUpperCase();
      const model = MODELS_SET.has(modelUpper) ? modelUpper : (displayToCode[modelInput.toLowerCase()] || null);
      return { name, model };
    })
    .filter(r => r.name);
}

function showBatchCsvPanel(partnerId, machineModels, onDone) {
  const slot = document.getElementById('batch-panel-slot');
  slot.innerHTML = `
    <div class="batch-panel">
      <div class="batch-panel-head">
        <div>
          <div class="batch-panel-title">Upload merchants via CSV</div>
          <div class="batch-panel-sub">Same format as the export file: <code>Merchant Name</code>, <code>Device Type</code>, then amount columns (GP %, Electricity, Placement, Others, Min Guarantee). Currently only name + device type are imported.</div>
        </div>
        <button id="bp-close" class="btn-ghost">✕</button>
      </div>
      <div class="upload-zone">
        <p>Choose a CSV file or drag it here</p>
        <input type="file" id="bp-csv-file" accept=".csv,text/csv" style="display:none">
        <div style="display:flex;gap:8px;justify-content:center;">
          <button id="bp-choose" class="btn">Choose file</button>
          <button id="bp-sample" class="btn">↓ Sample CSV</button>
        </div>
        <div class="upload-hint">After upload, merchants are saved immediately. Existing names are updated, not duplicated.</div>
      </div>
      <div id="bp-status" style="margin-top:12px;font-size:13px;"></div>
    </div>`;
  slot.querySelector('#bp-close').addEventListener('click', () => { slot.innerHTML = ''; slot.dataset.panel = ''; });
  slot.querySelector('#bp-choose').addEventListener('click', () => slot.querySelector('#bp-csv-file').click());
  slot.querySelector('#bp-sample').addEventListener('click', () => {
    const q = s => `"${String(s).replace(/"/g, '""')}"`;
    const header = SHARE_TERMS_CSV_HEADER;
    const examples = machineModels.slice(0, 3).map((m, i) =>
      `${q('Example Partner')},${q('Example Store ' + (i + 1))},${q(m.displayName)},15,200,1500,0,800,HH`
    );
    if (!examples.length) examples.push('"Example Partner","Example Store","Advertising Player-S5",15,200,1500,0,800,HH');
    const csv = [header, ...examples].join('\n') + '\n';
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'share-terms-sample.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });
  slot.querySelector('#bp-csv-file').addEventListener('change', async e => {
    const file = e.target.files[0]; if (!file) return;
    const status = slot.querySelector('#bp-status');
    status.innerHTML = 'Parsing…';
    try {
      const text = await file.text();
      const validCodes = new Set(machineModels.map(m => m.code));
      const allRows = parseMerchantCsv(text, validCodes, machineModels);
      const validRows = allRows.filter(r => r.model);
      const skipped = allRows.length - validRows.length;
      if (!validRows.length) { status.innerHTML = '<span style="color:var(--loss);">No rows with a valid model found. Check the file format.</span>'; return; }
      const skipNote = skipped > 0 ? ` (${skipped} skipped — missing/unknown model)` : '';
      status.innerHTML = `Parsed ${validRows.length} merchant(s)${skipNote} — saving…`;
      await Promise.all(validRows.map(r => api('/merchants', { method: 'POST', body: JSON.stringify({ name: r.name, machineModel: r.model, partnerId }) })));
      status.innerHTML = `<span style="color:var(--gain);">Saved ${validRows.length} merchant(s).${skipped > 0 ? ` ${skipped} row(s) skipped (missing/unknown model).` : ''}</span>`;
      setTimeout(onDone, 800);
    } catch (err) {
      status.innerHTML = `<span style="color:var(--loss);">Error: ${escape(err.message)}</span>`;
    }
  });
}

function showBatchRowsPanel(partnerId, machineModels, onDone) {
  const slot = document.getElementById('batch-panel-slot');
  let rows = [{ name: '', model: '' }];

  function draw() {
    const validCount = rows.filter(r => r.name.trim() && r.model).length;
    slot.innerHTML = `
      <div class="batch-panel">
        <div class="batch-panel-head">
          <div>
            <div class="batch-panel-title">Add multiple merchants</div>
            <div class="batch-panel-sub">Both name and machine model are required for each row.</div>
          </div>
          <button id="bp-close" class="btn-ghost">✕</button>
        </div>
        <table class="row-form">
          <thead><tr><th style="width:55%">Name</th><th style="width:30%">Model</th><th style="width:15%"></th></tr></thead>
          <tbody>
            ${rows.map((r, i) => `
              <tr>
                <td><input class="rf-name" data-i="${i}" value="${escape(r.name)}" placeholder="Merchant name…"></td>
                <td><select class="rf-model" data-i="${i}">
                  <option value="">— select —</option>
                  ${machineModels.map(m => `<option ${r.model===m.code?'selected':''} value="${m.code}">${escape(m.displayName)}</option>`).join('')}
                </select></td>
                <td style="text-align:center"><button class="btn-sm rf-del" data-i="${i}" style="color:var(--loss)">✕</button></td>
              </tr>`).join('')}
          </tbody>
        </table>
        <button id="bp-add-row" class="add-row-btn">+ Add row</button>
        <div style="display:flex;gap:8px;">
          <button id="bp-save" class="btn-primary" ${validCount===0?'disabled':''}>Save ${validCount} merchant${validCount!==1?'s':''}</button>
          <button id="bp-cancel" class="btn-ghost">Cancel</button>
        </div>
        <div id="bp-status" style="margin-top:10px;font-size:13px;"></div>
      </div>`;

    slot.querySelector('#bp-close').addEventListener('click', () => { slot.innerHTML = ''; slot.dataset.panel = ''; });
    slot.querySelector('#bp-cancel').addEventListener('click', () => { slot.innerHTML = ''; slot.dataset.panel = ''; });
    slot.querySelector('#bp-add-row').addEventListener('click', () => { rows.push({ name: '', model: '' }); draw(); });
    slot.querySelectorAll('.rf-name').forEach(inp => inp.addEventListener('input', e => { rows[+e.target.dataset.i].name = e.target.value; draw(); }));
    slot.querySelectorAll('.rf-model').forEach(sel => sel.addEventListener('change', e => { rows[+e.target.dataset.i].model = e.target.value; draw(); }));
    slot.querySelectorAll('.rf-del').forEach(btn => btn.addEventListener('click', e => {
      const i = +e.target.dataset.i;
      if (rows.length === 1) { rows[0] = { name: '', model: '' }; } else { rows.splice(i, 1); }
      draw();
    }));
    slot.querySelector('#bp-save')?.addEventListener('click', async () => {
      const toSave = rows.filter(r => r.name.trim() && r.model);
      const status = slot.querySelector('#bp-status');
      slot.querySelector('#bp-save').disabled = true;
      slot.querySelector('#bp-save').textContent = 'Saving…';
      try {
        await Promise.all(toSave.map(r => api('/merchants', { method: 'POST', body: JSON.stringify({ name: r.name.trim(), machineModel: r.model || null, partnerId }) })));
        slot.innerHTML = '';
        onDone();
      } catch (err) {
        status.innerHTML = `<span style="color:var(--loss);">Error: ${escape(err.message)}</span>`;
        slot.querySelector('#bp-save').disabled = false;
        slot.querySelector('#bp-save').textContent = `Save ${toSave.length} merchant${toSave.length!==1?'s':''}`;
      }
    });
  }

  draw();
}

// ---------- Leaf rendering helpers (top-level functions) ----------

function makeNode(type) {
  switch (type) {
    case 'flat_per_machine':       return { type, rows: [{ model: 'ALL', amount: 0 }] };
    case 'flat_per_partner_total': return { type, amount: 0 };
    case 'percent':                return { type, rows: [{ model: 'ALL', percent: 0 }] };
    case 'tiered_percent':         return { type, basis: 'revenue', rows: [{ model: 'ALL', tiers: [{ from: 0, percent: 0 }] }] };
    case 'max':                    return { type, children: [] };   // populated by wrap logic
    default: throw new Error('unknown node type: ' + type);
  }
}

function leafCardMarkup(leaf, i, total) {
  const friendlyName = LEAF_META[leaf.type]?.label || leaf.type;
  const head = `
    <div class="lh">
      <div><span class="lt">${escape(friendlyName)}</span></div>
      <div class="controls">
        <button class="btn-up" ${i===0?'disabled':''}>↑</button>
        <button class="btn-down" ${i===total-1?'disabled':''}>↓</button>
        <button class="btn-remove">Remove</button>
      </div>
    </div>`;
  switch (leaf.type) {
    case 'flat_per_machine':       return head + flatPerMachineMarkup(leaf);
    case 'flat_per_partner_total': return head + flatPerPartnerTotalMarkup(leaf);
    case 'percent':                return head + percentMarkup(leaf);
    case 'tiered_percent':         return head + tieredPercentMarkup(leaf);
    default:                       return head + `<pre>${escape(JSON.stringify(leaf, null, 2))}</pre>`;
  }
}

function flatPerMachineMarkup(leaf) {
  return `
    <table class="leaf-tbl">
      <thead><tr><th>Model</th><th>Amount</th><th></th></tr></thead>
      <tbody>${leaf.rows.map((r, j) => `
        <tr><td><input data-row="${j}" data-field="model" value="${escape(r.model)}"></td>
        <td><input data-row="${j}" data-field="amount" type="number" value="${r.amount}"></td>
        <td><button data-act="del-row" data-row="${j}">×</button></td></tr>`).join('')}
      </tbody>
    </table>
    <button data-act="add-row">+ Add model row</button>`;
}

function flatPerPartnerTotalMarkup(leaf) {
  return `<label>Amount <input data-field="amount" type="number" value="${leaf.amount}"></label>`;
}

function percentMarkup(leaf) {
  return `
    <table class="leaf-tbl">
      <thead><tr><th>Model</th><th>%</th><th></th></tr></thead>
      <tbody>${leaf.rows.map((r, j) => `
        <tr><td><input data-row="${j}" data-field="model" value="${escape(r.model)}"></td>
        <td><input data-row="${j}" data-field="percent" type="number" value="${r.percent}"></td>
        <td><button data-act="del-row" data-row="${j}">×</button></td></tr>`).join('')}
      </tbody>
    </table>
    <button data-act="add-row">+ Add model row</button>`;
}

function tieredPercentMarkup(leaf) {
  return `
    <div class="basis-row">
      <label for="basis-sel">Tier brackets are based on:</label>
      <select data-field="basis" id="basis-sel">
        <option value="revenue" ${leaf.basis==='revenue'?'selected':''}>revenue</option>
        <option value="rentals" ${leaf.basis==='rentals'?'selected':''}>rentals (count)</option>
      </select>
    </div>
    ${leaf.rows.map((r, j) => `
      <div class="tier-block" data-row="${j}">
        <div><strong>Model:</strong> <input data-row="${j}" data-field="model" value="${escape(r.model)}"></div>
        <table class="leaf-tbl">
          <thead><tr><th>From</th><th>To (blank = ∞)</th><th>%</th><th></th></tr></thead>
          <tbody>${r.tiers.map((t, k) => `
            <tr>
              <td><input data-row="${j}" data-tier="${k}" data-field="from" type="number" value="${t.from}"></td>
              <td><input data-row="${j}" data-tier="${k}" data-field="to" type="number" value="${t.to ?? ''}"></td>
              <td><input data-row="${j}" data-tier="${k}" data-field="percent" type="number" value="${t.percent}"></td>
              <td><button data-act="del-tier" data-row="${j}" data-tier="${k}">×</button></td>
            </tr>`).join('')}
          </tbody>
        </table>
        <button data-act="add-tier" data-row="${j}">+ Add bracket</button>
        <button data-act="del-row" data-row="${j}">Remove model</button>
      </div>`).join('')}
    <button data-act="add-row">+ Add model row</button>`;
}

function bindLeafInputs(el, leaf, refresh) {
  el.addEventListener('input', (ev) => {
    const t = ev.target; if (t.tagName !== 'INPUT' && t.tagName !== 'SELECT') return;
    const rowIdx = t.dataset.row !== undefined ? Number(t.dataset.row) : null;
    const tierIdx = t.dataset.tier !== undefined ? Number(t.dataset.tier) : null;
    const field = t.dataset.field;
    const val = t.type === 'number' ? (t.value === '' ? null : Number(t.value)) : t.value;
    if (rowIdx == null) { leaf[field] = val; return; }
    if (tierIdx != null) { leaf.rows[rowIdx].tiers[tierIdx][field] = field === 'to' && val === null ? undefined : val; return; }
    leaf.rows[rowIdx][field] = val;
  });
  el.addEventListener('click', (ev) => {
    const t = ev.target; if (t.tagName !== 'BUTTON') return;
    const act = t.dataset.act; if (!act) return;
    const rowIdx = t.dataset.row !== undefined ? Number(t.dataset.row) : null;
    const tierIdx = t.dataset.tier !== undefined ? Number(t.dataset.tier) : null;
    if (act === 'add-row') {
      if (leaf.type === 'tiered_percent') leaf.rows.push({ model: 'ALL', tiers: [{ from: 0, percent: 0 }] });
      else if (leaf.type === 'flat_per_machine') leaf.rows.push({ model: 'ALL', amount: 0 });
      else if (leaf.type === 'percent') leaf.rows.push({ model: 'ALL', percent: 0 });
    }
    if (act === 'del-row') leaf.rows.splice(rowIdx, 1);
    if (act === 'add-tier') leaf.rows[rowIdx].tiers.push({ from: 0, percent: 0 });
    if (act === 'del-tier') leaf.rows[rowIdx].tiers.splice(tierIdx, 1);
    refresh();
  });
}

function rulePreview(rule) {
  if (rule.type === 'sum') return `SUM(${rule.children.map(rulePreview).join(', ')})`;
  if (rule.type === 'max') return `MAX(${rule.children.map(rulePreview).join(', ')})`;
  if (rule.type === 'min') return `MIN(${rule.children.map(rulePreview).join(', ')})`;
  return rule.type;
}

function escape(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ---------- Run flow ----------

async function downloadSampleCsv(partnerId) {
  const [allMerchants, machineModels, partner] = await Promise.all([
    api('/merchants'), api('/machine-models'), api('/partners/' + partnerId)
  ]);
  const merchants = allMerchants.filter(m => m.partnerId === partnerId);
  const form = decompileRule(partner.rule);
  const q = s => `"${String(s).replace(/"/g, '""')}"`;
  const header = SHARE_TERMS_CSV_HEADER;
  const rows = merchants.map(m => shareTermsCsvRow(q, partner.name, m, machineModels, form));
  const fallback = rows.length === 0
    ? [`${q(partner.name)},"Example Store","Advertising Player-S5",15,200,1500,0,800,HH`]
    : rows;
  const csv = [header, ...fallback].join('\n') + '\n';
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${partner.name}-share-terms.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function renderNewRunForm(partnerId, partner) {
  const main = document.getElementById('main');
  main.innerHTML = `
    <button class="back-link" id="back">← ${escape(partner.name)}</button>
    <h2>New calculation run</h2>
    <p class="muted" style="margin-bottom:18px;">Upload a per-machine CSV. The calculator applies <b>${escape(partner.name)}</b>'s current rule.</p>
    <form id="run-form">
      <label>Period start <input type="date" name="periodStart" required></label>
      <label>Period end <input type="date" name="periodEnd" required></label>
      <label>
        <span style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <span>CSV file</span>
          <button type="button" class="btn-ghost" id="download-sample" style="font-size:12px;padding:2px 8px;">↓ Download sample CSV</button>
        </span>
        <input type="file" id="run-file" name="file" accept=".csv,text/csv" style="display:none">
        <div id="run-file-zone" class="upload-zone" style="cursor:pointer;">
          <p>Choose a CSV file or drag it here</p>
          <button type="button" id="run-choose" class="btn">Choose file</button>
          <div id="run-file-name" class="upload-hint"></div>
        </div>
        <span class="muted" style="display:block;margin-top:6px;font-size:11.5px;">
          Columns: <code style="font-family:var(--font-mono);font-size:11px;">Merchant Name, Device Type, GP (%), Electricity, Placement, Others, Min Guarantee</code>
        </span>
      </label>
      <div>
        <button type="submit" class="btn-primary">Run calculation</button>
        <button type="button" id="cancel-run">Cancel</button>
      </div>
    </form>`;
  document.getElementById('back').addEventListener('click', () => renderPartnerDetail(partnerId));
  document.getElementById('cancel-run').addEventListener('click', () => renderPartnerDetail(partnerId));
  document.getElementById('download-sample').addEventListener('click', () => downloadSampleCsv(partnerId));
  document.getElementById('run-choose').addEventListener('click', () => document.getElementById('run-file').click());
  document.getElementById('run-file-zone').addEventListener('click', e => { if (e.target.id !== 'run-choose') document.getElementById('run-file').click(); });
  document.getElementById('run-file').addEventListener('change', e => {
    const f = e.target.files[0];
    const nameEl = document.getElementById('run-file-name');
    if (nameEl && f) nameEl.textContent = f.name;
  });
  document.getElementById('run-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const file = fd.get('file');
    if (!file || !file.size) { alert('Please select a CSV file.'); return; }
    const text = await file.text();
    const csvBase64 = btoa(unescape(encodeURIComponent(text)));
    try {
      const run = await api('/partners/' + partnerId + '/runs', {
        method: 'POST',
        body: JSON.stringify({ periodStart: fd.get('periodStart'), periodEnd: fd.get('periodEnd'), csvBase64 })
      });
      renderRunResult(partnerId, run.runId);
    } catch (e) { alert(e.message); }
  });
}

async function renderRunResult(partnerId, runId) {
  const main = document.getElementById('main');
  main.innerHTML = '<p class="muted">Loading run…</p>';
  const run = await api('/partners/' + partnerId + '/runs/' + runId);
  const partner = await api('/partners/' + partnerId);
  const r = run.result;
  const cur = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const byStore = (r.byStore || []).map(s => `
    <tr><td>${escape(s.storeId)}</td><td style="text-align:right;font-family:var(--font-mono);">${cur(s.payout)}</td></tr>`).join('');
  const byComponent = ((r.byPartner?.components) || (r.byStore?.[0]?.components) || []).map(c => `
    <tr><td>${escape(LEAF_META[c.leafType]?.label || c.leafType)}</td><td style="text-align:right;font-family:var(--font-mono);">${cur(c.payout)}</td></tr>`).join('');
  main.innerHTML = `
    <button class="back-link" id="back">← ${escape(partner.name)}</button>
    <div class="page-head">
      <div>
        <h2>Run result</h2>
        <div class="result-meta">
          <span>${escape(run.periodStart)} → ${escape(run.periodEnd)}</span>
          <span>Uploaded <b>${escape(run.uploadedAt.split('T')[0])}</b></span>
        </div>
      </div>
      <div>
        <button id="pdf-btn">Download PDF</button>
      </div>
    </div>
    <div class="section-label">Total payout</div>
    <div class="hero"><span class="hero-ccy">${escape(partner.currency)}</span>${cur(r.totalPayout)}</div>
    ${r.byStore ? `<h3>By store</h3><table class="ts"><thead><tr><th>Store</th><th style="text-align:right;">Payout</th></tr></thead><tbody>${byStore}</tbody></table>` : ''}
    ${r.topLevel ? `<p class="muted" style="margin-top:14px;">Top-level lump-sum: <b style="color:var(--ink);font-family:var(--font-mono);">${escape(partner.currency)} ${cur(r.topLevel.payout)}</b></p>` : ''}
    <h3>By component (first unit)</h3>
    <table class="ts"><thead><tr><th>Component</th><th style="text-align:right;">Payout</th></tr></thead><tbody>${byComponent}</tbody></table>
    <div style="margin-top:22px;">
      <button id="toggle-raw">Show raw JSON</button>
    </div>
    <pre class="raw-json" id="raw" style="display:none;">${escape(JSON.stringify(run, null, 2))}</pre>`;
  document.getElementById('back').addEventListener('click', () => renderPartnerDetail(partnerId));
  document.getElementById('toggle-raw').addEventListener('click', () => {
    const raw = document.getElementById('raw');
    raw.style.display = raw.style.display === 'none' ? 'block' : 'none';
  });
  document.getElementById('pdf-btn').addEventListener('click', () => downloadPdf(run));
}

async function downloadPdf(run) {
  // Render an off-screen statement HTML, capture via html2canvas, build A4 PDF via jsPDF.
  const partner = await api('/partners/' + run.partnerId);
  const cur = (n) => Number(n).toLocaleString('en-US');
  const statement = document.createElement('div');
  statement.style.cssText = `
    width: 794px; background: #fafaf9; padding: 36px 44px;
    font-family: Inter, sans-serif; color: #0f172a;
    position: fixed; left: -9999px; top: 0;`;
  statement.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:baseline;border-bottom:2px solid #0f172a;padding-bottom:10px;">
      <div>
        <div style="font-size:24px;font-weight:700;">Revenue-Share Statement</div>
        <div style="font-size:13px;color:#475569;">${escape(partner.name)}</div>
      </div>
      <div style="font-size:11px;color:#64748b;">${escape(run.periodStart)} → ${escape(run.periodEnd)}<br>Generated ${escape(new Date().toLocaleString('en-US'))}</div>
    </div>
    <div style="margin-top:18px;font-size:11px;letter-spacing:.04em;color:#64748b;">TOTAL PAYOUT</div>
    <div style="font-size:42px;font-weight:800;">${escape(partner.currency)} ${cur(run.result.totalPayout)}</div>
    ${run.result.byStore ? `
      <h3 style="font-size:13px;margin-top:24px;">By store</h3>
      <table style="width:100%;border-collapse:collapse;font-size:11px;">
        <thead><tr style="background:#e2e8f0;"><th style="text-align:left;padding:4px 8px;">Store</th><th style="text-align:right;padding:4px 8px;">Payout</th></tr></thead>
        <tbody>${run.result.byStore.map(s => `<tr><td style="padding:4px 8px;border-bottom:1px solid #e5e7eb;">${escape(s.storeId)}</td><td style="padding:4px 8px;border-bottom:1px solid #e5e7eb;text-align:right;">${cur(s.payout)}</td></tr>`).join('')}</tbody>
      </table>` : ''}
    ${run.result.topLevel ? `<p style="font-size:11px;margin-top:14px;">Top-level lump-sum: ${escape(partner.currency)} ${cur(run.result.topLevel.payout)}</p>` : ''}
    <div style="margin-top:36px;font-size:9px;color:#94a3b8;text-align:center;">Merchant Contract &amp; Revenue Share Management · ${R().name} · Generated automatically · Not a tax document</div>`;
  document.body.appendChild(statement);
  const canvas = await window.html2canvas(statement, { scale: 2, useCORS: true });
  document.body.removeChild(statement);

  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ unit: 'mm', format: 'a4' });
  const pdfWidth = pdf.internal.pageSize.getWidth();
  const imgHeight = (canvas.height * pdfWidth) / canvas.width;
  pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, pdfWidth, imgHeight);
  pdf.save(`revshare-${partner.name}-${run.periodStart}.pdf`);
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

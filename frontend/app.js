// === API ===
const API_URL = window.REVSHARE_API_URL || '';   // injected by deploy script

const CURRENCIES = ['TWD', 'USD', 'HKD', 'JPY', 'IDR', 'THB'];

// ── Rule form helpers ──────────────────────────────────────────────────────

function compileRule({ gpPercent, mgEnabled, mgAmount, electricity, placementRows, others }) {
  const children = [];
  const gpLeaf = { type: 'percent', rows: [{ model: 'ALL', percent: Number(gpPercent) }] };
  if (mgEnabled && Number(mgAmount) > 0) {
    children.push({ type: 'max', children: [gpLeaf, { type: 'flat_per_machine', rows: [{ model: 'ALL', amount: Number(mgAmount) }] }] });
  } else {
    children.push(gpLeaf);
  }
  if (Number(electricity) > 0) children.push({ type: 'flat_per_partner_total', amount: Number(electricity) });
  const validPlacement = (placementRows || []).filter(r => r.model && Number(r.amount) > 0);
  if (validPlacement.length) children.push({ type: 'flat_per_machine', rows: validPlacement.map(r => ({ model: r.model, amount: Number(r.amount) })) });
  if (Number(others) > 0) children.push({ type: 'flat_per_partner_total', amount: Number(others) });
  if (children.length === 1) return children[0];
  return { type: 'sum', children };
}

function decompileRule(rule) {
  if (!rule) return { gpPercent: 0, mgEnabled: false, mgAmount: 0, electricity: 0, placementRows: [], others: 0 };
  const nodes = rule.type === 'sum' ? (rule.children || []) : [rule];
  let gpPercent = 0, mgEnabled = false, mgAmount = 0;
  const flatAmounts = [];
  let placementRows = [];
  for (const node of nodes) {
    if (node.type === 'percent') {
      gpPercent = node.rows?.[0]?.percent ?? 0;
    } else if (node.type === 'max') {
      const pc = node.children?.find(c => c.type === 'percent');
      const fc = node.children?.find(c => c.type === 'flat_per_machine');
      if (pc) gpPercent = pc.rows?.[0]?.percent ?? 0;
      if (fc) { mgEnabled = true; mgAmount = fc.rows?.[0]?.amount ?? 0; }
    } else if (node.type === 'flat_per_partner_total') {
      flatAmounts.push(node.amount ?? 0);
    } else if (node.type === 'flat_per_machine') {
      placementRows = (node.rows || []).map(r => ({ model: r.model, amount: r.amount ?? 0 }));
    }
  }
  const electricity = flatAmounts[0] ?? 0;
  const others = flatAmounts.length >= 3 ? (flatAmounts[2] ?? 0) : (flatAmounts[1] ?? 0);
  return { gpPercent, mgEnabled, mgAmount, electricity, placementRows, others };
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
  const res = await fetch(API_URL + path, { ...opts, headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.status === 204 ? null : res.json();
}

// === router + screens ===
function initApp() {
  renderNav();
  renderPartnersList();
}

async function renderPartnersList() {
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head">
      <h2>Partners</h2>
      <button id="new-partner" class="btn-primary">+ New partner</button>
    </div>
    <input id="partner-search" class="search-input" placeholder="Search partners…" autocomplete="off">
    <div id="partners-out">Loading…</div>`;
  document.getElementById('new-partner').addEventListener('click', () => renderNewPartnerForm());
  try {
    const [partners, merchants] = await Promise.all([api('/partners'), api('/merchants')]);
    const countByPartner = {};
    merchants.forEach(m => { countByPartner[m.partnerId] = (countByPartner[m.partnerId] || 0) + 1; });

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
      out.innerHTML = `
        <table class="ts">
          <thead><tr><th>Name</th><th>Currency</th><th>Aggregation</th><th>Merchants</th></tr></thead>
          <tbody>${sorted.map(p => `
            <tr class="row-clickable" data-id="${escape(p.partnerId)}">
              <td>${escape(p.name)}</td>
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
    <button id="nav-bulk-runs" class="nav-btn">Share Calculation</button>
    <button id="nav-device-types" class="nav-btn">Device Types</button>
    <button id="nav-import" class="nav-btn">Import</button>`;
  nav.querySelector('#nav-partners').addEventListener('click', () => { setActiveNav('nav-partners'); renderPartnersList(); });
  nav.querySelector('#nav-bulk-runs').addEventListener('click', () => { setActiveNav('nav-bulk-runs'); renderBulkRunsList(); });
  nav.querySelector('#nav-device-types').addEventListener('click', () => { setActiveNav('nav-device-types'); renderDeviceTypesScreen(); });
  nav.querySelector('#nav-import').addEventListener('click', () => { setActiveNav('nav-import'); renderImportScreen(); });
}

function setActiveNav(id) {
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.id === id));
}

async function renderImportScreen() {
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head"><h2>Import from KA Excel</h2></div>
    <p class="muted">Upload the <strong>KA cost rate</strong> Excel file (Rev Share sheet). New partners will be created; existing partners are skipped. Merchants are upserted by name.</p>
    <input id="import-file" type="file" accept=".xlsx" style="display:none">
    <div id="import-file-zone" class="upload-zone" style="cursor:pointer;max-width:520px;margin-top:16px;">
      <p>Choose the KA cost rate Excel file or drag it here</p>
      <button type="button" id="import-choose" class="btn">Choose file</button>
      <div id="import-file-name" class="upload-hint"></div>
    </div>
    <div id="import-preview" style="margin-top:16px;"></div>`;

  document.getElementById('import-choose').addEventListener('click', () => document.getElementById('import-file').click());
  document.getElementById('import-file-zone').addEventListener('click', e => { if (e.target.id !== 'import-choose') document.getElementById('import-file').click(); });
  document.getElementById('import-file').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    const nameEl = document.getElementById('import-file-name');
    if (nameEl) nameEl.textContent = file.name;
    const preview = document.getElementById('import-preview');
    preview.innerHTML = 'Parsing…';
    try {
      const { partners, merchants, warnings } = await parseKaExcel(file);
      preview.innerHTML = `
        <h3>Preview</h3>
        <p>${partners.length} partner(s) to create, ${merchants.length} merchant(s) to upsert.</p>
        ${warnings.length ? `<p style="color:#f03e3e;">Warnings: ${warnings.map(escape).join(', ')}</p>` : ''}
        <table class="ts"><thead><tr><th>Partner (TAG)</th><th>GP%</th><th>MG</th><th>Electricity</th><th>Placement</th></tr></thead>
        <tbody>${partners.map(p => `<tr>
          <td>${escape(p.name)}</td>
          <td>${p.gpPercent}%</td>
          <td>${p.mgEnabled ? p.mgAmount + ' THB' : '—'}</td>
          <td>${p.electricity || 0}</td>
          <td>${p.placement || 0}</td>
        </tr>`).join('')}</tbody></table>
        <button id="confirm-import" class="btn-primary" style="margin-top:16px;">Confirm import</button>`;

      document.getElementById('confirm-import').addEventListener('click', async () => {
        document.getElementById('confirm-import').disabled = true;
        document.getElementById('confirm-import').textContent = 'Importing…';
        const result = await api('/import/rev-share', { method: 'POST', body: JSON.stringify({ partners, merchants }) });
        preview.innerHTML = `
          <div style="color:#2f9e44;font-weight:600;">Import complete</div>
          <p>Partners created: ${result.created.partners} | Skipped (already exist): ${result.skipped.partners.length}</p>
          <p>Merchants upserted: ${result.created.merchants}</p>
          ${result.warnings.length ? `<p style="color:#f03e3e;">${result.warnings.map(escape).join('<br>')}</p>` : ''}`;
      });
    } catch (err) {
      preview.innerHTML = `<p style="color:#f03e3e;">Parse error: ${escape(err.message)}</p>`;
    }
  });
}

async function renderDeviceTypesScreen() {
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head">
      <h2>Device Types</h2>
      <button id="add-model-btn" class="btn-primary">+ Add device type</button>
    </div>
    <div id="model-form-slot"></div>
    <div id="models-out">Loading…</div>`;

  document.getElementById('add-model-btn').addEventListener('click', showAddModelForm);

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
                <button class="btn-ghost edit-model" data-code="${escape(m.code)}" data-dn="${escape(m.displayName)}">Edit</button>
                <button class="btn-ghost del-model" data-code="${escape(m.code)}" style="color:var(--loss)">Delete</button>
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

async function parseKaExcel(file) {
  const wb = await readExcel(file);
  const ws = wb.Sheets['Rev Share'];
  if (!ws) throw new Error('Sheet "Rev Share" not found');
  const rows = XLSX.utils.sheet_to_json(ws, { defval: null });

  const partnerMap = {};
  const merchants = [];
  const warnings = [];

  for (const row of rows) {
    const tag        = row['Merchant label (TAG)'];
    const name       = row['merchant name.'];
    const deviceType = row['Device Type'];
    const gpPercent  = Number(row['Rev share %'] || 0) * 100;
    const triggerType= row['Trigger Type'];
    const placement  = Number(row['Placement (monthly)'] || 0);
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
      partnerMap[tagKey] = {
        name: String(tag),
        gpPercent,
        mgEnabled: triggerType === 'B',
        mgAmount: triggerType === 'B' ? placement : 0,
        electricity: triggerType === 'B' ? electricity : 0,
        placement: triggerType !== 'B' ? placement : 0,
        others: 0,
        aggregationMode: 'whole',
        currency: 'THB'
      };
    }

    merchants.push({ name: String(name), partnerName: String(tag), machineModel, externalId });
  }

  return { partners: Object.values(partnerMap), merchants, warnings };
}

async function renderBulkRunsList() {
  const main = document.getElementById('main');
  main.innerHTML = `<div class="page-head"><h2>Share Calculation</h2><button id="new-bulk-run" class="btn-primary">+ New calculation</button></div><div id="bulk-runs-out">Loading…</div>`;
  document.getElementById('new-bulk-run').addEventListener('click', renderNewBulkRunForm);
  const runs = await api('/bulk-runs');
  const out = document.getElementById('bulk-runs-out');
  if (!runs.length) { out.innerHTML = '<p class="muted">No calculations yet.</p>'; return; }
  out.innerHTML = `<table class="ts"><thead><tr><th>Period</th><th>Uploaded</th><th>Partners</th><th>Total payout</th><th>Unmatched</th></tr></thead>
    <tbody>${runs.map(r => `<tr data-id="${r.runId}" style="cursor:pointer;">
      <td>${escape(r.periodStart)} – ${escape(r.periodEnd)}</td>
      <td>${escape(r.uploadedAt?.split('T')[0] || '')}</td>
      <td>${r.partnerCount}</td>
      <td>${(r.totalPayout || 0).toFixed(2)}</td>
      <td>${r.unmatchedCount > 0 ? `<span style="color:#f03e3e;">${r.unmatchedCount}</span>` : '0'}</td>
    </tr>`).join('')}</tbody></table>`;
  out.querySelectorAll('tr[data-id]').forEach(tr => {
    tr.addEventListener('click', () => renderBulkRunDetail(tr.dataset.id));
  });
}

function renderNewBulkRunForm() {
  const now = new Date();
  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head">
      <button id="back" class="btn-ghost">← Back</button>
      <h2>New Share Calculation</h2>
    </div>
    <label>Year <input type="number" id="br-year" min="2020" max="2035" value="${now.getFullYear()}" style="width:100px;margin-left:8px;"></label>
    <label style="margin-top:12px;">Month
      <select id="br-month" style="margin-left:8px;">
        ${MONTHS.map((m, i) => `<option value="${i+1}" ${i===now.getMonth()?'selected':''}>${m}</option>`).join('')}
      </select>
    </label>
    <div style="margin-top:12px;">
      <div style="font-size:12.5px;color:var(--ink-soft);margin-bottom:8px;">Order report (.xlsx)</div>
      <input type="file" id="br-file" accept=".xlsx" style="display:none">
      <div id="br-file-zone" class="upload-zone" style="cursor:pointer;">
        <p>Choose an Excel file or drag it here</p>
        <button type="button" id="br-choose" class="btn">Choose file</button>
        <div id="br-file-name" class="upload-hint"></div>
      </div>
    </div>
    <div id="br-status" style="margin-top:16px;"></div>`;
  document.getElementById('back').addEventListener('click', renderBulkRunsList);
  document.getElementById('br-choose').addEventListener('click', () => document.getElementById('br-file').click());
  document.getElementById('br-file-zone').addEventListener('click', e => { if (e.target.id !== 'br-choose') document.getElementById('br-file').click(); });
  document.getElementById('br-file').addEventListener('change', async e => {
    const file = e.target.files[0];
    const nameEl = document.getElementById('br-file-name');
    if (nameEl && file) nameEl.textContent = file.name;
    const year = Number(document.getElementById('br-year').value);
    const month = Number(document.getElementById('br-month').value);
    if (!file || !year || !month) { alert('Select a year, month and file'); return; }
    const pad = n => String(n).padStart(2, '0');
    const start = `${year}-${pad(month)}-01`;
    const end = `${year}-${pad(month)}-${pad(new Date(year, month, 0).getDate())}`;
    const status = document.getElementById('br-status');
    status.innerHTML = 'Parsing Excel…';
    try {
      const orders = await parseOrderReport(file);
      status.innerHTML = `Parsed ${orders.length} paid orders. <button id="run-bulk" class="btn-primary">Run calculation</button>`;
      document.getElementById('run-bulk').addEventListener('click', async () => {
        document.getElementById('run-bulk').disabled = true;
        document.getElementById('run-bulk').textContent = 'Running…';
        const run = await api('/bulk-runs', { method: 'POST', body: JSON.stringify({ orders, periodStart: start, periodEnd: end }) });
        renderBulkRunDetail(run.runId);
      });
    } catch (err) {
      status.innerHTML = `<p style="color:#f03e3e;">Error: ${escape(err.message)}</p>`;
    }
  });
}

async function parseOrderReport(file) {
  const wb = await readExcel(file);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: null });
  return rows
    .filter(r => String(r['Payment Status'] || '').trim() === 'Paid')
    .map(r => ({ merchantName: String(r['Rental Merchant'] || '').trim(), netAmount: Number(r['Net Amount'] || 0) }))
    .filter(r => r.merchantName);
}

async function renderBulkRunDetail(runId) {
  const main = document.getElementById('main');
  main.innerHTML = `<div class="page-head"><button id="back" class="btn-ghost">← Back</button><h2>Share Calculation</h2></div><div id="br-detail">Loading…</div>`;
  document.getElementById('back').addEventListener('click', renderBulkRunsList);
  const run = await api('/bulk-runs/' + runId);
  const el = document.getElementById('br-detail');
  el.innerHTML = `
    <p class="muted">Period: <strong>${escape(run.periodStart)}</strong> – <strong>${escape(run.periodEnd)}</strong> · Uploaded: ${escape(run.uploadedAt?.split('T')[0])} · ${run.orderCount} orders · ${run.partnerCount} partners</p>
    ${run.warnings?.length ? `<p style="color:#e67700;">${run.warnings.map(escape).join('<br>')}</p>` : ''}
    <table class="ts"><thead><tr><th>Partner</th><th>Merchants</th><th>Rentals</th><th>Revenue</th><th>Payout</th></tr></thead>
    <tbody>${(run.results || []).sort((a,b) => b.payout - a.payout).map(r => `<tr>
      <td>${escape(r.partnerName)}</td>
      <td>${r.merchantCount}</td>
      <td>${r.rentals}</td>
      <td>${Number(r.revenue).toFixed(2)}</td>
      <td><strong>${Number(r.payout).toFixed(2)}</strong></td>
    </tr>`).join('')}</tbody>
    <tfoot><tr><td colspan="4"><strong>Total</strong></td><td><strong>${Number(run.totalPayout||0).toFixed(2)}</strong></td></tr></tfoot>
    </table>
    ${run.unmatched?.length ? `
      <div style="margin-top:24px;padding:16px;background:#fff5f5;border-radius:8px;border:1px solid #ffa8a8;">
        <strong style="color:#c92a2a;">⚠ ${run.unmatched.length} unmatched merchant(s)</strong>
        <p style="color:#868e96;font-size:13px;">These names were in the order report but not found in the merchant registry. Add them under the correct partner and re-run.</p>
        <ul style="font-size:13px;">${run.unmatched.map(n => `<li>${escape(n)}</li>`).join('')}</ul>
      </div>` : ''}`;
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
        <select name="currency">${CURRENCIES.map(c => `<option>${c}</option>`).join('')}</select>
      </label>
      <label>Aggregation mode
        <select name="aggregationMode"><option value="per_store">per store (one calc per store, summed)</option><option value="whole">whole partner (one calc over all rows)</option></select>
      </label>
      <div style="border-top:1px solid var(--border);margin-top:18px;padding-top:16px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-faint);margin-bottom:14px;">Revenue rule <span style="font-weight:400;text-transform:none;letter-spacing:0;">(optional — can be set later)</span></div>
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

  document.getElementById('new-partner-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    let rule;
    try { rule = editor.getRule(); } catch(e) { alert('Invalid rule JSON: ' + e.message); return; }
    const body = { name: fd.get('name'), currency: fd.get('currency'), aggregationMode: fd.get('aggregationMode'), rule };
    try {
      const p = await api('/partners', { method: 'POST', body: JSON.stringify(body) });
      renderPartnerDetail(p.partnerId);
    } catch (e) { alert(e.message); }
  });
}

function renderStructuredRuleEditor(container, initialRule, machineModels, { readOnly = false } = {}) {
  let form = decompileRule(initialRule);
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
      <div class="rule-form">
        <div class="rf-row"><label>GP Share %</label>
          <input id="rf-gp" type="number" min="0" max="100" step="0.1" value="${form.gpPercent}" ${d(rawMode)}></div>
        <div class="rf-row">
          <label><input id="rf-mg-toggle" type="checkbox" ${form.mgEnabled?'checked':''} ${d(rawMode)}> Minimum guarantee (THB / machine / month)</label>
          <input id="rf-mg-amt" type="number" min="0" value="${form.mgAmount}" ${d(!form.mgEnabled||rawMode)}></div>
        <div class="rf-row"><label>Monthly electricity (THB)</label>
          <input id="rf-elec" type="number" min="0" value="${form.electricity}" ${d(rawMode)}></div>
        <div style="margin:10px 0 6px"><label style="font-size:12.5px;color:var(--ink-soft);">Monthly placement — per machine type</label></div>
        <table class="row-form">
          <thead><tr>
            <th style="width:50%">Device type</th>
            <th style="width:35%">Amount (THB/month)</th>
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
        <div class="rf-row"><label>Monthly others (THB)</label>
          <input id="rf-others" type="number" min="0" value="${form.others}" ${d(rawMode)}></div>
        ${readOnly ? '' : `<details ${rawMode?'open':''}>
          <summary style="cursor:pointer;color:#868e96;font-size:13px;">Advanced (raw JSON)</summary>
          <textarea id="rf-json" rows="10" style="width:100%;font-family:monospace;font-size:12px;">${escape(rawJson)}</textarea>
          <label style="font-size:13px;"><input id="rf-raw-mode" type="checkbox" ${rawMode?'checked':''}> Use raw JSON (overrides form above)</label>
        </details>`}
      </div>`;

    if (readOnly) return;

    container.querySelector('#rf-mg-toggle')?.addEventListener('change', e => {
      syncPlacement();
      form.mgEnabled = e.target.checked;
      draw();
    });
    container.querySelector('#rf-raw-mode')?.addEventListener('change', e => {
      syncPlacement();
      rawMode = e.target.checked;
      if (!rawMode) {
        try { form = decompileRule(JSON.parse(container.querySelector('#rf-json').value)); } catch(_) {}
      }
      draw();
    });
    container.querySelector('#pl-add')?.addEventListener('click', () => {
      syncPlacement();
      form.placementRows.push({ model: '', amount: 0 });
      draw();
    });
    container.querySelectorAll('.pl-del').forEach(btn => btn.addEventListener('click', e => {
      syncPlacement();
      form.placementRows.splice(+e.target.dataset.i, 1);
      draw();
    }));
  }

  draw();

  return {
    getRule() {
      if (rawMode) {
        const ta = container.querySelector('#rf-json');
        return JSON.parse(ta.value);
      }
      form.gpPercent   = Number(container.querySelector('#rf-gp')?.value    || 0);
      form.mgEnabled   = container.querySelector('#rf-mg-toggle')?.checked  || false;
      form.mgAmount    = Number(container.querySelector('#rf-mg-amt')?.value || 0);
      form.electricity = Number(container.querySelector('#rf-elec')?.value   || 0);
      form.others      = Number(container.querySelector('#rf-others')?.value || 0);
      syncPlacement();
      return compileRule(form);
    }
  };
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
      <button id="new-run" class="btn-primary">+ New run</button>
    </div>
    <p class="muted" style="margin-bottom:18px;">Currency: ${escape(p.currency)} · Aggregation: ${escape(p.aggregationMode)}</p>
    <div class="tabs">
      <button id="tab-merchants" class="tab active">Merchants (<span id="merchant-count">…</span>)</button>
      <button id="tab-rule" class="tab">Rule</button>
      <button id="tab-runs" class="tab">Runs</button>
    </div>
    <div id="tab-merchants-content">
      <div id="merchants-tab-content">Loading…</div>
    </div>
    <div id="tab-rule-content" style="display:none">
      <div id="rule-edit-bar" style="display:flex;justify-content:flex-end;margin-bottom:14px;"></div>
      <div id="rule-editor-container"></div>
    </div>
    <div id="tab-runs-content" style="display:none">
      <div id="runs-history"></div>
    </div>`;

  document.getElementById('back').addEventListener('click', renderPartnersList);
  document.getElementById('new-run').addEventListener('click', () => renderNewRunForm(partnerId, p));

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
      <button id="edit-rule-btn" class="btn-primary" style="padding:6px 14px;font-size:12.5px;">Edit rule</button>`;
    renderStructuredRuleEditor(ruleContainer, p.rule, machineModels, { readOnly: true });
    document.getElementById('edit-rule-btn').addEventListener('click', () => showRuleEdit(machineModels));
  }

  function showRuleEdit(machineModels) {
    const bar = document.getElementById('rule-edit-bar');
    const ruleContainer = document.getElementById('rule-editor-container');
    if (!bar || !ruleContainer) return;
    const editor = renderStructuredRuleEditor(ruleContainer, p.rule, machineModels, { readOnly: false });
    bar.innerHTML = `
      <button id="cancel-rule-btn" class="btn-ghost" style="margin-right:6px;">Cancel</button>
      <button id="save-rule-btn" class="btn-primary" style="padding:6px 14px;font-size:12.5px;">Save rule</button>`;
    document.getElementById('cancel-rule-btn').addEventListener('click', () => showRuleView(machineModels));
    document.getElementById('save-rule-btn').addEventListener('click', async () => {
      let rule;
      try { rule = editor.getRule(); } catch(e) { alert('Invalid JSON: ' + e.message); return; }
      const btn = document.getElementById('save-rule-btn');
      btn.disabled = true; btn.textContent = 'Saving…';
      await api('/partners/' + partnerId, { method: 'PUT', body: JSON.stringify({ rule }) });
      p.rule = rule;
      showRuleView(machineModels);
    });
  }

  api('/merchants').then(all => {
    const el = document.getElementById('merchant-count');
    if (el) el.textContent = all.filter(m => m.partnerId === partnerId).length;
  });

  // Nested closure — renders past runs into #runs-history inside tab-runs-content
  async function renderRunsHistory() {
    const runsHistory = document.getElementById('runs-history');
    runsHistory.innerHTML = '<p class="muted">Loading…</p>';
    const runs = await api('/partners/' + partnerId + '/runs');
    runsHistory.innerHTML = `
      <h3 style="margin-top:30px;">Run history</h3>
      ${runs.length === 0 ? '<p class="muted">No runs yet.</p>' : `
        <table class="ts"><thead><tr><th>Period</th><th>Uploaded</th><th>Total</th></tr></thead><tbody>
        ${runs.map(r => `<tr class="row-clickable" data-runid="${escape(r.runId)}">
          <td>${escape(r.periodStart)} → ${escape(r.periodEnd)}</td>
          <td>${escape(r.uploadedAt.split('T')[0])}</td>
          <td>${Number(r.result.totalPayout).toLocaleString('en-US')}</td>
        </tr>`).join('')}
        </tbody></table>`}`;
    runsHistory.querySelectorAll('.row-clickable').forEach(tr => {
      tr.addEventListener('click', () => renderRunResult(partnerId, tr.dataset.runid));
    });
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
      <div style="display:flex;gap:6px;">
        <button id="batch-csv-btn" class="btn">↑ CSV upload</button>
        <button id="batch-rows-btn" class="btn">+ Add rows</button>
        <button id="add-merchant-btn" class="btn-primary">+ Add one</button>
      </div>
    </div>
    <div id="batch-panel-slot"></div>
    ${merchants.length === 0 ? '<p class="muted">No merchants yet. Add one or import from Excel.</p>' : `
    <table class="ts"><thead><tr><th>Name</th><th>Model</th><th></th></tr></thead><tbody>
      ${merchants.map(m => `
        <tr>
          <td>${escape(m.name)}</td>
          <td>${m.machineModel ? `<span class="badge badge-neutral">${escape(machineModels.find(mm => mm.code === m.machineModel)?.displayName || m.machineModel)}</span>` : '—'}</td>
          <td>
            <button class="btn-ghost edit-m" data-id="${m.merchantId}">Edit</button>
            <button class="btn-ghost del-m" data-id="${m.merchantId}">Delete</button>
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

    const header = 'Merchant Name,Device Type,GP (%),Min Guarantee (THB/machine/month),Electricity (THB/month),Placement (THB/month),Others (THB/month)';
    const rows = merchants.map(m => {
      const modelDisplay = m.machineModel
        ? (machineModels.find(mm => mm.code === m.machineModel)?.displayName || m.machineModel)
        : '';
      const placementRow = (form.placementRows || []).find(r => r.model === m.machineModel || r.model === 'ALL');
      return [
        q(m.name),
        q(modelDisplay),
        form.gpPercent,
        form.mgEnabled ? form.mgAmount : 0,
        form.electricity,
        placementRow?.amount ?? 0,
        form.others
      ].join(',');
    });

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
  container.querySelector('#batch-csv-btn').addEventListener('click', () => {
    const isOpen = batchSlot.dataset.panel === 'csv';
    batchSlot.dataset.panel = isOpen ? '' : 'csv';
    isOpen ? (batchSlot.innerHTML = '') : showBatchCsvPanel(partnerId, machineModels, () => renderMerchantsTab(partnerId));
  });
  container.querySelector('#batch-rows-btn').addEventListener('click', () => {
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
  let dataLines = lines;
  if (lines[0].toLowerCase().includes('name')) dataLines = lines.slice(1);
  return dataLines
    .map(line => {
      const fields = parseCsvLine(line);
      const name = (fields[0] || '').trim();
      const modelInput = (fields[1] || '').trim();
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
          <div class="batch-panel-sub">Same format as the export file: <code>Merchant Name</code>, <code>Device Type</code>, then rule columns. Extra columns are ignored.</div>
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
    const header = 'Merchant Name,Device Type,GP (%),Min Guarantee (THB/machine/month),Electricity (THB/month),Placement (THB/month),Others (THB/month)';
    const examples = machineModels.slice(0, 3).map((m, i) =>
      `${q('Example Store ' + (i + 1))},${q(m.displayName)},15,200,1500,500,0`
    );
    if (!examples.length) examples.push('"Example Store","Advertising Player-S5",15,200,1500,500,0');
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
  const header = 'Merchant Name,Device Type,GP (%),Min Guarantee (THB/machine/month),Electricity (THB/month),Placement (THB/month),Others (THB/month)';
  const rows = merchants.map(m => {
    const modelDisplay = m.machineModel
      ? (machineModels.find(mm => mm.code === m.machineModel)?.displayName || m.machineModel)
      : '';
    const placementRow = (form.placementRows || []).find(r => r.model === m.machineModel || r.model === 'ALL');
    return [
      q(m.name), q(modelDisplay),
      form.gpPercent, form.mgEnabled ? form.mgAmount : 0,
      form.electricity, placementRow?.amount ?? 0, form.others
    ].join(',');
  });
  const fallback = rows.length === 0
    ? ['"Example Store","Advertising Player-S5",15,200,1500,500,0']
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
          Columns: <code style="font-family:var(--font-mono);font-size:11px;">Merchant Name, Device Type, GP (%), Min Guarantee, Electricity, Placement, Others</code>
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
    <div style="margin-top:36px;font-size:9px;color:#94a3b8;text-align:center;">RevShare · Generated automatically · Not a tax document</div>`;
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
initApp();

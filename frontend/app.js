// === API ===
const API_URL = window.REVSHARE_API_URL || '';   // injected by deploy script

const CURRENCIES = ['TWD', 'USD', 'HKD', 'JPY', 'IDR', 'THB'];

// ── Rule form helpers ──────────────────────────────────────────────────────

function compileRule({ gpPercent, mgEnabled, mgAmount, electricity, placement, others }) {
  const children = [];
  const gpLeaf = { type: 'percent', rows: [{ model: 'ALL', percent: Number(gpPercent) }] };
  if (mgEnabled && Number(mgAmount) > 0) {
    children.push({ type: 'max', children: [gpLeaf, { type: 'flat_per_machine', rows: [{ model: 'ALL', amount: Number(mgAmount) }] }] });
  } else {
    children.push(gpLeaf);
  }
  if (Number(electricity) > 0) children.push({ type: 'flat_per_partner_total', amount: Number(electricity) });
  if (Number(placement) > 0) children.push({ type: 'flat_per_partner_total', amount: Number(placement) });
  if (Number(others) > 0) children.push({ type: 'flat_per_partner_total', amount: Number(others) });
  if (children.length === 1) return children[0];
  return { type: 'sum', children };
}

function decompileRule(rule) {
  if (!rule) return { gpPercent: 0, mgEnabled: false, mgAmount: 0, electricity: 0, placement: 0, others: 0 };
  const nodes = rule.type === 'sum' ? (rule.children || []) : [rule];
  let gpPercent = 0, mgEnabled = false, mgAmount = 0;
  const flatAmounts = [];
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
    }
  }
  return { gpPercent, mgEnabled, mgAmount, electricity: flatAmounts[0] ?? 0, placement: flatAmounts[1] ?? 0, others: flatAmounts[2] ?? 0 };
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
  renderPartnersList();
}

async function renderPartnersList() {
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head">
      <h2>Partners</h2>
      <button id="new-partner" class="btn-primary">+ New partner</button>
    </div>
    <div id="partners-out">Loading…</div>`;
  document.getElementById('new-partner').addEventListener('click', () => renderNewPartnerForm());
  try {
    const partners = await api('/partners');
    const out = document.getElementById('partners-out');
    if (!partners.length) { out.innerHTML = '<p class="muted">No partners yet.</p>'; return; }
    out.innerHTML = `
      <table class="ts">
        <thead><tr><th>Name</th><th>Currency</th><th>Aggregation</th></tr></thead>
        <tbody>${partners.map(p => `
          <tr class="row-clickable" data-id="${escape(p.partnerId)}">
            <td>${escape(p.name)}</td>
            <td>${escape(p.currency)}</td>
            <td>${escape(p.aggregationMode)}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;
    out.querySelectorAll('.row-clickable').forEach(tr => {
      tr.addEventListener('click', () => renderPartnerDetail(tr.dataset.id));
    });
  } catch (e) {
    document.getElementById('partners-out').innerHTML = `<p class="error">${escape(e.message)}</p>`;
  }
}

function renderNewPartnerForm() {
  const main = document.getElementById('main');
  main.innerHTML = `
    <button class="back-link" id="back">← Partners</button>
    <h2>New partner</h2>
    <p class="muted" style="margin-bottom:18px;">Currency and aggregation mode are fixed once set. The rule can be edited on the partner detail page after creation.</p>
    <form id="new-partner-form">
      <label>Name <input name="name" required></label>
      <label>Currency
        <select name="currency">${CURRENCIES.map(c => `<option>${c}</option>`).join('')}</select>
      </label>
      <label>Aggregation mode
        <select name="aggregationMode"><option value="per_store">per store (one calc per store, summed)</option><option value="whole">whole partner (one calc over all rows)</option></select>
      </label>
      <div>
        <button type="submit" class="btn-primary">Create partner</button>
        <button type="button" id="cancel-new">Cancel</button>
      </div>
    </form>`;
  document.getElementById('back').addEventListener('click', renderPartnersList);
  document.getElementById('cancel-new').addEventListener('click', renderPartnersList);
  document.getElementById('new-partner-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const body = { name: fd.get('name'), currency: fd.get('currency'), aggregationMode: fd.get('aggregationMode') };
    try {
      const p = await api('/partners', { method: 'POST', body: JSON.stringify(body) });
      renderPartnerDetail(p.partnerId);
    } catch (e) { alert(e.message); }
  });
}

function renderStructuredRuleEditor(container, initialRule) {
  let form = decompileRule(initialRule);
  let rawMode = false;
  let rawJson = JSON.stringify(initialRule || { type: 'sum', children: [] }, null, 2);

  function draw() {
    container.innerHTML = `
      <div class="rule-form">
        <div class="rf-row"><label>GP Share %</label>
          <input id="rf-gp" type="number" min="0" max="100" step="0.1" value="${form.gpPercent}" ${rawMode?'disabled':''}></div>
        <div class="rf-row">
          <label><input id="rf-mg-toggle" type="checkbox" ${form.mgEnabled?'checked':''} ${rawMode?'disabled':''}> Minimum guarantee (THB / machine / month)</label>
          <input id="rf-mg-amt" type="number" min="0" value="${form.mgAmount}" ${(!form.mgEnabled||rawMode)?'disabled':''}></div>
        <div class="rf-row"><label>Monthly electricity (THB)</label>
          <input id="rf-elec" type="number" min="0" value="${form.electricity}" ${rawMode?'disabled':''}></div>
        <div class="rf-row"><label>Monthly placement (THB)</label>
          <input id="rf-place" type="number" min="0" value="${form.placement}" ${rawMode?'disabled':''}></div>
        <div class="rf-row"><label>Monthly others (THB)</label>
          <input id="rf-others" type="number" min="0" value="${form.others}" ${rawMode?'disabled':''}></div>
        <details ${rawMode?'open':''}>
          <summary style="cursor:pointer;color:#868e96;font-size:13px;">Advanced (raw JSON)</summary>
          <textarea id="rf-json" rows="10" style="width:100%;font-family:monospace;font-size:12px;">${escape(rawJson)}</textarea>
          <label style="font-size:13px;"><input id="rf-raw-mode" type="checkbox" ${rawMode?'checked':''}> Use raw JSON (overrides form above)</label>
        </details>
      </div>`;

    container.querySelector('#rf-mg-toggle')?.addEventListener('change', e => {
      form.mgEnabled = e.target.checked;
      draw();
    });
    container.querySelector('#rf-raw-mode')?.addEventListener('change', e => {
      rawMode = e.target.checked;
      if (!rawMode) {
        try { form = decompileRule(JSON.parse(container.querySelector('#rf-json').value)); } catch(_) {}
      }
      draw();
    });
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
      form.placement   = Number(container.querySelector('#rf-place')?.value  || 0);
      form.others      = Number(container.querySelector('#rf-others')?.value || 0);
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
      <button id="back" class="btn-ghost">← Partners</button>
      <h2>${escape(p.name)}</h2>
    </div>
    <p class="muted">Currency: ${escape(p.currency)} · Aggregation: ${escape(p.aggregationMode)}</p>
    <button id="new-run" class="btn-primary" style="margin-bottom:16px;">+ New run</button>
    <div class="tabs" style="margin-bottom:16px;">
      <button id="tab-rule" class="tab active">Rule</button>
      <button id="tab-merchants" class="tab">Merchants (<span id="merchant-count">…</span>)</button>
      <button id="tab-runs" class="tab">Runs</button>
    </div>
    <div id="tab-rule-content">
      <div id="rule-editor-container"></div>
      <button id="save-rule" class="btn-primary" style="margin-top:12px;">Save rule</button>
    </div>
    <div id="tab-merchants-content" style="display:none">
      <div id="merchants-tab-content">Loading…</div>
    </div>
    <div id="tab-runs-content" style="display:none">
      <div id="runs-history"></div>
    </div>`;

  document.getElementById('back').addEventListener('click', renderPartnersList);
  document.getElementById('new-run').addEventListener('click', () => renderNewRunForm(partnerId, p));

  const ruleContainer = document.getElementById('rule-editor-container');
  const editor = renderStructuredRuleEditor(ruleContainer, p.rule);

  document.getElementById('save-rule').addEventListener('click', async () => {
    let rule;
    try { rule = editor.getRule(); } catch(e) { alert('Invalid JSON: ' + e.message); return; }
    await api('/partners/' + partnerId, { method: 'PUT', body: JSON.stringify({ rule }) });
    alert('Saved');
    renderPartnerDetail(partnerId);
  });

  ['rule','merchants','runs'].forEach(t => {
    document.getElementById(`tab-${t}`).addEventListener('click', () => {
      ['rule','merchants','runs'].forEach(x => {
        document.getElementById(`tab-${x}`).classList.toggle('active', x === t);
        document.getElementById(`tab-${x}-content`).style.display = x === t ? '' : 'none';
      });
      if (t === 'merchants') renderMerchantsTab(partnerId);
      if (t === 'runs') renderRunsHistory();
    });
  });

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
          <td>${Number(r.result.totalPayout).toLocaleString()}</td>
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
  const all = await api('/merchants');
  const merchants = all.filter(m => m.partnerId === partnerId);
  const MODELS = ['S5','S8','S10','T8','T10','T20','T35','L20','L40'];
  container.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
      <span>${merchants.length} merchant${merchants.length !== 1 ? 's' : ''}</span>
      <button id="add-merchant-btn" class="btn-primary">+ Add merchant</button>
    </div>
    ${merchants.length === 0 ? '<p class="muted">No merchants yet. Add one or import from Excel.</p>' : `
    <table class="ts"><thead><tr><th>Name</th><th>Model</th><th></th></tr></thead><tbody>
      ${merchants.map(m => `
        <tr>
          <td>${escape(m.name)}</td>
          <td>${escape(m.machineModel || '—')}</td>
          <td>
            <button class="btn-ghost edit-m" data-id="${m.merchantId}">Edit</button>
            <button class="btn-ghost del-m" data-id="${m.merchantId}">Delete</button>
          </td>
        </tr>`).join('')}
    </tbody></table>`}
    <div id="merchant-form-slot"></div>`;

  container.querySelector('#add-merchant-btn')?.addEventListener('click', () => {
    showMerchantForm(partnerId, null, MODELS, () => renderMerchantsTab(partnerId));
  });
  container.querySelectorAll('.edit-m').forEach(btn => {
    btn.addEventListener('click', () => {
      const m = merchants.find(x => x.merchantId === btn.dataset.id);
      showMerchantForm(partnerId, m, MODELS, () => renderMerchantsTab(partnerId));
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

function showMerchantForm(partnerId, existing, MODELS, onDone) {
  const slot = document.getElementById('merchant-form-slot');
  slot.innerHTML = `
    <div class="modal-bg"><div class="modal">
      <h3>${existing ? 'Edit' : 'Add'} merchant</h3>
      <label>Name<input id="mf-name" value="${escape(existing?.name || '')}"></label>
      <label>Machine model
        <select id="mf-model">
          <option value="">— select —</option>
          ${MODELS.map(m => `<option ${existing?.machineModel===m?'selected':''} value="${m}">${m}</option>`).join('')}
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

function downloadSampleCsv() {
  const csv = [
    'store_id,machine_serial,model,rentals,revenue',
    'TPE-001,SN-A100,S5,120,36000',
    'TPE-001,SN-A101,T35,40,28000',
    'TPE-002,SN-B200,S5,200,60000',
    'TPE-002,SN-B201,S5,80,24000',
    'TPE-002,SN-B202,L20,15,8500',
    'KHH-001,SN-C300,T35,60,42000',
    'KHH-001,SN-C301,S10,95,31000',
  ].join('\n') + '\n';
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'revshare-sample.csv';
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
        <span style="display:flex;justify-content:space-between;align-items:center;">
          <span>CSV file</span>
          <button type="button" class="btn-ghost" id="download-sample" style="font-size:12px;padding:2px 8px;">↓ Download sample CSV</button>
        </span>
        <input type="file" name="file" accept=".csv,text/csv" required>
        <span class="muted" style="display:block;margin-top:6px;font-size:11.5px;">
          Columns: <code style="font-family:var(--font-mono);font-size:11px;">store_id, machine_serial, model, rentals, revenue</code> — one row per machine.
          Models must be one of: S5, S8, S10, T8, T10, T20, T35, L20, L40.
        </span>
      </label>
      <div>
        <button type="submit" class="btn-primary">Run calculation</button>
        <button type="button" id="cancel-run">Cancel</button>
      </div>
    </form>`;
  document.getElementById('back').addEventListener('click', () => renderPartnerDetail(partnerId));
  document.getElementById('cancel-run').addEventListener('click', () => renderPartnerDetail(partnerId));
  document.getElementById('download-sample').addEventListener('click', downloadSampleCsv);
  document.getElementById('run-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const file = fd.get('file');
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
  const cur = (n) => Number(n).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
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
  const cur = (n) => Number(n).toLocaleString();
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
      <div style="font-size:11px;color:#64748b;">${escape(run.periodStart)} → ${escape(run.periodEnd)}<br>Generated ${escape(new Date().toLocaleString())}</div>
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

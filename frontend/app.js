// === auth ===
const API_URL = window.REVSHARE_API_URL || '';   // injected by deploy script
function getPw() {
  const pw = localStorage.getItem('revshare_pw');
  const exp = parseInt(localStorage.getItem('revshare_pw_exp') || '0', 10);
  if (!pw || exp < Date.now()) return null;
  return pw;
}
function setPw(pw) {
  localStorage.setItem('revshare_pw', pw);
  localStorage.setItem('revshare_pw_exp', String(Date.now() + 30 * 24 * 3600 * 1000));
}
function clearPw() {
  localStorage.removeItem('revshare_pw');
  localStorage.removeItem('revshare_pw_exp');
}
async function api(path, opts = {}) {
  const headers = { 'content-type': 'application/json', 'x-app-password': getPw() || '', ...(opts.headers || {}) };
  const res = await fetch(API_URL + path, { ...opts, headers });
  if (res.status === 401) { clearPw(); location.reload(); throw new Error('auth_failed'); }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.status === 204 ? null : res.json();
}

// === login screen wiring ===
document.getElementById('pw-submit').addEventListener('click', async () => {
  const pw = document.getElementById('pw-input').value;
  const errEl = document.getElementById('pw-error');
  errEl.hidden = true;
  try {
    const res = await fetch(API_URL + '/partners', { headers: { 'x-app-password': pw } });
    if (res.ok) {
      setPw(pw);
      document.body.classList.remove('no-auth');
      initApp();
    } else {
      errEl.textContent = res.status === 429 ? 'Too many attempts. Wait 1 minute.' : 'Invalid password.';
      errEl.hidden = false;
    }
  } catch (e) {
    errEl.textContent = 'Network error: ' + e.message;
    errEl.hidden = false;
  }
});

// === router + screens ===
function initApp() {
  // Mount partners list by default. Real router added in Task 27.
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
    <h2>New partner</h2>
    <form id="new-partner-form">
      <label>Name <input name="name" required></label>
      <label>Currency
        <select name="currency"><option>TWD</option><option>USD</option><option>HKD</option><option>JPY</option><option>IDR</option></select>
      </label>
      <label>Aggregation
        <select name="aggregationMode"><option value="per_store">per store</option><option value="whole">whole partner</option></select>
      </label>
      <div style="margin-top:14px;">
        <button type="submit" class="btn-primary">Create</button>
        <button type="button" id="cancel-new">Cancel</button>
      </div>
    </form>`;
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

async function renderPartnerDetail(partnerId) {
  const main = document.getElementById('main');
  main.innerHTML = '<p>Loading partner…</p>';
  const p = await api('/partners/' + partnerId);

  // Normalize partner.rule to a top-level SUM for editing
  let editorRule = (p.rule && p.rule.type === 'sum') ? p.rule : { type: 'sum', children: p.rule ? [p.rule] : [] };

  function render() {
    main.innerHTML = `
      <button id="back">← Partners</button>
      <div class="page-head">
        <div>
          <h2>${escape(p.name)} <span class="muted" style="font-weight:400;font-size:14px;">— ${escape(p.currency)} · ${escape(p.aggregationMode)}</span></h2>
        </div>
        <div>
          <button id="run-new" class="btn-primary">+ Run calculation</button>
          <button id="save-rule">Save rule</button>
        </div>
      </div>
      <div class="muted" style="font-size:11px;letter-spacing:.04em;margin-bottom:8px;">RULE COMPONENTS · ALL SUMMED TOGETHER</div>
      <div id="leaf-list"></div>
      <button class="addbtn" id="add-leaf">+ Add component</button>
      <div class="rule-preview muted" style="margin-top:14px;font-size:12px;">
        Preview: <code>${escape(rulePreview(editorRule))}</code>
      </div>`;
    document.getElementById('back').addEventListener('click', renderPartnersList);
    document.getElementById('save-rule').addEventListener('click', async () => {
      // Unwrap solo SUM
      const ruleToSave = editorRule.children.length === 1 ? editorRule.children[0] : editorRule;
      try { await api('/partners/' + partnerId, { method: 'PUT', body: JSON.stringify({ rule: ruleToSave }) }); alert('Saved'); }
      catch (e) { alert(e.message); }
    });
    document.getElementById('add-leaf').addEventListener('click', () => pickLeaf());
    document.getElementById('run-new').addEventListener('click', () => renderNewRunForm(partnerId, p));
    renderLeafList();
    renderRunsHistory();
  }

  function renderLeafList() {
    const root = document.getElementById('leaf-list');
    root.innerHTML = '';
    editorRule.children.forEach((leaf, i) => {
      const el = document.createElement('div');
      el.className = 'leaf-card';
      el.innerHTML = leafCardMarkup(leaf, i, editorRule.children.length);
      el.querySelector('.btn-remove')?.addEventListener('click', () => { editorRule.children.splice(i,1); render(); });
      el.querySelector('.btn-up')?.addEventListener('click', () => { if (i>0) { const [m]=editorRule.children.splice(i,1); editorRule.children.splice(i-1,0,m); render(); }});
      el.querySelector('.btn-down')?.addEventListener('click', () => { if (i<editorRule.children.length-1) { const [m]=editorRule.children.splice(i,1); editorRule.children.splice(i+1,0,m); render(); }});
      bindLeafInputs(el, leaf, render);
      root.appendChild(el);
    });
  }

  function pickLeaf() {
    const choice = prompt('Component type:\n1) flat_per_machine\n2) flat_per_partner_total\n3) percent\n4) tiered_percent\n\nEnter 1-4:');
    const map = { '1': { type: 'flat_per_machine', rows: [{ model: 'ALL', amount: 0 }] },
                  '2': { type: 'flat_per_partner_total', amount: 0 },
                  '3': { type: 'percent', rows: [{ model: 'ALL', percent: 0 }] },
                  '4': { type: 'tiered_percent', basis: 'revenue', rows: [{ model: 'ALL', tiers: [{ from: 0, percent: 0 }] }] }};
    const leaf = map[choice];
    if (leaf) { editorRule.children.push(leaf); render(); }
  }

  async function renderRunsHistory() {
    const runs = await api('/partners/' + partnerId + '/runs');
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <h3 style="margin-top:30px;">Run history</h3>
      ${runs.length === 0 ? '<p class="muted">No runs yet.</p>' : `
        <table class="ts"><thead><tr><th>Period</th><th>Uploaded</th><th>Total</th></tr></thead><tbody>
        ${runs.map(r => `<tr class="row-clickable" data-runid="${escape(r.runId)}">
          <td>${escape(r.periodStart)} → ${escape(r.periodEnd)}</td>
          <td>${escape(r.uploadedAt.split('T')[0])}</td>
          <td>${Number(r.result.totalPayout).toLocaleString()}</td>
        </tr>`).join('')}
        </tbody></table>`}`;
    document.getElementById('main').appendChild(wrap);
    wrap.querySelectorAll('.row-clickable').forEach(tr => {
      tr.addEventListener('click', () => renderRunResult(partnerId, tr.dataset.runid));
    });
  }

  render();
}

// ---------- Leaf rendering helpers (top-level functions) ----------

function leafCardMarkup(leaf, i, total) {
  const head = `
    <div class="lh">
      <div><span class="lt">${escape(leaf.type)}</span></div>
      <div class="controls">
        <button class="btn-up" ${i===0?'disabled':''}>↑</button>
        <button class="btn-down" ${i===total-1?'disabled':''}>↓</button>
        <button class="btn-remove" style="color:#dc2626;">Remove</button>
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
    <div style="font-size:12px;margin-bottom:8px;">basis:
      <select data-field="basis">
        <option value="revenue" ${leaf.basis==='revenue'?'selected':''}>revenue</option>
        <option value="rentals" ${leaf.basis==='rentals'?'selected':''}>rentals</option>
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

function renderNewRunForm(partnerId, partner) {
  const main = document.getElementById('main');
  main.innerHTML = `
    <button id="back">← Back</button>
    <h2>New run — ${escape(partner.name)}</h2>
    <form id="run-form">
      <label>Period start <input type="date" name="periodStart" required></label>
      <label>Period end <input type="date" name="periodEnd" required></label>
      <label>CSV file <input type="file" name="file" accept=".csv,text/csv" required></label>
      <div style="margin-top:14px;">
        <button type="submit" class="btn-primary">Run</button>
      </div>
    </form>`;
  document.getElementById('back').addEventListener('click', () => renderPartnerDetail(partnerId));
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
  main.innerHTML = '<p>Loading run…</p>';
  const run = await api('/partners/' + partnerId + '/runs/' + runId);
  const r = run.result;
  const cur = (n) => Number(n).toLocaleString();
  const byStore = (r.byStore || []).map(s => `
    <tr><td>${escape(s.storeId)}</td><td>${cur(s.payout)}</td></tr>`).join('');
  const byComponent = ((r.byPartner?.components) || (r.byStore?.[0]?.components) || []).map(c => `
    <tr><td>${escape(c.leafType)}</td><td>${cur(c.payout)}</td></tr>`).join('');
  main.innerHTML = `
    <button id="back">← Back</button>
    <h2>Run result</h2>
    <p>${escape(run.periodStart)} → ${escape(run.periodEnd)}</p>
    <div class="hero"><strong>${cur(r.totalPayout)}</strong></div>
    ${r.byStore ? `<h3>By store</h3><table class="ts"><thead><tr><th>Store</th><th>Payout</th></tr></thead><tbody>${byStore}</tbody></table>` : ''}
    ${r.topLevel ? `<p>Top-level lump: ${cur(r.topLevel.payout)}</p>` : ''}
    <h3>By component (first unit)</h3>
    <table class="ts"><thead><tr><th>Leaf</th><th>Payout</th></tr></thead><tbody>${byComponent}</tbody></table>
    <button id="pdf-btn">Download PDF statement</button>
    <pre id="raw" style="margin-top:20px;display:none;">${escape(JSON.stringify(run, null, 2))}</pre>
    <button id="toggle-raw">Show raw JSON</button>`;
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
if (getPw()) {
  document.body.classList.remove('no-auth');
  initApp();
}

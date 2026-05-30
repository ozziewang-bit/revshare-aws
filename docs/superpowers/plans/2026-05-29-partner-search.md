# Partner Search Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a live name-filter search input to the Partners list page.

**Architecture:** Client-side only. After the API call resolves, partners are stored in a closure variable. An `input` event listener filters the array by case-insensitive name substring and calls an inner `renderTable(list)` helper to re-render the table body. No backend changes.

**Tech Stack:** Vanilla CSS, vanilla JS.

---

## File map

| File | What changes |
|---|---|
| `frontend/style.css` | Add `.search-input` class |
| `frontend/app.js` | Refactor `renderPartnersList`: add search `<input>`, extract `renderTable()` inner function, wire `input` listener |
| `frontend/service-worker.js` | Bump `CACHE_VERSION` to `revshare-v15` |

---

## Task 1: Add `.search-input` CSS class

**Files:**
- Modify: `frontend/style.css`

- [ ] **Step 1: Confirm baseline tests pass**

```bash
npm test
```
Expected: `pass 47`.

- [ ] **Step 2: Add `.search-input` after the `.badge-neutral` block in `style.css`**

Find the line `/* ============ HERO (big payout number) ============ */` and insert before it:

```css
/* ============ SEARCH INPUT ============ */
.search-input {
  display: block;
  width: 100%;
  padding: 9px 12px;
  margin-bottom: 16px;
  background: var(--surface);
  color: var(--ink);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  font-size: 13.5px;
  font-family: var(--font-ui);
  transition: border-color .12s, box-shadow .12s;
}

.search-input:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

```

- [ ] **Step 3: Commit**

```bash
git add frontend/style.css
git commit -m "style: add search-input CSS class"
```

---

## Task 2: Refactor `renderPartnersList` with search

**Files:**
- Modify: `frontend/app.js` (`renderPartnersList`, lines 95–128)

- [ ] **Step 1: Replace the full `renderPartnersList` function**

Find the entire `async function renderPartnersList()` block (from `async function renderPartnersList() {` to its closing `}`) and replace it with:

```js
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

    function renderTable(list) {
      const out = document.getElementById('partners-out');
      if (!list.length) {
        const q = document.getElementById('partner-search')?.value;
        out.innerHTML = `<p class="muted">${q ? 'No partners match your search.' : 'No partners yet.'}</p>`;
        return;
      }
      out.innerHTML = `
        <table class="ts">
          <thead><tr><th>Name</th><th>Currency</th><th>Aggregation</th><th>Merchants</th></tr></thead>
          <tbody>${list.map(p => `
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
```

- [ ] **Step 2: Run tests**

```bash
npm test
```
Expected: `pass 47`.

- [ ] **Step 3: Commit**

```bash
git add frontend/app.js
git commit -m "feat: live search filter on partners list"
```

---

## Task 3: Bump cache version and deploy

**Files:**
- Modify: `frontend/service-worker.js` (line 1)

- [ ] **Step 1: Bump `CACHE_VERSION`**

Change line 1 of `frontend/service-worker.js`:

```js
const CACHE_VERSION = 'revshare-v15';
```

- [ ] **Step 2: Run final tests**

```bash
npm test
```
Expected: `pass 47`.

- [ ] **Step 3: Commit**

```bash
git add frontend/service-worker.js
git commit -m "chore: bump cache to v15 for partner search deploy"
```

- [ ] **Step 4: Deploy**

```bash
./infra/deploy-frontend.sh
```

Expected: all files uploaded, `InProgress` invalidation, URL printed.

- [ ] **Step 5: Smoke-check**

Open https://d2t76jfby056ul.cloudfront.net (Cmd+Shift+R to hard-refresh).

Verify:
- Search input appears below the "Partners" heading
- Typing a name filters the table live
- Clearing the input restores all rows
- Typing a string that matches nothing shows "No partners match your search."
- "+ New partner" button still works

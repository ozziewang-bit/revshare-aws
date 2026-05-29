# Partner Search Filter — Design Spec

Date: 2026-05-29

## 1. Goal

Add a live search filter to the Partners list page so finance staff can quickly find a partner by name without scrolling.

## 2. Approach

Client-side filter on the already-loaded partners array. No backend changes. On each `input` event the array is filtered and the table body re-rendered. Instant feedback, zero extra API calls.

## 3. Design

### 3.1 Layout

A full-width search input is placed between the `page-head` (h2 + "+ New partner" button) and the partners table. It occupies its own row, full width, with `margin-bottom: 16px`.

```
┌─────────────────────────────────────────────────┐
│  Partners                      [+ New partner]  │  ← page-head (unchanged)
├─────────────────────────────────────────────────┤
│  🔍 Search partners…                            │  ← new search row
├─────────────────────────────────────────────────┤
│  Name       Currency   Aggregation   Merchants  │  ← table (unchanged)
│  …                                              │
└─────────────────────────────────────────────────┘
```

### 3.2 Behaviour

- Filtering is **live-as-you-type** (`input` event, no submit button).
- Match is **case-insensitive substring** on `partner.name` only.
- When the filtered list is empty: replace the table with `<p class="muted">No partners match your search.</p>`.
- Clearing the input restores all partners.
- The partners array is fetched once on page load and held in a local variable for filtering — no re-fetch on keypress.

### 3.3 CSS

Add a `.search-input` class to `style.css`:

```css
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

### 3.4 JS changes (`renderPartnersList`)

1. After `api('/partners')` and `api('/merchants')` resolve, store `partners` in a local `let filteredPartners = partners` variable.
2. Render the search input as a `<input id="partner-search" class="search-input" placeholder="Search partners…" autocomplete="off">` between the `page-head` div and `#partners-out`.
3. Extract table-rendering into an inner function `renderTable(list)` that writes the `<table>` (or empty-state `<p>`) into `#partners-out`.
4. Call `renderTable(partners)` on initial load.
5. Attach an `input` listener on `#partner-search` that filters by name and calls `renderTable(filtered)`.

## 4. Files changed

| File | What changes |
|---|---|
| `frontend/style.css` | Add `.search-input` class |
| `frontend/app.js` | Refactor `renderPartnersList` to add search input + `renderTable` inner function |
| `frontend/service-worker.js` | Bump `CACHE_VERSION` |

## 5. Out of scope

- No server-side search.
- No filter by currency or aggregation mode.
- No debounce (partners list is small; instant re-render is fine).
- No URL state / deep-link for the search query.

## 6. Success criteria

- Typing in the search box filters the partners table live.
- Match is case-insensitive on partner name.
- Clearing the input shows all partners again.
- When no partners match, "No partners match your search." appears instead of an empty table.
- The `+ New partner` button still works while a search is active.
- All 47 engine/csv tests pass (no logic change).

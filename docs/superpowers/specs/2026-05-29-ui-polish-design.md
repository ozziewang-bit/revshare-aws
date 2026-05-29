# RevShare UI Polish — Design Spec

Date: 2026-05-29

## 1. Goal

A broad visual polish pass on the RevShare SPA. No behaviour changes, no new features. Pure CSS-only refactor plus minimal HTML markup changes in two places (`renderNav` and `renderPartnerDetail`).

## 2. Chosen direction

**Clean & Elevated** — an evolution of the existing palette. White cards on light grey, pill navigation, underline in-page tabs, sharper shadows. Comparable to Linear or Vercel's admin UI.

## 3. Changes

### 3.1 Topbar

- Height: 60 px → 56 px.
- Add `box-shadow: 0 1px 4px rgba(15,23,42,.06)` to `.topbar`. Removes the heavy feeling of a bare border; gives the bar depth.
- No layout changes.

### 3.2 Navigation — pill / segmented control

**CSS** — replace `.nav-btn` / `.nav-btn.active` with a pill-track pattern:

```
.topnav (the <nav> element)
  background: var(--bg)
  border: 1px solid var(--border)
  border-radius: 9px
  padding: 3px
  display: flex; gap: 2px

.nav-btn
  padding: 5px 16px
  border-radius: 7px
  font-size: 12.5px; font-weight: 500
  color: var(--ink-soft)
  background: transparent; border: none

.nav-btn.active
  background: var(--surface)
  color: var(--ink); font-weight: 600
  box-shadow: 0 1px 3px rgba(15,23,42,.10), 0 0 0 1px rgba(15,23,42,.06)
```

**JS** — no change. `renderNav()` already sets `.active` via `setActiveNav()`. The existing class toggling works with the new CSS unchanged.

### 3.3 In-page tabs (partner detail)

Replace the current `.tab` pill style with an underline pattern:

```
.tabs
  display: flex; gap: 0
  border-bottom: 1px solid var(--border)
  margin-bottom: 22px  (was 16px)

.tab
  padding: 9px 16px
  font-size: 13px; font-weight: 500
  color: var(--ink-soft)
  background: none; border: none
  border-bottom: 2px solid transparent
  margin-bottom: -1px   ← overlaps the .tabs border

.tab.active
  color: var(--ink); font-weight: 600
  border-bottom-color: var(--ink)
```

No JS change. The existing tab click handler already toggles `.active`.

### 3.4 Table polish

- `.ts thead th` colour: `var(--ink-soft)` → `var(--ink-faint)`. Lighter headers let data rows dominate.
- Add `box-shadow: 0 1px 3px rgba(15,23,42,.05)` to `.ts` (currently only `var(--shadow-sm)` which is `0 1px 2px`). Very subtle lift.
- No layout or padding changes.

### 3.5 Currency and model badges

Add a `.badge-neutral` utility class:

```css
.badge {
  display: inline-flex; align-items: center;
  padding: 2px 9px; border-radius: 99px;
  font-size: 11.5px; font-weight: 500;
}
.badge-neutral {
  background: var(--surface-muted);
  color: var(--ink-soft);
  border: 1px solid var(--border);
}
```

**JS changes:**
- Partners list: wrap currency cell value in `<span class="badge badge-neutral">`.
- Merchants tab: wrap machine model cell value in `<span class="badge badge-neutral">` (only when model is non-null; keep `—` as plain text).

### 3.6 Restore "+ New run" button

The last commit removed the `+ New run` button from `renderPartnerDetail`. It must be restored to the `page-head` next to the partner name. This is the natural entry point for a single-partner calculation run.

```html
<div class="page-head">
  <div>
    <button id="back" class="btn-ghost">← Partners</button>
    <h2>${escape(p.name)}</h2>
  </div>
  <button id="new-run" class="btn-primary">+ New run</button>
</div>
```

Wire the click handler back:
```js
document.getElementById('new-run').addEventListener('click', () => renderNewRunForm(partnerId, p));
```

## 4. Files changed

| File | What changes |
|---|---|
| `frontend/style.css` | Topbar shadow + height, `.topnav` pill track, `.nav-btn` pill item, `.tab` underline, `.ts` shadow + header colour, `.badge` + `.badge-neutral` |
| `frontend/app.js` | Currency badge in `renderPartnersList`, model badge in `renderMerchantsTab`, restore `+ New run` button + handler in `renderPartnerDetail` |
| `frontend/service-worker.js` | Bump `CACHE_VERSION` |

## 5. Out of scope

- No changes to forms, the rule editor, bulk-run screens, or import screen.
- No new fonts, colour tokens, or layout shifts.
- No backend changes.

## 6. Success criteria

- Pill nav is visible and active-state works on all three nav items.
- In-page tabs show the underline on the active tab; no visual gap or overlap at the border.
- Currency and model values in tables render as small neutral badges.
- `+ New run` button appears on the partner detail header and navigates to the new-run form.
- Service worker cache version is bumped so existing users pick up the change on next reload.
- All 47 engine/csv tests still pass (no JS logic changed).

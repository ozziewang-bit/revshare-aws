# Device Types Management — Design Spec

Date: 2026-05-29

## 1. Goal

Store machine model definitions (code + display name) in DynamoDB so finance staff can manage the list via a UI page without a code deploy. All model dropdowns in the app show the configured display names instead of bare codes.

## 2. Data model

Single-table `RevsharePartner`, new row family:

| pk | sk | Fields |
|---|---|---|
| `CONFIG` | `MODEL#<code>` | `code` (string), `displayName` (string) |

- `code` — the short identifier used everywhere in the system (e.g. `S5`, `M10`). Immutable after creation.
- `displayName` — the human-readable label shown in dropdowns (e.g. `Advertising Player-S5`). Editable.
- No soft-delete / active flag — delete is hard delete.

### 2.1 Auto-seed

On `GET /machine-models`, if the query returns zero rows, the handler seeds one row per code in the hardcoded `MACHINE_MODELS` set (`S5 S8 S10 T8 T10 T20 T35 L20 L40 M10`) with `displayName = code`. Finance staff then edit display names via the management page.

## 3. Backend

### 3.1 New route file: `lambda/revshare-api/code/routes/machine-models.mjs`

```
GET  /machine-models          — list all, sorted by code; auto-seeds if empty
POST /machine-models          — create { code, displayName }; 409 if code exists
PUT  /machine-models/:code    — update { displayName } only
DELETE /machine-models/:code  — hard delete
```

### 3.2 New DDB helpers in `lambda/revshare-api/code/db.mjs`

```js
listMachineModels()               → [{ code, displayName }, ...]  sorted by code
putMachineModel({ code, displayName })
deleteMachineModel(code)
getMachineModel(code)             → { code, displayName } | null
```

DDB key pattern:
- `pk = 'CONFIG'`
- `sk = 'MODEL#' + code`

### 3.3 Engine update: `lambda/revshare-api/code/engine.mjs`

`evaluateRun` gains an optional `allowedModels` param:

```js
export function evaluateRun({ rule, rows, aggregationMode, allowedModels }) {
  const models = allowedModels instanceof Set ? allowedModels : MACHINE_MODELS;
  // ... use `models` wherever MACHINE_MODELS was used for validation
}
```

The runs route (`routes/runs.mjs`) and bulk-runs route (`routes/bulk-runs.mjs`) fetch the DDB model list, build a `Set` of codes, and pass it as `allowedModels` to `evaluateRun`.

### 3.4 Wire route in `lambda/revshare-api/code/index.mjs`

Import and register the new machine-models route alongside the existing ones.

## 4. Frontend

### 4.1 Nav — 4th item

```
Partners | Share Calculation | Device Types | Import
```

`renderNav()` gains a 4th button `id="nav-device-types"` with label `Device Types`.

### 4.2 Device Types page (`renderDeviceTypesScreen()`)

```
┌─────────────────────────────────────────────────┐
│  Device Types                  [+ Add device]   │
├─────────────────────────────────────────────────┤
│  Display Name            Code       Action       │
│  Advertising Player-S5   S5     [Edit] [Delete]  │
│  ChargeSpot Station-S8   S8     [Edit] [Delete]  │
│  …                                               │
└─────────────────────────────────────────────────┘
```

- Loads `GET /machine-models` on render.
- **Add:** inline form below header — two inputs (`Display name`, `Code`) + Save button. On save: `POST /machine-models`, refresh list.
- **Edit:** clicking Edit swaps the row into an inline edit state for display name only. Code shown read-only. Save calls `PUT /machine-models/:code`, collapses row.
- **Delete:** `confirm()` dialog, then `DELETE /machine-models/:code`, refresh list.
- Empty state: "No device types yet." (won't normally show — auto-seed covers it.)

### 4.3 Dropdown updates

`renderMerchantsTab` fetches `GET /machine-models` in parallel with `GET /merchants`:

```js
const [all, machineModels] = await Promise.all([api('/merchants'), api('/machine-models')]);
```

`machineModels` (array of `{ code, displayName }`) is passed to:
- `showMerchantForm(partnerId, existing, machineModels, onDone)`
- `showBatchRowsPanel(partnerId, machineModels, onDone)`
- `showBatchCsvPanel(partnerId, machineModels, onDone)`

Each function signature changes from `MODELS` (string array) to `machineModels` (object array). Dropdowns render:
```js
machineModels.map(m => `<option value="${m.code}" ${sel===m.code?'selected':''}>${escape(m.displayName)}</option>`)
```

`parseMerchantCsv(text, validCodes)` — `validCodes` is a `Set` of codes built from the fetched list:
```js
const validCodes = new Set(machineModels.map(m => m.code));
```

## 5. Files changed

| File | What changes |
|---|---|
| `lambda/revshare-api/code/db.mjs` | Add `listMachineModels`, `putMachineModel`, `deleteMachineModel`, `getMachineModel` |
| `lambda/revshare-api/code/engine.mjs` | Add optional `allowedModels` param to `evaluateRun` |
| `lambda/revshare-api/code/routes/machine-models.mjs` | New file — all 4 CRUD handlers |
| `lambda/revshare-api/code/index.mjs` | Register machine-models route |
| `lambda/revshare-api/code/routes/runs.mjs` | Fetch models from DDB, pass `allowedModels` to `evaluateRun` |
| `lambda/revshare-api/code/routes/bulk-runs.mjs` | Same |
| `frontend/app.js` | `renderNav` (4th item), `renderDeviceTypesScreen`, `renderMerchantsTab` (parallel fetch), update `showMerchantForm` / `showBatchRowsPanel` / `showBatchCsvPanel` / `parseMerchantCsv` signatures |
| `frontend/service-worker.js` | Bump `CACHE_VERSION` |

## 6. Out of scope

- No ordering / sort-order field (sorted by code alphabetically).
- No active/inactive toggle — delete is the only way to remove a model.
- No per-partner model restrictions.
- No bulk-import of device types.

## 7. Success criteria

- `GET /machine-models` on a fresh deploy returns 10 seeded rows (one per code in `MACHINE_MODELS`).
- Adding a device type via the UI persists to DDB and appears in all dropdowns on next open.
- Editing a display name updates the dropdown label everywhere.
- Deleting a model removes it from DDB and from dropdowns.
- The runs route and bulk-runs route pass `allowedModels` from DDB to `evaluateRun`; a run with an unknown model code (not in DDB) returns an error.
- All 47 engine/csv tests pass.

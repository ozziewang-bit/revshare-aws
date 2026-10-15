// One rule only: every name used must be defined. A name that exists in another function's
// scope passes every source-text test and still throws the moment that code runs — 2026-10-14,
// Mailing → Preview read the Send dialog's `statementCc` and opened as an empty white strip.
// Runs in `npm test` (tests/no-undef.test.mjs) and before every frontend deploy.
import globals from 'globals';

export default [
  { files: ['frontend/app.js'], languageOptions: { ecmaVersion: 2022, sourceType: 'script',
      // Loaded by index.html's <script> tags before app.js.
      globals: { ...globals.browser, XLSX: 'readonly', jspdf: 'readonly', html2canvas: 'readonly',
        SimpleZip: 'readonly', google: 'readonly' } },
    rules: { 'no-undef': 'error' } },
  { files: ['frontend/service-worker.js'], languageOptions: { ecmaVersion: 2022, sourceType: 'script',
      globals: globals.serviceworker },
    rules: { 'no-undef': 'error' } },
  { files: ['lambda/revshare-api/code/**/*.mjs'], languageOptions: { ecmaVersion: 2022, sourceType: 'module',
      globals: globals.node },
    rules: { 'no-undef': 'error' } },
];

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ESLint } from 'eslint';

// Every name used must be defined (eslint.config.js). A name that lives in ANOTHER function's
// scope passes every test that reads source text and still throws the moment the code runs:
// 2026-10-14, Mailing → Preview read the Send dialog's `statementCc` and opened an empty white
// strip; the same sweep found routes/import.mjs calling a `compileRule` it only re-exported.
test('no undefined names in the frontend, the service worker or the Lambda code', async () => {
  const root = new URL('../../../', import.meta.url).pathname;
  const eslint = new ESLint({ cwd: root });
  const results = await eslint.lintFiles(['frontend/app.js', 'frontend/service-worker.js', 'lambda/revshare-api/code/**/*.mjs']);
  const errors = results.flatMap((r) => r.messages.map((m) => `${r.filePath.replace(root, '')}:${m.line} ${m.message}`));
  assert.ok(results.length > 10, 'the lint must actually have read the files');
  assert.deepEqual(errors, []);
});

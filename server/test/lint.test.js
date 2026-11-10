import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// eslint.config.js: names that aren't defined, unreachable code, duplicate keys… none allowed.
test('lint: no undefined names, unreachable code or duplicate keys', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const results = await new ESLint({ cwd: root }).lintFiles(['src', 'test']);
  assert.deepEqual(results.flatMap((r) => r.messages.map((m) => `${path.relative(root, r.filePath)}:${m.line} ${m.ruleId}: ${m.message}`)), []);
});

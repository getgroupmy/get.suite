import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// The lint rules in eslint.config.js find real bugs (a hook after an early return breaks the page as
// soon as the data arrives): none allowed.
test('lint: no hooks out of order, undefined names, unreachable code or duplicate keys', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const eslint = new ESLint({ cwd: root });
  const results = await eslint.lintFiles(['src']);
  const problems = results.flatMap((r) => r.messages.map((m) => `${path.relative(root, r.filePath)}:${m.line} ${m.ruleId}: ${m.message}`));
  assert.deepEqual(problems, []);
});

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

// "Today" is where the person is: new Date().toISOString() is the date in UTC, still yesterday in the morning east of
// it (Kuala Lumpur before 8am) and already tomorrow in the evening west of it. Use localToday() (tasks/taskmath.js).
test('no "today" taken from UTC', async () => {
  const fs = await import('node:fs');
  const root = path.dirname(fileURLToPath(import.meta.url));
  const found = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.jsx?$/.test(e.name) && !/\.test\.js$/.test(e.name)) {
        fs.readFileSync(p, 'utf8').split('\n').forEach((l, i) => { if (/new Date\(\)\.toISOString\(\)\.slice\(0, (10|16)\)/.test(l)) found.push(`${path.relative(root, p)}:${i + 1}`); });
      }
    }
  };
  walk(root);
  assert.deepEqual(found, []);
});

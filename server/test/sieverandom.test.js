// Random filter rules (every condition and action; values with " \\ * ? ${…} ; line breaks, tabs, emoji and other scripts;
// folders with those in their names) and out-of-office replies (subject, text and the sender's name the same way), each
// user's script compiled by Dovecot's own sievec. The test found a name with ; \\ or " in it (a display name such as
// "Lee; Ann") making the reply's From address invalid, so Dovecot refused the whole script and every filter stopped
// working, not only the reply: the name is quoted now.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { userSieve, normalizeRules, fromHeader } from '../src/mail/sieve.js';

let sievec = null;
try { sievec = execFileSync('sh', ['-c', 'command -v sievec'], { encoding: 'utf8' }).trim() || null; } catch { /* not installed */ }

test('150 random users\' filters and out-of-office replies: every script compiles in Dovecot', { skip: !sievec && 'sievec (Dovecot Pigeonhole) isn’t installed here' }, () => {
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const V = ['invoice', 'a"quote', 'back\\slash', 'star*', 'q?mark', '${var}', 'Ünïcödé', '中文', '😀', 'line\nbreak', 'semi;colon', 'x'.repeat(150), '"', '\\', 'trail\\', 'percent%', '#hash', 'tab\there', '  spaces  ', 'text:\r\n.\r\n'];
  const FOLDERS = ['Receipts', 'Work/2026', 'Ünïcödé', 'a"b', 'back\\slash', 'with space', '中文', 'semi;colon', 'INBOX', 'Trash'];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sieverandom-'));
  const wrong = [];
  let compiled = 0;
  try {
    for (let k = 0; k < 150; k++) {
      const rules = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => ({ name: pick(V), match: pick(['all', 'any']),
        conditions: Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => {
          const f = pick(['from', 'to', 'subject', 'body', 'list', 'filename', 'size', 'attachment', 'importance']);
          if (f === 'size') return { field: f, op: pick(['over', 'under']), value: pick(['5 MB', '300kb', '1.5M']) };
          if (f === 'attachment') return { field: f, op: pick(['has', 'has_not']) };
          if (f === 'importance') return { field: f, op: pick(['high', 'not_high']) };
          return { field: f, op: pick(['contains', 'not_contains', ...(['from', 'to', 'subject'].includes(f) ? ['is'] : [])]), value: pick(V) };
        }),
        actions: { moveTo: rnd() < 0.6 ? pick(FOLDERS) : null, markRead: rnd() < 0.3, star: true, forwardTo: rnd() < 0.2 ? 'boss@ex.example' : null, stop: rnd() < 0.3 } })); // (a rule needs an action: always a star)
      const vacation = rnd() < 0.5 ? { enabled: true, subject: pick(V), body: pick(V), name: pick(V), start_date: null, end_date: null, addresses: ['u@ex.example'] } : null;
      const script = userSieve({ username: 'u@ex.example', rules: normalizeRules(rules), vacation, muted: [], blocked: rnd() < 0.3 ? ['spam.example'] : [] });
      const file = path.join(dir, `s${k}.sieve`);
      fs.writeFileSync(file, script);
      try { execFileSync(sievec, [file, path.join(dir, `s${k}.svbin`)], { stdio: 'pipe' }); compiled++; }
      catch (e) { wrong.push(`#${k}: ${String(e.stderr || e.stdout).split('\n')[0]}`); }
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.deepEqual(wrong, []);
  assert.equal(compiled, 150);
});

test('the out-of-office reply\'s sender: a name with ; \\ " . or the like in quotes, a plain one as it is', () => {
  assert.equal(fromHeader('Ada Lovelace', 'u@ex.example'), 'Ada Lovelace <u@ex.example>');
  assert.equal(fromHeader('Lee; Ann', 'u@ex.example'), '"Lee; Ann" <u@ex.example>');
  assert.equal(fromHeader('back\\slash "q"', 'u@ex.example'), '"back\\\\slash \\"q\\"" <u@ex.example>');
  assert.equal(fromHeader('Dr. Kim', 'u@ex.example'), '"Dr. Kim" <u@ex.example>');
  assert.equal(fromHeader('中文 名', 'u@ex.example'), '中文 名 <u@ex.example>');
  assert.equal(fromHeader('', 'u@ex.example'), 'u@ex.example');
  assert.equal(fromHeader(' two\nlines ', 'u@ex.example'), 'two lines <u@ex.example>');
});

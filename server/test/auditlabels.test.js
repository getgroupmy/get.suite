// Every action the server records in the activity log has words for it: no raw "passkey.added"
// in Admin → Activity, and every kind can be filtered on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ACTIONS } from '../src/audit.js';

const SRC = new URL('../src', import.meta.url).pathname;
const files = (dir) => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? files(p) : p.endsWith('.js') ? [p] : []; });

// The second argument of each audit(...) call: literals, both sides of a ternary, and templates.
function recorded() {
  const out = { literal: new Set(), templates: new Set() };
  for (const f of files(SRC)) {
    const s = readFileSync(f, 'utf8');
    for (const m of s.matchAll(/\baudit\(\s*[^,()]+,\s*((?:[^,'`{]|'[^']*'|`[^`]*`)+?)\s*(?:,\s*\{|\))/g)) {
      for (const x of m[1].replace(/[!=]==\s*'[^']*'/g, '').matchAll(/'([^']+)'/g)) out.literal.add(x[1]); // not the ones compared against
      for (const x of m[1].matchAll(/`([^`]+)`/g)) out.templates.add(x[1]);
    }
  }
  return out;
}

test('every recorded action has a label', () => {
  const { literal } = recorded();
  assert.ok(literal.size > 80, `found only ${literal.size}`); // the scan is still finding them
  for (const want of ['passkey.added', 'mail.phishing', 'dlp.blocked', 'recovery.set', 'user.hold']) assert.ok(literal.has(want), want);
  const missing = [...literal].filter((a) => !ACTIONS[a]);
  assert.deepEqual(missing, [], `no words for: ${missing.join(', ')}`);
});

test('templated actions: every value they can take has a label', () => {
  const { templates } = recorded();
  const expand = {
    'user.bulk.${action}': ['suspend', 'restore', 'signout', 'department'].map((a) => `user.bulk.${a}`),
    'calendar.${what}_shared': ['added', 'changed', 'deleted'].map((w) => `calendar.${w}_shared`),
    'calendar.${what}_for': ['added', 'changed', 'deleted'].map((w) => `calendar.${w}_for`),
  };
  assert.deepEqual([...templates].sort(), Object.keys(expand).sort(), 'a new templated action: add its values here');
  for (const a of Object.values(expand).flat()) assert.ok(ACTIONS[a], a);
  // The bulk route's own list matches.
  const users = readFileSync(join(SRC, 'routes/users.js'), 'utf8');
  assert.match(users, /\['suspend', 'restore', 'signout', 'department'\]\.includes\(action\)/);
});

test('labels are words, not codes', () => {
  for (const [k, v] of Object.entries(ACTIONS)) {
    assert.ok(v && v !== k && /^[A-Z]/.test(v), `${k}: ${v}`);
    assert.doesNotMatch(v, /[a-z]+\.[a-z_]+/, `${k} label looks like a code`);
  }
});

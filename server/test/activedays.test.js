import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-activedays-')); // a database of its own
const { q } = await import('../src/db.js');
const { markActive, activePerDay, dayOf } = await import('../src/activedays.js');

test('active people per day: each person once a day, every day listed, only the company', () => {
  const t0 = Date.parse('2026-03-10T12:00:00Z');
  for (const [id, org] of [['ado1', 'adorg'], ['ado2', 'adorg'], ['adx', 'adother']]) {
    q('INSERT OR IGNORE INTO orgs (id, name, created_at) VALUES (?, ?, ?)').run(org, org, t0);
    q('INSERT OR IGNORE INTO users (id, org_id, username, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, org, `${id}@${org}.test`, id, 'x', t0);
  }
  markActive('ado1', t0); markActive('ado1', t0 + 3600e3); // twice the same day: once
  markActive('ado2', t0);
  markActive('ado2', t0 + 2 * 864e5);
  markActive('adx', t0);
  const { days, since } = activePerDay('adorg', t0 - 864e5, t0 + 3 * 864e5);
  assert.deepEqual(days, [
    { day: '2026-03-09', active: 0 }, { day: '2026-03-10', active: 2 }, { day: '2026-03-11', active: 0 },
    { day: '2026-03-12', active: 1 }, { day: '2026-03-13', active: 0 },
  ]);
  assert.equal(since, '2026-03-10');
  assert.equal(dayOf(Date.parse('2026-03-10T23:59:59Z')), '2026-03-10', 'UTC days');
});

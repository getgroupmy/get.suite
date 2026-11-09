import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { requestRestore, applyPendingRestore } from '../src/restore.js';

const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-restore-')); fs.mkdirSync(path.join(d, 'backups')); return d; };
const make = (file, value) => { const d = new DatabaseSync(file); d.exec('PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS t (v TEXT); DELETE FROM t;'); d.prepare('INSERT INTO t VALUES (?)').run(value); return d; };
const read = (file) => { const d = new DatabaseSync(file); const v = d.prepare('SELECT v FROM t').get().v; d.close(); return v; };

test('restore: the asked-for snapshot goes in place; the database as it was is kept', () => {
  const dir = tmp();
  make(path.join(dir, 'backups', 'workspace-2026-11-01.db'), 'from the snapshot').close();
  const live = make(path.join(dir, 'workspace.db'), 'as it was');
  assert.equal(applyPendingRestore(dir), null, 'nothing asked');
  assert.throws(() => requestRestore(dir, 'workspace-2026-10-01.db', { name: 'Olivia' }), /No such snapshot/);
  assert.throws(() => requestRestore(dir, '../workspace.db', { name: 'Olivia' }), /No such snapshot/);
  requestRestore(dir, 'workspace-2026-11-01.db', { name: 'Olivia' });
  live.close();
  const logs = [];
  const done = applyPendingRestore(dir, { now: new Date('2026-11-09T01:02:03Z'), log: (m) => logs.push(m) });
  assert.equal(done.kept, 'workspace-2026-11-09-before-restore-010203.db');
  assert.equal(done.by.name, 'Olivia');
  assert.equal(read(path.join(dir, 'workspace.db')), 'from the snapshot');
  assert.equal(read(path.join(dir, 'backups', done.kept)), 'as it was');
  assert.ok(!fs.existsSync(path.join(dir, 'restore-pending.json')), 'done once');
  assert.equal(applyPendingRestore(dir), null);
  assert.match(logs[0], /Restored the database from workspace-2026-11-01\.db/);
});

test('restore: a note naming a snapshot that is gone is dropped, and the database is left alone', () => {
  const dir = tmp();
  make(path.join(dir, 'workspace.db'), 'keep me').close();
  fs.writeFileSync(path.join(dir, 'restore-pending.json'), JSON.stringify({ name: 'workspace-2026-01-01.db' }));
  const logs = [];
  assert.equal(applyPendingRestore(dir, { log: (m) => logs.push(m) }), null);
  assert.equal(read(path.join(dir, 'workspace.db')), 'keep me');
  assert.match(logs[0], /not found/);
});

test('restore: opening the app’s database applies it first', () => {
  const dir = tmp();
  // A snapshot of a real app database, with a person in it.
  execFileSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', `
    const { q, db } = await import('./src/db.js');
    q("INSERT INTO orgs (id, name, created_at) VALUES ('o1', 'Snap Co', 0)").run();
    db.prepare('VACUUM INTO ?').run(${JSON.stringify(path.join(dir, 'backups', 'workspace-2026-11-02.db'))});
    q("INSERT INTO orgs (id, name, created_at) VALUES ('o2', 'Later Co', 0)").run();`], { env: { ...process.env, DATA_DIR: dir }, cwd: path.resolve('.') });
  requestRestore(dir, 'workspace-2026-11-02.db', { name: 'Olivia' });
  const out = execFileSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', `
    const { q, restored } = await import('./src/db.js');
    console.log(JSON.stringify({ orgs: q('SELECT name FROM orgs ORDER BY name').all().map((o) => o.name), kept: restored?.kept }));`], { env: { ...process.env, DATA_DIR: dir }, cwd: path.resolve('.'), encoding: 'utf8' });
  const r = JSON.parse(out.trim().split('\n').pop());
  assert.deepEqual(r.orgs, ['Snap Co']);
  assert.match(r.kept, /^workspace-\d{4}-\d{2}-\d{2}-before-restore-\d{6}\.db$/);
});

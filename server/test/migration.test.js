// Upgrading a v0.1 (single-company) database must keep every user working.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

test('v0.1 database is migrated into a default company', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-mig-'));
  const old = new DatabaseSync(path.join(dir, 'workspace.db'));
  old.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL, email TEXT,
      password_hash TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0, disabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE TABLE channels (id TEXT PRIMARY KEY, name TEXT NOT NULL, dm_key TEXT UNIQUE, created_by TEXT, created_at INTEGER NOT NULL);
    INSERT INTO users VALUES ('u1', 'alice', 'Alice', NULL, 'x', 1, 0, 1), ('u2', 'bob', 'Bob', NULL, 'x', 0, 0, 2);
    INSERT INTO channels VALUES ('c1', 'general', NULL, 'u1', 1);
  `);
  old.close();

  process.env.DATA_DIR = dir;
  const { db } = await import('../src/db.js');
  const users = db.prepare('SELECT username, is_super, org_id FROM users ORDER BY created_at').all();
  assert.deepEqual(users.map((u) => u.username), ['alice@workspace.local', 'bob@workspace.local']);
  assert.equal(users[0].is_super, 1);
  assert.equal(users[1].is_super, 0);
  assert.ok(users[0].org_id && users[0].org_id === users[1].org_id);
  assert.equal(db.prepare('SELECT org_id FROM channels WHERE id = ?').get('c1').org_id, users[0].org_id);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

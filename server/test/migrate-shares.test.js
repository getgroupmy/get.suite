// Upgrading a database from before commenters: the shares table's CHECK is widened, rows kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

test('shares from before commenters keep every row and column, and take commenters', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-mig-sh-'));
  const old = new DatabaseSync(path.join(dir, 'workspace.db'));
  old.exec(`
    CREATE TABLE shares (
      file_id TEXT NOT NULL, user_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('viewer','editor')),
      PRIMARY KEY (file_id, user_id));
    ALTER TABLE shares ADD COLUMN direct_role TEXT;
    ALTER TABLE shares ADD COLUMN expires_at INTEGER;
    CREATE INDEX shares_user ON shares(user_id);
    INSERT INTO shares VALUES ('f1', 'u1', 'editor', 'editor', 123), ('f1', 'u2', 'viewer', NULL, NULL);
  `);
  old.close();
  process.env.DATA_DIR = dir;
  const { db } = await import('../src/db.js');
  assert.deepEqual(db.prepare('SELECT file_id, user_id, role, direct_role, expires_at FROM shares ORDER BY user_id').all().map((r) => ({ ...r })),
    [{ file_id: 'f1', user_id: 'u1', role: 'editor', direct_role: 'editor', expires_at: 123 }, { file_id: 'f1', user_id: 'u2', role: 'viewer', direct_role: null, expires_at: null }]);
  db.exec('PRAGMA foreign_keys = OFF');
  db.prepare("INSERT INTO shares (file_id, user_id, role) VALUES ('f1', 'u3', 'commenter')").run();
  assert.throws(() => db.prepare("INSERT INTO shares (file_id, user_id, role) VALUES ('f1', 'u4', 'boss')").run());
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'shares_user'").get(), 'index kept');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

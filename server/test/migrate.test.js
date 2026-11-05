import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const run = (dir, code) => execFileSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', code], { env: { ...process.env, DATA_DIR: dir }, cwd: path.resolve('.') }).toString();

test('a database from before Slides is upgraded in place, keeping files and their links', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-mig-'));
  try {
    run(dir, "await import('./src/db.js');"); // today's schema
    // Put the files table back the way older versions made it, with data that points at it.
    const db = new DatabaseSync(path.join(dir, 'workspace.db'));
    db.exec(`PRAGMA foreign_keys = OFF;
      INSERT INTO orgs (id, name, created_at) VALUES ('o', 'Acme', 0);
      INSERT INTO users (id, org_id, username, name, email, password_hash, created_at) VALUES ('u', 'o', 'a@acme.com', 'A', 'a@acme.com', 'x', 0), ('v', 'o', 'b@acme.com', 'B', 'b@acme.com', 'x', 0);
      DROP TABLE files;
      CREATE TABLE files (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, parent_id TEXT REFERENCES files(id) ON DELETE CASCADE,
        name TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('folder','file','doc','sheet')), mime TEXT, size INTEGER NOT NULL DEFAULT 0, storage TEXT, content TEXT,
        version INTEGER NOT NULL DEFAULT 1, trashed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT);
      INSERT INTO files (id, owner_id, parent_id, name, kind, created_at, updated_at) VALUES ('f', 'u', NULL, 'Folder', 'folder', 1, 1), ('d', 'u', 'f', 'Plan', 'doc', 2, 2);
      INSERT INTO shares (file_id, user_id, role) VALUES ('d', 'v', 'viewer');`);
    db.close();

    const out = run(dir, `const { db } = await import('./src/db.js');
      const rows = db.prepare('SELECT id, parent_id, kind FROM files ORDER BY id').all();
      const problems = db.prepare('PRAGMA foreign_key_check').all();
      db.prepare("INSERT INTO files (id, owner_id, name, kind, created_at, updated_at) VALUES ('s', 'u', 'Deck', 'slides', 3, 3)").run();
      db.prepare("DELETE FROM files WHERE id = 'f'").run(); // cascades still work after the rebuild
      const left = db.prepare('SELECT COUNT(*) AS n FROM shares').get().n;
      console.log(JSON.stringify({ rows, problems, left }));`);
    const r = JSON.parse(out.trim().split('\n').pop());
    assert.deepEqual(r.rows.map((x) => [x.id, x.parent_id, x.kind]), [['d', 'f', 'doc'], ['f', null, 'folder']]);
    assert.deepEqual(r.problems, []);
    assert.equal(r.left, 0, 'deleting the folder removed the doc and its share');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

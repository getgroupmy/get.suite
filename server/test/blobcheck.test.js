import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-blobs-'));
const { q, db, FILES_DIR } = await import('../src/db.js');
await import('../src/app.js'); // every table
const { checkBlobs, removeUnused } = await import('../src/blobcheck.js');
const { BACKUP_DIR } = await import('../src/backup.js');

const old = Date.now() / 1000 - 2 * 3600;
const blob = (name, body, aged = true) => { const f = path.join(FILES_DIR, name); fs.writeFileSync(f, body); if (aged) fs.utimesSync(f, old, old); };

test('uploaded files: unused ones (not in the database or any snapshot) are found and removed; missing ones are listed', () => {
  q("INSERT INTO orgs (id, name, created_at) VALUES ('bo', 'Blob Co', 0)").run();
  q("INSERT INTO users (id, org_id, username, name, password_hash, created_at) VALUES ('bu', 'bo', 'b@blob.test', 'Bea Blob', 'x', 0)").run();
  const file = (id, name, storage) => q("INSERT INTO files (id, owner_id, name, kind, size, storage, created_at, updated_at) VALUES (?, 'bu', ?, 'file', 1, ?, 0, 0)").run(id, name, storage);
  file('f1', 'Kept.pdf', 'blob-live'); blob('blob-live', 'live');
  file('f2', 'Lost.pdf', 'blob-gone'); // listed, not on disk
  // Only an older snapshot knows this one: kept, so restoring it still works.
  file('f3', 'Old.pdf', 'blob-snap'); blob('blob-snap', 'snap');
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  db.prepare('VACUUM INTO ?').run(path.join(BACKUP_DIR, 'workspace-2026-11-01.db'));
  q("DELETE FROM files WHERE id = 'f3'").run();
  blob('blob-orphan', 'twelve bytes'); // nothing knows it
  blob('blob-fresh', 'uploading', false); // an upload finishing right now
  const c = checkBlobs();
  assert.equal(c.files, 4);
  assert.deepEqual([c.unused.count, c.unused.bytes, c.unused.names], [1, 12, ['blob-orphan']]);
  assert.equal(c.kept_for_snapshots, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(c.missing)), { count: 1, list: [{ id: 'f2', name: 'Lost.pdf', owner: 'Bea Blob' }] });
  assert.deepEqual(removeUnused(), { count: 1, bytes: 12 });
  assert.deepEqual(fs.readdirSync(FILES_DIR).sort(), ['blob-fresh', 'blob-live', 'blob-snap']);
  assert.equal(checkBlobs().unused.count, 0);
});

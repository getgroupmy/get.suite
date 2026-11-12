// What happened to each file or folder in Drive, for its Details: who made it, edited it (one entry
// per person per hour of editing), renamed, moved, shared, trashed or restored it, or brought back
// an earlier version. Newest first; the latest 200 are kept per file.
import { q } from './db.js';
import { changedBy } from './filewatch.js';

q(`CREATE TABLE IF NOT EXISTS file_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,      -- create | copy | upload | edit | rename | move | trash | restore | share | version
  details TEXT,              -- JSON: { from, to, name, added, removed, … }
  at INTEGER NOT NULL
)`).run();
q('CREATE INDEX IF NOT EXISTS file_activity_file ON file_activity(file_id, id)').run();

const EDIT_RUN_MS = 60 * 60e3;
const KEEP = 200;

/** Note something that happened to a file. Edits by the same person within an hour are one entry. */
export function recordActivity(fileId, userId, action, details = null, at = Date.now()) {
  if (!fileId) return;
  if (action === 'edit' || action === 'version') changedBy(fileId, userId, at);
  else if (action === 'create' || action === 'upload' || action === 'copy' || action === 'request') changedBy(fileId, userId, at, { added: true });
  if (action === 'edit') {
    const last = q('SELECT id, user_id, action, at FROM file_activity WHERE file_id = ? ORDER BY id DESC LIMIT 1').get(fileId);
    if (last && last.action === 'edit' && last.user_id === userId && at - last.at < EDIT_RUN_MS) {
      q('UPDATE file_activity SET at = ? WHERE id = ?').run(at, last.id);
      return;
    }
  }
  q('INSERT INTO file_activity (file_id, user_id, action, details, at) VALUES (?, ?, ?, ?, ?)').run(fileId, userId ?? null, action, details ? JSON.stringify(details) : null, at);
  q(`DELETE FROM file_activity WHERE file_id = ? AND id NOT IN (SELECT id FROM file_activity WHERE file_id = ? ORDER BY id DESC LIMIT ${KEEP})`).run(fileId, fileId);
}

/** A file's activity, newest first: [{ action, at, user_name, details }]. */
/**
 * What happened in a folder: its own activity and that of everything inside it (at any depth, the trash
 * included), newest first, each saying which item it was about when it isn't the folder itself.
 */
export function folderActivityOf(folderId, ids, limit = 100, before = null) {
  return q(`SELECT a.id, a.action, a.at, a.details, a.file_id, f.name AS file_name, f.kind AS file_kind, u.name AS user_name
            FROM file_activity a JOIN files f ON f.id = a.file_id LEFT JOIN users u ON u.id = a.user_id
            WHERE a.file_id IN (SELECT value FROM json_each(?)) AND a.id < ? ORDER BY a.id DESC LIMIT ?`).all(JSON.stringify(ids), before ?? Number.MAX_SAFE_INTEGER, limit)
    .map(({ file_id: id, file_name: name, file_kind: kind, ...a }) => ({ ...a, details: a.details ? JSON.parse(a.details) : null,
      ...(id !== folderId && { file: { id, name, kind } }) }));
}

export function activityOf(fileId, limit = 100, before = null) {
  return q(`SELECT a.id, a.action, a.at, a.details, u.name AS user_name FROM file_activity a LEFT JOIN users u ON u.id = a.user_id
            WHERE a.file_id = ? AND a.id < ? ORDER BY a.id DESC LIMIT ?`).all(fileId, before ?? Number.MAX_SAFE_INTEGER, limit)
    .map((a) => ({ ...a, details: a.details ? JSON.parse(a.details) : null }));
}

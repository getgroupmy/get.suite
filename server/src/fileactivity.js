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

// When each person last looked at Drive → Activity: what came after is new for them.
if (!q('PRAGMA table_info(users)').all().some((c) => c.name === 'activity_seen_at')) q('ALTER TABLE users ADD COLUMN activity_seen_at INTEGER').run();

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

/**
 * What others did lately to files someone can open (not in the trash), newest first: [{ id, action, at, details,
 * user_name, file: { id, name, kind } }]. `can(fileId)` says whether they can open it; `before` pages back.
 */
/** The kinds Drive → Activity can be narrowed to, and the actions in each. */
export const ACTIVITY_KINDS = {
  new: ['create', 'upload', 'copy', 'request'], edit: ['edit', 'version'], share: ['share', 'transfer'],
  move: ['move', 'rename', 'trash', 'restore'], other: ['lock', 'unlock', 'approval'],
};

export function recentActivityFor(userId, can, { limit = 100, before = null, days = 30, by = null, kind = null } = {}) {
  const actions = kind ? ACTIVITY_KINDS[kind] : null;
  const out = [];
  let cursor = before ?? Number.MAX_SAFE_INTEGER;
  const since = Date.now() - days * 864e5;
  const seen = new Map(); // fileId → can open
  for (let round = 0; round < 20 && out.length < limit; round++) {
    const rows = q(`SELECT a.id, a.action, a.at, a.details, a.file_id, f.name AS file_name, f.kind AS file_kind, u.name AS user_name
                    FROM file_activity a JOIN files f ON f.id = a.file_id LEFT JOIN users u ON u.id = a.user_id
                    WHERE a.id < ? AND a.at >= ? AND COALESCE(a.user_id, '') <> ? AND f.trashed = 0
                      AND (? IS NULL OR a.user_id = ?) AND (? IS NULL OR a.action IN (SELECT value FROM json_each(?)))
                    ORDER BY a.id DESC LIMIT 500`).all(cursor, since, userId, by, by, actions && 1, actions ? JSON.stringify(actions) : '[]');
    if (!rows.length) break;
    cursor = rows.at(-1).id;
    for (const r of rows) {
      if (!seen.has(r.file_id)) seen.set(r.file_id, !!can(r.file_id));
      if (!seen.get(r.file_id)) continue;
      const { file_id: id, file_name: name, file_kind: kind, ...a } = r;
      out.push({ ...a, details: a.details ? JSON.parse(a.details) : null, file: { id, name, kind } });
      if (out.length >= limit) break;
    }
  }
  return out;
}

// "Notify me of changes": people following a file hear when someone else edits it (or uploads a new
// version), at most once an hour per file, while they can still open it.
import { q } from './db.js';
import { roleFor } from './access.js';
import { notify } from './notifications.js';

q(`CREATE TABLE IF NOT EXISTS file_watchers (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  last_told INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, file_id)
)`).run();
const QUIET_MS = 60 * 60e3;

export const isWatching = (userId, fileId) => !!q('SELECT 1 FROM file_watchers WHERE user_id = ? AND file_id = ?').get(userId, fileId);
export function setWatching(userId, fileId, on) {
  if (on) q('INSERT OR IGNORE INTO file_watchers (user_id, file_id) VALUES (?, ?)').run(userId, fileId);
  else q('DELETE FROM file_watchers WHERE user_id = ? AND file_id = ?').run(userId, fileId);
}

const LINK = { doc: 'docs', sheet: 'sheets', slides: 'slides' };
/** Someone changed a file: tell the people following it (not them). */
export function changedBy(fileId, userId, at = Date.now()) {
  const watchers = q('SELECT user_id, last_told FROM file_watchers WHERE file_id = ? AND user_id != ?').all(fileId, userId || '');
  if (!watchers.length) return;
  const f = q('SELECT id, name, kind, parent_id FROM files WHERE id = ?').get(fileId);
  const who = userId ? q('SELECT name FROM users WHERE id = ?').get(userId)?.name : null;
  if (!f) return;
  for (const w of watchers) {
    if (at - w.last_told < QUIET_MS || !roleFor(f.id, w.user_id)) continue;
    q('UPDATE file_watchers SET last_told = ? WHERE user_id = ? AND file_id = ?').run(at, w.user_id, f.id);
    notify([w.user_id], { kind: 'edit', title: `${who || 'Someone'} changed “${f.name}”`, body: 'You asked to hear about changes',
      link: LINK[f.kind] ? `/${LINK[f.kind]}/${f.id}` : f.parent_id ? `/drive/folder/${f.parent_id}` : '/drive', actor: who });
  }
}

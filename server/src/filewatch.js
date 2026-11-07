// "Notify me of changes": people following a file hear when someone else edits it (or uploads a new
// version); people following a folder hear when something is added to it, or changed in it (at any
// depth). At most once an hour for each thing followed, and only while they can still open it.
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
const linkTo = (f) => (LINK[f.kind] ? `/${LINK[f.kind]}/${f.id}` : f.kind === 'folder' ? `/drive/folder/${f.id}` : f.parent_id ? `/drive/folder/${f.parent_id}` : '/drive');

/** Someone changed a file (or added it: `added`): tell the people following it or a folder it's in (not them). */
export function changedBy(fileId, userId, at = Date.now(), { added = false } = {}) {
  const f = q('SELECT id, name, kind, parent_id FROM files WHERE id = ?').get(fileId);
  if (!f) return;
  // The file itself, then each folder it's in, up to the top: each person hears once, about the nearest.
  const chain = [];
  for (let cur = added ? f.parent_id : f.id, depth = 0; cur && depth < 64; depth++) {
    const x = cur === f.id ? f : q('SELECT id, name, kind, parent_id FROM files WHERE id = ?').get(cur);
    if (!x) break;
    chain.push(x);
    cur = x.parent_id;
  }
  const who = userId ? q('SELECT name FROM users WHERE id = ?').get(userId)?.name : null;
  const told = new Set();
  for (const followed of chain) {
    for (const w of q('SELECT user_id, last_told FROM file_watchers WHERE file_id = ? AND user_id != ?').all(followed.id, userId || '')) {
      if (told.has(w.user_id)) continue;
      told.add(w.user_id);
      if (at - w.last_told < QUIET_MS || !roleFor(f.id, w.user_id)) continue;
      q('UPDATE file_watchers SET last_told = ? WHERE user_id = ? AND file_id = ?').run(at, w.user_id, followed.id);
      const inFolder = followed.id !== f.id;
      notify([w.user_id], { kind: 'edit',
        title: inFolder ? `${who || 'Someone'} ${added ? 'added' : 'changed'} “${f.name}” in “${followed.name}”` : `${who || 'Someone'} changed “${f.name}”`,
        body: 'You asked to hear about changes', link: inFolder && added ? linkTo(followed) : linkTo(f), actor: who });
    }
  }
}

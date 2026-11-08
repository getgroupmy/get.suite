// Calendar sharing: you let chosen colleagues (in your company) see what your events are, not just
// when you're busy: the title and place of each, when they look at your calendar beside theirs.
import { q } from './db.js';

q(`CREATE TABLE IF NOT EXISTS calendar_shares (
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, user_id)
)`).run();

/** Can `viewerId` see the details of `ownerId`'s events? */
export const seesDetails = (ownerId, viewerId) => ownerId === viewerId || !!q('SELECT 1 FROM calendar_shares WHERE owner_id = ? AND user_id = ?').get(ownerId, viewerId);
/** Who you share your calendar with, and who shares theirs with you. */
export function sharesOf(userId) {
  return {
    with: q('SELECT u.id, u.name, u.username FROM calendar_shares s JOIN users u ON u.id = s.user_id WHERE s.owner_id = ? ORDER BY u.name').all(userId),
    from: q('SELECT u.id, u.name, u.username FROM calendar_shares s JOIN users u ON u.id = s.owner_id WHERE s.user_id = ? AND u.disabled = 0 ORDER BY u.name').all(userId),
  };
}
/** Share with exactly these people; returns { added, removed }. */
export function setShares(ownerId, ids) {
  const now = Date.now();
  const before = new Set(q('SELECT user_id FROM calendar_shares WHERE owner_id = ?').all(ownerId).map((r) => r.user_id));
  q('DELETE FROM calendar_shares WHERE owner_id = ?').run(ownerId);
  for (const id of ids) q('INSERT OR IGNORE INTO calendar_shares (owner_id, user_id, created_at) VALUES (?, ?, ?)').run(ownerId, id, now);
  return { added: ids.filter((id) => !before.has(id)), removed: [...before].filter((id) => !ids.includes(id)) };
}

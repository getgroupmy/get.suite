// The notifications behind the bell: things that need you (a mention, a task given to you, an
// invitation, something shared with you, a booking), kept so they're there when you come back.
import { q } from './db.js';
import { uid } from './util.js';
import { sendTo } from './hub.js';

q(`CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                 -- mention | comment | task | invite | share | booking
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,                          -- where in Workspace it leads
  actor TEXT,                         -- who did it (a name)
  created_at INTEGER NOT NULL,
  read_at INTEGER
)`).run();
q('CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id, created_at)').run();

const KEEP = 200;
const shape = (n) => ({ ...n, read: !!n.read_at });

/** Add a notification for each of these people (and tell their open tabs). */
export function notify(userIds, { kind, title, body = null, link = null, actor = null }) {
  const at = Date.now();
  for (const userId of new Set(userIds)) {
    if (!userId) continue;
    const id = uid();
    q('INSERT INTO notifications (id, user_id, kind, title, body, link, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, userId, kind, String(title).slice(0, 200), body ? String(body).slice(0, 300) : null, link, actor, at);
    // Only the latest are kept.
    q(`DELETE FROM notifications WHERE user_id = ? AND id NOT IN (SELECT id FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ${KEEP})`).run(userId, userId);
    sendTo([userId], { type: 'notification', notification: shape(q('SELECT * FROM notifications WHERE id = ?').get(id)) });
  }
}

export function listFor(userId) {
  return {
    items: q('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').all(userId).map(shape),
    unread: q('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(userId).n,
  };
}

export function markRead(userId, ids) {
  const at = Date.now();
  if (ids === 'all') q('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(at, userId);
  else q(`UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND id IN (SELECT value FROM json_each(?))`).run(at, userId, JSON.stringify(ids));
  sendTo([userId], { type: 'notifications-read' });
}

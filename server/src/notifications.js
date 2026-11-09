// The notifications behind the bell: things that need you (a mention, a task given to you, an
// invitation, something shared with you, a booking), kept so they're there when you come back.
import { pushTo } from './push.js';
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
// Kinds someone can turn off (each person's choice; all on to begin with).
export const KINDS = [
  ['mention', 'Mentions in Chat and in documents'], ['comment', 'Mentions in comments on files'], ['task', 'Tasks given to you, and comments on tasks'],
  ['invite', 'Calendar invitations, answers and proposed times'], ['share', 'Files shared with you and access requests'],
  ['edit', 'Changes to files you follow'], ['chat', 'Chat reminders and scheduled messages'], ['booking', 'Booking page appointments'], ['timeoff', 'Time off requests and answers'],
  ['form', 'Responses to your forms'], ['note', 'Note reminders'], ['followup', 'Emails that got no reply'], ['assign', 'Shared mailbox emails given to you'], ['security', 'Security alerts (admins)'], ['system', 'Server health (platform owner)'], ['signin', 'Sign-ins to your account from a new device'],
  ['mail', 'New email (on devices with notifications on)'], ['dm', 'Direct messages in Chat (on devices with notifications on)'],
];
if (!q('PRAGMA table_info(users)').all().some((c) => c.name === 'notify_off')) q('ALTER TABLE users ADD COLUMN notify_off TEXT').run();
export const offFor = (userId) => { try { return JSON.parse(q('SELECT notify_off FROM users WHERE id = ?').get(userId)?.notify_off || '[]'); } catch { return []; } };
export function setOff(userId, kinds) {
  const known = new Set(KINDS.map(([k]) => k));
  const off = [...new Set(kinds.map(String))].filter((k) => known.has(k));
  q('UPDATE users SET notify_off = ? WHERE id = ?').run(off.length ? JSON.stringify(off) : null, userId);
  return off;
}
const shape = (n) => ({ ...n, read: !!n.read_at });

/** Add a notification for each of these people (and tell their open tabs). */
export function notify(userIds, { kind, title, body = null, link = null, actor = null }) {
  const at = Date.now();
  for (const userId of new Set(userIds)) {
    if (!userId || offFor(userId).includes(kind)) continue; // they turned this kind off
    const id = uid();
    q('INSERT INTO notifications (id, user_id, kind, title, body, link, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, userId, kind, String(title).slice(0, 200), body ? String(body).slice(0, 300) : null, link, actor, at);
    // Only the latest are kept.
    q(`DELETE FROM notifications WHERE user_id = ? AND id NOT IN (SELECT id FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ${KEEP})`).run(userId, userId);
    sendTo([userId], { type: 'notification', notification: shape(q('SELECT * FROM notifications WHERE id = ?').get(id)) });
    pushTo(userId, { title, body, link, tag: kind }).catch((e) => console.error('[push]', e.message)); // phones and computers with it turned on
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

// The notifications behind the bell: things that need you (a mention, a task given to you, an
// invitation, something shared with you, a booking), kept so they're there when you come back.
import { pushTo } from './push.js';
import { q } from './db.js';
import { uid } from './util.js';
import { sendTo } from './hub.js';

q(`CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                 -- mention | comment | reply | task | invite | share | booking
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,                          -- where in Workspace it leads
  actor TEXT,                         -- who did it (a name)
  created_at INTEGER NOT NULL,
  read_at INTEGER
)`).run();
q('CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id, created_at)').run();
// Grouped ones (several files through one file request…): one notification counting them while it's unread and recent.
for (const [c, t] of [['group_key', 'TEXT'], ['group_n', 'INTEGER']]) if (!q('PRAGMA table_info(notifications)').all().some((x) => x.name === c)) q(`ALTER TABLE notifications ADD COLUMN ${c} ${t}`).run();
export const GROUP_WINDOW = 10 * 60e3;

const KEEP = 200;
// Kinds someone can turn off (each person's choice; all on to begin with).
export const KINDS = [
  ['mention', 'Mentions in Chat and in documents'], ['comment', 'Mentions in comments on files'], ['reply', 'Replies in comment threads you’re in, and new comments on your files'], ['task', 'Tasks given to you, and comments on tasks'],
  ['invite', 'Calendar invitations, answers and proposed times'], ['share', 'Files shared with you and access requests'], ['link', 'Your share links: opened, ending soon, files sent through a request, stopped by an admin'],
  ['edit', 'Changes to files you follow'], ['chat', 'Chat reminders and scheduled messages'], ['booking', 'Booking page appointments'], ['timeoff', 'Time off requests and answers'],
  ['form', 'Responses to your forms'], ['note', 'Note reminders'], ['touch', 'Contacts you’re due to keep in touch with'], ['dates', 'Contacts’ birthdays and dates'], ['followup', 'Emails that got no reply'], ['mailfull', 'Your mailbox filling up'], ['assign', 'Shared mailbox emails given to you'], ['security', 'Security alerts (admins)'], ['system', 'Server health (platform owner)'], ['signin', 'Sign-ins to your account from a new device'],
  ['mail', 'New email (on devices with notifications on)'], ['dm', 'Direct messages in Chat (on devices with notifications on)'],
];
if (!q('PRAGMA table_info(users)').all().some((c) => c.name === 'notify_off')) q('ALTER TABLE users ADD COLUMN notify_off TEXT').run();
/** Once: people who had “Files shared with you” off before their own links got a kind of their own keep those quiet too. */
export function splitLinkKind() {
  if (q("SELECT 1 FROM settings WHERE key = 'notify_link_split'").get()) return 0;
  let n = 0;
  for (const u of q("SELECT id, notify_off FROM users WHERE notify_off LIKE '%\"share\"%'").all()) {
    let off; try { off = JSON.parse(u.notify_off); } catch { continue; }
    if (!Array.isArray(off) || !off.includes('share') || off.includes('link')) continue;
    q('UPDATE users SET notify_off = ? WHERE id = ?').run(JSON.stringify([...off, 'link']), u.id); n++;
  }
  q("INSERT OR REPLACE INTO settings (key, value) VALUES ('notify_link_split', ?)").run(String(Date.now()));
  return n;
}
splitLinkKind();
export const offFor = (userId) => { try { return JSON.parse(q('SELECT notify_off FROM users WHERE id = ?').get(userId)?.notify_off || '[]'); } catch { return []; } };
export function setOff(userId, kinds) {
  const known = new Set(KINDS.map(([k]) => k));
  const off = [...new Set(kinds.map(String))].filter((k) => known.has(k));
  q('UPDATE users SET notify_off = ? WHERE id = ?').run(off.length ? JSON.stringify(off) : null, userId);
  return off;
}
const shape = (n) => ({ ...n, read: !!n.read_at });

/**
 * Add a notification for each of these people (and tell their open tabs). With `group` ({ key, many(n) → { title,
 * body } }), one that's still unread and came less than 10 minutes ago with the same key is replaced by one counting
 * them all (n), at the top again; phones aren't buzzed again for it.
 */
export function notify(userIds, { kind, title, body = null, link = null, actor = null, group = null }) {
  const at = Date.now();
  for (const userId of new Set(userIds)) {
    if (!userId || offFor(userId).includes(kind)) continue; // they turned this kind off
    const id = uid();
    const prev = group && q('SELECT id, group_n FROM notifications WHERE user_id = ? AND group_key = ? AND read_at IS NULL AND created_at > ? ORDER BY created_at DESC LIMIT 1').get(userId, group.key, at - GROUP_WINDOW);
    let t = title, b = body, n = 1;
    if (prev) { n = (prev.group_n || 1) + 1; ({ title: t, body: b = null } = group.many(n)); q('DELETE FROM notifications WHERE id = ?').run(prev.id); }
    q('INSERT INTO notifications (id, user_id, kind, title, body, link, actor, created_at, group_key, group_n) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, userId, kind, String(t).slice(0, 200), b ? String(b).slice(0, 300) : null, link, actor, at, group?.key ?? null, group ? n : null);
    // Only the latest are kept.
    q(`DELETE FROM notifications WHERE user_id = ? AND id NOT IN (SELECT id FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ${KEEP})`).run(userId, userId);
    sendTo([userId], { type: 'notification', notification: shape(q('SELECT * FROM notifications WHERE id = ?').get(id)), ...(prev && { replaces: prev.id }) });
    if (!prev) pushTo(userId, { title, body, link, tag: kind }).catch((e) => console.error('[push]', e.message)); // phones and computers with it turned on
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

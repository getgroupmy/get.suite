// Unread chat by email: people who turn it on get an email when a direct message to them, or a
// message mentioning them (or one of their chat keywords), is still unread 30 minutes later (or 15 minutes, an hour or 3 hours, as they choose). One email gathers everything waiting,
// sent from their own mailbox to their inbox; nothing is sent while their notifications are paused.
import { q } from './db.js';
import { mailEnabled } from './mail/config.js';
import { smtpFor } from './mail/imap.js';
import { quietUntil } from './workhours.js';

if (!q('PRAGMA table_info(users)').all().some((c) => c.name === 'chat_email')) q('ALTER TABLE users ADD COLUMN chat_email INTEGER NOT NULL DEFAULT 0').run();
// How long a message waits unread before the email, in minutes (empty: the standard half hour).
if (!q('PRAGMA table_info(users)').all().some((c) => c.name === 'chat_email_wait')) q('ALTER TABLE users ADD COLUMN chat_email_wait INTEGER').run();
q(`CREATE TABLE IF NOT EXISTS chat_email_queue (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, message_id)
)`).run();

export const WAIT_MS = 30 * 60e3;
/** The waits people can choose, in minutes. */
export const WAITS = [15, 30, 60, 180];
/** Someone's wait, in milliseconds. */
export function waitFor(userId) {
  const m = q('SELECT chat_email_wait FROM users WHERE id = ?').get(userId)?.chat_email_wait;
  return WAITS.includes(m) ? m * 60e3 : WAIT_MS;
}

/** Note messages that may need an email (only for people who turned it on). */
export function queueChatEmail(userIds, messageId, at = Date.now()) {
  for (const id of userIds) {
    if (!q('SELECT chat_email FROM users WHERE id = ?').get(id)?.chat_email) continue;
    q('INSERT OR IGNORE INTO chat_email_queue (user_id, message_id, created_at) VALUES (?, ?, ?)').run(id, messageId, at);
  }
}

/** Send the emails that are due: messages still unread the person's wait (WAIT_MS unless they chose another) after they came. Returns emails sent. */
export async function sendChatEmails(now = Date.now(), base = process.env.PUBLIC_URL || '') {
  if (!mailEnabled()) return 0;
  let sent = 0;
  const users = q('SELECT DISTINCT user_id FROM chat_email_queue WHERE created_at <= ?').all(now - WAITS[0] * 60e3).map((r) => r.user_id);
  for (const userId of users) {
    const due = now - waitFor(userId);
    const user = q('SELECT id, username, name, disabled, paused_until, chat_email FROM users WHERE id = ?').get(userId);
    if (!user || user.disabled || !user.chat_email) { q('DELETE FROM chat_email_queue WHERE user_id = ?').run(userId); continue; }
    if ((user.paused_until && user.paused_until > now) || quietUntil(userId, now)) continue; // later, when they're back
    if (!q('SELECT 1 FROM chat_email_queue WHERE user_id = ? AND created_at <= ?').get(userId, due)) continue; // not waited long enough yet
    // Only messages still there, in conversations they can still see (not a private channel they were taken out of,
    // nor a channel they left).
    const rows = q(`SELECT qq.message_id, m.body, m.created_at, m.channel_id, c.name AS channel, c.dm_key, u.name AS sender
                    FROM chat_email_queue qq JOIN messages m ON m.id = qq.message_id JOIN channels c ON c.id = m.channel_id LEFT JOIN users u ON u.id = m.user_id
                    WHERE qq.user_id = ? AND qq.created_at <= ? AND m.deleted_at IS NULL
                      AND ((c.dm_key IS NULL AND c.private = 0 AND c.org_id = (SELECT org_id FROM users WHERE id = qq.user_id)
                            AND NOT EXISTS (SELECT 1 FROM chat_left lf WHERE lf.channel_id = c.id AND lf.user_id = qq.user_id))
                        OR EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = qq.user_id))
                    ORDER BY m.created_at`).all(userId, due);
    q('DELETE FROM chat_email_queue WHERE user_id = ? AND created_at <= ?').run(userId, due);
    const unread = rows.filter((r) => r.created_at > (q('SELECT read_at FROM channel_reads WHERE channel_id = ? AND user_id = ?').get(r.channel_id, userId)?.read_at ?? 0));
    if (!unread.length) continue;
    const lines = [`${unread.length === 1 ? 'A message is' : `${unread.length} messages are`} waiting for you in Chat:`, ''];
    const keyword = (r) => (r.dm_key ? null : q('SELECT keyword FROM chat_mentions WHERE message_id = ? AND user_id = ?').get(r.message_id, userId)?.keyword);
    for (const r of unread.slice(0, 20)) {
      const k = keyword(r);
      lines.push(`${r.sender || 'Someone'}${r.dm_key ? ' (direct message)' : ` in #${r.channel}`}${k ? ` (your keyword “${k}”)` : ''}:`);
      lines.push(`  ${String(r.body).replace(/\s+/g, ' ').slice(0, 300)}`);
      lines.push(`  ${base}/chat/${r.channel_id}`, '');
    }
    if (unread.length > 20) lines.push(`…and ${unread.length - 20} more.`, '');
    lines.push('You get these because you turned on chat emails in Workspace → Settings.');
    const k1 = unread.length === 1 && keyword(unread[0]);
    const subject = unread.length === 1 ? (k1 ? `“${k1}” in #${unread[0].channel}: ${unread[0].sender || 'Someone'}` : `${unread[0].sender || 'Someone'} ${unread[0].dm_key ? 'sent you a message' : `mentioned you in #${unread[0].channel}`}`) : `${unread.length} unread chat messages for you`;
    try {
      await smtpFor(user).sendMail({ from: { name: 'Workspace Chat', address: user.username }, to: user.username, subject, text: lines.join('\n') });
      sent++;
    } catch (e) { console.error('[chat] email:', e.message); }
  }
  return sent;
}

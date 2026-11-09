// Calendar reminders on phones and computers with Workspace notifications on, even with Workspace
// closed: each minute, the reminders that have just come due (the ones people set on their events,
// repeating ones too) go to their devices. Not to someone who has Workspace open right now: the open
// app shows its own (eventReminders.js), so it isn't shown twice. Each is sent once.
import { q } from './db.js';
import { expand } from './calmath.js';
import { outEvent } from './routes/calendar.js';
import { pushTo } from './push.js';
import { onlineUserIds } from './hub.js';

q('CREATE TABLE IF NOT EXISTS push_reminders_sent (key TEXT PRIMARY KEY, sent_at INTEGER NOT NULL)').run();
const LATE = 5 * 6e4; // one missed by up to five minutes (the server was restarting) still goes

const when = (m) => (m === 0 ? 'Starting now' : m < 60 ? `In ${m} minute${m === 1 ? '' : 's'}` : m < 1440 && m % 60 === 0 ? `In ${m / 60} hour${m === 60 ? '' : 's'}` : m % 1440 === 0 ? `In ${m / 1440} day${m === 1440 ? '' : 's'}` : `In ${m} minutes`);

/** Returns how many reminders went out. */
export async function sendDueReminderPushes(now = Date.now(), { skipOnline = true } = {}) {
  const online = new Set(skipOnline ? onlineUserIds() : []);
  const users = q('SELECT DISTINCT user_id FROM push_subscriptions').all().map((r) => r.user_id).filter((id) => !online.has(id));
  let sent = 0;
  for (const userId of users) {
    const rows = q(`SELECT e.*, (SELECT status FROM event_guests g WHERE g.event_id = e.id AND g.user_id = ?) AS my_status FROM events e
                    WHERE e.id IN (SELECT DISTINCT event_id FROM event_reminders WHERE user_id = ?)`).all(userId, userId);
    for (const row of rows) {
      if (row.owner_id !== userId && (!row.my_status || row.my_status === 'no')) continue; // not theirs, or declined
      const mins = q('SELECT minutes FROM event_reminders WHERE event_id = ? AND user_id = ?').all(row.id, userId).map((r) => r.minutes);
      const furthest = Math.max(...mins) * 6e4;
      for (const occ of expand(outEvent(row), now - LATE, now + furthest + 864e5)) {
        if (occ.end < now) continue;
        for (const m of mins) {
          const at = occ.start - m * 6e4;
          if (at > now || at <= now - LATE) continue;
          const key = `${userId}:${row.id}@${occ.start}:${m}`;
          if (!q('INSERT OR IGNORE INTO push_reminders_sent (key, sent_at) VALUES (?, ?)').run(key, now).changes) continue;
          await pushTo(userId, { title: row.title || '(No title)', body: [when(m), row.location].filter(Boolean).join(' · '), link: '/calendar', tag: `event-${row.id}` }, { now });
          sent++;
        }
      }
    }
  }
  q('DELETE FROM push_reminders_sent WHERE sent_at < ?').run(now - 3 * 864e5);
  return sent;
}

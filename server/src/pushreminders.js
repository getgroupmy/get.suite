// Calendar reminders on phones and computers with Workspace notifications on, even with Workspace
// closed: each minute, the reminders that have just come due (the ones people set on their events,
// repeating ones too) go to their devices. Not to someone who has Workspace open right now: the open
// app shows its own (eventReminders.js), so it isn't shown twice. Each is sent once.
import { q } from './db.js';
import { expand } from './calmath.js';
import { outEvent } from './routes/calendar.js';
import { pushTo } from './push.js';
import { onlineUserIds } from './hub.js';
import { zonedToUtc, zoneOrUtc } from './ics.js';
import { localNow } from './digest.js';
import { hoursOf } from './workhours.js';

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
          // With a video meeting: say so, and tapping it opens the meeting rather than the calendar.
          await pushTo(userId, { title: row.title || '(No title)', body: [when(m), row.location, row.meet_code && 'Video meeting: tap to join'].filter(Boolean).join(' · '),
            link: row.meet_code ? `/meet/${row.meet_code}` : '/calendar', tag: `event-${row.id}`, private: { title: 'Calendar reminder', body: when(m) } }, { now });
          sent++;
        }
      }
    }
  }
  q('DELETE FROM push_reminders_sent WHERE sent_at < ?').run(now - 3 * 864e5);
  return sent;
}

// ---- Tasks: each morning from 9:00 (their time) the tasks due today and overdue, and a task with a
// due time when that time comes. Same rules: devices with notifications on, not while Workspace is open.
export const MORNING_HOUR = 9;
/** Someone's time zone: their phone's, else their working hours', else their morning email's, else UTC. */
export function zoneOf(userId) {
  const sub = q('SELECT tz FROM push_subscriptions WHERE user_id = ? AND tz IS NOT NULL ORDER BY created_at DESC LIMIT 1').get(userId)?.tz;
  const h = hoursOf(userId);
  return zoneOrUtc(sub || (h.own && h.tz) || q('SELECT digest_tz FROM users WHERE id = ?').get(userId)?.digest_tz || 'UTC');
}
const openTasks = (userId, upTo) => q(`SELECT t.id, t.title, t.due, t.due_time FROM tasks t JOIN task_lists l ON l.id = t.list_id
  WHERE t.done_at IS NULL AND t.due IS NOT NULL AND t.due <= ? AND (t.assignee_id = ? OR (t.assignee_id IS NULL AND l.owner_id = ?))
  ORDER BY t.due, t.due_time IS NULL, t.due_time LIMIT 500`).all(upTo, userId, userId);

export async function sendTaskPushes(now = Date.now(), { skipOnline = true } = {}) {
  const online = new Set(skipOnline ? onlineUserIds() : []);
  const users = q('SELECT DISTINCT user_id FROM push_subscriptions').all().map((r) => r.user_id).filter((id) => !online.has(id));
  let sent = 0;
  const once = (key) => q('INSERT OR IGNORE INTO push_reminders_sent (key, sent_at) VALUES (?, ?)').run(key, now).changes > 0;
  for (const userId of users) {
    const tz = zoneOf(userId);
    const { date, hour } = localNow(now, tz);
    const tasks = openTasks(userId, date);
    // The morning note.
    if (hour >= MORNING_HOUR && once(`${userId}:tasks:${date}`)) {
      const today = tasks.filter((t) => t.due === date), late = tasks.filter((t) => t.due < date);
      if (today.length || late.length) {
        const parts = [];
        if (today.length) parts.push(today.length === 1 ? `“${today[0].title}” is due today` : `${today.length} tasks are due today`);
        if (late.length) parts.push(`${late.length} ${late.length === 1 ? 'is' : 'are'} overdue`);
        const counts = [today.length && `${today.length} due today`, late.length && `${late.length} overdue`].filter(Boolean).join(', ');
        await pushTo(userId, { title: 'Tasks', body: parts.join(', and '), link: '/tasks', tag: 'tasks', private: { body: counts } }, { now });
        sent++;
      }
    }
    // Due now (a due time, today).
    for (const t of tasks.filter((x) => x.due === date && x.due_time)) {
      const [y, m, d] = t.due.split('-').map(Number), [hh, mm] = t.due_time.split(':').map(Number);
      const at = zonedToUtc(y, m, d, hh, mm, 0, tz); // (months from 1)
      if (at > now || at <= now - LATE || !once(`${userId}:task:${t.id}:${at}`)) continue;
      await pushTo(userId, { title: t.title, body: 'Due now', link: '/tasks', tag: `task-${t.id}`, private: { title: 'A task is due now', body: '' } }, { now });
      sent++;
    }
  }
  return sent;
}

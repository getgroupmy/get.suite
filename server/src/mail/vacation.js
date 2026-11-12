// The vacation auto-reply (Mail → Vacation reply), set from Mail or from an Out of office event.
import { q } from '../db.js';
import { scheduleMailConfig } from './config.js';
import { zoneOrUtc } from '../ics.js';
import crypto from 'node:crypto';

/** Turn on (or change) someone's auto-reply: { enabled, subject, body, start_date, end_date }. */
export function setVacation(userId, { enabled, subject, body, start_date = null, end_date = null }) {
  q(`INSERT INTO vacations (user_id, enabled, subject, body, start_date, end_date, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET enabled = excluded.enabled, subject = excluded.subject, body = excluded.body,
       start_date = excluded.start_date, end_date = excluded.end_date, updated_at = excluded.updated_at`)
    .run(userId, enabled ? 1 : 0, subject, body, start_date, end_date, Date.now());
  scheduleMailConfig();
}

/** The local date ("2026-11-09") of a moment in a time zone. */
const dayIn = (ms, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: zoneOrUtc(tz || 'UTC'), year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));

/**
 * The auto-reply for an Out of office event: its first and last day (in its time zone), and its
 * description as the message (or a plain one saying when you're back).
 */
export function vacationForAway(ev, tz) {
  const start_date = dayIn(ev.start, tz);
  const end_date = dayIn(Math.max(ev.start, ev.all_day ? ev.end : ev.end - 1), tz);
  const back = new Intl.DateTimeFormat('en-GB', { timeZone: zoneOrUtc(tz || 'UTC'), weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(ev.all_day ? ev.end + 1 : ev.end));
  const body = (ev.description || '').trim() || `I'm out of the office and will be back on ${back}. I'll reply to your message then.`;
  return { enabled: true, subject: ev.title && ev.title !== 'Out of office' ? `Out of office: ${ev.title}` : 'Out of office', body: body.slice(0, 5000), start_date, end_date };
}

// "Also mark me Out of office in my calendar": an all-day Out of office event for the reply's days, kept in
// step with it (moved when its days change, removed when the reply is turned off). vacations.ooo_event_id.
if (!q('PRAGMA table_info(vacations)').all().some((c) => c.name === 'ooo_event_id')) q('ALTER TABLE vacations ADD COLUMN ooo_event_id TEXT').run();

/** Midnight at the start of a day ("2026-11-20") in a time zone, as ms. */
export function midnightIn(ymd, tz) {
  const zone = zoneOrUtc(tz || 'UTC');
  const guess = Date.parse(`${ymd}T00:00:00Z`);
  const offset = (t) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - t;
  };
  let t = guess - offset(guess);
  t = guess - offset(t); // again, for a day when the clocks change
  return t;
}

/** The Out of office event for this reply, made, moved or removed: gives its id (or null). */
export function syncAwayEvent(userId, { on, start_date, end_date, title = 'Out of office', description = null, tz = 'UTC' }) {
  const row = q('SELECT ooo_event_id FROM vacations WHERE user_id = ?').get(userId);
  const existing = row?.ooo_event_id ? q("SELECT id FROM events WHERE id = ? AND owner_id = ? AND kind = 'ooo'").get(row.ooo_event_id, userId) : null;
  if (!on || !end_date) {
    if (existing) q('DELETE FROM events WHERE id = ?').run(existing.id);
    q('UPDATE vacations SET ooo_event_id = NULL WHERE user_id = ?').run(userId);
    return null;
  }
  const first = start_date || new Date().toISOString().slice(0, 10);
  const start = midnightIn(first, tz);
  const last = midnightIn(end_date, tz);
  const end = midnightIn(new Date(Date.parse(`${end_date}T00:00:00Z`) + 864e5).toISOString().slice(0, 10), tz) - 1; // to the end of the last day
  if (end < start || last < start) return null;
  let id = existing?.id;
  if (id) q('UPDATE events SET title = ?, description = ?, start = ?, end = ?, tz = ? WHERE id = ?').run(title, description, start, end, zoneOrUtc(tz), id);
  else {
    id = crypto.randomUUID();
    q(`INSERT INTO events (id, owner_id, title, description, location, start, end, all_day, color, rrule, exdates, repeat_until, tz, recur_parent, recur_id, kind, meet_code)
       VALUES (?, ?, ?, ?, NULL, ?, ?, 1, NULL, NULL, '[]', NULL, ?, NULL, NULL, 'ooo', NULL)`).run(id, userId, title, description, start, end, zoneOrUtc(tz));
  }
  q('UPDATE vacations SET ooo_event_id = ? WHERE user_id = ?').run(id, userId);
  return id;
}

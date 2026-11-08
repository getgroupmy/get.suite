// The vacation auto-reply (Mail → Vacation reply), set from Mail or from an Out of office event.
import { q } from '../db.js';
import { scheduleMailConfig } from './config.js';
import { zoneOrUtc } from '../ics.js';

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

// "It's 23:10 for Kim": colleagues on a message who are outside the working hours they've set (Calendar →
// Working hours), with their local time and when their day starts again, so Compose can offer to send then.
import { q } from '../db.js';
import { hoursOf, nextWorkStart } from '../workhours.js';
import './storage.js'; // users.mail_full_told

const clean = (e) => String(e || '').trim().toLowerCase();
const timeIn = (t, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(t));

/** One colleague out of their own working hours at `now`: { tz, local, next }, or null. */
function outOfHours(userId, now) {
  const h = hoursOf(userId);
  if (!h.own) return null; // only hours they've set themselves: the usual 9 to 5 may not be theirs
  const next = nextWorkStart(h, now);
  if (next === null || next - now < 15 * 6e4) return null; // working now (or within the quarter hour)
  return { tz: h.tz, local: timeIn(now, h.tz), next };
}

/** [{ email, name, tz, local: 'HH:MM', next: ms }] for colleagues (same company) out of their own working hours at `now`. */
export function afterHours(user, emails, now = Date.now()) {
  const out = [];
  for (const e of new Set((emails || []).map(clean))) {
    if (!e || e === clean(user.username)) continue;
    const who = q('SELECT id, name FROM users WHERE LOWER(username) = ? AND org_id = ? AND disabled = 0').get(e, user.org_id);
    const o = who && outOfHours(who.id, now);
    if (o) out.push({ email: e, name: who.name, ...o });
  }
  return out;
}

/** The same for people by id (a Chat direct message): [{ id, name, tz, local, next }]. */
export function afterHoursOfIds(user, ids, now = Date.now()) {
  const out = [];
  for (const id of new Set(ids || [])) {
    if (!id || id === user.id) continue;
    const who = q('SELECT id, name FROM users WHERE id = ? AND org_id = ? AND disabled = 0').get(id, user.org_id);
    const o = who && outOfHours(who.id, now);
    if (o) out.push({ id: who.id, name: who.name, ...o });
  }
  return out;
}

const toList = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 100);
export function afterHoursRoutes(r) {
  r.get('/after-hours', (req, res) => res.json(afterHours(req.user, toList(req.query.to))));
  // Colleagues on the message who are away (their vacation reply is on today).
  r.get('/away', (req, res) => res.json(awayRecipients(req.user, toList(req.query.to))));
  // Colleagues on the message whose mailbox is full (new mail is sent back to the sender).
  r.get('/full', (req, res) => res.json(fullRecipients(req.user, toList(req.query.to))));
}

/**
 * Colleagues whose mailbox is full, as the hourly check last found (users.mail_full_told = 100; see
 * mail/storage.js): mail to them comes back. [{ email, name }].
 */
export function fullRecipients(user, emails) {
  const out = [];
  for (const e of new Set((emails || []).map(clean))) {
    if (!e || e === clean(user.username)) continue;
    const row = q('SELECT name FROM users WHERE LOWER(username) = ? AND org_id = ? AND disabled = 0 AND mail_quota_mb > 0 AND mail_full_told >= 100').get(e, user.org_id);
    if (row) out.push({ email: e, name: row.name });
  }
  return out;
}

/** Whether someone's vacation reply is on the day of `now` (UTC): { until, subject } or null. */
export function awayToday(userId, now = Date.now()) {
  const today = new Date(now).toISOString().slice(0, 10);
  const v = q('SELECT subject, start_date, end_date FROM vacations WHERE user_id = ? AND enabled = 1').get(userId);
  if (!v || (v.start_date && v.start_date > today) || (v.end_date && v.end_date < today)) return null;
  return { until: v.end_date || null, subject: String(v.subject || '').slice(0, 120) };
}

/** The same by id (a Chat direct message): [{ id, name, until, subject }], colleagues only. */
export function awayOfIds(user, ids, now = Date.now()) {
  const out = [];
  for (const id of new Set(ids || [])) {
    if (!id || id === user.id) continue;
    const who = q('SELECT id, name FROM users WHERE id = ? AND org_id = ? AND disabled = 0').get(id, user.org_id);
    const a = who && awayToday(who.id, now);
    if (a) out.push({ id: who.id, name: who.name, ...a });
  }
  return out;
}

/**
 * Colleagues on a message whose vacation reply is on today (Mail → Vacation reply): [{ email, name, until, subject }],
 * `until` the last day (YYYY-MM-DD) or null when it has no end. Dates as the mail server keeps them (UTC).
 */
export function awayRecipients(user, emails, now = Date.now()) {
  const today = new Date(now).toISOString().slice(0, 10);
  const out = [];
  for (const e of new Set((emails || []).map(clean))) {
    if (!e || e === clean(user.username)) continue;
    const row = q(`SELECT u.name, v.subject, v.start_date, v.end_date FROM users u JOIN vacations v ON v.user_id = u.id
                   WHERE LOWER(u.username) = ? AND u.org_id = ? AND u.disabled = 0 AND v.enabled = 1`).get(e, user.org_id);
    if (!row || (row.start_date && row.start_date > today) || (row.end_date && row.end_date < today)) continue;
    out.push({ email: e, name: row.name, until: row.end_date || null, subject: String(row.subject || '').slice(0, 120) });
  }
  return out;
}

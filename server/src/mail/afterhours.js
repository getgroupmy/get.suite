// "It's 23:10 for Kim": colleagues on a message who are outside the working hours they've set (Calendar →
// Working hours), with their local time and when their day starts again, so Compose can offer to send then.
import { q } from '../db.js';
import { hoursOf, nextWorkStart } from '../workhours.js';

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

export function afterHoursRoutes(r) {
  r.get('/after-hours', (req, res) => {
    const list = String(req.query.to || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 100);
    res.json(afterHours(req.user, list));
  });
}

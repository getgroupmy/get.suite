// "It's 23:10 for Kim": colleagues on a message who are outside the working hours they've set (Calendar →
// Working hours), with their local time and when their day starts again, so Compose can offer to send then.
import { q } from '../db.js';
import { hoursOf, nextWorkStart } from '../workhours.js';

const clean = (e) => String(e || '').trim().toLowerCase();
const timeIn = (t, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(t));

/** [{ email, name, tz, local: 'HH:MM', next: ms }] for colleagues (same company) out of their own working hours at `now`. */
export function afterHours(user, emails, now = Date.now()) {
  const out = [];
  for (const e of new Set((emails || []).map(clean))) {
    if (!e || e === clean(user.username)) continue;
    const who = q('SELECT id, name FROM users WHERE LOWER(username) = ? AND org_id = ? AND disabled = 0').get(e, user.org_id);
    if (!who) continue;
    const h = hoursOf(who.id);
    if (!h.own) continue; // only hours they've set themselves: the usual 9 to 5 may not be theirs
    const next = nextWorkStart(h, now);
    if (next === null || next - now < 15 * 6e4) continue; // working now (or within the quarter hour)
    out.push({ email: e, name: who.name, tz: h.tz, local: timeIn(now, h.tz), next });
  }
  return out;
}

export function afterHoursRoutes(r) {
  r.get('/after-hours', (req, res) => {
    const list = String(req.query.to || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 100);
    res.json(afterHours(req.user, list));
  });
}

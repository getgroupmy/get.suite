// Which days each person used Workspace (UTC days), for Admin → Reports' chart of active people per day.
// Written whenever someone's last activity is (at most every few minutes per session), so it costs little.
import { q } from './db.js';

q(`CREATE TABLE IF NOT EXISTS active_days (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL, -- YYYY-MM-DD, UTC
  PRIMARY KEY (user_id, day)
)`).run();
q('CREATE INDEX IF NOT EXISTS active_days_day ON active_days(day)').run();

export const dayOf = (t) => new Date(t).toISOString().slice(0, 10);

/** Note that someone was active at time t. */
export function markActive(userId, t = Date.now()) {
  q('INSERT OR IGNORE INTO active_days (user_id, day) VALUES (?, ?)').run(userId, dayOf(t));
}

/**
 * Active people in a company for each UTC day from `from` to `to`: [{ day, active }], every day listed
 * (0 for quiet ones). `since` is the first day anyone in the company was recorded (older days weren't).
 */
export function activePerDay(orgId, from, to) {
  const counts = new Map(q(`SELECT a.day, COUNT(*) AS n FROM active_days a JOIN users u ON u.id = a.user_id
                            WHERE u.org_id = ? AND a.day >= ? AND a.day <= ? GROUP BY a.day`).all(orgId, dayOf(from), dayOf(to)).map((r) => [r.day, r.n]));
  const out = [];
  for (let d = Date.parse(`${dayOf(from)}T00:00:00Z`); d <= to; d += 864e5) out.push({ day: dayOf(d), active: counts.get(dayOf(d)) || 0 });
  const since = q('SELECT MIN(a.day) AS d FROM active_days a JOIN users u ON u.id = a.user_id WHERE u.org_id = ?').get(orgId).d || null;
  return { days: out, since };
}

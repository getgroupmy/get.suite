// Repeating note reminders: the next time after a reminder went off, at the same wall-clock time in the
// person's time zone (so 8:00 stays 8:00 when the clocks change).
import { offsetAt, zonedToUtc, zoneOrUtc } from './ics.js';

export const REPEATS = ['daily', 'weekdays', 'weekly', 'monthly'];

/** The next reminder after `now` for one at `at` repeating `repeat` in `zone` (ms), or null for no repeat. */
export function nextRemind(at, repeat, zone, now = at) {
  if (!REPEATS.includes(repeat)) return null;
  const z = zoneOrUtc(zone);
  const w = new Date(at + offsetAt(at, z) * 6e4); // the wall clock, in UTC fields
  const day = w.getUTCDate();
  let y = w.getUTCFullYear(), mo = w.getUTCMonth(), d = day;
  const [h, mi, sec, ms] = [w.getUTCHours(), w.getUTCMinutes(), w.getUTCSeconds(), w.getUTCMilliseconds()];
  for (let i = 0; i < 2000; i++) {
    if (repeat === 'monthly') {
      mo += 1;
      const last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate(); // days in that month
      d = Math.min(day, last);
    } else {
      const step = repeat === 'weekly' ? 7 : 1;
      const n = new Date(Date.UTC(y, mo, d + step));
      [y, mo, d] = [n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()];
      if (repeat === 'weekdays') while ([0, 6].includes(new Date(Date.UTC(y, mo, d)).getUTCDay())) { const m = new Date(Date.UTC(y, mo, d + 1)); [y, mo, d] = [m.getUTCFullYear(), m.getUTCMonth(), m.getUTCDate()]; }
    }
    const n = new Date(Date.UTC(y, mo, 1)); // normalise a month past December
    const t = zonedToUtc(n.getUTCFullYear(), n.getUTCMonth() + 1, d, h, mi, sec, z) + ms;
    [y, mo] = [n.getUTCFullYear(), n.getUTCMonth()];
    if (t > now) return t;
  }
  return null;
}

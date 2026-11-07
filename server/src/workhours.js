// Working hours: the days and times someone works, in their own time zone. "Find a time" only
// suggests times inside everyone's. Without a setting: Monday to Friday, 9:00 to 17:00.
import { bad } from './util.js';
import { zoneOrUtc } from './ics.js';
import { q } from './db.js';

if (!q('PRAGMA table_info(users)').all().some((c) => c.name === 'work_hours')) q('ALTER TABLE users ADD COLUMN work_hours TEXT').run();

export const DEFAULT_HOURS = { days: [1, 2, 3, 4, 5], start: 9 * 60, end: 17 * 60 };

/** Hours as sent ({ days: [0–6, Sunday first], start, end: minutes into the day, tz }), checked. */
export function readHours(v) {
  if (!v || typeof v !== 'object') throw bad('Working hours needed');
  const days = [...new Set((Array.isArray(v.days) ? v.days : []).map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort();
  if (!days.length) throw bad('Pick at least one working day');
  const start = Number(v.start), end = Number(v.end);
  if (![start, end].every((x) => Number.isInteger(x) && x >= 0 && x <= 1440) || end - start < 30) throw bad('Working hours must end at least half an hour after they start');
  return { days, start, end, tz: zoneOrUtc(String(v.tz || 'UTC')) };
}

/** Someone's working hours: their own, or the usual ones in the given time zone. */
export function hoursOf(userId, fallbackTz = 'UTC') {
  const raw = q('SELECT work_hours FROM users WHERE id = ?').get(userId)?.work_hours;
  return raw ? { ...JSON.parse(raw), own: true } : { ...DEFAULT_HOURS, tz: fallbackTz, own: false };
}
export function setHours(userId, hours) {
  q('UPDATE users SET work_hours = ? WHERE id = ?').run(hours ? JSON.stringify(hours) : null, userId);
}

const fmt = new Map();
function parts(t, tz) {
  if (!fmt.has(tz)) fmt.set(tz, new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', hour: 'numeric', minute: 'numeric', weekday: 'short' }));
  const p = Object.fromEntries(fmt.get(tz).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday), min: (+p.hour) * 60 + (+p.minute) };
}

/** Is the time from s to e (ms) inside these working hours, on one working day in their time zone? */
export function withinHours(s, e, hours) {
  const p = parts(s, hours.tz);
  const length = Math.round((e - s) / 6e4);
  return hours.days.includes(p.wd) && p.min >= hours.start && p.min + length <= hours.end;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const hhmm = (m) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
/** "Mon–Fri 9:00–17:00", "Mon, Wed, Fri 8:30–14:00". */
export function hoursText(h) {
  const d = [...h.days].sort();
  const run = d.length > 2 && d.every((x, i) => i === 0 || x === d[i - 1] + 1);
  return `${run ? `${DAY_NAMES[d[0]]}–${DAY_NAMES[d[d.length - 1]]}` : d.map((x) => DAY_NAMES[x]).join(', ')} ${hhmm(h.start)}–${hhmm(h.end)}`;
}

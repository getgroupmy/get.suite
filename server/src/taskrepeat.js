// Repeating tasks: when one is ticked off, the next comes due. The schedule keeps its day (the
// same weekday, or day of the month), and occurrences already past are skipped, so ticking off an
// overdue daily task brings it back for today rather than for each missed day.
// Besides daily, weekdays, weekly, monthly and yearly, a custom schedule is written
// "every:N:unit[:days]": every N days, weeks, months or years, and for weeks on chosen weekdays
// (0 Sunday … 6 Saturday), e.g. "every:2:week:1,4" is every other week on Monday and Thursday.

export const REPEATS = ['daily', 'weekdays', 'weekly', 'monthly', 'yearly'];
const CUSTOM = /^every:(\d{1,2}):(day|week|month|year)(?::([0-6](?:,[0-6]){0,6}))?$/;

/** A repeat as kept (one of REPEATS, or a tidy custom one), or null when it isn't one. */
export function cleanRepeat(v) {
  if (REPEATS.includes(v)) return v;
  const m = CUSTOM.exec(String(v || ''));
  if (!m) return null;
  const n = Number(m[1]);
  if (n < 1 || n > 99) return null;
  const days = m[3] && m[2] === 'week' ? [...new Set(m[3].split(',').map(Number))].sort((a, b) => a - b) : null;
  // Plain ones as their simple names.
  if (n === 1 && !days) return { day: 'daily', week: 'weekly', month: 'monthly', year: 'yearly' }[m[2]];
  if (n === 1 && days?.join() === '1,2,3,4,5') return 'weekdays';
  return `every:${n}:${m[2]}${days ? `:${days.join(',')}` : ''}`;
}

const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return { y, m: m - 1, d }; };
const text = (ms) => new Date(ms).toISOString().slice(0, 10);
const utc = (y, m, d) => Date.UTC(y, m, Math.min(d, new Date(Date.UTC(y, m + 1, 0)).getUTCDate())); // 31 Jan + 1 month → 28/29 Feb
const DAY = 864e5;

/** The occurrences after `due`, as ms, one after another. Months and years count from the original day. */
function* occurrences(due, repeat) {
  const { y, m, d } = parse(due);
  const start = Date.UTC(y, m, d);
  const simple = { daily: 'every:1:day', weekly: 'every:1:week', monthly: 'every:1:month', yearly: 'every:1:year' }[repeat];
  if (repeat === 'weekdays') {
    for (let t = start + DAY; ; t += DAY) { const w = new Date(t).getUTCDay(); if (w !== 0 && w !== 6) yield t; }
  }
  const c = CUSTOM.exec(simple || repeat);
  if (!c) return;
  const n = Number(c[1]), unit = c[2];
  const days = c[3] ? c[3].split(',').map(Number) : null;
  if (unit === 'week' && days) {
    // Weeks run Monday to Sunday; every n-th week from the one the task was due in, on those weekdays.
    const mondayOf = (t) => t - ((new Date(t).getUTCDay() + 6) % 7) * DAY;
    const week0 = mondayOf(start);
    for (let t = start + DAY; ; t += DAY) {
      const weeks = Math.round((mondayOf(t) - week0) / (7 * DAY));
      if (weeks % n === 0 && days.includes(new Date(t).getUTCDay())) yield t;
    }
  }
  for (let k = 1; ; k++) {
    if (unit === 'day') yield start + k * n * DAY;
    else if (unit === 'week') yield start + k * n * 7 * DAY;
    else if (unit === 'month') yield utc(y, m + k * n, d);
    else yield utc(y + k * n, m, d);
  }
}

/** The next due date (YYYY-MM-DD) after `due` that isn't before `today`, or null for no repeat. */
export function nextDue(due, repeat, today) {
  if (!due || !cleanRepeat(repeat)) return null;
  const floor = today && today > due ? today : null;
  let k = 0;
  for (const t of occurrences(due, repeat)) {
    const s = text(t);
    if (!floor || s >= floor) return s;
    if (++k > 200000) break;
  }
  return null;
}

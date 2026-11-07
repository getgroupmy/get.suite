// Repeating tasks: when one is ticked off, the next comes due. The schedule keeps its day (the
// same weekday, or day of the month), and occurrences already past are skipped, so ticking off an
// overdue daily task brings it back for today rather than for each missed day.

export const REPEATS = ['daily', 'weekdays', 'weekly', 'monthly', 'yearly'];

const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return { y, m: m - 1, d }; };
const text = (ms) => new Date(ms).toISOString().slice(0, 10);
const utc = (y, m, d) => Date.UTC(y, m, Math.min(d, new Date(Date.UTC(y, m + 1, 0)).getUTCDate())); // 31 Jan + 1 month → 28/29 Feb

/** The k-th occurrence after `due` (k ≥ 1), as ms. Months and years count from the original day. */
function step(due, repeat, k) {
  const { y, m, d } = parse(due);
  const start = Date.UTC(y, m, d);
  switch (repeat) {
    case 'daily': return start + k * 864e5;
    case 'weekly': return start + k * 7 * 864e5;
    case 'monthly': return utc(y, m + k, d);
    case 'yearly': return utc(y + k, m, d);
    case 'weekdays': {
      let t = start, left = k;
      while (left) { t += 864e5; const w = new Date(t).getUTCDay(); if (w !== 0 && w !== 6) left--; }
      return t;
    }
    default: return null;
  }
}

/** The next due date (YYYY-MM-DD) after `due` that isn't before `today`, or null for no repeat. */
export function nextDue(due, repeat, today) {
  if (!due || !REPEATS.includes(repeat)) return null;
  const floor = today && today > due ? today : null;
  for (let k = 1; k < 100000; k++) {
    const t = text(step(due, repeat, k));
    if (!floor || t >= floor) return t;
  }
  return null;
}

// The numbers behind Reports' "Active people per day" chart: bar geometry, axis steps and a summary.

/** A tidy top for the axis (1, 2, 5, 10, 20, 50…) at or above the busiest day, and its gridline steps. */
export function axisOf(max) {
  const top = Math.max(1, max);
  const nice = [1, 2, 5].flatMap((m) => [1, 10, 100, 1000, 10000].map((p) => m * p)).sort((a, b) => a - b).find((n) => n >= top) || top;
  const step = nice <= 5 ? 1 : nice / 5;
  const ticks = [];
  for (let v = 0; v <= nice; v += step) ticks.push(v);
  return { top: nice, ticks };
}

/** Average over the days counted (from `since` on), the busiest day, and how many days were counted. */
export function summaryOf(days, since) {
  const counted = days.filter((d) => !since || d.day >= since);
  if (!counted.length) return { average: 0, peak: null, counted: 0 };
  const peak = counted.reduce((a, b) => (b.active > a.active ? b : a));
  return { average: counted.reduce((n, d) => n + d.active, 0) / counted.length, peak: peak.active ? peak : null, counted: counted.length };
}

/** "Tue 10 Nov" for a YYYY-MM-DD (UTC) day. */
export const dayLabel = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

// Away from a running timer: when you come back after a while with no typing, clicking or moving the
// mouse (in any tab), the time away can be kept or left out.

export const AWAY_MS = 10 * 60e3; // ten minutes with nothing done

/**
 * When you come back (`now`) after being idle since `lastActive`: the span away { from, to } if the timer `run`
 * was running then and the gap is long enough, else null. Focus sessions end by themselves, so they're not asked about.
 */
export function awaySpan(run, lastActive, now = Date.now(), threshold = AWAY_MS) {
  if (!run || run.until || !lastActive || now - lastActive < threshold) return null;
  const from = Math.max(lastActive, run.since);
  return now - from >= threshold ? { from, to: now } : null;
}

/** "10:05 – 10:50 (45 min)" */
export function awayText({ from, to }, fmt = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })) {
  const m = Math.round((to - from) / 60e3);
  return `${fmt(from)} – ${fmt(to)} (${m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`})`;
}

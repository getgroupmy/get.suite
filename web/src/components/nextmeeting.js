/**
 * The meeting to show in the top bar: one of yours that starts within `ahead` ms or is going on now (the one starting
 * soonest; one under way before one coming). Not all-day events, ones you declined, out-of-office or focus time.
 * Returns { ev, label } or null; label: "in 5 min", "now", "started 10 min ago".
 */
export function nextMeeting(events, now = Date.now(), ahead = 15 * 60e3) {
  const fits = (e) => !e.all_day && e.my_status !== 'no' && e.kind !== 'ooo' && e.kind !== 'focus' && e.end > now && e.start - now <= ahead;
  const list = (events || []).filter(fits).sort((a, b) => a.start - b.start);
  const ev = list.find((e) => e.start <= now) || list[0];
  if (!ev) return null;
  const mins = Math.round((ev.start - now) / 60e3);
  const label = mins > 0 ? `in ${mins} min` : mins === 0 ? 'now' : `started ${-mins} min ago`;
  return { ev, label };
}

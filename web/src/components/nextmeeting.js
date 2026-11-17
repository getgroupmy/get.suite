/**
 * The meeting to show in the top bar: one of yours that starts within `ahead` ms or is going on now (the one starting
 * soonest; one under way before one coming). Not all-day events, ones you declined, out-of-office or focus time.
 * Ones waved away (× on the chip: their meetingKey in `dismissed`) aren't shown again.
 * Returns { ev, label } or null; label: "in 5 min", "now", "started 10 min ago".
 */
export function nextMeeting(events, now = Date.now(), ahead = 15 * 60e3, dismissed = []) {
  const fits = (e) => !dismissed.includes(meetingKey(e)) && !e.all_day && e.my_status !== 'no' && e.kind !== 'ooo' && e.kind !== 'focus' && e.end > now && e.start - now <= ahead;
  const list = (events || []).filter(fits).sort((a, b) => a.start - b.start);
  const ev = list.find((e) => e.start <= now) || list[0];
  if (!ev) return null;
  const mins = Math.round((ev.start - now) / 60e3);
  const label = mins > 0 ? `in ${mins} min` : mins === 0 ? 'now' : `started ${-mins} min ago`;
  return { ev, label };
}

/** One meeting (one occurrence of a repeating one), for remembering it was waved away. */
export const meetingKey = (e) => `${e.id}@${e.start}`;
/** Waved away ones that have ended are forgotten (kept: at most a day's worth). */
export const keepDismissed = (keys, now = Date.now()) => keys.filter((k) => Number(k.split('@')[1]) > now - 864e5).slice(-50);

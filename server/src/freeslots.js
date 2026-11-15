// Free times for a meeting: gaps in everyone's calendars inside working hours (in a time zone),
// for the MCP server's find_free_time.
import { wallClock, fromWallClock } from './calmath.js';
import { zoneOrUtc } from './ics.js';


/** Busy times overlapping, joined: [[start, end]] sorted. */
export function mergeBusy(list) {
  const out = [];
  for (const [s, e] of [...list].filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0])) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e); else out.push([s, e]);
  }
  return out;
}

/**
 * Up to `max` free times of `minutes` between from and to: each the earliest start (on a `step`-minute
 * mark) in a gap, inside dayStart–dayEnd o'clock in `tz`, weekdays only unless `weekends`.
 */
export function freeSlots({ busy = [], from, to, minutes = 30, tz = 'UTC', dayStart = 9, dayEnd = 17, weekends = false, max = 10, step = 15 }) {
  const zone = zoneOrUtc(tz);
  const len = minutes * 6e4, stepMs = step * 6e4;
  const merged = mergeBusy(busy);
  const out = [];
  const first = wallClock(from, zone);
  for (let i = 0; out.length < max; i++) {
    const day = new Date(Date.UTC(first.y, first.m, first.d + i));
    const [y, m, d] = [day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()];
    const open = fromWallClock(y, m, d, dayStart, 0, 0, 0, zone);
    if (open >= to || i > 400) break;
    if (!weekends && [0, 6].includes(day.getUTCDay())) continue;
    const close = Math.min(fromWallClock(y, m, d, dayEnd, 0, 0, 0, zone), to);
    let t = Math.max(open, from);
    t = open + Math.ceil((t - open) / stepMs) * stepMs; // on the quarter hour (from the day's start)
    for (const [s, e] of merged) {
      if (out.length >= max) break;
      if (e <= t) continue;
      if (s >= close) break;
      if (s - t >= len) out.push({ start: t, end: t + len });
      t = Math.max(t, open + Math.ceil((e - open) / stepMs) * stepMs);
    }
    if (out.length < max && close - t >= len) out.push({ start: t, end: t + len });
  }
  return out.slice(0, max);
}

// A copy of web/src/apps/calendar/calmath.js (the server uses it to work out free time for booking pages).
// Keep the two the same: test/calmath-copy.test.js checks.
// Pure helpers for the calendar views (local time): visible ranges, moving between periods, and
// laying out timed events side by side in the week/day grid.

export const DAY = 864e5;
export const VIEWS = ['month', 'week', 'day', 'year', 'schedule'];
export const SCHEDULE_DAYS = 28; // the schedule lists four weeks from the day it starts

export const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
/** The Sunday on or before d (weeks start on Sunday, as in the month view). */
export const startOfWeek = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/** The days shown: 42 for the month grid, 7 for a week, 1 for a day. */
export function visibleDays(view, anchor) {
  if (view === 'day') return [startOfDay(anchor)];
  if (view === 'year') { const y = anchor.getFullYear(); const n = Math.round((new Date(y + 1, 0, 1) - new Date(y, 0, 1)) / 864e5); return Array.from({ length: n }, (_, i) => new Date(y, 0, 1 + i)); }
  if (view === 'schedule') return Array.from({ length: SCHEDULE_DAYS }, (_, i) => addDays(startOfDay(anchor), i));
  if (view === 'week') { const s = startOfWeek(anchor); return Array.from({ length: 7 }, (_, i) => addDays(s, i)); }
  const first = startOfWeek(new Date(anchor.getFullYear(), anchor.getMonth(), 1));
  return Array.from({ length: 42 }, (_, i) => addDays(first, i));
}

/** Move by one month / week / day (dir = 1 or -1). Months keep the day where possible. */
export function shift(view, anchor, dir) {
  if (view === 'day') return addDays(anchor, dir);
  if (view === 'year') { const y = anchor.getFullYear() + dir; return new Date(y, anchor.getMonth(), Math.min(anchor.getDate(), new Date(y, anchor.getMonth() + 1, 0).getDate())); }
  if (view === 'schedule') return addDays(anchor, SCHEDULE_DAYS * dir);
  if (view === 'week') return addDays(anchor, 7 * dir);
  const target = new Date(anchor.getFullYear(), anchor.getMonth() + dir, 1);
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return new Date(target.getFullYear(), target.getMonth(), Math.min(anchor.getDate(), last));
}

export function title(view, anchor, locale) {
  if (view === 'month') return anchor.toLocaleDateString(locale, { month: 'long', year: 'numeric' });
  if (view === 'year') return String(anchor.getFullYear());
  if (view === 'day') return anchor.toLocaleDateString(locale, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  if (view === 'schedule') return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', year: 'numeric' }).formatRange(startOfDay(anchor), addDays(startOfDay(anchor), SCHEDULE_DAYS - 1));
  // formatRange writes ranges the local way, e.g. "Nov 1 – 7, 2026" or "Dec 27, 2026 – Jan 2, 2027".
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', year: 'numeric' }).formatRange(startOfWeek(anchor), addDays(startOfWeek(anchor), 6));
}

/** Events touching a day [dayStart, dayStart + 1 day). Zero-length events count on their day. */
export const onDay = (events, dayStart) => {
  const s = dayStart.getTime(), e = addDays(dayStart, 1).getTime();
  return events.filter((ev) => ev.start < e && (ev.end > s || (ev.end === ev.start && ev.start >= s)));
};

/**
 * Timed events of one day placed in the hour grid: minutes from midnight for top and length (at
 * least `minMinutes`, so short events stay clickable), and a column within each group of
 * overlapping events so they sit side by side. Parts of events from other days are clipped.
 */
export function layoutDay(events, dayStart, { minMinutes = 20 } = {}) {
  const s = dayStart.getTime(), e = addDays(dayStart, 1).getTime();
  const items = onDay(events.filter((ev) => !ev.all_day), dayStart)
    .map((ev) => {
      const from = Math.max(ev.start, s), to = Math.min(Math.max(ev.end, ev.start), e);
      const top = (from - s) / 6e4;
      return { ev, top, height: Math.max(minMinutes, (to - from) / 6e4), col: 0, cols: 1 };
    })
    .sort((a, b) => a.top - b.top || b.height - a.height);
  // Groups of events that overlap (directly or through each other) share the width.
  let group = [], groupEnd = -1;
  const close = () => { const n = Math.max(0, ...group.map((g) => g.col)) + 1; for (const g of group) g.cols = n; group = []; };
  for (const it of items) {
    if (it.top >= groupEnd) { close(); groupEnd = -1; }
    const used = new Set(group.filter((g) => g.top + g.height > it.top).map((g) => g.col));
    let col = 0;
    while (used.has(col)) col++;
    it.col = col;
    group.push(it);
    groupEnd = Math.max(groupEnd, it.top + it.height);
  }
  close();
  return items;
}

// ---- repeating events ----
const MAX_STEPS = 20000; // safety cap when walking a long series

// Wall-clock time in a named time zone, so a repeating event is worked out in its own zone: a 9:00
// meeting in Berlin stays at 9:00 Berlin time for someone looking at it from Kuala Lumpur.
let zoneHere = null;
const localZone = () => (zoneHere ??= Intl.DateTimeFormat().resolvedOptions().timeZone);
const fmts = new Map();
function zoneFormat(tz) {
  if (!fmts.has(tz)) {
    let f = null;
    try { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }); } catch { /* unknown zone */ }
    fmts.set(tz, f);
  }
  return fmts.get(tz);
}
/** The zone a repeating event is worked out in: its own (timed events), else this browser's. */
const zoneOf = (ev) => (!ev.all_day && ev.tz && zoneFormat(ev.tz) ? ev.tz : localZone());
/** { y, m (0-11), d, h, mi, s, ms, wd } of `t` in zone `tz`. */
export function wallClock(t, tz) {
  if (tz === localZone()) { const d = new Date(t); return { y: d.getFullYear(), m: d.getMonth(), d: d.getDate(), h: d.getHours(), mi: d.getMinutes(), s: d.getSeconds(), ms: d.getMilliseconds(), wd: d.getDay() }; }
  const p = Object.fromEntries(zoneFormat(tz).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  const w = { y: +p.year, m: +p.month - 1, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second, ms: ((t % 1000) + 1000) % 1000 };
  w.wd = new Date(Date.UTC(w.y, w.m, w.d)).getUTCDay();
  return w;
}
// Offsets only change on the quarter hour, so they are kept per zone and quarter hour.
const offsets = new Map();
function offsetMin(t, tz) {
  const key = `${tz}|${Math.floor(t / 9e5)}`;
  let o = offsets.get(key);
  if (o === undefined) {
    const w = wallClock(t, tz);
    o = Math.round((Date.UTC(w.y, w.m, w.d, w.h, w.mi, w.s, w.ms) - t) / 6e4);
    if (offsets.size > 200000) offsets.clear();
    offsets.set(key, o);
  }
  return o;
}
/** The moment a wall-clock time happens in zone `tz` (months and days may overflow, as with Date). */
export function fromWallClock(y, m, d, h, mi, s, ms, tz) {
  if (tz === localZone()) return new Date(y, m, d, h, mi, s, ms).getTime();
  const guess = Date.UTC(y, m, d, h, mi, s, ms);
  let t = guess - offsetMin(guess, tz) * 6e4;
  t = guess - offsetMin(t, tz) * 6e4;
  return t;
}

/** Calendar days from a to b (local dates), ignoring the time of day and clock changes. */
export const daysBetween = (a, b) => Math.round((startOfDay(b) - startOfDay(a)) / DAY);

/**
 * The occurrence starts of a repeating event that begin before `to` (all of them from the first,
 * since "after N times" counts from the start), in local wall-clock time: a 9:00 weekly meeting
 * stays at 9:00 across clock changes. Skipped dates (exdates) are left out but still counted.
 */
export function occurrenceStarts(ev, to) {
  const r = ev.rrule;
  if (!r) return [ev.start];
  const tz = zoneOf(ev);
  const w0 = wallClock(ev.start, tz);
  // A date (in the event's zone) at the event's time of day; getFullYear/getMonth/getDate/getDay
  // of the returned object are that date, getTime() the real moment.
  const at = (y, m, d) => {
    const day = new Date(Date.UTC(y, m, d));
    const t = fromWallClock(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), w0.h, w0.mi, w0.s, w0.ms, tz);
    return { getTime: () => t, getFullYear: () => day.getUTCFullYear(), getMonth: () => day.getUTCMonth(), getDate: () => day.getUTCDate(), getDay: () => day.getUTCDay() };
  };
  const first = at(w0.y, w0.m, w0.d);
  const startOfWeek = (d) => at(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay());
  const every = r.interval || 1;
  const out = [];
  let n = 0;
  const take = (t) => {
    if (r.until !== undefined && t > r.until) return false;
    if (r.count !== undefined && n >= r.count) return false;
    if (t >= to) return false;
    n++;
    out.push(t);
    return true;
  };
  for (let i = 0; i < MAX_STEPS; i++) {
    if (r.freq === 'daily') {
      if (!take(at(first.getFullYear(), first.getMonth(), first.getDate() + i * every).getTime())) break;
    } else if (r.freq === 'weekly') {
      const days = r.byday?.length ? r.byday : [first.getDay()];
      const week = startOfWeek(first);
      let stop = false;
      for (const wd of days) {
        const t = at(week.getFullYear(), week.getMonth(), week.getDate() + i * 7 * every + wd).getTime();
        if (t < ev.start) continue; // days earlier in the first week
        if (!take(t)) { stop = true; break; }
      }
      if (stop) break;
    } else if (r.freq === 'monthly' && r.nth) {
      // Monthly on a weekday: the 1st–4th or the last (say) Monday of every month.
      const m = at(first.getFullYear(), first.getMonth() + i * every, 1);
      const day = nthWeekdayOf(m.getFullYear(), m.getMonth(), r.nth, r.wd);
      const t = at(m.getFullYear(), m.getMonth(), day).getTime();
      if (t >= to || (r.until !== undefined && t > r.until)) break;
      if (t < ev.start) continue; // earlier in the first month
      if (!take(t)) break;
    } else {
      // Monthly / yearly on the same date; months without that date (31st, 29 Feb) are skipped.
      const months = r.freq === 'monthly' ? i * every : i * 12 * every;
      const d = at(first.getFullYear(), first.getMonth() + months, first.getDate());
      const t = d.getTime();
      if (t >= to || (r.until !== undefined && t > r.until)) break;
      if (d.getDate() !== first.getDate()) continue;
      if (!take(t)) break;
    }
  }
  return out;
}

/** The day of the month that is the `nth` (1–4, or -1 for the last) weekday `wd` (0 = Sunday) of month `m` (0-based). */
export function nthWeekdayOf(y, m, nth, wd) {
  if (nth === -1) {
    const last = new Date(Date.UTC(y, m + 1, 0));
    return last.getUTCDate() - ((last.getUTCDay() - wd + 7) % 7);
  }
  const firstDow = new Date(Date.UTC(y, m, 1)).getUTCDay();
  return 1 + ((wd - firstDow + 7) % 7) + (nth - 1) * 7;
}

/**
 * Which weekday of its month a date is: { wd, nth (1–5), last (no more of that weekday in the month) }
 * — for "Monthly on the second Monday" and "Monthly on the last Friday".
 */
export function weekdayInMonth(t) {
  const d = new Date(t);
  const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  return { wd: d.getDay(), nth: Math.ceil(d.getDate() / 7), last: d.getDate() + 7 > daysInMonth };
}
const ORDINALS = { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', '-1': 'last' };

/** The event's occurrences that touch [from, to), each a copy with its own start and end. */
export function expand(ev, from, to) {
  if (!ev.rrule) return ev.start < to && ev.end >= from ? [ev] : [];
  const tz = zoneOf(ev);
  const a = wallClock(ev.start, tz), b = wallClock(ev.end, tz);
  const spanDays = Math.round((Date.UTC(b.y, b.m, b.d) - Date.UTC(a.y, a.m, a.d)) / DAY);
  const skip = new Set(ev.exdates || []);
  const out = [];
  const longest = ev.end - ev.start + 2 * DAY; // an occurrence can't last longer than this (clock changes included)
  for (const start of occurrenceStarts(ev, to)) {
    if (skip.has(start) || start + longest < from) continue;
    const s = wallClock(start, tz);
    const end = fromWallClock(s.y, s.m, s.d + spanDays, b.h, b.mi, b.s, b.ms, tz);
    if (end < from) continue;
    out.push({ ...ev, start, end, occurrence: start, seriesStart: ev.start, seriesEnd: ev.end, key: `${ev.id}@${start}` });
  }
  return out;
}

/** All events touching [from, to), repeating ones expanded. */
export const expandAll = (events, from, to) => events.flatMap((ev) => expand(ev, from, to)).sort((a, b) => a.start - b.start);

/** How many occurrences come before this one (for "this and following" on a counted series). */
export const occurrenceIndex = (ev, occurrence) => occurrenceStarts(ev, occurrence).length;

/** A short description of a rule: "Weekly on Mon, Thu", "Every 2 months", "Daily, 5 times". */
export function describeRule(r, start, locale) {
  if (!r) return 'Does not repeat';
  const n = r.interval || 1;
  const unit = { daily: ['Daily', 'days'], weekly: ['Weekly', 'weeks'], monthly: ['Monthly', 'months'], yearly: ['Yearly', 'years'] }[r.freq];
  let text = n === 1 ? unit[0] : `Every ${n} ${unit[1]}`;
  if (r.freq === 'weekly') {
    const days = r.byday?.length ? r.byday : [new Date(start).getDay()];
    const names = days.map((d) => new Date(2026, 10, 1 + d).toLocaleDateString(locale, { weekday: 'short' }));
    text += ` on ${days.join() === '1,2,3,4,5' ? 'weekdays' : names.join(', ')}`;
  }
  if (r.freq === 'monthly' && r.nth) text += ` on the ${ORDINALS[r.nth]} ${new Date(2026, 10, 1 + r.wd).toLocaleDateString(locale, { weekday: 'long' })}`;
  if (r.count) text += `, ${r.count} times`;
  if (r.until !== undefined) text += `, until ${new Date(r.until).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' })}`;
  return text;
}

// ---- dragging events ----
/** An event moved by whole calendar days and minutes, keeping its length (wall-clock, DST-safe for whole days). */
export function moveTimes(ev, dayDelta, minDelta) {
  const s = new Date(ev.start), e = new Date(ev.end);
  const start = new Date(s.getFullYear(), s.getMonth(), s.getDate() + dayDelta, s.getHours(), s.getMinutes() + minDelta, s.getSeconds(), s.getMilliseconds()).getTime();
  // Whole-day moves keep the end's time of day; time moves keep the length.
  const end = minDelta === 0
    ? new Date(e.getFullYear(), e.getMonth(), e.getDate() + dayDelta, e.getHours(), e.getMinutes(), e.getSeconds(), e.getMilliseconds()).getTime()
    : start + (ev.end - ev.start);
  return { start, end };
}

/** A new end time, at least `minMinutes` after the start. */
export function resizeEnd(ev, minDelta, minMinutes = 15) {
  const e = new Date(ev.end);
  const end = new Date(e.getFullYear(), e.getMonth(), e.getDate(), e.getHours(), e.getMinutes() + minDelta, e.getSeconds(), e.getMilliseconds()).getTime();
  return { start: ev.start, end: Math.max(end, ev.start + minMinutes * 6e4) };
}

/**
 * A weekly rule's weekdays after the series moves by `dayDelta` days (Mon/Wed moved a day later: Tue/Thu);
 * a monthly-on-a-weekday rule takes the weekday of `newStart`.
 */
export function shiftWeekdays(rule, dayDelta, newStart) {
  // Monthly on a weekday follows the new date: moved to the third Tuesday, it's the third Tuesday.
  if (rule?.freq === 'monthly' && rule.nth && newStart !== undefined && dayDelta) {
    const w = weekdayInMonth(newStart);
    return { ...rule, wd: w.wd, nth: (rule.nth === -1 && w.last) || w.nth > 4 ? -1 : w.nth };
  }
  if (!rule || rule.freq !== 'weekly' || !rule.byday?.length || dayDelta % 7 === 0) return rule;
  return { ...rule, byday: [...new Set(rule.byday.map((d) => (((d + dayDelta) % 7) + 7) % 7))].sort() };
}

/** Minutes for a vertical drag of `px` pixels, snapped to `step` minutes. */
export const snapMinutes = (px, hourPx, step = 15) => Math.round((px / hourPx) * 60 / step) * step;

/** The schedule: the days in `days` that have something, each with its items (all-day first, then by time). */
export function scheduleOf(events, days) {
  return days.map((d) => ({ day: d, items: onDay(events, d).sort((a, b) => (b.all_day ? 1 : 0) - (a.all_day ? 1 : 0) || a.start - b.start) }))
    .filter((x) => x.items.length);
}

/** Printing: the days of a range ('week' = this week from Monday, 'month' = this calendar month, 'four' = four weeks from today). */
export function printRange(kind, today = new Date()) {
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (kind === 'month') return { from: new Date(d.getFullYear(), d.getMonth(), 1), to: new Date(d.getFullYear(), d.getMonth() + 1, 0) };
  if (kind === 'four') return { from: d, to: new Date(d.getFullYear(), d.getMonth(), d.getDate() + 27) };
  const back = (d.getDay() + 6) % 7; // Monday
  const from = new Date(d.getFullYear(), d.getMonth(), d.getDate() - back);
  return { from, to: new Date(from.getFullYear(), from.getMonth(), from.getDate() + 6) };
}
/** Every day from `from` to `to` (local dates, both included; at most 92). */
export function daysFromTo(from, to) {
  const out = [];
  for (let d = new Date(from.getFullYear(), from.getMonth(), from.getDate()); d <= to && out.length < 92; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) out.push(d);
  return out;
}

/**
 * The event form after its start changes: the end moves with it, keeping the length (as in other
 * calendars), so moving a late-evening draft to 16:00 doesn't leave it ending the next day.
 * form: { startDate: 'YYYY-MM-DD', startTime: 'HH:MM', endDate, endTime, all_day }.
 */
export function moveStart(form, change) {
  const at = (d, t) => new Date(`${d}T${form.all_day ? '00:00' : t || '00:00'}`).getTime();
  const oldStart = at(form.startDate, form.startTime), oldEnd = at(form.endDate, form.endTime);
  const next = { ...form, ...change };
  const ns = at(next.startDate, next.startTime);
  if (!Number.isFinite(oldStart) || !Number.isFinite(oldEnd) || !Number.isFinite(ns)) return next;
  const end = new Date(ns + Math.max(0, oldEnd - oldStart));
  const pad = (n) => String(n).padStart(2, '0');
  return { ...next, endDate: `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())}`, ...(!form.all_day && { endTime: `${pad(end.getHours())}:${pad(end.getMinutes())}` }) };
}

/** For the year view: how many events touch each day, by the day's start time (local midnight). */
export function eventsPerDay(events, days) {
  const out = new Map();
  if (!days.length) return out;
  const first = days[0].getTime(), last = addDays(days.at(-1), 1).getTime();
  for (const ev of events) {
    let d = startOfDay(new Date(Math.max(ev.start, first)));
    const end = Math.min(ev.end > ev.start ? ev.end : ev.start + 1, last);
    for (let k = 0; d.getTime() < end && k < 400; k++, d = addDays(d, 1)) out.set(d.getTime(), (out.get(d.getTime()) || 0) + 1);
  }
  return out;
}

/** The ISO week number of a day (weeks start on Monday; week 1 holds the year's first Thursday). */
export function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  return Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 864e5 + 1) / 7);
}

/** The days a view shows: without Saturdays and Sundays in the week and month views when weekends are hidden. */
export function daysShown(view, days, weekends = true) {
  return weekends || (view !== 'week' && view !== 'month') ? days : days.filter((d) => d.getDay() !== 0 && d.getDay() !== 6);
}

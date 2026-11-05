// Pure helpers for the calendar views (local time): visible ranges, moving between periods, and
// laying out timed events side by side in the week/day grid.

export const DAY = 864e5;
export const VIEWS = ['month', 'week', 'day'];

export const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
/** The Sunday on or before d (weeks start on Sunday, as in the month view). */
export const startOfWeek = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/** The days shown: 42 for the month grid, 7 for a week, 1 for a day. */
export function visibleDays(view, anchor) {
  if (view === 'day') return [startOfDay(anchor)];
  if (view === 'week') { const s = startOfWeek(anchor); return Array.from({ length: 7 }, (_, i) => addDays(s, i)); }
  const first = startOfWeek(new Date(anchor.getFullYear(), anchor.getMonth(), 1));
  return Array.from({ length: 42 }, (_, i) => addDays(first, i));
}

/** Move by one month / week / day (dir = 1 or -1). Months keep the day where possible. */
export function shift(view, anchor, dir) {
  if (view === 'day') return addDays(anchor, dir);
  if (view === 'week') return addDays(anchor, 7 * dir);
  const target = new Date(anchor.getFullYear(), anchor.getMonth() + dir, 1);
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return new Date(target.getFullYear(), target.getMonth(), Math.min(anchor.getDate(), last));
}

export function title(view, anchor, locale) {
  if (view === 'month') return anchor.toLocaleDateString(locale, { month: 'long', year: 'numeric' });
  if (view === 'day') return anchor.toLocaleDateString(locale, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
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
  const first = new Date(ev.start);
  const [h, mi, s, ms] = [first.getHours(), first.getMinutes(), first.getSeconds(), first.getMilliseconds()];
  const at = (y, m, d) => new Date(y, m, d, h, mi, s, ms);
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

/** The event's occurrences that touch [from, to), each a copy with its own start and end. */
export function expand(ev, from, to) {
  if (!ev.rrule) return ev.start < to && ev.end >= from ? [ev] : [];
  const first = new Date(ev.start), last = new Date(ev.end);
  const spanDays = daysBetween(first, last);
  const skip = new Set(ev.exdates || []);
  const out = [];
  for (const start of occurrenceStarts(ev, to)) {
    if (skip.has(start)) continue;
    const s = new Date(start);
    const end = new Date(s.getFullYear(), s.getMonth(), s.getDate() + spanDays, last.getHours(), last.getMinutes(), last.getSeconds(), last.getMilliseconds()).getTime();
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

/** A weekly rule's weekdays after the series moves by `dayDelta` days (Mon/Wed moved a day later: Tue/Thu). */
export function shiftWeekdays(rule, dayDelta) {
  if (!rule || rule.freq !== 'weekly' || !rule.byday?.length || dayDelta % 7 === 0) return rule;
  return { ...rule, byday: [...new Set(rule.byday.map((d) => (((d + dayDelta) % 7) + 7) % 7))].sort() };
}

/** Minutes for a vertical drag of `px` pixels, snapped to `step` minutes. */
export const snapMinutes = (px, hourPx, step = 15) => Math.round((px / hourPx) * 60 / step) * step;

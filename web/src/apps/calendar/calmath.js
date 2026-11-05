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

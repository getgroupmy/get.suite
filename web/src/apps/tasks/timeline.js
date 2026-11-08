// The timeline view of a task list: each task with a due date is a bar from its start (or just
// its due day) to its due date, on a strip of days. Dates are plain YYYY-MM-DD days.
const ms = (d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
const iso = (t) => new Date(t).toISOString().slice(0, 10);
/** A day moved by n days. */
export const addDays = (d, n) => iso(ms(d) + n * 86400000);
/** Whole days from a to b. */
export const daysFrom = (a, b) => Math.round((ms(b) - ms(a)) / 86400000);
/** Monday of the week a day is in. */
export const mondayOf = (d) => addDays(d, -((new Date(ms(d)).getUTCDay() + 6) % 7));

/** The days a task covers: { from, to }, or null without a due date. */
export function barOf(t) {
  if (!t.due) return null;
  return { from: t.start && t.start <= t.due ? t.start : t.due, to: t.due };
}

/**
 * The strip of days to show: from the Monday of the week before the earliest bar (or today),
 * whole weeks, at least `weeks` of them, to past the latest bar.
 */
export function timelineRange(tasks, today, weeks = 6) {
  const bars = tasks.map(barOf).filter(Boolean);
  const first = bars.reduce((m, b) => (b.from < m ? b.from : m), today);
  const last = bars.reduce((m, b) => (b.to > m ? b.to : m), today);
  const from = mondayOf(addDays(first, -7));
  const days = Math.max(weeks * 7, Math.ceil((daysFrom(from, last) + 8) / 7) * 7);
  return { from, days };
}

/**
 * What dragging a bar by `delta` days changes: 'move' shifts the whole bar, 'end' the due date
 * (never before the start), 'start' the start (never after the due date). {} for no change.
 */
export function dragChange(t, mode, delta) {
  const bar = barOf(t);
  if (!bar || !delta) return {};
  if (mode === 'move') return t.start ? { start: addDays(t.start, delta), due: addDays(t.due, delta) } : { due: addDays(t.due, delta) };
  if (mode === 'end') { const due = addDays(t.due, delta); return due < bar.from ? (t.start ? { due: bar.from } : { due }) : { due }; }
  const start = addDays(bar.from, delta);
  return { start: start > t.due ? t.due : start };
}

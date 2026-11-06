// Small pieces of Tasks that are easy to get wrong: due-date wording and where a dragged task goes.

const day = (d) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5;

/** "Today", "Tomorrow", "Overdue · Mon 3 Nov", "Fri 14 Nov"... with a tone for colour (late, soon, or none). */
export function dueLabel(due, now = new Date()) {
  const [y, m, d] = due.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const diff = day(date) - day(now);
  const short = date.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', ...(y !== now.getFullYear() && { year: 'numeric' }) });
  if (diff < 0) return { text: diff === -1 ? 'Yesterday' : short, tone: 'late' };
  if (diff === 0) return { text: 'Today', tone: 'soon' };
  if (diff === 1) return { text: 'Tomorrow', tone: 'soon' };
  return { text: short, tone: '' };
}

/** A position between two neighbours (either may be missing: the top or the bottom of the list). */
export function between(before, after) {
  if (before === undefined && after === undefined) return 0;
  if (before === undefined) return after - 1;
  if (after === undefined) return before + 1;
  return (before + after) / 2;
}

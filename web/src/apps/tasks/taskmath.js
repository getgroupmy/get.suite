// Small pieces of Tasks that are easy to get wrong: due-date wording and where a dragged task goes.

const day = (d) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5;

/** "Today", "Tomorrow", "Overdue · Mon 3 Nov", "Fri 14 Nov"... with a tone for colour (late, soon, or none). */
export function dueLabel(due, now = new Date(), time = null) {
  const [y, m, d] = due.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const diff = day(date) - day(now);
  const short = date.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', ...(y !== now.getFullYear() && { year: 'numeric' }) });
  const at = time ? ` ${time}` : '';
  if (diff < 0) return { text: (diff === -1 ? 'Yesterday' : short) + at, tone: 'late' };
  if (diff === 0) return { text: `Today${at}`, tone: time && dueAt(due, time) <= now.getTime() ? 'late' : 'soon' };
  if (diff === 1) return { text: `Tomorrow${at}`, tone: 'soon' };
  return { text: short + at, tone: '' };
}

/** When a task with a due time is due (local time), as a timestamp. */
export function dueAt(due, time) {
  const [y, m, d] = due.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  return new Date(y, m - 1, d, h, mi).getTime();
}

/** A position between two neighbours (either may be missing: the top or the bottom of the list). */
export function between(before, after) {
  if (before === undefined && after === undefined) return 0;
  if (before === undefined) return after - 1;
  if (after === undefined) return before + 1;
  return (before + after) / 2;
}

/** Today's date where the person is, as YYYY-MM-DD (repeating tasks count from it). */
export function localToday(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** How a task can repeat, with what the picker and the list say. */
export const REPEATS = [['', 'Does not repeat'], ['daily', 'Every day'], ['weekdays', 'Every weekday (Mon–Fri)'], ['weekly', 'Every week'], ['monthly', 'Every month'], ['yearly', 'Every year']];
export const repeatText = (r) => ({ daily: 'Daily', weekdays: 'Weekdays', weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly' }[r] || '');

export const SORTS = [['mine', 'My order'], ['due', 'Due date'], ['title', 'Title'], ['added', 'Recently added'], ['important', 'Starred first']];
/** Open tasks in the chosen order (they arrive in "my order"; ties keep it). */
export function sortTasks(tasks, sort) {
  const at = new Map(tasks.map((t, i) => [t.id, i]));
  const keep = (a, b) => at.get(a.id) - at.get(b.id);
  const list = [...tasks];
  if (sort === 'due') list.sort((a, b) => (!a.due) - (!b.due) || (a.due || '').localeCompare(b.due || '') || (!a.due_time) - (!b.due_time) || (a.due_time || '').localeCompare(b.due_time || '') || keep(a, b));
  else if (sort === 'title') list.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true }) || keep(a, b));
  else if (sort === 'added') list.sort((a, b) => b.created_at - a.created_at || keep(a, b));
  else if (sort === 'important') list.sort((a, b) => (!a.important) - (!b.important) || keep(a, b));
  return list;
}

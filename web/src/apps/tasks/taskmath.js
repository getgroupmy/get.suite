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
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const UNITS = { day: ['day', 'days'], week: ['week', 'weeks'], month: ['month', 'months'], year: ['year', 'years'] };

/** A custom repeat ("every:2:week:1,4") as { n, unit, days }, or null for anything else. */
export function readCustom(r) {
  const m = /^every:(\d{1,2}):(day|week|month|year)(?::([0-6](?:,[0-6])*))?$/.exec(String(r || ''));
  return m ? { n: Number(m[1]), unit: m[2], days: m[3] ? m[3].split(',').map(Number) : [] } : null;
}

/** The repeat for every n units (on some weekdays, for weeks), with plain ones by their simple names (as the server keeps them). */
export function customRepeat({ n, unit, days = [] }) {
  const k = Math.max(1, Math.min(99, Math.round(Number(n) || 1)));
  const d = unit === 'week' ? [...new Set(days)].sort((a, b) => a - b) : [];
  if (k === 1 && !d.length) return { day: 'daily', week: 'weekly', month: 'monthly', year: 'yearly' }[unit];
  if (k === 1 && d.join() === '1,2,3,4,5') return 'weekdays';
  return `every:${k}:${unit}${d.length ? `:${d.join(',')}` : ''}`;
}

/** "Daily", "Every 2 weeks on Mon, Thu", "Every 3 months". */
export function repeatText(r) {
  const plain = { daily: 'Daily', weekdays: 'Weekdays', weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly' }[r];
  if (plain) return plain;
  const c = readCustom(r);
  if (!c) return '';
  const every = c.n === 1 ? `Every ${UNITS[c.unit][0]}` : `Every ${c.n} ${UNITS[c.unit][1]}`;
  return c.days.length ? `${every} on ${c.days.map((d) => WEEKDAYS[d]).join(', ')}` : every;
}

// Priority: high, medium, low (or none), with how each shows on a task.
export const PRIORITY_RANK = { high: 3, medium: 2, low: 1 };
export const PRIORITIES = [['high', 'High', '!!!'], ['medium', 'Medium', '!!'], ['low', 'Low', '!']];
export const SORTS = [['mine', 'My order'], ['due', 'Due date'], ['title', 'Title'], ['added', 'Recently added'], ['important', 'Starred first'], ['priority', 'Priority']];
/** Open tasks in the chosen order (they arrive in "my order"; ties keep it). */
export function sortTasks(tasks, sort) {
  const at = new Map(tasks.map((t, i) => [t.id, i]));
  const keep = (a, b) => at.get(a.id) - at.get(b.id);
  const list = [...tasks];
  if (sort === 'due') list.sort((a, b) => (!a.due) - (!b.due) || (a.due || '').localeCompare(b.due || '') || (!a.due_time) - (!b.due_time) || (a.due_time || '').localeCompare(b.due_time || '') || keep(a, b));
  else if (sort === 'title') list.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true }) || keep(a, b));
  else if (sort === 'added') list.sort((a, b) => b.created_at - a.created_at || keep(a, b));
  else if (sort === 'important') list.sort((a, b) => (!a.important) - (!b.important) || keep(a, b));
  else if (sort === 'priority') list.sort((a, b) => (PRIORITY_RANK[b.priority] || 0) - (PRIORITY_RANK[a.priority] || 0) || keep(a, b)); // high first, none last
  return list;
}

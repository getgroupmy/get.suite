// The Planned view (Tasks): open tasks with a due date from all your lists, in groups by when they're due.

export const PLAN_GROUPS = [['overdue', 'Overdue'], ['today', 'Today'], ['tomorrow', 'Tomorrow'], ['week', 'Next 7 days'], ['later', 'Later']];

const addDays = (ymd, n) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/** Which group a due date (YYYY-MM-DD) falls in, seen from today (YYYY-MM-DD, your local day). */
export function planGroup(due, today) {
  if (!due) return null;
  if (due < today) return 'overdue';
  if (due === today) return 'today';
  if (due === addDays(today, 1)) return 'tomorrow';
  if (due <= addDays(today, 7)) return 'week';
  return 'later';
}

/** The tasks in their groups, in order, leaving out empty groups: [{ key, label, tasks }]. */
export function groupPlanned(tasks, today) {
  const by = new Map(PLAN_GROUPS.map(([k]) => [k, []]));
  for (const t of tasks) { const g = planGroup(t.due, today); if (g) by.get(g).push(t); }
  return PLAN_GROUPS.map(([key, label]) => ({ key, label, tasks: by.get(key) })).filter((g) => g.tasks.length);
}

const localYmd = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/**
 * The Completed view: tasks you ticked off, in groups by the day you did (newest first), labelled
 * Today, Yesterday or the date: [{ key: 'YYYY-MM-DD', label, tasks }].
 */
export function groupCompleted(tasks, now = Date.now()) {
  const today = localYmd(now), yesterday = addDays(today, -1);
  const groups = new Map();
  for (const t of [...tasks].filter((x) => x.done_at).sort((a, b) => b.done_at - a.done_at)) {
    const key = localYmd(t.done_at);
    if (!groups.has(key)) {
      const label = key === today ? 'Today' : key === yesterday ? 'Yesterday'
        : new Date(`${key}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', ...(key.slice(0, 4) !== today.slice(0, 4) ? { year: 'numeric' } : {}) });
      groups.set(key, { key, label, tasks: [] });
    }
    groups.get(key).tasks.push(t);
  }
  return [...groups.values()];
}

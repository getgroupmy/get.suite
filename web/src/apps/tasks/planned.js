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

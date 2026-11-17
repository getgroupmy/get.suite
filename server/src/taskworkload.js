// Tasks → Workload: on a shared list, how much each person on it has open, and when it's due:
// overdue, this week (Monday to Sunday), next week, later, or with no date; and the time it's estimated
// to take. Tasks nobody has been given count under "Not assigned".
import { q } from './db.js';

const ymd = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;

/** The Sunday ending this week and the next, for a day (YYYY-MM-DD). */
export function weekEnds(today) {
  const d = new Date(`${today}T00:00:00Z`);
  const toSunday = (7 - d.getUTCDay()) % 7;
  const end = new Date(d.getTime() + toSunday * 86400000);
  return { thisWeek: ymd(end), nextWeek: ymd(new Date(end.getTime() + 7 * 86400000)) };
}

/** Where a due date falls, seen from today. */
export function bucketOf(due, today) {
  if (!due) return 'no_date';
  if (due < today) return 'overdue';
  const { thisWeek, nextWeek } = weekEnds(today);
  if (due <= thisWeek) return 'this_week';
  if (due <= nextWeek) return 'next_week';
  return 'later';
}

/** One row per person on the list (the owner first, then by name), and "Not assigned" if anything is. */
export function workloadOf(list, today) {
  const people = [list.owner_id, ...q('SELECT user_id FROM task_list_members WHERE list_id = ?').all(list.id).map((r) => r.user_id)];
  const names = new Map(q('SELECT id, name FROM users WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(people)).map((u) => [u.id, u.name]));
  const blank = (user_id, name) => ({ user_id, name, open: 0, overdue: 0, this_week: 0, next_week: 0, later: 0, no_date: 0, estimate: 0 });
  const rows = new Map(people.filter((id) => names.has(id)).map((id) => [id, blank(id, names.get(id))]));
  const none = blank(null, 'Not assigned');
  for (const t of q('SELECT assignee_id, due, estimate FROM tasks WHERE list_id = ? AND done_at IS NULL').all(list.id)) {
    const row = (t.assignee_id && rows.get(t.assignee_id)) || none; // someone who has since left the list: not assigned any more, in effect
    row.open++; row[bucketOf(t.due, today)]++; row.estimate += t.estimate || 0;
  }
  const [owner, ...rest] = [...rows.values()];
  return [owner, ...rest.sort((a, b) => a.name.localeCompare(b.name)), ...(none.open ? [none] : [])].filter(Boolean);
}

// Remind someone of their overdue tasks on a list: a bell notice naming them (the first three). At most once a
// day for each person and list, whoever sends it, so a list's members can't pile them up.
q(`CREATE TABLE IF NOT EXISTS task_workload_reminders (list_id TEXT NOT NULL, user_id TEXT NOT NULL, sent_at INTEGER NOT NULL, PRIMARY KEY (list_id, user_id))`).run();
const DAY = 86400000;

/** The overdue tasks a reminder would name, and whether one may go now: { tasks, wait_until }. */
export function overdueFor(list, userId, today) {
  const tasks = q('SELECT id, title, due FROM tasks WHERE list_id = ? AND assignee_id = ? AND done_at IS NULL AND due IS NOT NULL AND due < ? ORDER BY due, title').all(list.id, userId, today);
  const last = q('SELECT sent_at FROM task_workload_reminders WHERE list_id = ? AND user_id = ?').get(list.id, userId)?.sent_at;
  return { tasks, wait_until: last && Date.now() - last < DAY ? last + DAY : null };
}

export function noteReminder(listId, userId) {
  q('INSERT INTO task_workload_reminders (list_id, user_id, sent_at) VALUES (?, ?, ?) ON CONFLICT(list_id, user_id) DO UPDATE SET sent_at = excluded.sent_at').run(listId, userId, Date.now());
}

/** "“Write the press release”, “Book the venue” and 1 more" */
export function titlesText(tasks) {
  const names = tasks.slice(0, 3).map((t) => `“${t.title}”`);
  const more = tasks.length - names.length;
  if (more > 0) return `${names.join(', ')} and ${more} more`;
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0] || '';
}

/**
 * Across every shared list someone is on (their own or shared with them): each person's open tasks there, added up,
 * with how many of those lists they have open tasks on. Only lists shared with others count (a list of your own
 * nobody else is on isn't a team's). Unassigned tasks aren't anyone's, so they're left out.
 */
export function teamWorkloadOf(userId, today) {
  const lists = q(`SELECT * FROM task_lists WHERE (owner_id = ? OR id IN (SELECT list_id FROM task_list_members WHERE user_id = ?))
                   AND id IN (SELECT list_id FROM task_list_members)`).all(userId, userId);
  const people = new Map();
  for (const l of lists) {
    for (const p of workloadOf(l, today)) {
      if (!p.user_id) continue;
      const t = people.get(p.user_id) || { user_id: p.user_id, name: p.name, lists: 0, open: 0, overdue: 0, this_week: 0, next_week: 0, later: 0, no_date: 0, estimate: 0 };
      for (const k of ['open', 'overdue', 'this_week', 'next_week', 'later', 'no_date', 'estimate']) t[k] += p[k];
      if (p.open) t.lists++;
      people.set(p.user_id, t);
    }
  }
  return { lists: lists.length, people: [...people.values()].sort((a, b) => b.overdue - a.overdue || b.open - a.open || a.name.localeCompare(b.name)) };
}

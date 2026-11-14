// A task's history: who changed what on it, and when (its due date, who it's for, its status, and so
// on), shown in its details so people on a shared list can see what happened. Quick changes in a row
// by the same person to the same thing are one entry (typing a title, ticking off and Undo).
import { q } from './db.js';
import { now } from './util.js';

q(`CREATE TABLE IF NOT EXISTS task_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,             -- no foreign key: a deleted task keeps its history in the trash
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  at INTEGER NOT NULL,
  field TEXT NOT NULL,
  before TEXT,
  after TEXT
)`).run();
q('CREATE INDEX IF NOT EXISTS task_history_task ON task_history(task_id, id)').run();

export const MERGE_MS = 10 * 60e3; // changes to the same thing by the same person this close together are one
export const KEEP = 200; // entries kept per task

const dueOf = (t) => (t.due ? (t.due_time ? `${t.due} ${t.due_time}` : t.due) : null);
const statusOf = (t) => (t.done_at ? 'done' : t.started ? 'progress' : 'todo');
// The things recorded, each as a text value of a tasks row (or null).
const FIELDS = {
  title: (t) => t.title,
  notes: (t) => t.notes || null,
  due: dueOf,
  start: (t) => t.start || null,
  assignee: (t) => t.assignee_id || null,
  status: statusOf,
  priority: (t) => (t.priority == null ? null : String(t.priority)),
  important: (t) => (t.important ? '1' : null),
  list: (t) => t.list_id,
  section: (t) => t.section_id || null,
  repeat: (t) => t.repeat || null,
  tags: (t) => t.tags || null,
  estimate: (t) => (t.estimate == null ? null : String(t.estimate)),
};

/** Record what changed between two versions of a task's row (before and after an update), by userId. Call inside the update's transaction. */
export function recordChanges(before, after, userId, at = now()) {
  {
    for (const [field, value] of Object.entries(FIELDS)) {
      const a = value(before), b = value(after);
      if (a === b) continue;
      const last = q('SELECT * FROM task_history WHERE task_id = ? AND field = ? ORDER BY id DESC LIMIT 1').get(after.id, field);
      if (last && last.user_id === userId && at - last.at < MERGE_MS) {
        if (field === 'notes') q('UPDATE task_history SET after = ?, at = ? WHERE id = ?').run(b ? '1' : null, at, last.id);
        else if (last.before === b) q('DELETE FROM task_history WHERE id = ?').run(last.id); // back as it was: nothing happened
        else q('UPDATE task_history SET after = ?, at = ? WHERE id = ?').run(b, at, last.id);
        continue;
      }
      // Notes are only "changed": what they said isn't kept twice.
      q('INSERT INTO task_history (task_id, user_id, at, field, before, after) VALUES (?, ?, ?, ?, ?, ?)')
        .run(after.id, userId, at, field, field === 'notes' ? null : a, field === 'notes' ? (b ? '1' : null) : b);
    }
    const n = q('SELECT COUNT(*) AS n FROM task_history WHERE task_id = ?').get(after.id).n;
    if (n > KEEP) q('DELETE FROM task_history WHERE id IN (SELECT id FROM task_history WHERE task_id = ? ORDER BY id LIMIT ?)').run(after.id, n - KEEP);
  }
}

const PRIORITY = { 1: 'low', 2: 'medium', 3: 'high' };
/** A task's history, newest first, with the names of the people and lists involved. */
export function historyOf(taskId) {
  const userName = (id) => (id ? q('SELECT name FROM users WHERE id = ?').get(id)?.name || 'Someone who has left' : null);
  const listName = (id) => (id ? q('SELECT name FROM task_lists WHERE id = ?').get(id)?.name || 'a list that was deleted' : null);
  const sectionName = (id) => (id ? q('SELECT name FROM task_sections WHERE id = ?').get(id)?.name || 'a section that was deleted' : null);
  const show = {
    assignee: (v) => (v ? { id: v, name: userName(v) } : null),
    list: listName, section: sectionName,
    priority: (v) => (v ? PRIORITY[v] || null : null),
    tags: (v) => (v ? JSON.parse(v) : []),
    estimate: (v) => (v ? Number(v) : null),
    important: (v) => !!v,
  };
  return q(`SELECT h.*, u.name AS user_name FROM task_history h LEFT JOIN users u ON u.id = h.user_id
            WHERE h.task_id = ? ORDER BY h.at DESC, h.id DESC`).all(taskId).map((h) => {
    const f = show[h.field] || ((v) => v);
    return { at: h.at, field: h.field, user: { id: h.user_id, name: h.user_name || 'Someone who has left' }, before: f(h.before), after: f(h.after) };
  });
}

/** Forget the history of tasks that are gone for good (not on a list, nor in a list's trash). */
export function forgetGoneHistory() {
  q('DELETE FROM task_history WHERE task_id NOT IN (SELECT id FROM tasks) AND task_id NOT IN (SELECT id FROM task_trash)').run();
}

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
  // Lists in a set order (by id), so moving a step up or down isn't a change.
  steps: (t) => canonical(t.steps, (x) => ({ id: x.id, title: x.title, done: !!x.done })),
  files: (t) => canonical(t.attachments, (x) => ({ id: x.id, name: x.name })),
  waiting: (t) => canonical(t.blocked_by, (x) => x),
};
function canonical(json, pick) {
  const l = json ? JSON.parse(json) : [];
  if (!l.length) return null;
  return JSON.stringify(l.map(pick).sort((a, b) => String(a.id ?? a).localeCompare(String(b.id ?? b))));
}

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
const userName = (id) => (id ? q('SELECT name FROM users WHERE id = ?').get(id)?.name || 'Someone who has left' : null);
const listName = (id) => (id ? q('SELECT name FROM task_lists WHERE id = ?').get(id)?.name || 'a list that was deleted' : null);
const sectionName = (id) => (id ? q('SELECT name FROM task_sections WHERE id = ?').get(id)?.name || 'a section that was deleted' : null);
const taskTitle = (id) => q('SELECT title FROM tasks WHERE id = ?').get(id)?.title || q('SELECT title FROM task_trash WHERE id = ?').get(id)?.title || 'a task that was deleted';
const SHOW = {
  assignee: (v) => (v ? { id: v, name: userName(v) } : null),
  list: listName, section: sectionName,
  priority: (v) => (v ? PRIORITY[v] || null : null),
  tags: (v) => (v ? JSON.parse(v) : []),
  estimate: (v) => (v ? Number(v) : null),
  important: (v) => !!v,
  steps: (v) => (v ? JSON.parse(v) : []),
  files: (v) => (v ? JSON.parse(v) : []),
  waiting: (v) => (v ? JSON.parse(v).map((id) => ({ id, title: taskTitle(id) })) : []),
};
const shapeEntry = (h) => {
  const f = SHOW[h.field] || ((v) => v);
  return { at: h.at, field: h.field, user: { id: h.user_id, name: h.user_name || 'Someone who has left' }, before: f(h.before), after: f(h.after) };
};

/** A task's history, newest first, with the names of the people and lists involved. */
export function historyOf(taskId) {
  return q(`SELECT h.*, u.name AS user_name FROM task_history h LEFT JOIN users u ON u.id = h.user_id
            WHERE h.task_id = ? ORDER BY h.at DESC, h.id DESC`).all(taskId).map(shapeEntry);
}

/**
 * What happened on a list, newest first: the history of its tasks (and of those in its trash), tasks
 * added and tasks deleted, each with the task's id and title (and `gone` for one that's deleted).
 * `before` (a time) pages back; entries at the same moment are never split between pages.
 */
export function listActivity(listId, { before = Infinity, limit = 50 } = {}) {
  const sql = `SELECT * FROM (
      SELECT h.at, h.id AS n, h.field, h.before, h.after, h.user_id, h.task_id FROM task_history h WHERE h.task_id IN (SELECT id FROM tasks WHERE list_id = :l)
      UNION ALL SELECT h.at, h.id, h.field, h.before, h.after, h.user_id, h.task_id FROM task_history h WHERE h.task_id IN (SELECT id FROM task_trash WHERE list_id = :l)
      UNION ALL SELECT created_at, 0, 'added', NULL, NULL, created_by, id FROM tasks WHERE list_id = :l
      UNION ALL SELECT json_extract(row, '$.created_at'), 0, 'added', NULL, NULL, json_extract(row, '$.created_by'), id FROM task_trash WHERE list_id = :l
      UNION ALL SELECT deleted_at, 0, 'deleted', NULL, NULL, deleted_by, id FROM task_trash WHERE list_id = :l
    ) WHERE at %s ORDER BY at DESC, n DESC`;
  const cap = Number.isFinite(before) ? before : Number.MAX_SAFE_INTEGER;
  let rows = q(`${sql.replace('%s', '< :b')} LIMIT :n`).all({ l: listId, b: cap, n: limit });
  let more = false;
  if (rows.length === limit) { // finish the moment the page ends on
    const last = rows.at(-1).at;
    rows = [...rows.filter((r) => r.at > last), ...q(sql.replace('%s', '= :b')).all({ l: listId, b: last })];
    more = q(`${sql.replace('%s', '< :b')} LIMIT 1`).all({ l: listId, b: last }).length > 0;
  }
  const entries = rows.map((r) => {
    const live = q('SELECT title FROM tasks WHERE id = ? AND list_id = ?').get(r.task_id, listId);
    const task = { id: r.task_id, title: live?.title ?? q('SELECT title FROM task_trash WHERE id = ?').get(r.task_id)?.title ?? 'a task', gone: !live };
    return { ...shapeEntry({ ...r, user_name: userName(r.user_id) }), task };
  });
  return { entries, more, before: entries.length ? entries.at(-1).at : null };
}

/** Forget the history of tasks that are gone for good (not on a list, nor in a list's trash). */
export function forgetGoneHistory() {
  q('DELETE FROM task_history WHERE task_id NOT IN (SELECT id FROM tasks) AND task_id NOT IN (SELECT id FROM task_trash)').run();
}

// Deleted tasks wait in their list's trash for TASK_TRASH_DAYS: the task as it was, with its comments and
// time spent, so Undo (or Deleted tasks… on the list) puts it back whole. After that they're gone for good.
import { q, tx } from './db.js';
import { now } from './util.js';

q(`CREATE TABLE IF NOT EXISTS task_trash (
  id TEXT PRIMARY KEY,               -- the task's own id
  list_id TEXT NOT NULL REFERENCES task_lists(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  deleted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  deleted_at INTEGER NOT NULL,
  row TEXT NOT NULL,                 -- JSON: the tasks row
  comments TEXT NOT NULL,            -- JSON: its task_comments rows
  time TEXT NOT NULL                 -- JSON: its task_time rows
)`).run();
export const TASK_TRASH_DAYS = 30;

/** Move a task (and its comments and time) to the trash. Call inside a transaction with the rest of a delete. */
export function trashTask(taskId, userId) {
  const row = q('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!row) return false;
  const comments = q('SELECT * FROM task_comments WHERE task_id = ?').all(taskId);
  const time = q('SELECT * FROM task_time WHERE task_id = ? AND ended_at IS NOT NULL').all(taskId); // a running timer stops with it
  q(`INSERT INTO task_trash (id, list_id, title, deleted_by, deleted_at, row, comments, time) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET deleted_at = excluded.deleted_at, row = excluded.row, comments = excluded.comments, time = excluded.time`)
    .run(taskId, row.list_id, row.title, userId, now(), JSON.stringify(row), JSON.stringify(comments), JSON.stringify(time));
  q('DELETE FROM tasks WHERE id = ?').run(taskId);
  return true;
}

const insertRow = (table, row) => {
  const cols = new Set(q(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  const keys = Object.keys(row).filter((k) => cols.has(k));
  q(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((k) => row[k]));
};

/** Put a deleted task back on its list (at the top of the open ones when it wasn't done). Returns its id, or null. */
export function restoreTask(id) {
  const t = q('SELECT * FROM task_trash WHERE id = ?').get(String(id));
  if (!t) return null;
  const row = JSON.parse(t.row);
  if (!row.done_at) row.position = (q('SELECT MIN(position) AS p FROM tasks WHERE list_id = ? AND done_at IS NULL').get(t.list_id).p ?? 1) - 1;
  // A section or a task it waited on may have gone since.
  if (row.section_id && !q('SELECT 1 FROM task_sections WHERE id = ? AND list_id = ?').get(row.section_id, t.list_id)) row.section_id = null;
  if (row.assignee_id && !q('SELECT 1 FROM users WHERE id = ?').get(row.assignee_id)) row.assignee_id = null;
  tx(() => {
    insertRow('tasks', { ...row, next_id: null });
    for (const c of JSON.parse(t.comments)) insertRow('task_comments', c);
    for (const x of JSON.parse(t.time)) if (q('SELECT 1 FROM users WHERE id = ?').get(x.user_id)) insertRow('task_time', x);
    q('DELETE FROM task_trash WHERE id = ?').run(t.id);
  });
  return t.id;
}

/** A list's deleted tasks, newest first (older than TASK_TRASH_DAYS go first). */
export function trashOfList(listId, at = Date.now()) {
  q('DELETE FROM task_trash WHERE deleted_at < ?').run(at - TASK_TRASH_DAYS * 864e5);
  return q(`SELECT t.id, t.title, t.deleted_at, u.name AS deleted_by_name FROM task_trash t LEFT JOIN users u ON u.id = t.deleted_by
            WHERE t.list_id = ? ORDER BY t.deleted_at DESC`).all(listId).map((x) => ({ ...x, goes_at: x.deleted_at + TASK_TRASH_DAYS * 864e5 }));
}

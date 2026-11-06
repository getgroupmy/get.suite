// Tasks: to-do lists, your own or shared with colleagues. Each task has a title, notes, a due date,
// someone it's assigned to (a person on the list), and a place in the list you can drag it to.
// Everyone on a list sees changes as they're made.
import { Router } from 'express';
import { q, tx } from '../db.js';
import { uid, now, str, bad, notFound } from '../util.js';
import { sendTo } from '../hub.js';
import { canReach } from '../tenancy.js';

q(`CREATE TABLE IF NOT EXISTS task_lists (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`).run();
q(`CREATE TABLE IF NOT EXISTS task_list_members (
  list_id TEXT NOT NULL REFERENCES task_lists(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (list_id, user_id)
)`).run();
q(`CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL REFERENCES task_lists(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  notes TEXT,
  due TEXT,                         -- YYYY-MM-DD
  assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  position REAL NOT NULL,
  done_at INTEGER,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`).run();
q('CREATE INDEX IF NOT EXISTS tasks_list ON tasks(list_id, position)').run();
q('CREATE INDEX IF NOT EXISTS tasks_assignee ON tasks(assignee_id, done_at)').run();

const MAX_LISTS = 200, MAX_TASKS = 5000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Everyone on a list: its owner and the people it's shared with. */
const peopleOn = (list) => [list.owner_id, ...q('SELECT user_id FROM task_list_members WHERE list_id = ?').all(list.id).map((r) => r.user_id)];
const changed = (list) => sendTo(new Set(peopleOn(list)), { type: 'tasks-changed', list_id: list.id });

function loadList(id, user, { own = false } = {}) {
  const list = q('SELECT * FROM task_lists WHERE id = ?').get(id);
  if (!list) throw notFound('List not found');
  if (list.owner_id === user.id) return list;
  if (!own && q('SELECT 1 FROM task_list_members WHERE list_id = ? AND user_id = ?').get(id, user.id)) return list;
  throw notFound('List not found');
}

const TASK = `SELECT t.*, u.name AS assignee_name, c.name AS created_by_name, l.name AS list_name
              FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id LEFT JOIN users c ON c.id = t.created_by JOIN task_lists l ON l.id = t.list_id`;
const shape = (t) => ({ ...t, done: !!t.done_at });

function dueOf(v) {
  if (v === null || v === '' || v === undefined) return null;
  if (typeof v !== 'string' || !DATE_RE.test(v) || Number.isNaN(Date.parse(v))) throw bad('Due date must be YYYY-MM-DD');
  return v;
}
function assigneeOf(v, list) {
  if (v === null || v === '' || v === undefined) return null;
  if (!peopleOn(list).includes(String(v))) throw bad('Only people on the list can be given a task');
  return String(v);
}

export default function taskRoutes() {
  const r = Router();

  r.get('/lists', (req, res) => {
    const me = req.user.id;
    // Everyone starts with a list of their own.
    if (!q('SELECT 1 FROM task_lists WHERE owner_id = ?').get(me)) q('INSERT INTO task_lists (id, owner_id, name, created_at) VALUES (?, ?, ?, ?)').run(uid(), me, 'My tasks', now());
    const lists = q(`SELECT l.id, l.name, l.owner_id, l.created_at, u.name AS owner_name,
                       (SELECT COUNT(*) FROM tasks t WHERE t.list_id = l.id AND t.done_at IS NULL) AS open
                     FROM task_lists l JOIN users u ON u.id = l.owner_id
                     WHERE l.owner_id = ? OR l.id IN (SELECT list_id FROM task_list_members WHERE user_id = ?)
                     ORDER BY l.owner_id != ?, l.created_at`).all(me, me, me);
    const members = q(`SELECT m.list_id, u.id, u.name, u.username FROM task_list_members m JOIN users u ON u.id = m.user_id
                       WHERE m.list_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(lists.map((l) => l.id)));
    const assigned = q('SELECT COUNT(*) AS n FROM tasks WHERE assignee_id = ? AND done_at IS NULL').get(me).n;
    res.json({ lists: lists.map((l) => ({ ...l, mine: l.owner_id === me, members: members.filter((m) => m.list_id === l.id).map(({ list_id, ...p }) => p) })), assigned });
  });

  r.post('/lists', (req, res) => {
    if (q('SELECT COUNT(*) AS n FROM task_lists WHERE owner_id = ?').get(req.user.id).n >= MAX_LISTS) throw bad('Too many lists');
    const id = uid();
    q('INSERT INTO task_lists (id, owner_id, name, created_at) VALUES (?, ?, ?, ?)').run(id, req.user.id, str(req.body.name, { required: true, name: 'List name', max: 100 }), now());
    sendTo([req.user.id], { type: 'tasks-changed', list_id: id });
    res.status(201).json({ id });
  });

  r.patch('/lists/:id', (req, res) => {
    const list = loadList(req.params.id, req.user, { own: true });
    q('UPDATE task_lists SET name = ? WHERE id = ?').run(str(req.body.name, { required: true, name: 'List name', max: 100 }), list.id);
    changed(list);
    res.json({ ok: true });
  });

  // Sharing: the people (besides the owner) who can see and change the list.
  r.put('/lists/:id/members', (req, res) => {
    const list = loadList(req.params.id, req.user, { own: true });
    const ids = [...new Set((Array.isArray(req.body.user_ids) ? req.body.user_ids : []).map(String))].filter((id) => id !== list.owner_id);
    for (const id of ids) if (!canReach(req.user, id)) throw bad('You cannot share with that person');
    const before = peopleOn(list);
    tx(() => {
      q('DELETE FROM task_list_members WHERE list_id = ?').run(list.id);
      for (const id of ids) q('INSERT INTO task_list_members (list_id, user_id) VALUES (?, ?)').run(list.id, id);
      // Tasks given to someone no longer on the list aren't theirs any more.
      q(`UPDATE tasks SET assignee_id = NULL WHERE list_id = ? AND assignee_id IS NOT NULL AND assignee_id NOT IN (SELECT value FROM json_each(?))`).run(list.id, JSON.stringify([list.owner_id, ...ids]));
    });
    sendTo(new Set([...before, ...ids]), { type: 'tasks-changed', list_id: list.id });
    res.json({ ok: true });
  });

  // Leave a list someone shared with you, or delete your own (with its tasks).
  r.delete('/lists/:id', (req, res) => {
    const list = loadList(req.params.id, req.user);
    const before = peopleOn(list);
    if (list.owner_id === req.user.id) q('DELETE FROM task_lists WHERE id = ?').run(list.id);
    else tx(() => {
      q('DELETE FROM task_list_members WHERE list_id = ? AND user_id = ?').run(list.id, req.user.id);
      q('UPDATE tasks SET assignee_id = NULL WHERE list_id = ? AND assignee_id = ?').run(list.id, req.user.id);
    });
    sendTo(new Set(before), { type: 'tasks-changed', list_id: list.id });
    res.json({ ok: true });
  });

  r.get('/lists/:id/tasks', (req, res) => {
    const list = loadList(req.params.id, req.user);
    res.json(q(`${TASK} WHERE t.list_id = ? ORDER BY t.done_at IS NOT NULL, CASE WHEN t.done_at IS NULL THEN t.position END, t.done_at DESC`).all(list.id).map(shape));
  });

  // Tasks given to you, on any list: overdue and soonest first, those without a date last.
  r.get('/assigned', (req, res) => {
    res.json(q(`${TASK} WHERE t.assignee_id = ? AND t.done_at IS NULL ORDER BY t.due IS NULL, t.due, t.position`).all(req.user.id).map(shape));
  });

  // For the calendar: open tasks due between two dates (YYYY-MM-DD, both included) that are yours:
  // given to you, or given to nobody on a list of your own.
  r.get('/due', (req, res) => {
    const from = dueOf(String(req.query.from || '')), to = dueOf(String(req.query.to || ''));
    if (!from || !to) throw bad('from and to are required');
    const me = req.user.id;
    res.json(q(`${TASK} WHERE t.done_at IS NULL AND t.due >= ? AND t.due <= ?
                AND (t.assignee_id = ? OR (t.assignee_id IS NULL AND l.owner_id = ?))
                ORDER BY t.due, t.position LIMIT 500`).all(from, to, me, me).map(shape));
  });

  r.post('/lists/:id/tasks', (req, res) => {
    const list = loadList(req.params.id, req.user);
    if (q('SELECT COUNT(*) AS n FROM tasks WHERE list_id = ?').get(list.id).n >= MAX_TASKS) throw bad('This list is full');
    // New tasks go on top, unless asked to go at the end.
    const edge = q(`SELECT ${req.body.at === 'end' ? 'MAX' : 'MIN'}(position) AS p FROM tasks WHERE list_id = ? AND done_at IS NULL`).get(list.id).p;
    const position = edge === null ? 0 : req.body.at === 'end' ? edge + 1 : edge - 1;
    const id = uid(), t = now();
    q('INSERT INTO tasks (id, list_id, title, notes, due, assignee_id, position, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, list.id, str(req.body.title, { required: true, name: 'Task', max: 500 }), str(req.body.notes, { max: 10000 }), dueOf(req.body.due), assigneeOf(req.body.assignee_id, list), position, req.user.id, t, t);
    changed(list);
    res.status(201).json(shape(q(`${TASK} WHERE t.id = ?`).get(id)));
  });

  r.patch('/tasks/:id', (req, res) => {
    const task = q('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!task) throw notFound('Task not found');
    let list = loadList(task.list_id, req.user);
    const b = req.body || {};
    const set = {};
    if (b.list_id !== undefined && b.list_id !== task.list_id) { // move to another of your lists
      const to = loadList(String(b.list_id), req.user);
      set.list_id = to.id;
      set.position = (q('SELECT MIN(position) AS p FROM tasks WHERE list_id = ? AND done_at IS NULL').get(to.id).p ?? 1) - 1;
      if (task.assignee_id && !peopleOn(to).includes(task.assignee_id)) set.assignee_id = null;
    }
    const target = set.list_id ? q('SELECT * FROM task_lists WHERE id = ?').get(set.list_id) : list;
    if (b.title !== undefined) set.title = str(b.title, { required: true, name: 'Task', max: 500 });
    if (b.notes !== undefined) set.notes = str(b.notes, { max: 10000 });
    if (b.due !== undefined) set.due = dueOf(b.due);
    if (b.assignee_id !== undefined) set.assignee_id = assigneeOf(b.assignee_id, target);
    if (b.done !== undefined) set.done_at = b.done ? task.done_at || now() : null;
    if (b.position !== undefined) { if (!Number.isFinite(Number(b.position))) throw bad('Bad position'); set.position = Number(b.position); }
    if (b.done === false && task.done_at && b.position === undefined) set.position = (q('SELECT MIN(position) AS p FROM tasks WHERE list_id = ? AND done_at IS NULL').get(target.id).p ?? 1) - 1; // back on top
    const keys = Object.keys(set);
    if (keys.length) q(`UPDATE tasks SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => set[k]), now(), task.id);
    changed(list);
    if (target !== list) changed(target);
    res.json(shape(q(`${TASK} WHERE t.id = ?`).get(task.id)));
  });

  r.delete('/tasks/:id', (req, res) => {
    const task = q('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!task) throw notFound('Task not found');
    const list = loadList(task.list_id, req.user);
    q('DELETE FROM tasks WHERE id = ?').run(task.id);
    changed(list);
    res.json({ ok: true });
  });

  // Clear the completed tasks of a list.
  r.delete('/lists/:id/done', (req, res) => {
    const list = loadList(req.params.id, req.user);
    const n = q('DELETE FROM tasks WHERE list_id = ? AND done_at IS NOT NULL').run(list.id).changes;
    changed(list);
    res.json({ ok: true, deleted: n });
  });

  return r;
}

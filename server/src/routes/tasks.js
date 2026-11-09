// Tasks: to-do lists, your own or shared with colleagues. Each task has a title, notes, a due date,
// someone it's assigned to (a person on the list), and a place in the list you can drag it to.
// Everyone on a list sees changes as they're made.
import { addTimeRoutes } from '../tasktime.js';
import { REPEATS, nextDue } from '../taskrepeat.js';
import express, { Router } from 'express';
import { tasksFromCsv } from '../taskimport.js';
import { q, tx } from '../db.js';
import { uid, now, str, bad, notFound } from '../util.js';
import { sendTo } from '../hub.js';
import { notify as bell } from '../notifications.js';
import { canReach } from '../tenancy.js';
import { audienceFor, roleFor, atLeast } from '../access.js';
import { recordActivity } from '../fileactivity.js';
import { insertFile } from './files.js';

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
// Repeating tasks: how it repeats, and (once ticked off) the task that came next.
for (const [col, type] of [['repeat', 'TEXT'], ['next_id', 'TEXT'], ['steps', 'TEXT'], ['important', 'INTEGER NOT NULL DEFAULT 0'], ['link_url', 'TEXT'], ['link_label', 'TEXT'], ['due_time', 'TEXT'], ['started', 'INTEGER NOT NULL DEFAULT 0'], ['done_by', 'TEXT'], ['attachments', 'TEXT'], ['blocked_by', 'TEXT'], ['tags', 'TEXT'], ['start', 'TEXT']]) { // start: the day work begins (YYYY-MM-DD), for the timeline; // tags: JSON ["client", …]; // blocked_by: tasks on the same list this one waits on, JSON [ids]; // attachments: Drive files, JSON [{ id, name, kind, mime }]; // steps: a checklist, JSON [{ id, title, done }]
  if (!q('PRAGMA table_info(tasks)').all().some((c) => c.name === col)) q(`ALTER TABLE tasks ADD COLUMN ${col} ${type}`).run();
}
q('CREATE INDEX IF NOT EXISTS tasks_assignee ON tasks(assignee_id, done_at)').run();

const MAX_LISTS = 200, MAX_TASKS = 5000;
// How each person sorts each list (their own choice; others see their own).
q(`CREATE TABLE IF NOT EXISTS task_list_views (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  list_id TEXT NOT NULL REFERENCES task_lists(id) ON DELETE CASCADE,
  sort TEXT NOT NULL,
  PRIMARY KEY (user_id, list_id)
)`).run();
export const SORTS = ['mine', 'due', 'title', 'added', 'important'];
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

// Comments on a task: a short discussion everyone on the list sees.
q(`CREATE TABLE IF NOT EXISTS task_comments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`).run();
q('CREATE INDEX IF NOT EXISTS task_comments_task ON task_comments(task_id, created_at)').run();
const MAX_COMMENTS = 500;

const TASK = `SELECT t.*, u.name AS assignee_name, c.name AS created_by_name, l.name AS list_name,
              (SELECT COUNT(*) FROM task_comments k WHERE k.task_id = t.id) AS comments
              FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id LEFT JOIN users c ON c.id = t.created_by JOIN task_lists l ON l.id = t.list_id`;
const shape = (t) => ({ ...t, done: !!t.done_at, important: !!t.important, started: !!t.started && !t.done_at, // started: "In progress" on the board
  steps: t.steps ? JSON.parse(t.steps) : [], attachments: t.attachments ? JSON.parse(t.attachments) : [], blocked_by: t.blocked_by ? JSON.parse(t.blocked_by) : [], tags: t.tags ? JSON.parse(t.tags) : [] });
/** Tags for a task: words (letters first), lower case, without #, no repeats, at most 10. Stored as JSON or null. */
export function tagsOf(input) {
  if (input == null || input === '') return null;
  const list = (Array.isArray(input) ? input : String(input).split(/[\s,]+/)).map((x) => String(x ?? '').trim().replace(/^#+/, '').toLowerCase()).filter(Boolean);
  for (const t of list) if (!/^\p{L}[\p{L}\p{N}_-]{0,29}$/u.test(t)) throw bad(`“${t}” can’t be a tag: use a word of up to 30 letters, numbers, - or _`);
  const out = [...new Set(list)].slice(0, 10);
  return out.length ? JSON.stringify(out) : null;
}
const MAX_STEPS = 100, MAX_ATTACHMENTS = 20;
// A cell as a spreadsheet reads it: quoted when needed, and text that would start a formula made plain.
const csvCell = (v) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
/** Tasks as CSV rows: what each is, its state, dates, who it's for, its steps and tags. */
export function tasksCsv(tasks) {
  const head = ['Task', 'Status', 'Due', 'Time', 'Start', 'Assigned to', 'Important', 'Tags', 'Steps done', 'Steps', 'Notes', 'Completed'];
  const status = (t) => (t.done ? 'Done' : t.started ? 'In progress' : 'To do');
  const rows = tasks.map((t) => [t.title, status(t), t.due || '', t.due_time || '', t.start || '', t.assignee_name || '', t.important ? 'Yes' : '', (t.tags || []).map((x) => `#${x}`).join(' '),
    t.steps.length ? `${t.steps.filter((x) => x.done).length}/${t.steps.length}` : '', t.steps.map((x) => `${x.done ? '[x]' : '[ ]'} ${x.title}`).join('\n'), t.notes || '',
    t.done_at ? new Date(t.done_at).toISOString().slice(0, 10) : '']);
  return `\ufeff${[head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}
/** A task as one person sees it: each attachment says whether they can open it. */
const shapeFor = (userId) => (t) => { const out = shape(t); out.attachments = out.attachments.map((a) => ({ ...a, can_open: !!roleFor(a.id, userId) })); return out; };

/**
 * Everyone on a list can view the files attached to its tasks that someone on the list owns
 * (people its owner can share with); nobody loses access they had.
 */
function shareAttachments(list, tasks) {
  const people = peopleOn(list);
  for (const t of tasks) {
    for (const a of t.attachments ? JSON.parse(t.attachments) : []) {
      const f = q('SELECT id, owner_id, parent_id FROM files WHERE id = ? AND trashed = 0').get(a.id);
      if (!f || !people.includes(f.owner_id)) continue;
      const owner = q('SELECT * FROM users WHERE id = ?').get(f.owner_id);
      const given = [];
      for (const p of people) {
        if (p === f.owner_id || roleFor(f.id, p) || !canReach(owner, p)) continue;
        q("INSERT INTO shares (file_id, user_id, role, direct_role) VALUES (?, ?, 'viewer', 'viewer') ON CONFLICT(file_id, user_id) DO NOTHING").run(f.id, p);
        given.push(q('SELECT name FROM users WHERE id = ?').get(p)?.name || 'someone');
      }
      if (given.length) {
        recordActivity(f.id, owner.id, 'share', { added: given.map((n) => `${n} (can view, on the task list “${list.name}”)`), removed: [] });
        sendTo(new Set(audienceFor(f.id)), { type: 'files-changed', parent_id: f.parent_id });
      }
    }
  }
}

/** Take a task out of what the others on its list wait on (it was deleted or moved away). */
function unblockFrom(listId, taskId) {
  for (const t of q("SELECT id, blocked_by FROM tasks WHERE list_id = ? AND blocked_by IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(blocked_by) WHERE value = ?)").all(listId, taskId)) {
    const left = JSON.parse(t.blocked_by).filter((x) => x !== taskId);
    q('UPDATE tasks SET blocked_by = ? WHERE id = ?').run(left.length ? JSON.stringify(left) : null, t.id);
  }
}
/** A task just ticked off: whoever has a task that was waiting only on open ones like it can start now. */
function notifyUnblocked(done, by) {
  for (const t of q(`${TASK} WHERE t.list_id = ? AND t.done_at IS NULL AND t.blocked_by IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(t.blocked_by) WHERE value = ?)`).all(done.list_id, done.id)) {
    const open = q("SELECT COUNT(*) AS n FROM tasks WHERE id IN (SELECT value FROM json_each(?)) AND done_at IS NULL").get(t.blocked_by).n;
    const who = t.assignee_id || t.created_by;
    if (open || !who || who === by.id) continue;
    bell([who], { kind: 'task', title: `“${t.title}” can start`, body: `${by.name || by.username} finished “${done.title}”, which it was waiting on`, link: `/tasks/${t.list_id}?task=${t.id}`, actor: by.name });
  }
}

/** Tell someone a task was given to them (by someone else). */
function notifyAssigned(task, by) {
  if (!task.assignee_id || task.assignee_id === by.id || task.done) return;
  bell([task.assignee_id], { kind: 'task', title: `${by.name || by.username} gave you “${task.title}”`, body: task.list_name ? `On ${task.list_name}${task.due ? ` · due ${task.due}` : ''}` : null, link: `/tasks/${task.list_id}?task=${task.id}`, actor: by.name });
  sendTo([task.assignee_id], { type: 'task-assigned', at: Date.now(), from: by.name || by.username,
    task: { id: task.id, title: task.title, list_id: task.list_id, list_name: task.list_name, due: task.due } });
}

function dueOf(v) {
  if (v === null || v === '' || v === undefined) return null;
  if (typeof v !== 'string' || !DATE_RE.test(v) || Number.isNaN(Date.parse(v))) throw bad('Due date must be YYYY-MM-DD');
  return v;
}
function startOf(v) {
  if (typeof v !== 'string' || !DATE_RE.test(v) || Number.isNaN(Date.parse(v))) throw bad('Start date must be YYYY-MM-DD');
  return v;
}
const dayMs = (d) => Date.parse(`${d}T00:00:00Z`);
/** Whole days from a to b (YYYY-MM-DD). */
export const daysBetween = (a, b) => Math.round((dayMs(b) - dayMs(a)) / 86400000);
/** A day moved by n days. */
export const shiftDay = (d, n) => new Date(dayMs(d) + n * 86400000).toISOString().slice(0, 10);
/** A time on the due date ("HH:MM", the person's own clock), or null for any time that day. */
function dueTimeOf(v) {
  if (v === null || v === '' || v === undefined) return null;
  if (typeof v !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw bad('Due time must be HH:MM');
  return v;
}
function repeatOf(v) {
  if (v === null || v === '' || v === undefined) return null;
  if (!REPEATS.includes(v)) throw bad('Repeat must be one of ' + REPEATS.join(', '));
  return v;
}
const todayOf = (v) => (typeof v === 'string' && DATE_RE.test(v) ? v : new Date().toISOString().slice(0, 10)); // the person's own date, if sent

/**
 * Where a task came from (an email, a chat message): a path inside Workspace and what to call it.
 * Only paths to Mail or Chat are kept, so a link on a task can't take anyone off-site.
 */
export function linkOf(v) {
  if (v == null || v === '') return { url: null, label: null };
  const url = String(v.url || '');
  if (!/^\/(mail|chat|docs)(\/|\?|$)/.test(url) || url.length > 2000 || /[\s\\]/.test(url)) throw bad('Bad link');
  return { url, label: String(v.label || '').trim().slice(0, 300) || null };
}

function assigneeOf(v, list) {
  if (v === null || v === '' || v === undefined) return null;
  if (!peopleOn(list).includes(String(v))) throw bad('Only people on the list can be given a task');
  return String(v);
}

/** Your first own list ("My tasks", made if you have none). */
// Action items sent from a document: which (person, item) became which task, so sending again doesn't repeat them.
q(`CREATE TABLE IF NOT EXISTS doc_action_tasks (
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,
  task_id TEXT NOT NULL,
  PRIMARY KEY (file_id, user_id, item_key)
)`).run();
const itemKey = (text) => String(text).toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 300);

export function myFirstList(userId) {
  if (!q('SELECT 1 FROM task_lists WHERE owner_id = ?').get(userId)) q('INSERT INTO task_lists (id, owner_id, name, created_at) VALUES (?, ?, ?, ?)').run(uid(), userId, 'My tasks', now());
  return q('SELECT * FROM task_lists WHERE owner_id = ? ORDER BY created_at LIMIT 1').get(userId);
}
/** Add tasks on top of a list, in the order given. Returns how many. */
export function addTasks(listId, userId, titles) {
  let top = (q('SELECT MIN(position) AS p FROM tasks WHERE list_id = ? AND done_at IS NULL').get(listId).p ?? 1) - titles.length;
  const t = now();
  for (const title of titles) q('INSERT INTO tasks (id, list_id, title, position, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(uid(), listId, title.slice(0, 500), top++, userId, t, t);
  return titles.length;
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
    const important = q(`SELECT COUNT(*) AS n FROM tasks t JOIN task_lists l ON l.id = t.list_id WHERE t.important = 1 AND t.done_at IS NULL
                         AND (l.owner_id = ? OR l.id IN (SELECT list_id FROM task_list_members WHERE user_id = ?))`).get(me, me).n;
    const sorts = new Map(q('SELECT list_id, sort FROM task_list_views WHERE user_id = ?').all(me).map((v) => [v.list_id, v.sort]));
    res.json({ lists: lists.map((l) => ({ ...l, sort: sorts.get(l.id) || 'mine', mine: l.owner_id === me, members: members.filter((m) => m.list_id === l.id).map(({ list_id, ...p }) => p) })), assigned, important });
  });

  r.post('/lists', (req, res) => {
    if (q('SELECT COUNT(*) AS n FROM task_lists WHERE owner_id = ?').get(req.user.id).n >= MAX_LISTS) throw bad('Too many lists');
    const id = uid();
    q('INSERT INTO task_lists (id, owner_id, name, created_at) VALUES (?, ?, ?, ?)').run(id, req.user.id, str(req.body.name, { required: true, name: 'List name', max: 100 }), now());
    sendTo([req.user.id], { type: 'tasks-changed', list_id: id });
    res.status(201).json({ id });
  });

  // A copy of a list (a checklist used again: onboarding, month-end): its open tasks with their notes,
  // steps (unticked), tags, stars, links, files and what they wait on; not who they're for, nor comments
  // or time. { name, start: YYYY-MM-DD }: with a start, due dates (and start days) move by as many days as
  // it takes for the earliest to fall on that day; without, they're left off.
  r.post('/lists/:id/copy', (req, res) => {
    const list = loadList(req.params.id, req.user);
    if (q('SELECT COUNT(*) AS n FROM task_lists WHERE owner_id = ?').get(req.user.id).n >= MAX_LISTS) throw bad('Too many lists');
    const name = str(req.body?.name || `${list.name} (copy)`, { required: true, name: 'List name', max: 100 });
    const start = req.body?.start ? String(req.body.start) : null;
    if (start && (!/^\d{4}-\d{2}-\d{2}$/.test(start) || Number.isNaN(Date.parse(`${start}T00:00:00Z`)))) throw bad('Choose a day to start from');
    const tasks = q('SELECT * FROM tasks WHERE list_id = ? AND done_at IS NULL ORDER BY position').all(list.id);
    const dates = tasks.flatMap((t) => [t.due, t.start]).filter(Boolean).sort();
    const shift = start && dates.length ? Math.round((Date.parse(`${start}T00:00:00Z`) - Date.parse(`${dates[0]}T00:00:00Z`)) / 864e5) : 0;
    const moved = (d) => (d && start ? new Date(Date.parse(`${d}T00:00:00Z`) + shift * 864e5).toISOString().slice(0, 10) : null);
    const id = uid(), t = now();
    const ids = new Map(tasks.map((x) => [x.id, uid()]));
    tx(() => {
      q('INSERT INTO task_lists (id, owner_id, name, created_at) VALUES (?, ?, ?, ?)').run(id, req.user.id, name, t);
      for (const x of tasks) {
        let steps = null;
        try { steps = x.steps ? JSON.stringify(JSON.parse(x.steps).map((st) => ({ ...st, id: uid().slice(0, 8), done: false }))) : null; } catch { steps = null; }
        let blocked = null;
        try { const b = JSON.parse(x.blocked_by || '[]').map((o) => ids.get(o)).filter(Boolean); blocked = b.length ? JSON.stringify(b) : null; } catch { blocked = null; }
        q(`INSERT INTO tasks (id, list_id, title, notes, due, due_time, start, position, repeat, steps, important, link_url, link_label, attachments, blocked_by, tags, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(ids.get(x.id), id, x.title, x.notes, moved(x.due), start && x.due ? x.due_time : null, moved(x.start), x.position, x.repeat, steps, x.important, x.link_url, x.link_label, x.attachments, blocked, x.tags, req.user.id, t, t);
      }
    });
    sendTo([req.user.id], { type: 'tasks-changed', list_id: id });
    res.status(201).json({ id, name, tasks: tasks.length, shift_days: shift });
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
    shareAttachments(list, q('SELECT attachments FROM tasks WHERE list_id = ? AND attachments IS NOT NULL').all(list.id)); // for the people added
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

  // ---- comments ----
  const taskFor = (req) => {
    const t = q(`${TASK} WHERE t.id = ?`).get(req.params.id);
    if (!t) throw notFound('Task not found');
    return { task: t, list: loadList(t.list_id, req.user) };
  };
  addTimeRoutes(r, { taskFor, loadList, changed }); // time spent on tasks (tasktime.js)
  r.get('/tasks/:id/comments', (req, res) => {
    const { task } = taskFor(req);
    res.json(q(`SELECT k.id, k.body, k.created_at, k.author_id, u.name AS author_name FROM task_comments k LEFT JOIN users u ON u.id = k.author_id
                WHERE k.task_id = ? ORDER BY k.created_at`).all(task.id));
  });
  r.post('/tasks/:id/comments', (req, res) => {
    const { task, list } = taskFor(req);
    const body = str(req.body.body, { required: true, name: 'Comment', max: 4000 });
    if (q('SELECT COUNT(*) AS n FROM task_comments WHERE task_id = ?').get(task.id).n >= MAX_COMMENTS) throw bad('This task has enough comments');
    const id = uid();
    q('INSERT INTO task_comments (id, task_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)').run(id, task.id, req.user.id, body, now());
    // Told: who it's for, who made it, and who has commented, if they're still on the list.
    const on = new Set(peopleOn(list));
    const told = new Set([task.assignee_id, task.created_by, ...q('SELECT DISTINCT author_id FROM task_comments WHERE task_id = ?').all(task.id).map((x) => x.author_id)]
      .filter((u) => u && u !== req.user.id && on.has(u)));
    if (told.size) bell([...told], { kind: 'task', title: `${req.user.name || req.user.username} commented on “${task.title}”`, body: body.slice(0, 200), link: `/tasks/${task.list_id}?task=${task.id}`, actor: req.user.name });
    changed(list);
    res.status(201).json({ id, body, created_at: now(), author_id: req.user.id, author_name: req.user.name });
  });
  r.delete('/tasks/:id/comments/:cid', (req, res) => {
    const { task } = taskFor(req);
    const c = q('SELECT * FROM task_comments WHERE id = ? AND task_id = ?').get(req.params.cid, task.id);
    if (!c || c.author_id !== req.user.id) throw notFound('Comment not found'); // your own only
    q('DELETE FROM task_comments WHERE id = ?').run(c.id);
    changed(loadList(task.list_id, req.user));
    res.json({ ok: true });
  });

  // How you sort a list: your order (drag), by due date, by title, newest first, or starred first.
  r.put('/lists/:id/sort', (req, res) => {
    const list = loadList(req.params.id, req.user);
    const sort = String(req.body.sort || '');
    if (!SORTS.includes(sort)) throw bad('Sort by your order, due date, title, date added or importance');
    if (sort === 'mine') q('DELETE FROM task_list_views WHERE user_id = ? AND list_id = ?').run(req.user.id, list.id);
    else q('INSERT INTO task_list_views (user_id, list_id, sort) VALUES (?, ?, ?) ON CONFLICT(user_id, list_id) DO UPDATE SET sort = excluded.sort').run(req.user.id, list.id, sort);
    sendTo([req.user.id], { type: 'tasks-changed', list_id: list.id });
    res.json({ sort });
  });

  // Tasks from a spreadsheet (CSV) added to the end of the list, in the file's order; done ones as done.
  r.post('/lists/:id/import', express.text({ type: () => true, limit: '5mb' }), (req, res) => {
    const list = loadList(req.params.id, req.user);
    const found = tasksFromCsv(req.body);
    if (found.error) throw bad(found.error);
    const have = q('SELECT COUNT(*) AS n FROM tasks WHERE list_id = ?').get(list.id).n;
    if (have + found.tasks.length > MAX_TASKS) throw bad(`This list can hold ${MAX_TASKS} tasks; there's room for ${Math.max(0, MAX_TASKS - have)} more`);
    let at = q('SELECT MAX(position) AS p FROM tasks WHERE list_id = ?').get(list.id).p ?? -1;
    const t = now();
    tx(() => {
      for (const x of found.tasks) {
        const steps = x.steps.length ? JSON.stringify(x.steps.map((st) => ({ id: uid(), title: st.title, done: st.done }))) : null;
        q(`INSERT INTO tasks (id, list_id, title, notes, due, due_time, start, position, important, tags, steps, done_at, done_by, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(uid(), list.id, x.title, x.notes, x.due, x.due_time, x.start, ++at, x.important ? 1 : 0, x.tags.length ? JSON.stringify(x.tags) : null, steps, x.done ? t : null, x.done ? req.user.id : null, req.user.id, t, t);
      }
    });
    changed(list);
    res.json({ added: found.tasks.length, done: found.tasks.filter((x) => x.done).length, skipped: found.skipped });
  });

  // The whole list as a spreadsheet (CSV, opens in Excel or Sheets): open tasks in order, then done ones.
  r.get('/lists/:id/export.csv', (req, res) => {
    const list = loadList(req.params.id, req.user);
    const rows = q(`${TASK} WHERE t.list_id = ? ORDER BY t.done_at IS NOT NULL, CASE WHEN t.done_at IS NULL THEN t.position END, t.done_at DESC`).all(list.id).map(shape);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${list.name || 'Tasks'}.csv`)}`);
    res.send(tasksCsv(rows));
  });

  r.get('/lists/:id/tasks', (req, res) => {
    const list = loadList(req.params.id, req.user);
    res.json(q(`${TASK} WHERE t.list_id = ? ORDER BY t.done_at IS NOT NULL, CASE WHEN t.done_at IS NULL THEN t.position END, t.done_at DESC`).all(list.id).map(shapeFor(req.user.id)));
  });

  // Search your lists (your own and those shared with you) for tasks with all these words in the
  // title, notes or steps. Open ones first (soonest due first), then done ones.
  r.get('/search', (req, res) => {
    const words = String(req.query.q || '').toLowerCase().match(/[\p{L}\p{N}@._'-]+/gu)?.slice(0, 8) || [];
    if (!words.length) return res.json([]);
    const me = req.user.id;
    const like = words.map(() => "LOWER(t.title || ' ' || COALESCE(t.notes, '') || ' ' || COALESCE(t.steps, '') || ' ' || COALESCE(t.tags, '')) LIKE ? ESCAPE '!'");
    res.json(q(`${TASK} WHERE (l.owner_id = ? OR l.id IN (SELECT list_id FROM task_list_members WHERE user_id = ?)) AND ${like.join(' AND ')}
                ORDER BY t.done_at IS NOT NULL, t.due IS NULL, t.due, t.done_at DESC, t.position LIMIT 100`)
      .all(me, me, ...words.map((w) => `%${w.replace(/[%_!]/g, (x) => `!${x}`)}%`)).map(shape));
  });

  // Open tasks with a tag, on any of your lists (soonest due first), and the tags in use there with how many open tasks have each.
  r.get('/tags', (req, res) => {
    const me = req.user.id;
    const rows = q(`${TASK} WHERE t.done_at IS NULL AND t.tags IS NOT NULL AND (l.owner_id = ? OR l.id IN (SELECT list_id FROM task_list_members WHERE user_id = ?))
                    ORDER BY t.due IS NULL, t.due, t.position`).all(me, me).map(shape);
    const counts = new Map();
    for (const t of rows) for (const tag of t.tags) counts.set(tag, (counts.get(tag) || 0) + 1);
    const tag = req.query.tag ? String(req.query.tag).replace(/^#/, '').toLowerCase() : null;
    res.json({ tags: [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, count]) => ({ name, count })),
      tasks: tag ? rows.filter((t) => t.tags.includes(tag)) : [] });
  });

  // Tasks given to you, on any list: overdue and soonest first, those without a date last.
  r.get('/assigned', (req, res) => {
    res.json(q(`${TASK} WHERE t.assignee_id = ? AND t.done_at IS NULL ORDER BY t.due IS NULL, t.due, t.due_time IS NULL, t.due_time, t.position`).all(req.user.id).map(shape));
  });

  // Open tasks marked important on any of your lists: overdue and soonest first, those without a date last.
  r.get('/important', (req, res) => {
    const me = req.user.id;
    res.json(q(`${TASK} WHERE t.important = 1 AND t.done_at IS NULL AND (l.owner_id = ? OR l.id IN (SELECT list_id FROM task_list_members WHERE user_id = ?))
                ORDER BY t.due IS NULL, t.due, t.due_time IS NULL, t.due_time, t.position`).all(me, me).map(shape));
  });

  // For the calendar: open tasks due between two dates (YYYY-MM-DD, both included) that are yours:
  // given to you, or given to nobody on a list of your own.
  r.get('/due', (req, res) => {
    const from = dueOf(String(req.query.from || '')), to = dueOf(String(req.query.to || ''));
    if (!from || !to) throw bad('from and to are required');
    const me = req.user.id;
    res.json(q(`${TASK} WHERE t.done_at IS NULL AND t.due >= ? AND t.due <= ?
                AND (t.assignee_id = ? OR (t.assignee_id IS NULL AND l.owner_id = ?))
                ORDER BY t.due, t.due_time IS NULL, t.due_time, t.position LIMIT 500`).all(from, to, me, me).map(shape));
  });

  r.post('/lists/:id/tasks', (req, res) => {
    const list = loadList(req.params.id, req.user);
    if (q('SELECT COUNT(*) AS n FROM tasks WHERE list_id = ?').get(list.id).n >= MAX_TASKS) throw bad('This list is full');
    // New tasks go on top, unless asked to go at the end.
    const edge = q(`SELECT ${req.body.at === 'end' ? 'MAX' : 'MIN'}(position) AS p FROM tasks WHERE list_id = ? AND done_at IS NULL`).get(list.id).p;
    const position = edge === null ? 0 : req.body.at === 'end' ? edge + 1 : edge - 1;
    const id = uid(), t = now();
    const due = dueOf(req.body.due), repeat = repeatOf(req.body.repeat);
    const dueTime = due ? dueTimeOf(req.body.due_time) : null;
    if (repeat && !due) throw bad('A repeating task needs a due date');
    const link = linkOf(req.body.link);
    const tags = tagsOf(req.body.tags);
    q('INSERT INTO tasks (id, list_id, title, notes, due, due_time, assignee_id, position, repeat, important, link_url, link_label, tags, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, list.id, str(req.body.title, { required: true, name: 'Task', max: 500 }), str(req.body.notes, { max: 10000 }), due, dueTime, assigneeOf(req.body.assignee_id, list), position, repeat, req.body.important ? 1 : 0, link.url, link.label, tags, req.user.id, t, t);
    changed(list);
    const made = shape(q(`${TASK} WHERE t.id = ?`).get(id));
    notifyAssigned(made, req.user);
    res.status(201).json(made);
  });

  // A document's action items (ticked-off-able items that @mention someone) become tasks for those
  // people, on their own first list, given by you and linking back to the document. Items already
  // sent (and still there) aren't sent again. Body: { items: [{ text, title, user_id, due?, due_time? }] }.
  r.get('/from-doc/:fileId', (req, res) => {
    if (!roleFor(req.params.fileId, req.user.id)) throw notFound();
    res.json(q(`SELECT d.user_id, d.item_key AS key, t.done_at FROM doc_action_tasks d JOIN tasks t ON t.id = d.task_id WHERE d.file_id = ?`).all(req.params.fileId)
      .map((x) => ({ user_id: x.user_id, key: x.key, done: !!x.done_at })));
  });
  r.post('/from-doc/:fileId', (req, res) => {
    const file = q("SELECT id, name, kind FROM files WHERE id = ? AND trashed = 0").get(req.params.fileId);
    const role = file && roleFor(file.id, req.user.id);
    if (!role || file.kind !== 'doc') throw notFound();
    if (!atLeast(role, 'editor')) throw bad('Only people who can edit the document can send its action items');
    const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 100) : [];
    const made = [], already = [], skipped = [];
    for (const it of items) {
      const who = q('SELECT id, name, disabled FROM users WHERE id = ?').get(String(it.user_id || ''));
      const title = String(it.title || '').trim().slice(0, 500);
      if (!who || who.disabled || !title || !canReach(req.user, who.id)) { skipped.push(String(it.text || title)); continue; }
      const key = itemKey(it.text || title);
      const had = q('SELECT d.task_id FROM doc_action_tasks d JOIN tasks t ON t.id = d.task_id WHERE d.file_id = ? AND d.user_id = ? AND d.item_key = ?').get(file.id, who.id, key);
      if (had) { already.push(title); continue; }
      const list = myFirstList(who.id);
      const due = it.due ? dueOf(it.due) : null;
      const dueTime = due && it.due_time ? dueTimeOf(it.due_time) : null;
      const id = uid(), t = now();
      const position = (q('SELECT MIN(position) AS p FROM tasks WHERE list_id = ? AND done_at IS NULL').get(list.id).p ?? 1) - 1;
      q(`INSERT INTO tasks (id, list_id, title, due, due_time, assignee_id, position, link_url, link_label, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, list.id, title, due, dueTime, who.id, position, `/docs/${file.id}`, file.name.slice(0, 300), req.user.id, t, t);
      q('INSERT OR REPLACE INTO doc_action_tasks (file_id, user_id, item_key, task_id) VALUES (?, ?, ?, ?)').run(file.id, who.id, key, id);
      changed(list);
      notifyAssigned(shape(q(`${TASK} WHERE t.id = ?`).get(id)), req.user);
      made.push({ title, name: who.name, can_open: !!roleFor(file.id, who.id) });
    }
    res.json({ made, already, skipped });
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
      set.blocked_by = null; // what it waited on stays behind, and nothing there waits on it any more
      unblockFrom(task.list_id, task.id);
      set.position = (q('SELECT MIN(position) AS p FROM tasks WHERE list_id = ? AND done_at IS NULL').get(to.id).p ?? 1) - 1;
      if (task.assignee_id && !peopleOn(to).includes(task.assignee_id)) set.assignee_id = null;
    }
    const target = set.list_id ? q('SELECT * FROM task_lists WHERE id = ?').get(set.list_id) : list;
    if (b.title !== undefined) set.title = str(b.title, { required: true, name: 'Task', max: 500 });
    if (b.notes !== undefined) set.notes = str(b.notes, { max: 10000 });
    if (b.due !== undefined) set.due = dueOf(b.due);
    if (b.due_time !== undefined) set.due_time = dueTimeOf(b.due_time);
    if (b.start !== undefined) set.start = b.start === null || b.start === '' ? null : startOf(b.start);
    if (set.due === null) { set.due_time = null; set.start = null; } // no date, no time and no start
    else if (set.due_time && !(set.due !== undefined ? set.due : task.due)) throw bad('Set a due date first');
    { const st = set.start !== undefined ? set.start : task.start, du = set.due !== undefined ? set.due : task.due;
      if (st && !du) throw bad('Set a due date first');
      if (st && du && st > du) throw bad('The start can’t be after the due date'); }
    if (b.assignee_id !== undefined) set.assignee_id = assigneeOf(b.assignee_id, target);
    if (b.done !== undefined) { set.done_at = b.done ? task.done_at || now() : null; set.done_by = b.done ? task.done_by || req.user.id : null; }
    if (b.repeat !== undefined) set.repeat = repeatOf(b.repeat);
    if (b.important !== undefined) set.important = b.important ? 1 : 0;
    if (b.tags !== undefined) set.tags = tagsOf(b.tags);
    if (b.started !== undefined) set.started = b.started ? 1 : 0;
    if (b.done === false && b.started === undefined) set.started = 0; // brought back: to do again
    if (b.link !== undefined) { const l = linkOf(b.link); set.link_url = l.url; set.link_label = l.label; } // null takes it off
    if ((set.repeat ?? task.repeat) && !(set.due !== undefined ? set.due : task.due)) {
      if (set.repeat) throw bad('A repeating task needs a due date');
      set.repeat = null; // clearing the date stops it repeating
    }
    if (b.position !== undefined) { if (!Number.isFinite(Number(b.position))) throw bad('Bad position'); set.position = Number(b.position); }
    if (b.done === false && task.done_at && b.position === undefined) set.position = (q('SELECT MIN(position) AS p FROM tasks WHERE list_id = ? AND done_at IS NULL').get(target.id).p ?? 1) - 1; // back on top
    const keys = Object.keys(set);
    tx(() => {
      if (keys.length) q(`UPDATE tasks SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => set[k]), now(), task.id);
      const after = q('SELECT * FROM tasks WHERE id = ?').get(task.id);
      // Ticked off a repeating task: the next one comes due, on top of its list.
      if (b.done && !task.done_at && after.repeat && after.due && !after.next_id) {
        const due = nextDue(after.due, after.repeat, todayOf(b.today));
        const start = after.start ? shiftDay(due, -daysBetween(after.start, after.due)) : null; // as long as before
        const top = (q('SELECT MIN(position) AS p FROM tasks WHERE list_id = ? AND done_at IS NULL').get(after.list_id).p ?? 1) - 1;
        const id = uid(), t = now();
        const steps = after.steps ? JSON.stringify(JSON.parse(after.steps).map((x) => ({ ...x, id: uid(), done: false }))) : null; // a fresh checklist
        q('INSERT INTO tasks (id, list_id, title, notes, due, due_time, start, assignee_id, position, repeat, steps, important, link_url, link_label, attachments, tags, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id, after.list_id, after.title, after.notes, due, after.due_time, start, after.assignee_id, top, after.repeat, steps, after.important ? 1 : 0, after.link_url, after.link_label, after.attachments, after.tags, after.created_by, t, t);
        q('UPDATE tasks SET next_id = ? WHERE id = ?').run(id, task.id);
      }
      // Un-ticked (Undo): the next one goes again, unless someone has already worked on it.
      if (b.done === false && task.done_at && task.next_id) {
        const n = q('SELECT * FROM tasks WHERE id = ?').get(task.next_id);
        if (n && !n.done_at && n.updated_at === n.created_at) q('DELETE FROM tasks WHERE id = ?').run(n.id);
        q('UPDATE tasks SET next_id = NULL WHERE id = ?').run(task.id);
      }
    });
    changed(list);
    if (target !== list) changed(target);
    if (b.done && !task.done_at) notifyUnblocked(task, req.user);
    // A task from an assigned comment: ticking it off resolves the comment thread (and un-ticking reopens it).
    if (b.done !== undefined && !!b.done !== !!task.done_at) {
      const c = q('SELECT id, file_id, resolved FROM file_comments WHERE task_id = ? AND thread_id IS NULL').get(task.id);
      if (c && !!c.resolved !== !!b.done) {
        q('UPDATE file_comments SET resolved = ?, resolved_by = ? WHERE id = ?').run(b.done ? 1 : 0, b.done ? req.user.id : null, c.id);
        sendTo(audienceFor(c.file_id), { type: 'comments-changed', id: c.file_id });
      }
    }
    const next = shape(q(`${TASK} WHERE t.id = ?`).get(task.id));
    if (set.assignee_id && set.assignee_id !== task.assignee_id) notifyAssigned(next, req.user);
    res.json(next);
  });

  // A task's checklist: add a step, change one (title, done, or its place), or remove one.
  function withSteps(req, fn) {
    const task = q('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!task) throw notFound('Task not found');
    const list = loadList(task.list_id, req.user);
    let result;
    tx(() => {
      const steps = JSON.parse(q('SELECT steps FROM tasks WHERE id = ?').get(task.id).steps || '[]');
      result = fn(steps);
      q('UPDATE tasks SET steps = ?, updated_at = ? WHERE id = ?').run(steps.length ? JSON.stringify(steps) : null, now(), task.id);
    });
    changed(list);
    return { task: shape(q(`${TASK} WHERE t.id = ?`).get(task.id)), result };
  }
  const stepIn = (steps, sid) => { const i = steps.findIndex((x) => x.id === sid); if (i < 0) throw notFound('Step not found'); return i; };

  r.post('/tasks/:id/steps', (req, res) => {
    const title = str(req.body.title, { required: true, name: 'Step', max: 500 });
    res.status(201).json(withSteps(req, (steps) => {
      if (steps.length >= MAX_STEPS) throw bad(`At most ${MAX_STEPS} steps`);
      steps.push({ id: uid(), title, done: false });
    }).task);
  });

  r.patch('/tasks/:id/steps/:sid', (req, res) => {
    const b = req.body || {};
    res.json(withSteps(req, (steps) => {
      const i = stepIn(steps, req.params.sid);
      if (b.title !== undefined) steps[i].title = str(b.title, { required: true, name: 'Step', max: 500 });
      if (b.done !== undefined) steps[i].done = !!b.done;
      if (b.index !== undefined) {
        const to = Math.max(0, Math.min(steps.length - 1, Math.trunc(Number(b.index)) || 0));
        steps.splice(to, 0, ...steps.splice(i, 1));
      }
    }).task);
  });

  r.delete('/tasks/:id/steps/:sid', (req, res) => {
    res.json(withSteps(req, (steps) => { steps.splice(stepIn(steps, req.params.sid), 1); }).task);
  });

  // What a task waits on: other tasks on its list that need doing first (no loops).
  r.put('/tasks/:id/waiting-on', (req, res) => {
    const task = q('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!task) throw notFound('Task not found');
    const list = loadList(task.list_id, req.user);
    const ids = [...new Set((Array.isArray(req.body?.task_ids) ? req.body.task_ids : []).map(String))];
    if (ids.length > 20) throw bad('A task can wait on at most 20 others');
    const onList = new Map(q('SELECT id, blocked_by FROM tasks WHERE list_id = ?').all(list.id).map((t) => [t.id, t.blocked_by ? JSON.parse(t.blocked_by) : []]));
    for (const id of ids) if (id === task.id || !onList.has(id)) throw bad('A task can only wait on other tasks on its list');
    onList.set(task.id, ids);
    // A loop: following what each waits on comes back to this one.
    const seen = new Set();
    const reaches = (id) => { if (id === task.id) return true; if (seen.has(id)) return false; seen.add(id); return (onList.get(id) || []).some(reaches); };
    if (ids.some(reaches)) throw bad('That would make tasks wait on each other');
    q('UPDATE tasks SET blocked_by = ?, updated_at = ? WHERE id = ?').run(ids.length ? JSON.stringify(ids) : null, now(), task.id);
    changed(list);
    res.json(shapeFor(req.user.id)(q(`${TASK} WHERE t.id = ?`).get(task.id)));
  });

  // Files on a task: attach one from Drive (that you can open), or take one off. Files you attach
  // from your computer are uploaded first to a "Task files" folder in your Drive.
  r.post('/files-folder', (req, res) => {
    const found = q("SELECT id FROM files WHERE owner_id = ? AND parent_id IS NULL AND kind = 'folder' AND name = 'Task files' AND trashed = 0").get(req.user.id);
    res.json({ id: found ? found.id : insertFile({ owner: req.user.id, parentId: null, name: 'Task files', kind: 'folder' }) });
  });
  r.post('/tasks/:id/attachments', (req, res) => {
    const task = q('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!task) throw notFound('Task not found');
    const list = loadList(task.list_id, req.user);
    const f = q('SELECT id, name, kind, mime FROM files WHERE id = ? AND trashed = 0').get(String(req.body?.file_id || ''));
    if (!f || f.kind === 'folder' || !roleFor(f.id, req.user.id)) throw bad('That file is not available to attach');
    tx(() => {
      const list2 = JSON.parse(q('SELECT attachments FROM tasks WHERE id = ?').get(task.id).attachments || '[]');
      if (!list2.some((a) => a.id === f.id)) {
        if (list2.length >= MAX_ATTACHMENTS) throw bad(`At most ${MAX_ATTACHMENTS} files on a task`);
        list2.push({ id: f.id, name: f.name, kind: f.kind, mime: f.mime || null });
      }
      q('UPDATE tasks SET attachments = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(list2), now(), task.id);
    });
    shareAttachments(list, [q('SELECT attachments FROM tasks WHERE id = ?').get(task.id)]);
    changed(list);
    res.status(201).json(shapeFor(req.user.id)(q(`${TASK} WHERE t.id = ?`).get(task.id)));
  });
  r.delete('/tasks/:id/attachments/:fid', (req, res) => {
    const task = q('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!task) throw notFound('Task not found');
    const list = loadList(task.list_id, req.user);
    const left = JSON.parse(task.attachments || '[]').filter((a) => a.id !== req.params.fid);
    q('UPDATE tasks SET attachments = ?, updated_at = ? WHERE id = ?').run(left.length ? JSON.stringify(left) : null, now(), task.id);
    changed(list);
    res.json(shapeFor(req.user.id)(q(`${TASK} WHERE t.id = ?`).get(task.id)));
  });

  r.delete('/tasks/:id', (req, res) => {
    const task = q('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!task) throw notFound('Task not found');
    const list = loadList(task.list_id, req.user);
    tx(() => { q('DELETE FROM tasks WHERE id = ?').run(task.id); unblockFrom(list.id, task.id); });
    changed(list);
    res.json({ ok: true });
  });

  // Clear the completed tasks of a list.
  r.delete('/lists/:id/done', (req, res) => {
    const list = loadList(req.params.id, req.user);
    for (const t of q('SELECT id FROM tasks WHERE list_id = ? AND done_at IS NOT NULL').all(list.id)) unblockFrom(list.id, t.id);
    const n = q('DELETE FROM tasks WHERE list_id = ? AND done_at IS NOT NULL').run(list.id).changes;
    changed(list);
    res.json({ ok: true, deleted: n });
  });

  return r;
}

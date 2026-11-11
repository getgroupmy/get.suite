// Tasks: to-do lists, your own or shared with colleagues. Each task has a title, notes, a due date,
// someone it's assigned to (a person on the list), and a place in the list you can drag it to.
// Everyone on a list sees changes as they're made.
import { excelFromTable, sendXlsx } from '../office/excel.js';
import { addTimeRoutes } from '../tasktime.js';
import { cleanRepeat, nextDue } from '../taskrepeat.js';
import { trashTask, restoreTask, trashOfList, TASK_TRASH_DAYS } from '../tasktrash.js';
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
import { scheduleTask, blocksOf, clashes } from '../taskblocks.js';

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
for (const [col, type] of [['repeat', 'TEXT'], ['next_id', 'TEXT'], ['steps', 'TEXT'], ['important', 'INTEGER NOT NULL DEFAULT 0'], ['link_url', 'TEXT'], ['link_label', 'TEXT'], ['due_time', 'TEXT'], ['started', 'INTEGER NOT NULL DEFAULT 0'], ['done_by', 'TEXT'], ['attachments', 'TEXT'], ['blocked_by', 'TEXT'], ['tags', 'TEXT'], ['start', 'TEXT'], ['repeat_until', 'TEXT'], ['section_id', 'TEXT'], ['estimate', 'INTEGER'], ['priority', 'INTEGER']]) { // priority: 1 low, 2 medium, 3 high, or null; // estimate: minutes you expect it to take; // section_id: a heading on its list the task sits under, or null; // repeat_until: the last day a repeating task may come due (YYYY-MM-DD), or null for always; // start: the day work begins (YYYY-MM-DD), for the timeline; // tags: JSON ["client", …]; // blocked_by: tasks on the same list this one waits on, JSON [ids]; // attachments: Drive files, JSON [{ id, name, kind, mime }]; // steps: a checklist, JSON [{ id, title, done }]
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
export const SORTS = ['mine', 'due', 'title', 'added', 'important', 'priority'];
/** What Planned shows (with the person's id three times): open, dated, on their lists, and theirs or nobody's. */
const PLANNED = `t.done_at IS NULL AND t.due IS NOT NULL AND (l.owner_id = ? OR l.id IN (SELECT list_id FROM task_list_members WHERE user_id = ?))
                 AND (t.assignee_id IS NULL OR t.assignee_id = ?)`;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// A list's colour and emoji: shown beside its name, and with its tasks in Planned, My Day and the Calendar.
for (const col of ['color', 'emoji']) if (!q('PRAGMA table_info(task_lists)').all().some((c) => c.name === col)) q(`ALTER TABLE task_lists ADD COLUMN ${col} TEXT`).run();
export const LIST_COLORS = ['#d93025', '#e8710a', '#f9ab00', '#188038', '#12b5cb', '#1a73e8', '#9334e6', '#e52592', '#5f6368'];
/** An emoji for a list: a few characters with no letters or digits (or none). */
export function listEmojiOf(v) {
  const t = String(v ?? '').trim();
  if (!t) return null;
  if (t.length > 8 || /[\p{L}\p{N}\s]/u.test(t)) throw bad('Choose an emoji');
  return t;
}

// My Day: tasks you pick to do today, from any of your lists. It's yours alone (others on the list don't
// see it), and it starts empty each day: a pick is for the day it was made (the person's own date).
q(`CREATE TABLE IF NOT EXISTS task_myday (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, task_id)
)`).run();
const ON_MY_LISTS = '(l.owner_id = ? OR l.id IN (SELECT list_id FROM task_list_members WHERE user_id = ?))';
export const MAX_MYDAY = 100;

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

// Sections: headings that split a list into parts ("This week", "Later"); tasks sit under one or none.
q(`CREATE TABLE IF NOT EXISTS task_sections (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL REFERENCES task_lists(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position REAL NOT NULL,
  created_at INTEGER NOT NULL
)`).run();
export const MAX_SECTIONS = 30;
// Sections each person has folded away (their own choice, on every device).
q(`CREATE TABLE IF NOT EXISTS task_section_folded (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  section_id TEXT NOT NULL REFERENCES task_sections(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, section_id)
)`).run();
const sectionsOf = (listId, userId = null) => q(`SELECT s.id, s.name, s.position, EXISTS (SELECT 1 FROM task_section_folded f WHERE f.section_id = s.id AND f.user_id = ?) AS folded
  FROM task_sections s WHERE s.list_id = ? ORDER BY s.position`).all(userId, listId).map((x) => ({ ...x, folded: !!x.folded }));
/** A section id for a task on this list ('' or null for none); one from another list is refused. */
function sectionOn(listId, v) {
  if (v === null || v === '' || v === undefined) return null;
  if (!q('SELECT 1 FROM task_sections WHERE id = ? AND list_id = ?').get(String(v), listId)) throw bad('That section isn’t on this list');
  return String(v);
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

const TASK = `SELECT t.*, u.name AS assignee_name, c.name AS created_by_name, l.name AS list_name, l.color AS list_color, l.emoji AS list_emoji,
              (SELECT COUNT(*) FROM task_comments k WHERE k.task_id = t.id) AS comments
              FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id LEFT JOIN users c ON c.id = t.created_by JOIN task_lists l ON l.id = t.list_id`;
// Priority: kept as a number (so lists sort by it), given out by name.
export const PRIORITY = { low: 1, medium: 2, high: 3 };
const priorityName = (n) => Object.keys(PRIORITY).find((k) => PRIORITY[k] === n) || null;
/** A priority sent in ('high', 'medium', 'low', or null / '' for none) as its number. */
export function priorityOf(v) {
  if (v === null || v === undefined || v === '' || v === 'none') return null;
  if (!(v in PRIORITY)) throw bad('Priority is high, medium, low or none');
  return PRIORITY[v];
}
const shape = (t) => ({ ...t, priority: priorityName(t.priority), done: !!t.done_at, important: !!t.important, started: !!t.started && !t.done_at, // started: "In progress" on the board
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
export function tasksTable(tasks) {
  const head = ['Task', 'Status', 'Due', 'Time', 'Start', 'Assigned to', 'Important', 'Tags', 'Steps done', 'Steps', 'Notes', 'Completed'];
  const status = (t) => (t.done ? 'Done' : t.started ? 'In progress' : 'To do');
  const rows = tasks.map((t) => [t.title, status(t), t.due || '', t.due_time || '', t.start || '', t.assignee_name || '', t.important ? 'Yes' : '', (t.tags || []).map((x) => `#${x}`).join(' '),
    t.steps.length ? `${t.steps.filter((x) => x.done).length}/${t.steps.length}` : '', t.steps.map((x) => `${x.done ? '[x]' : '[ ]'} ${x.title}`).join('\n'), t.notes || '',
    t.done_at ? new Date(t.done_at).toISOString().slice(0, 10) : '']);
  // A list with sections says which each task is in (after Task, so the file reads in its parts).
  let table = [head, ...rows];
  // Estimates (minutes), when any task has one: after Time.
  if (tasks.some((t) => t.estimate)) table = table.map((r, i) => [...r.slice(0, 4), i ? (tasks[i - 1].estimate || '') : 'Estimate (min)', ...r.slice(4)]);
  // Priority, when any task has one: after Important.
  if (tasks.some((t) => t.priority)) { const at = table[0].indexOf('Important') + 1; table = table.map((r, i) => [...r.slice(0, at), i ? (tasks[i - 1].priority ? tasks[i - 1].priority[0].toUpperCase() + tasks[i - 1].priority.slice(1) : '') : 'Priority', ...r.slice(at)]); }
  if (tasks.some((t) => t.section_name)) table = table.map((r, i) => [r[0], i ? tasks[i - 1].section_name || '' : 'Section', ...r.slice(1)]);
  return table;
}
export const tasksCsv = (tasks) => `\ufeff${tasksTable(tasks).map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
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
  const r = cleanRepeat(v);
  if (!r) throw bad('Repeat must be daily, weekdays, weekly, monthly, yearly or a custom one (every N days, weeks, months or years)');
  return r;
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
/** Add tasks on top of a list: each a title, or { title, steps: [titles] } for a task with steps. */
export function addTasks(listId, userId, titles) {
  let top = (q('SELECT MIN(position) AS p FROM tasks WHERE list_id = ? AND done_at IS NULL').get(listId).p ?? 1) - titles.length;
  const t = now();
  for (const x of titles) {
    const title = typeof x === 'string' ? x : x.title;
    const steps = typeof x === 'object' && x.steps?.length ? JSON.stringify(x.steps.slice(0, 100).map((st) => ({ id: uid().slice(0, 8), title: String(st).slice(0, 500), done: false }))) : null;
    q('INSERT INTO tasks (id, list_id, title, steps, position, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(uid(), listId, title.slice(0, 500), steps, top++, userId, t, t);
  }
  return titles.length;
}

export default function taskRoutes() {
  const r = Router();

  r.get('/lists', (req, res) => {
    const me = req.user.id;
    // Everyone starts with a list of their own.
    if (!q('SELECT 1 FROM task_lists WHERE owner_id = ?').get(me)) q('INSERT INTO task_lists (id, owner_id, name, created_at) VALUES (?, ?, ?, ?)').run(uid(), me, 'My tasks', now());
    const lists = q(`SELECT l.id, l.name, l.owner_id, l.created_at, l.color, l.emoji, u.name AS owner_name,
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
    // Due today or overdue in Planned (today as the browser sees it, ?today=YYYY-MM-DD).
    const today = dueOf(String(req.query.today || '')) || new Date().toISOString().slice(0, 10);
    const planned = q(`SELECT COUNT(*) AS n FROM tasks t JOIN task_lists l ON l.id = t.list_id WHERE ${PLANNED} AND t.due <= ?`).get(me, me, me, today).n;
    res.json({ lists: lists.map((l) => ({ ...l, sort: sorts.get(l.id) || 'mine', mine: l.owner_id === me, members: members.filter((m) => m.list_id === l.id).map(({ list_id, ...p }) => p) })), assigned, important, planned });
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
      const secs = new Map();
      for (const sec of sectionsOf(list.id)) { secs.set(sec.id, uid()); q('INSERT INTO task_sections (id, list_id, name, position, created_at) VALUES (?, ?, ?, ?, ?)').run(secs.get(sec.id), id, sec.name, sec.position, t); }
      for (const x of tasks) {
        let steps = null;
        try { steps = x.steps ? JSON.stringify(JSON.parse(x.steps).map((st) => ({ ...st, id: uid().slice(0, 8), done: false }))) : null; } catch { steps = null; }
        let blocked = null;
        try { const b = JSON.parse(x.blocked_by || '[]').map((o) => ids.get(o)).filter(Boolean); blocked = b.length ? JSON.stringify(b) : null; } catch { blocked = null; }
        q(`INSERT INTO tasks (id, list_id, title, notes, due, due_time, start, position, repeat, repeat_until, steps, important, link_url, link_label, attachments, blocked_by, tags, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(ids.get(x.id), id, x.title, x.notes, moved(x.due), start && x.due ? x.due_time : null, moved(x.start), x.position, x.repeat, moved(x.repeat_until), steps, x.important, x.link_url, x.link_label, x.attachments, blocked, x.tags, req.user.id, t, t);
        if (x.section_id && secs.has(x.section_id)) q('UPDATE tasks SET section_id = ? WHERE id = ?').run(secs.get(x.section_id), ids.get(x.id));
        if (x.priority) q('UPDATE tasks SET priority = ? WHERE id = ?').run(x.priority, ids.get(x.id));
      }
    });
    sendTo([req.user.id], { type: 'tasks-changed', list_id: id });
    res.status(201).json({ id, name, tasks: tasks.length, shift_days: shift });
  });

  r.patch('/lists/:id', (req, res) => {
    const list = loadList(req.params.id, req.user, { own: true });
    const b = req.body || {};
    if (b.name !== undefined) q('UPDATE task_lists SET name = ? WHERE id = ?').run(str(b.name, { required: true, name: 'List name', max: 100 }), list.id);
    if (b.color !== undefined) { if (b.color && !LIST_COLORS.includes(b.color)) throw bad('Choose one of the colours'); q('UPDATE task_lists SET color = ? WHERE id = ?').run(b.color || null, list.id); }
    if (b.emoji !== undefined) q('UPDATE task_lists SET emoji = ? WHERE id = ?').run(listEmojiOf(b.emoji), list.id);
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
  // A link to a task, pasted in Chat: what it is, for a card. Only for people on its list (404 otherwise, as for the link).
  r.get('/tasks/:id/preview', (req, res) => {
    const { task: t } = taskFor(req);
    const steps = t.steps ? JSON.parse(t.steps) : [];
    res.json({
      id: t.id, list_id: t.list_id, list_name: t.list_name, title: t.title,
      done: !!t.done_at, started: !!t.started && !t.done_at, important: !!t.important,
      due: t.due || null, due_time: t.due_time || null, assignee_name: t.assignee_name || null,
      steps: steps.length ? { done: steps.filter((x) => x.done).length, total: steps.length } : null,
      comments: t.comments,
    });
  });
  // Duplicate a task: a copy just below it, not done, with its notes, steps (unticked), due date, start, repeat,
  // who it's for, star, tags, link and files; not its comments, time or what waits on it.
  r.post('/tasks/:id/duplicate', (req, res) => {
    const { task, list } = taskFor(req);
    if (q('SELECT COUNT(*) AS n FROM tasks WHERE list_id = ?').get(list.id).n >= MAX_TASKS) throw bad('This list is full');
    const below = q('SELECT MIN(position) AS p FROM tasks WHERE list_id = ? AND done_at IS NULL AND position > ?').get(list.id, task.position).p;
    const position = below === null ? task.position + 1 : (task.position + below) / 2;
    const id = uid(), t = now();
    const steps = task.steps ? JSON.stringify(JSON.parse(task.steps).map((x) => ({ ...x, id: uid(), done: false }))) : null;
    q(`INSERT INTO tasks (id, list_id, title, notes, due, due_time, start, assignee_id, position, repeat, repeat_until, steps, important, link_url, link_label, attachments, tags, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, list.id, task.title, task.notes, task.due, task.due_time, task.start, task.assignee_id, position, task.repeat, task.repeat_until, steps, task.important ? 1 : 0, task.link_url, task.link_label, task.attachments, task.tags, req.user.id, t, t);
    q('UPDATE tasks SET section_id = ?, estimate = ?, priority = ? WHERE id = ?').run(task.section_id, task.estimate, task.priority, id);
    changed(list);
    res.status(201).json(shape(q(`${TASK} WHERE t.id = ?`).get(id)));
  });
  // Skip this time: a repeating task moves on to its next date without being ticked off (missed ones skipped too).
  r.post('/tasks/:id/skip', (req, res) => {
    const { task, list } = taskFor(req);
    if (!task.repeat || !task.due) throw bad('Only a repeating task with a due date can skip a time');
    if (task.done_at) throw bad('It’s done already');
    const today = todayOf(req.body?.today);
    const after = shiftDay(task.due, 1);
    const due = nextDue(task.due, task.repeat, after > today ? after : today);
    if (!due) throw bad('There is no next time');
    if (task.repeat_until && due > task.repeat_until) throw bad('That’s the last time: it stops repeating after this');
    const start = task.start ? shiftDay(due, -daysBetween(task.start, task.due)) : null;
    q('UPDATE tasks SET due = ?, start = ?, updated_at = ? WHERE id = ?').run(due, start, now(), task.id);
    changed(list);
    res.json(shape(q(`${TASK} WHERE t.id = ?`).get(task.id)));
  });

  // Time blocks on your calendar for working on a task: your coming ones, a check for clashes, and booking one.
  r.get('/tasks/:id/blocks', (req, res) => {
    const { task } = taskFor(req);
    const start = Number(req.query.start), end = Number(req.query.end);
    res.json({ blocks: blocksOf(req.user.id, task.id), ...(Number.isFinite(start) && Number.isFinite(end) && end > start && { clashes: clashes(req.user.id, start, end, task.id) }) });
  });
  r.post('/tasks/:id/blocks', (req, res) => {
    const { task } = taskFor(req);
    const base = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
    res.status(201).json(scheduleTask(req.user, task, { ...req.body, link: `${base}/tasks/${task.list_id}?task=${task.id}` }));
  });

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
  r.get('/lists/:id/sections', (req, res) => res.json(sectionsOf(loadList(req.params.id, req.user).id, req.user.id)));
  // Fold a section away (or open it again): yours alone.
  r.put('/sections/:id/folded', (req, res) => {
    const { sec, list } = sectionFor(req);
    if (req.body?.folded) q('INSERT OR IGNORE INTO task_section_folded (user_id, section_id) VALUES (?, ?)').run(req.user.id, sec.id);
    else q('DELETE FROM task_section_folded WHERE user_id = ? AND section_id = ?').run(req.user.id, sec.id);
    sendTo([req.user.id], { type: 'tasks-changed', list_id: list.id });
    res.json({ folded: !!req.body?.folded });
  });
  r.post('/lists/:id/sections', (req, res) => {
    const list = loadList(req.params.id, req.user);
    const name = str(req.body?.name, { required: true, name: 'Section name', max: 100 });
    if (q('SELECT COUNT(*) AS n FROM task_sections WHERE list_id = ?').get(list.id).n >= MAX_SECTIONS) throw bad(`A list can have ${MAX_SECTIONS} sections`);
    const id = uid();
    const position = (q('SELECT MAX(position) AS p FROM task_sections WHERE list_id = ?').get(list.id).p ?? 0) + 1;
    q('INSERT INTO task_sections (id, list_id, name, position, created_at) VALUES (?, ?, ?, ?, ?)').run(id, list.id, name, position, now());
    changed(list);
    res.status(201).json({ id, name, position, folded: false });
  });
  const sectionFor = (req) => {
    const sec = q('SELECT * FROM task_sections WHERE id = ?').get(req.params.id);
    if (!sec) throw notFound('Section not found');
    return { sec, list: loadList(sec.list_id, req.user) };
  };
  // Rename a section, or move it ({ position }, between its neighbours').
  r.patch('/sections/:id', (req, res) => {
    const { sec, list } = sectionFor(req);
    const set = {};
    if (req.body?.name !== undefined) set.name = str(req.body.name, { required: true, name: 'Section name', max: 100 });
    if (req.body?.position !== undefined) { if (!Number.isFinite(Number(req.body.position))) throw bad('Bad position'); set.position = Number(req.body.position); }
    const keys = Object.keys(set);
    if (keys.length) q(`UPDATE task_sections SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => set[k]), sec.id);
    changed(list);
    res.json(sectionsOf(list.id, req.user.id).find((x) => x.id === sec.id));
  });
  // Delete a section: its tasks stay on the list, under no section (or, with { tasks: true }, go too).
  r.delete('/sections/:id', (req, res) => {
    const { sec, list } = sectionFor(req);
    const withTasks = req.query.tasks === '1';
    tx(() => {
      if (withTasks) { for (const t of q('SELECT id FROM tasks WHERE section_id = ?').all(sec.id)) { unblockFrom(list.id, t.id); trashTask(t.id, req.user.id); } }
      else q('UPDATE tasks SET section_id = NULL WHERE section_id = ?').run(sec.id);
      q('DELETE FROM task_section_folded WHERE section_id = ?').run(sec.id);
      q('DELETE FROM task_sections WHERE id = ?').run(sec.id);
    });
    changed(list);
    res.json({ ok: true });
  });
  r.put('/lists/:id/sort', (req, res) => {
    const list = loadList(req.params.id, req.user);
    const sort = String(req.body.sort || '');
    if (!SORTS.includes(sort)) throw bad('Sort by your order, due date, title, date added, importance or priority');
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
    // Sections named in the file: the list's own (whatever the capitals), or new ones at the end.
    const secs = sectionsOf(list.id);
    const wanted = [...new Set(found.tasks.map((x) => x.section).filter(Boolean))];
    const fresh = wanted.filter((n) => !secs.some((x) => x.name.toLowerCase() === n.toLowerCase()));
    if (secs.length + fresh.length > MAX_SECTIONS) throw bad(`A list can have ${MAX_SECTIONS} sections`);
    tx(() => {
      let pos = secs.length ? Math.max(...secs.map((x) => x.position)) : 0;
      for (const n of fresh) { const sid = uid(); q('INSERT INTO task_sections (id, list_id, name, position, created_at) VALUES (?, ?, ?, ?, ?)').run(sid, list.id, n, ++pos, t); secs.push({ id: sid, name: n }); }
      const secId = (n) => (n ? secs.find((x) => x.name.toLowerCase() === n.toLowerCase())?.id || null : null);
      for (const x of found.tasks) {
        const steps = x.steps.length ? JSON.stringify(x.steps.map((st) => ({ id: uid(), title: st.title, done: st.done }))) : null;
        const tid = uid();
        q(`INSERT INTO tasks (id, list_id, title, notes, due, due_time, start, position, important, tags, steps, done_at, done_by, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(tid, list.id, x.title, x.notes, x.due, x.due_time, x.start, ++at, x.important ? 1 : 0, x.tags.length ? JSON.stringify(x.tags) : null, steps, x.done ? t : null, x.done ? req.user.id : null, req.user.id, t, t);
        if (x.section) q('UPDATE tasks SET section_id = ? WHERE id = ?').run(secId(x.section), tid);
        if (x.estimate) q('UPDATE tasks SET estimate = ? WHERE id = ?').run(x.estimate, tid);
        if (x.priority) q('UPDATE tasks SET priority = ? WHERE id = ?').run(PRIORITY[x.priority], tid);
      }
    });
    changed(list);
    res.json({ added: found.tasks.length, done: found.tasks.filter((x) => x.done).length, skipped: found.skipped });
  });

  /** Tasks with their section's name; open ones in the list's order section by section (none first), then done ones. */
  function withSectionNames(listId, rows) {
    const secs = sectionsOf(listId);
    if (!secs.length) return rows;
    const at = new Map(secs.map((x, i) => [x.id, i]));
    const named = rows.map((t) => ({ ...t, section_name: secs[at.get(t.section_id)]?.name || '' }));
    const rank = (t) => (t.done ? 1e6 : at.has(t.section_id) ? at.get(t.section_id) + 1 : 0);
    return named.map((t, i) => [t, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([t]) => t);
  }
  // The whole list as a spreadsheet (CSV, opens in Excel or Sheets): open tasks in order, then done ones.
  r.get('/lists/:id/export.xlsx', async (req, res) => {
    const list = loadList(req.params.id, req.user);
    const rows = withSectionNames(list.id, q(`${TASK} WHERE t.list_id = ? ORDER BY t.done_at IS NOT NULL, CASE WHEN t.done_at IS NULL THEN t.position END, t.done_at DESC`).all(list.id).map(shape));
    sendXlsx(res, `${list.name || 'Tasks'}.xlsx`, await excelFromTable(list.name || 'Tasks', tasksTable(rows)));
  });

  r.get('/lists/:id/export.csv', (req, res) => {
    const list = loadList(req.params.id, req.user);
    const rows = withSectionNames(list.id, q(`${TASK} WHERE t.list_id = ? ORDER BY t.done_at IS NOT NULL, CASE WHEN t.done_at IS NULL THEN t.position END, t.done_at DESC`).all(list.id).map(shape));
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

  // Planned: open tasks with a due date on any of your lists that are for you (given to you, or to nobody),
  // soonest first (the browser groups them: overdue, today, tomorrow, the next 7 days, later).
  r.get('/planned', (req, res) => {
    const me = req.user.id;
    res.json(q(`${TASK} WHERE ${PLANNED} ORDER BY t.due, t.due_time IS NULL, t.due_time, t.position LIMIT 1000`).all(me, me, me).map(shape));
  });

  // My Day for the given day (?today=YYYY-MM-DD, the person's own date): what was picked, in the order it
  // was added (done ones too, so they can be seen ticked off). Earlier days' picks are cleared.
  r.get('/myday', (req, res) => {
    const me = req.user.id, day = todayOf(req.query.today);
    q('DELETE FROM task_myday WHERE user_id = ? AND day != ?').run(me, day);
    res.json(q(`${TASK} JOIN task_myday m ON m.task_id = t.id AND m.user_id = ? AND m.day = ? WHERE ${ON_MY_LISTS}
                ORDER BY t.done_at IS NOT NULL, m.added_at`).all(me, day, me, me).map((t) => ({ ...shape(t), my_day: true })));
  });
  // Suggestions for My Day: open tasks for you that are due today or overdue, and not picked yet.
  r.get('/myday/suggestions', (req, res) => {
    const me = req.user.id, day = todayOf(req.query.today);
    res.json(q(`${TASK} WHERE ${PLANNED} AND t.due <= ? AND t.id NOT IN (SELECT task_id FROM task_myday WHERE user_id = ? AND day = ?)
                ORDER BY t.due, t.due_time IS NULL, t.due_time, t.position LIMIT 20`).all(me, me, me, day, me, day).map(shape));
  });
  // Add a task to My Day ({ on: false } takes it off), for today.
  r.post('/tasks/:id/myday', (req, res) => {
    const { task } = taskFor(req);
    const me = req.user.id, day = todayOf(req.body?.today);
    if (req.body?.on === false) q('DELETE FROM task_myday WHERE user_id = ? AND task_id = ?').run(me, task.id);
    else {
      if (q('SELECT COUNT(*) AS n FROM task_myday WHERE user_id = ? AND day = ?').get(me, day).n >= MAX_MYDAY) throw bad(`At most ${MAX_MYDAY} tasks in My Day`);
      q('INSERT INTO task_myday (user_id, task_id, day, added_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, task_id) DO UPDATE SET day = excluded.day, added_at = excluded.added_at').run(me, task.id, day, now());
    }
    sendTo([me], { type: 'tasks-changed', list_id: task.list_id });
    res.json({ on: req.body?.on !== false });
  });

  // Open tasks marked important on any of your lists: overdue and soonest first, those without a date last.
  // What you ticked off in the last 30 days, on any of your lists: newest first (for a weekly look back).
  r.get('/completed', (req, res) => {
    const me = req.user.id;
    const days = req.query.days === undefined ? 30 : Number(req.query.days); // 7 for the week, or 30
    if (![7, 30].includes(days)) throw bad('Look back 7 or 30 days');
    const since = Date.now() - days * 864e5;
    res.json(q(`${TASK} WHERE t.done_at >= ? AND t.done_by = ? AND (l.owner_id = ? OR l.id IN (SELECT list_id FROM task_list_members WHERE user_id = ?))
                ORDER BY t.done_at DESC LIMIT 500`).all(since, me, me, me).map(shape));
  });
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

  // Today, for Home: open tasks in your My Day first (marked my_day), then the ones for you that are due today
  // or overdue and aren't in it (?today=YYYY-MM-DD, the person's own date).
  r.get('/today', (req, res) => {
    const me = req.user.id, day = todayOf(req.query.today);
    const picked = q(`${TASK} JOIN task_myday m ON m.task_id = t.id AND m.user_id = ? AND m.day = ? WHERE t.done_at IS NULL AND ${ON_MY_LISTS}
                      ORDER BY m.added_at`).all(me, day, me, me).map((t) => ({ ...shape(t), my_day: true }));
    const ids = new Set(picked.map((t) => t.id));
    const due = q(`${TASK} WHERE t.done_at IS NULL AND t.due <= ? AND (t.assignee_id = ? OR (t.assignee_id IS NULL AND l.owner_id = ?))
                   ORDER BY t.due, t.due_time IS NULL, t.due_time, t.position LIMIT 500`).all(day, me, me).map(shape).filter((t) => !ids.has(t.id));
    res.json([...picked, ...due]);
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
    if (req.body.section_id) q('UPDATE tasks SET section_id = ? WHERE id = ?').run(sectionOn(list.id, req.body.section_id), id);
    if (req.body.priority) q('UPDATE tasks SET priority = ? WHERE id = ?').run(priorityOf(req.body.priority), id);
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

  // Changing a task: first what would change (checked, nothing written), then doing it. Several tasks
  // at once (POST /tasks/batch) check them all before changing any.
  function planUpdate(taskId, b, user) {
    const task = q('SELECT * FROM tasks WHERE id = ?').get(taskId);
    if (!task) throw notFound('Task not found');
    const list = loadList(task.list_id, user);
    const req = { user }; // (the checks below are written for a request)
    const set = {};
    if (b.list_id !== undefined && b.list_id !== task.list_id) { // move to another of your lists
      const to = loadList(String(b.list_id), req.user);
      set.list_id = to.id;
      set.blocked_by = null; // what it waited on stays behind, and nothing there waits on it any more
      unblockFrom(task.list_id, task.id);
      set.position = (q('SELECT MIN(position) AS p FROM tasks WHERE list_id = ? AND done_at IS NULL').get(to.id).p ?? 1) - 1;
      if (task.assignee_id && !peopleOn(to).includes(task.assignee_id)) set.assignee_id = null;
      set.section_id = null; // sections belong to their list
    }
    const target = set.list_id ? q('SELECT * FROM task_lists WHERE id = ?').get(set.list_id) : list;
    if (b.section_id !== undefined) set.section_id = sectionOn(target.id, b.section_id);
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
    if (b.priority !== undefined) set.priority = priorityOf(b.priority);
    if (b.tags !== undefined) set.tags = tagsOf(b.tags);
    if (b.started !== undefined) set.started = b.started ? 1 : 0;
    if (b.estimate !== undefined) {
      const m = b.estimate === null || b.estimate === '' ? null : Number(b.estimate);
      if (m !== null && !(Number.isInteger(m) && m >= 1 && m <= 100 * 60)) throw bad('An estimate is a whole number of minutes, up to 100 hours');
      set.estimate = m;
    }
    if (b.done === false && b.started === undefined) set.started = 0; // brought back: to do again
    if (b.link !== undefined) { const l = linkOf(b.link); set.link_url = l.url; set.link_label = l.label; } // null takes it off
    if (b.repeat_until !== undefined) {
      const v = b.repeat_until === null || b.repeat_until === '' ? null : b.repeat_until;
      if (v !== null && (typeof v !== 'string' || !DATE_RE.test(v) || Number.isNaN(Date.parse(v)))) throw bad('The end date must be YYYY-MM-DD');
      set.repeat_until = v;
    }
    if (set.repeat === null) set.repeat_until = null; // not repeating: no end either
    { const rp = set.repeat !== undefined ? set.repeat : task.repeat, ru = set.repeat_until !== undefined ? set.repeat_until : task.repeat_until, du = set.due !== undefined ? set.due : task.due;
      if (ru && !rp) throw bad('Only a repeating task can end');
      if (ru && du && ru < du) throw bad('It can’t stop repeating before it’s due'); }
    if ((set.repeat ?? task.repeat) && !(set.due !== undefined ? set.due : task.due)) {
      if (set.repeat) throw bad('A repeating task needs a due date');
      set.repeat = null; set.repeat_until = null; // clearing the date stops it repeating
    }
    if (b.position !== undefined) { if (!Number.isFinite(Number(b.position))) throw bad('Bad position'); set.position = Number(b.position); }
    if (b.done === false && task.done_at && b.position === undefined) set.position = (q('SELECT MIN(position) AS p FROM tasks WHERE list_id = ? AND done_at IS NULL').get(target.id).p ?? 1) - 1; // back on top
    return { task, list, target, set };
  }
  function applyUpdate({ task, list, target, set }, b, user) {
    const req = { user };
    const keys = Object.keys(set);
    tx(() => {
      if (keys.length) q(`UPDATE tasks SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => set[k]), now(), task.id);
      const after = q('SELECT * FROM tasks WHERE id = ?').get(task.id);
      // Ticked off a repeating task: the next one comes due, on top of its list.
      if (b.done && !task.done_at && after.repeat && after.due && !after.next_id) {
        const due = nextDue(after.due, after.repeat, todayOf(b.today));
        if (due && !(after.repeat_until && due > after.repeat_until)) { // past its end date: that was the last time
        const start = after.start ? shiftDay(due, -daysBetween(after.start, after.due)) : null; // as long as before
        const top = (q('SELECT MIN(position) AS p FROM tasks WHERE list_id = ? AND done_at IS NULL').get(after.list_id).p ?? 1) - 1;
        const id = uid(), t = now();
        const steps = after.steps ? JSON.stringify(JSON.parse(after.steps).map((x) => ({ ...x, id: uid(), done: false }))) : null; // a fresh checklist
        q('INSERT INTO tasks (id, list_id, title, notes, due, due_time, start, assignee_id, position, repeat, repeat_until, steps, important, link_url, link_label, attachments, tags, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id, after.list_id, after.title, after.notes, due, after.due_time, start, after.assignee_id, top, after.repeat, after.repeat_until, steps, after.important ? 1 : 0, after.link_url, after.link_label, after.attachments, after.tags, after.created_by, t, t);
        q('UPDATE tasks SET next_id = ? WHERE id = ?').run(id, task.id);
        q('UPDATE tasks SET section_id = ?, estimate = ?, priority = ? WHERE id = ?').run(after.section_id, after.estimate, after.priority, id);
        }
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
    return next;
  }
  r.patch('/tasks/:id', (req, res) => {
    const b = req.body || {};
    res.json(applyUpdate(planUpdate(req.params.id, b, req.user), b, req.user));
  });

  // Several tasks at once: tick off (or bring back), a due date (or none), important or not, another list,
  // someone to do them, or delete them. Every task is checked first; if one can't be changed, none is.
  const BATCH_KEYS = ['section_id', 'done', 'due', 'important', 'priority', 'list_id', 'assignee_id'];
  r.post('/tasks/batch', (req, res) => {
    const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(String))];
    if (!ids.length) throw bad('Choose some tasks');
    if (ids.length > 500) throw bad('500 tasks at a time at most');
    if (req.body?.delete === true) {
      const found = ids.map((id) => { const t = q('SELECT * FROM tasks WHERE id = ?').get(id); if (!t) throw notFound('Task not found'); return { t, list: loadList(t.list_id, req.user) }; });
      tx(() => { for (const { t, list } of found) { trashTask(t.id, req.user.id); unblockFrom(list.id, t.id); } });
      for (const list of new Map(found.map(({ list }) => [list.id, list])).values()) changed(list);
      return res.json({ deleted: found.length });
    }
    const b = Object.fromEntries(Object.entries(req.body?.change || {}).filter(([k]) => BATCH_KEYS.includes(k)));
    if (!Object.keys(b).length) throw bad('Nothing to change');
    const plans = ids.map((id) => planUpdate(id, b, req.user));
    res.json({ tasks: plans.map((p) => applyUpdate(p, b, req.user)) });
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
    tx(() => { trashTask(task.id, req.user.id); unblockFrom(list.id, task.id); });
    changed(list);
    res.json({ ok: true, trash_days: TASK_TRASH_DAYS });
  });
  // A list's deleted tasks (kept TASK_TRASH_DAYS), and putting one back.
  r.get('/lists/:id/trash', (req, res) => res.json(trashOfList(loadList(req.params.id, req.user).id)));
  r.post('/trash/:id/restore', (req, res) => {
    const t = q('SELECT list_id FROM task_trash WHERE id = ?').get(String(req.params.id));
    if (!t) throw notFound('Not in the trash (or kept too long)');
    const list = loadList(t.list_id, req.user);
    if (q('SELECT COUNT(*) AS n FROM tasks WHERE list_id = ?').get(list.id).n >= MAX_TASKS) throw bad('This list is full');
    const id = restoreTask(String(req.params.id));
    changed(list);
    res.json(shapeFor(req.user.id)(q(`${TASK} WHERE t.id = ?`).get(id)));
  });

  // Clear the completed tasks of a list.
  r.delete('/lists/:id/done', (req, res) => {
    const list = loadList(req.params.id, req.user);
    const done = q('SELECT id FROM tasks WHERE list_id = ? AND done_at IS NOT NULL').all(list.id);
    tx(() => { for (const t of done) { unblockFrom(list.id, t.id); trashTask(t.id, req.user.id); } });
    const n = done.length;
    changed(list);
    res.json({ ok: true, deleted: n });
  });

  return r;
}

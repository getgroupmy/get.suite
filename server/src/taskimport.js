// Tasks from a spreadsheet (CSV): a list kept in Excel or Sheets, another to-do app's export, or a list
// downloaded from Workspace itself. The first row names the columns; only a task column is needed.
import { parseCsv } from './contactfiles.js';

export const MAX_TASK_IMPORT = 1000;

const COLUMNS = {
  title: ['task', 'title', 'name', 'subject', 'task name', 'to do', 'todo'],
  notes: ['notes', 'note', 'description', 'details', 'comments'],
  due: ['due', 'due date', 'deadline', 'date', 'due on'],
  time: ['time', 'due time'],
  start: ['start', 'start date'],
  tags: ['tags', 'tag', 'labels', 'label'],
  status: ['status', 'state', 'done', 'completed?'],
  completed: ['completed', 'completed on', 'completed at', 'done on', 'completion date'],
  important: ['important', 'priority', 'starred', 'star'],
  steps: ['steps', 'checklist', 'subtasks'],
  section: ['section', 'section/column', 'heading', 'group'],
  parent: ['parent task', 'parent'],
  estimate: ['estimate (min)', 'estimate', 'minutes'],
  priority: ['priority'],
};

const iso = (y, m, d) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null;
};

/** A date written the usual ways (2026-12-01, 1/12/2026 day first unless it can't be, 1.12.2026, Dec 1 2026) → YYYY-MM-DD, or null. */
export function dateOf(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s);
  if (m) {
    let [a, b, y] = [+m[1], +m[2], +m[3]];
    if (y < 100) y += 2000;
    return b > 12 ? iso(y, a, b) : iso(y, b, a); // 12/25/2026 is December; otherwise day first
  }
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  return iso(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

const timeOf = (text) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(text || '').trim()); return m && +m[1] < 24 && +m[2] < 60 ? `${m[1].padStart(2, '0')}:${m[2]}` : null; };
const yes = (text) => /^(yes|y|true|x|✓|☑|done|completed|complete|finished|high|★|1)$/i.test(String(text || '').trim());

/** { tasks: [{ title, notes, due, due_time, start, section, tags, done, important, steps }], skipped } or { error }. */
export function tasksFromCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { error: 'The file is empty' };
  const head = rows[0].map((h) => h.trim().toLowerCase());
  if (head.includes('type') && head.includes('content')) return fromTodoist(rows, head);
  const col = Object.fromEntries(Object.entries(COLUMNS).map(([k, names]) => [k, names.map((n) => head.indexOf(n)).find((i) => i >= 0) ?? -1]));
  if (col.title < 0) return { error: 'The first row must name the columns, with one called Task (or Title or Name)' };
  const get = (r, k) => (col[k] >= 0 ? String(r[col[k]] ?? '').trim() : '');
  const tasks = [];
  let skipped = 0;
  for (const r of rows.slice(1)) {
    const title = get(r, 'title').slice(0, 500);
    if (!title) { skipped++; continue; }
    const status = get(r, 'status');
    const tags = get(r, 'tags').split(/[\s,;]+/).map((x) => x.replace(/^#+/, '').toLowerCase()).filter((x) => /^\p{L}[\p{L}\p{N}_-]{0,29}$/u.test(x)).slice(0, 10);
    const steps = get(r, 'steps').split(/\r?\n/).map((l) => /^\s*\[([ xX✓])\]\s*(.+)$/.exec(l) || (l.trim() ? [null, ' ', l.trim()] : null)).filter(Boolean)
      .slice(0, 100).map(([, mark, t]) => ({ title: t.trim().slice(0, 500), done: mark !== ' ' }));
    const due = dateOf(get(r, 'due'));
    tasks.push({
      title, notes: get(r, 'notes').slice(0, 10000) || null, due, due_time: due ? timeOf(get(r, 'time')) : null, start: dateOf(get(r, 'start')),
      section: get(r, 'section').replace(/\s+/g, ' ').slice(0, 100) || null,
      ...((() => { const m = Math.round(Number(get(r, 'estimate'))); return m >= 1 && m <= 6000 ? { estimate: m } : {}; })()),
      ...((() => { const v = String(get(r, 'priority') || '').trim().toLowerCase(); const p = { high: 'high', h: 'high', 3: 'high', medium: 'medium', med: 'medium', m: 'medium', 2: 'medium', low: 'low', l: 'low', 1: 'low' }[v]; return p ? { priority: p } : {}; })()),
      ...(get(r, 'parent') && { parent: get(r, 'parent').slice(0, 500) }),
      tags: [...new Set(tags)], done: yes(status) || /^done|completed$/i.test(status) || !!dateOf(get(r, 'completed')) || (/^\d/.test(status) && !!dateOf(status)), important: yes(get(r, 'important')), steps, // a date in Done: when it was done
    });
  }
  if (!tasks.length) return { error: 'No tasks found: the Task column is empty' };
  if (tasks.length > MAX_TASK_IMPORT) return { error: `At most ${MAX_TASK_IMPORT} tasks can be brought in at once` };
  return { tasks: foldSubtasks(tasks), skipped };
}

/** Asana (and others) list subtasks as rows of their own with a Parent task column: they become the parent's steps. */
function foldSubtasks(tasks) {
  const byTitle = new Map();
  for (const t of tasks) if (!t.parent && !byTitle.has(t.title.toLowerCase())) byTitle.set(t.title.toLowerCase(), t);
  const out = [];
  for (const t of tasks) {
    const p = t.parent && byTitle.get(t.parent.toLowerCase());
    delete t.parent;
    if (p && p !== t && p.steps.length < 100) p.steps.push({ title: t.title, done: t.done });
    else out.push(t);
  }
  return out;
}

/**
 * Todoist's CSV export (a project's ⋯ → Export as a template, or a backup): TYPE (task, section, note), CONTENT, DESCRIPTION,
 * PRIORITY (1 highest … 4 none), INDENT (2 and more: a subtask, kept as a step), DATE. Sections become sections, notes
 * (comments) go into the task's notes, and @labels in a task become tags.
 */
function fromTodoist(rows, head) {
  const at = (n) => head.indexOf(n);
  const [type, content, desc, prio, indent, date] = ['type', 'content', 'description', 'priority', 'indent', 'date'].map(at);
  const get = (r, i) => (i >= 0 ? String(r[i] ?? '').trim() : '');
  const tasks = [];
  let section = null, last = null, skipped = 0;
  for (const r of rows.slice(1)) {
    const kind = get(r, type).toLowerCase(), text = get(r, content);
    if (kind === 'section') { section = text.slice(0, 100) || null; continue; }
    if (kind === 'note') { if (last && text) last.notes = `${last.notes ? `${last.notes}\n\n` : ''}${text}`.slice(0, 10000); continue; }
    if (kind !== 'task' || !text) { if (kind || text) skipped++; continue; }
    const labels = [...text.matchAll(/(?:^|\s)@([\p{L}\p{N}_-]+)/gu)].map((m) => m[1].toLowerCase()).filter((x) => /^\p{L}[\p{L}\p{N}_-]{0,29}$/u.test(x));
    const title = text.replace(/(?:^|\s)@[\p{L}\p{N}_-]+/gu, '').trim().slice(0, 500) || text.slice(0, 500);
    if (Number(get(r, indent)) > 1 && last) { if (last.steps.length < 100) last.steps.push({ title, done: false }); continue; }
    const p = { 1: 'high', 2: 'medium', 3: 'low' }[get(r, prio)];
    last = { title, notes: get(r, desc).slice(0, 10000) || null, due: dateOf(get(r, date)), due_time: null, start: null, section, tags: [...new Set(labels)].slice(0, 10), done: false, important: false, steps: [], ...(p && { priority: p }) };
    tasks.push(last);
  }
  if (!tasks.length) return { error: 'No tasks found in that Todoist file' };
  if (tasks.length > MAX_TASK_IMPORT) return { error: `At most ${MAX_TASK_IMPORT} tasks can be brought in at once` };
  return { tasks, skipped };
}

/** A CSV with a List column (Download your data's Tasks.csv, or any sheet): [{ name, text }] one CSV per list, in order of appearance; null if there's no List column. */
export function splitByList(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return null;
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const at = ['list', 'list name', 'tasklist', 'project'].map((n) => head.indexOf(n)).find((i) => i >= 0) ?? -1;
  if (at < 0) return null;
  const cell = (v) => { const x = String(v ?? ''); return /[",\r\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x; };
  const line = (r) => r.map(cell).join(',');
  const groups = new Map();
  for (const r of rows.slice(1)) {
    const name = String(r[at] ?? '').trim().slice(0, 100) || 'Tasks';
    if (!groups.has(name.toLowerCase())) groups.set(name.toLowerCase(), { name, rows: [] });
    groups.get(name.toLowerCase()).rows.push(r);
  }
  return [...groups.values()].map((g) => ({ name: g.name, text: [line(rows[0]), ...g.rows.map(line)].join('\r\n') }));
}

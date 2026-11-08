// Time spent on tasks: a timer per person (starting one stops their other one), or time added by
// hand ("1h 30m"), with totals per task and a report per list (who spent how long on what,
// between two dates) as a table or CSV. Everyone on a list sees its time; each person changes
// only their own entries.
import { q } from './db.js';
import { uid, now, str, bad, notFound } from './util.js';

q(`CREATE TABLE IF NOT EXISTS task_time (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,                 -- null while the timer runs
  minutes INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  manual INTEGER NOT NULL DEFAULT 0
)`).run();
q('CREATE INDEX IF NOT EXISTS task_time_task ON task_time(task_id)').run();
q('CREATE INDEX IF NOT EXISTS task_time_user ON task_time(user_id, ended_at)').run();

export const MAX_MINUTES = 24 * 60; // one entry: a day at most
const TIMER_LIMIT = 12 * 60; // a timer left running longer than this counts as 12 hours (forgotten overnight)

/** "1h 30m", "1.5h", "90", "90m", "1:30", "2 h" → minutes, or null when it isn't a duration. */
export function parseDuration(text) {
  const t = String(text ?? '').trim().toLowerCase();
  if (!t) return null;
  let m;
  if ((m = /^(\d{1,2}):([0-5]\d)$/.exec(t))) return Number(m[1]) * 60 + Number(m[2]);
  if ((m = /^(\d+(?:\.\d+)?)\s*$/.exec(t))) return Math.round(Number(m[1]));
  if ((m = /^(?:(\d+(?:\.\d+)?)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?|s)?)?)?$/.exec(t)) && (m[1] || m[2])) return Math.round(Number(m[1] || 0) * 60 + Number(m[2] || 0));
  return null;
}

/** 135 → "2 h 15 min", 45 → "45 min", 0 → "0 min". */
export function formatMinutes(min) {
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`;
}

const minutesBetween = (a, b) => Math.max(0, Math.min(TIMER_LIMIT, Math.round((b - a) / 60000)));

/** Stop someone's running timer (if any), counting its minutes. Returns the stopped entry's task id. */
export function stopTimer(userId, at = now()) {
  const run = q('SELECT * FROM task_time WHERE user_id = ? AND ended_at IS NULL').get(userId);
  if (!run) return null;
  q('UPDATE task_time SET ended_at = ?, minutes = ? WHERE id = ?').run(at, minutesBetween(run.started_at, at), run.id);
  return run.task_id;
}

/** A task's time: entries (newest first, running ones with their minutes so far), and totals per person. */
export function timeOf(taskId, at = now()) {
  const entries = q(`SELECT e.*, u.name AS user_name FROM task_time e LEFT JOIN users u ON u.id = e.user_id WHERE e.task_id = ? ORDER BY e.started_at DESC`).all(taskId)
    .map((e) => ({ ...e, running: e.ended_at === null, minutes: e.ended_at === null ? minutesBetween(e.started_at, at) : e.minutes, manual: !!e.manual }));
  const people = new Map();
  for (const e of entries) people.set(e.user_id, { user_id: e.user_id, name: e.user_name, minutes: (people.get(e.user_id)?.minutes || 0) + e.minutes });
  return { entries, total: entries.reduce((n, e) => n + e.minutes, 0), people: [...people.values()].sort((a, b) => b.minutes - a.minutes) };
}

/** Minutes so far per task on a list (for the list view), and who has a timer running on which task. */
export function listTime(listId, at = now()) {
  const rows = q(`SELECT e.task_id, e.user_id, e.started_at, e.ended_at, e.minutes, u.name FROM task_time e JOIN tasks t ON t.id = e.task_id LEFT JOIN users u ON u.id = e.user_id WHERE t.list_id = ?`).all(listId);
  const out = {};
  for (const r of rows) {
    const o = (out[r.task_id] ||= { minutes: 0, running: [] });
    o.minutes += r.ended_at === null ? minutesBetween(r.started_at, at) : r.minutes;
    if (r.ended_at === null) o.running.push({ user_id: r.user_id, name: r.name, since: r.started_at });
  }
  return out;
}

/** The time spent on a list's tasks between two days (YYYY-MM-DD, inclusive, in UTC): per person and task. */
export function listReport(listId, from, to, at = now()) {
  const start = Date.parse(`${from}T00:00:00Z`), end = Date.parse(`${to}T00:00:00Z`) + 864e5;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw bad('Choose a start and end date, the start first');
  const rows = q(`SELECT e.*, t.title, u.name AS user_name FROM task_time e JOIN tasks t ON t.id = e.task_id LEFT JOIN users u ON u.id = e.user_id
                  WHERE t.list_id = ? AND e.started_at >= ? AND e.started_at < ? ORDER BY u.name, t.title`).all(listId, start, end);
  const lines = new Map();
  for (const r of rows) {
    const k = `${r.user_id}|${r.task_id}`;
    const l = lines.get(k) || { person: r.user_name || 'Someone', task: r.title, minutes: 0 };
    l.minutes += r.ended_at === null ? minutesBetween(r.started_at, at) : r.minutes;
    lines.set(k, l);
  }
  const list = [...lines.values()].sort((a, b) => a.person.localeCompare(b.person) || b.minutes - a.minutes);
  return { from, to, lines: list, total: list.reduce((n, l) => n + l.minutes, 0) };
}

const csvCell = (v) => { const s = String(v ?? ''); const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe; };
/** The report as CSV (formula-looking text made plain, for Excel). */
export function reportCsv(report) {
  const rows = [['Person', 'Task', 'Minutes', 'Hours'], ...report.lines.map((l) => [l.person, l.task, l.minutes, (l.minutes / 60).toFixed(2)]), ['Total', '', report.total, (report.total / 60).toFixed(2)]];
  return `${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

/** The routes, added to the tasks router: taskFor(req) → { task, list } (checks access), changed(list) tells the list's people. */
export function addTimeRoutes(r, { taskFor, loadList, changed }) {
  r.get('/timer', (req, res) => {
    const run = q('SELECT e.*, t.title, t.list_id FROM task_time e JOIN tasks t ON t.id = e.task_id WHERE e.user_id = ? AND e.ended_at IS NULL').get(req.user.id);
    res.json(run ? { task_id: run.task_id, title: run.title, list_id: run.list_id, since: run.started_at } : null);
  });
  r.post('/tasks/:id/timer', (req, res) => {
    const { task, list } = taskFor(req);
    const stoppedOn = stopTimer(req.user.id); // one timer at a time
    q('INSERT INTO task_time (id, task_id, user_id, started_at) VALUES (?, ?, ?, ?)').run(uid(), task.id, req.user.id, now());
    changed(list);
    if (stoppedOn && stoppedOn !== task.id) { const other = q('SELECT list_id FROM tasks WHERE id = ?').get(stoppedOn); if (other && other.list_id !== list.id) changed(loadList(other.list_id, req.user)); }
    res.status(201).json(timeOf(task.id));
  });
  r.post('/timer/stop', (req, res) => {
    const taskId = stopTimer(req.user.id);
    if (!taskId) throw notFound('No timer is running');
    const listId = q('SELECT list_id FROM tasks WHERE id = ?').get(taskId)?.list_id;
    if (listId) changed(loadList(listId, req.user));
    res.json({ task_id: taskId, ...timeOf(taskId) });
  });
  r.get('/tasks/:id/time', (req, res) => { const { task } = taskFor(req); res.json(timeOf(task.id)); });
  r.post('/tasks/:id/time', (req, res) => {
    const { task, list } = taskFor(req);
    const minutes = parseDuration(req.body?.duration);
    if (!minutes || minutes < 1 || minutes > MAX_MINUTES) throw bad('Enter how long, such as 45m, 1h 30m or 2:15 (a day at most)');
    const day = req.body?.day ? Date.parse(`${req.body.day}T12:00:00Z`) : now();
    if (!Number.isFinite(day) || day > now() + 864e5) throw bad('Choose a day up to today');
    const note = req.body?.note ? str(req.body.note, { max: 300 }) : null;
    q('INSERT INTO task_time (id, task_id, user_id, started_at, ended_at, minutes, note, manual) VALUES (?, ?, ?, ?, ?, ?, ?, 1)').run(uid(), task.id, req.user.id, day, day, minutes, note);
    changed(list);
    res.status(201).json(timeOf(task.id));
  });
  r.delete('/time/:entry', (req, res) => {
    const e = q('SELECT * FROM task_time WHERE id = ?').get(req.params.entry);
    if (!e || e.user_id !== req.user.id) throw notFound('Time entry not found'); // only your own
    const { list } = taskFor({ ...req, params: { id: e.task_id } });
    q('DELETE FROM task_time WHERE id = ?').run(e.id);
    changed(list);
    res.json(timeOf(e.task_id));
  });
  r.get('/lists/:id/time', (req, res) => { const list = loadList(req.params.id, req.user); res.json(listTime(list.id)); });
  r.get('/lists/:id/time-report', (req, res) => {
    const list = loadList(req.params.id, req.user);
    const report = listReport(list.id, String(req.query.from || ''), String(req.query.to || ''));
    if (req.query.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${list.name} time ${report.from} to ${report.to}.csv`)}`);
      res.send(`﻿${reportCsv(report)}`);
      return;
    }
    res.json({ ...report, list: list.name });
  });
}

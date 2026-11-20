// Time spent on tasks: a timer per person (starting one stops their other one), or time added by
// hand ("1h 30m"), with totals per task and a report per list (who spent how long on what,
// between two dates) as a table or CSV. Everyone on a list sees its time; each person changes
// only their own entries.
import { q } from './db.js';
import { uid, now, str, bad, notFound } from './util.js';
import { colName } from './office/sheetnames.js';
import { csvCell } from './csvcell.js';

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
// A focus session: a timer that stops by itself at `until` (counted to then), with a note to its owner.
if (!q('PRAGMA table_info(task_time)').all().some((c) => c.name === 'until')) q('ALTER TABLE task_time ADD COLUMN until INTEGER').run();
q('CREATE INDEX IF NOT EXISTS task_time_task ON task_time(task_id)').run();
q('CREATE INDEX IF NOT EXISTS task_time_user ON task_time(user_id, ended_at)').run();

export const MAX_MINUTES = 24 * 60; // one entry: a day at most
// How long a focus session's minute lasts: a minute, except in browser tests (FOCUS_SECONDS_PER_MINUTE=1 makes 5 minutes 5 seconds).
const FOCUS_MINUTE_MS = Number(process.env.FOCUS_SECONDS_PER_MINUTE) * 1000 || 60e3;
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
  const end = run.until ? Math.min(at, run.until) : at; // a focus session counts no further than its end
  const minutes = minutesBetween(run.started_at, end);
  // Under half a minute (started by mistake, or all of it left out as time away) counts nothing: no "0 min" entry is kept.
  if (minutes === 0 && !(run.until && end >= run.until)) q('DELETE FROM task_time WHERE id = ?').run(run.id); // a focus session that ran to its end is kept
  else q('UPDATE task_time SET ended_at = ?, minutes = ? WHERE id = ?').run(end, minutes, run.id);
  return run.task_id;
}

/**
 * Focus sessions whose time is up are stopped (at their end) and their owners told; `onDone(userId, task, minutes)`
 * does the telling. Run every half minute; returns how many were stopped.
 */
export function endFocusSessions(onDone, at = now()) {
  const due = q('SELECT e.*, t.title, t.list_id FROM task_time e JOIN tasks t ON t.id = e.task_id WHERE e.ended_at IS NULL AND e.until IS NOT NULL AND e.until <= ?').all(at);
  for (const run of due) {
    q('UPDATE task_time SET ended_at = ?, minutes = ? WHERE id = ?').run(run.until, minutesBetween(run.started_at, run.until), run.id);
    try { onDone(run.user_id, run, minutesBetween(run.started_at, run.until)); } catch { /* told or not, it's stopped */ }
  }
  return due.length;
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
export function listReport(listId, from, to, at = now(), billing = null) {
  const start = Date.parse(`${from}T00:00:00Z`), end = Date.parse(`${to}T00:00:00Z`) + 864e5;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw bad('Choose a start and end date, the start first');
  const rows = q(`SELECT e.*, t.title, t.nonbillable, u.name AS user_name FROM task_time e JOIN tasks t ON t.id = e.task_id LEFT JOIN users u ON u.id = e.user_id
                  WHERE t.list_id = ? AND e.started_at >= ? AND e.started_at < ? ORDER BY u.name, t.title`).all(listId, start, end);
  const lines = new Map();
  for (const r of rows) {
    const k = `${r.user_id}|${r.task_id}`;
    const l = lines.get(k) || { person: r.user_name || 'Someone', task: r.title, minutes: 0, ...(r.nonbillable && { billable: false }) };
    l.minutes += r.ended_at === null ? minutesBetween(r.started_at, at) : r.minutes;
    lines.set(k, l);
  }
  const list = [...lines.values()].sort((a, b) => a.person.localeCompare(b.person) || b.minutes - a.minutes);
  const total = list.reduce((n, l) => n + l.minutes, 0);
  if (!billing?.rate) return { from, to, lines: list, total };
  // At the list's hourly rate: each line's amount to the cent, and the total of those.
  const money = (m) => Math.round((m / 60) * billing.rate * 100) / 100;
  for (const l of list) l.amount = l.billable === false ? 0 : money(l.minutes); // a task marked not billable counts nothing
  return { from, to, lines: list, total, rate: billing.rate, currency: billing.currency, amount: Math.round(list.reduce((n, l) => n + l.amount * 100, 0)) / 100 };
}

/**
 * The report as a spreadsheet (Sheets' content): Person, Task, Minutes, Hours (and Amount at a rate), a header row kept
 * in view, and a Total row of SUM formulas, so changes made there add up.
 */
export function reportSheet(report, listName) {
  const billed = report.rate != null;
  const head = ['Person', 'Task', 'Minutes', 'Hours', ...(billed ? [`Amount (${report.currency})`] : [])];
  const cells = {}, formats = {};
  head.forEach((h, c) => { cells[`${colName(c)}1`] = h; formats[`${colName(c)}1`] = { b: true }; });
  const plain = (v) => (/^[=+\-@]/.test(v) ? `'${v}` : v); // names that look like formulas stay text
  report.lines.forEach((l, i) => {
    const r = i + 2;
    cells[`A${r}`] = plain(l.person); cells[`B${r}`] = plain(l.task); cells[`C${r}`] = String(l.minutes);
    cells[`D${r}`] = `=ROUND(C${r}/60,2)`; formats[`D${r}`] = { num: 'number', dp: 2 };
    if (billed && l.billable === false) cells[`E${r}`] = 'not billable';
    else if (billed) { cells[`E${r}`] = `=ROUND(C${r}/60*$G$2,2)`; formats[`E${r}`] = { num: 'currency', cur: report.currency, dp: 2 }; } // the rate is in G2: change it there and the amounts follow
  });
  const last = report.lines.length + 1, t = last + 1;
  cells[`A${t}`] = 'Total'; formats[`A${t}`] = { b: true };
  for (const c of billed ? ['C', 'D', 'E'] : ['C', 'D']) {
    cells[`${c}${t}`] = last >= 2 ? `=SUM(${c}2:${c}${last})` : '0';
    formats[`${c}${t}`] = { b: true, ...(c === 'D' && { num: 'number', dp: 2 }), ...(c === 'E' && { num: 'currency', cur: report.currency, dp: 2 }) };
  }
  if (billed) { cells.G1 = 'Rate per hour'; formats.G1 = { b: true }; cells.G2 = String(report.rate); formats.G2 = { num: 'currency', cur: report.currency, dp: 2 }; }
  return {
    name: `${listName} time ${report.from} to ${report.to}`.slice(0, 200),
    content: { sheets: [{ name: 'Time', cells, formats, colWidths: { A: 160, B: 240, C: 90, D: 90, ...(billed && { E: 130, G: 120 }) }, frozen: { rows: 1 } }] },
  };
}

/** Validates { rate, currency } for a list: a rate above 0 (up to 100 000) and a three-letter currency; rate null clears. */
export function billingOf(body) {
  if (body?.rate == null || body.rate === '') return { rate: null, currency: null };
  const rate = Number(body.rate), currency = String(body.currency || '').toUpperCase();
  if (!Number.isFinite(rate) || rate <= 0 || rate > 100000) throw bad('Enter an hourly rate above 0');
  if (!/^[A-Z]{3}$/.test(currency)) throw bad('Choose a currency, such as EUR or USD');
  return { rate: Math.round(rate * 100) / 100, currency };
}

export { csvCell }; // (csvcell.js)
/** All your time entries, oldest first, as CSV (Download your data): when, how long, on what, and a note. */
export function myTimeCsv(userId, at = now()) {
  const rows = q(`SELECT e.*, t.title, l.name AS list_name FROM task_time e JOIN tasks t ON t.id = e.task_id LEFT JOIN task_lists l ON l.id = t.list_id
                  WHERE e.user_id = ? ORDER BY e.started_at`).all(userId);
  const iso = (t) => new Date(t).toISOString().replace('T', ' ').slice(0, 16);
  const lines = [['Day', 'Started (UTC)', 'Ended (UTC)', 'Minutes', 'Task', 'List', 'Note', 'How']];
  for (const r of rows) {
    const running = r.ended_at === null;
    lines.push([iso(r.started_at).slice(0, 10), r.manual ? '' : iso(r.started_at), r.manual || running ? '' : iso(r.ended_at),
      running ? minutesBetween(r.started_at, at) : r.minutes, r.title, r.list_name || '', r.note || '', r.manual ? 'added by hand' : running ? 'timer, still running' : r.until ? 'focus session' : 'timer']);
  }
  return `${lines.map((l) => l.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

/** The report as CSV (formula-looking text made plain, for Excel). */
export function reportCsv(report) {
  const billed = report.rate != null, money = (x) => x.toFixed(2);
  const rows = [['Person', 'Task', 'Minutes', 'Hours', ...(billed ? [`Amount (${report.currency}, ${money(report.rate)}/h)`] : [])],
    ...report.lines.map((l) => [l.person, l.task, l.minutes, (l.minutes / 60).toFixed(2), ...(billed ? [l.billable === false ? 'not billable' : money(l.amount)] : [])]),
    ['Total', '', report.total, (report.total / 60).toFixed(2), ...(billed ? [money(report.amount)] : [])]];
  return `${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

/**
 * Your time on tasks in the last `days` (Home): minutes in all (running timers counted so far) and the tasks with
 * the most, on lists you're still on.
 */
export function myTimeOf(userId, days = 7, at = now(), range = null, limit = 5) {
  const since = range ? range.from : at - days * 864e5, until = range ? range.to : Infinity;
  const rows = q(`SELECT e.id, e.task_id, e.started_at, e.ended_at, e.minutes, e.manual, e.note, t.title, t.list_id FROM task_time e JOIN tasks t ON t.id = e.task_id
    WHERE e.user_id = ? AND ((e.started_at >= ? AND e.started_at < ?) OR (e.ended_at IS NULL AND ? >= ?))`).all(userId, since, until === Infinity ? 8.64e15 : until, until === Infinity ? 8.64e15 : until, at);
  const byTask = new Map(), spans = [];
  let total = 0;
  for (const r of rows) {
    const m = r.ended_at === null ? minutesBetween(r.started_at, at) : r.minutes;
    total += m;
    // For each day's bar in Time insights: a timed entry runs start → end; a logged one is `minutes` on its day.
    if (range && m > 0) spans.push({ id: r.id, task_id: r.task_id, start: r.started_at, ...(r.manual ? { minutes: m, logged: true } : { end: r.ended_at ?? at, ...(r.ended_at === null && { running: true }) }), ...(r.note && { note: r.note }) });
    const x = byTask.get(r.task_id) || { id: r.task_id, title: r.title, list_id: r.list_id, minutes: 0 };
    x.minutes += m; byTask.set(r.task_id, x);
  }
  return { days, ...(range && { ...range, spans: spans.sort((a, b) => a.start - b.start) }), minutes: total, tasks: [...byTask.values()].sort((a, b) => b.minutes - a.minutes).slice(0, limit) };
}

/** The routes, added to the tasks router: taskFor(req) → { task, list } (checks access), changed(list) tells the list's people. */
export function addTimeRoutes(r, { taskFor, loadList, changed, onFocus = () => {} }) {
  // ?days=N (the last N days), or ?from=&to= (ms; a week in Calendar's Time insights or the timesheet, up to 62 days;
  // with spans, each entry, and with &all=1 every task, not just the top five).
  r.get('/time/mine', (req, res) => {
    const from = Number(req.query.from), to = Number(req.query.to);
    if (Number.isFinite(from) && Number.isFinite(to)) {
      if (to <= from || to - from > 62 * 864e5) throw bad('Pick up to two months');
      return res.json(myTimeOf(req.user.id, Math.round((to - from) / 864e5), now(), { from, to }, req.query.all ? Infinity : 5)); // all: every task (the timesheet)
    }
    res.json(myTimeOf(req.user.id, Math.min(31, Math.max(1, Number(req.query.days) || 7))));
  });
  // Focus sessions finished since a time (?since=ms, the browser's midnight; ?until for a week): { sessions, minutes }. Ones stopped early don't count.
  r.get('/focus/done', (req, res) => {
    const since = Number(req.query.since), until = req.query.until === undefined ? Infinity : Number(req.query.until); // ?until: a week's end (Time insights)
    if (!Number.isFinite(since) || Number.isNaN(until)) throw bad('Since when?');
    const t = now(); // one whose time is up but not yet closed by the half-minute sweep counts too
    const row = q(`SELECT COUNT(*) AS n, COALESCE(SUM(COALESCE(minutes, ROUND((until - started_at) / 60000.0))), 0) AS m FROM task_time
                   WHERE user_id = ? AND until IS NOT NULL AND until >= ? AND until < ? AND ((ended_at IS NOT NULL AND ended_at >= until) OR (ended_at IS NULL AND until <= ?))`).get(req.user.id, since, until === Infinity ? 8.64e15 : until, t + 2000); // a browser a moment ahead still counts the one just ended
    res.json({ sessions: row.n, minutes: row.m });
  });
  r.get('/timer', (req, res) => {
    const run = q('SELECT e.*, t.title, t.list_id FROM task_time e JOIN tasks t ON t.id = e.task_id WHERE e.user_id = ? AND e.ended_at IS NULL').get(req.user.id);
    res.json(run ? { task_id: run.task_id, title: run.title, list_id: run.list_id, since: run.started_at, until: run.until || null, now: now() } : null); // now: the server's clock, so a browser whose clock is off still sees the end right
  });
  // { minutes } (5 to 180) makes it a focus session: it stops by itself then.
  r.post('/tasks/:id/timer', (req, res) => {
    const { task, list } = taskFor(req);
    const focus = req.body?.minutes == null ? null : Number(req.body.minutes);
    if (focus !== null && !(Number.isInteger(focus) && focus >= 5 && focus <= 180)) throw bad('A focus session lasts 5 minutes to 3 hours');
    const wasFocus = !!q('SELECT 1 FROM task_time WHERE user_id = ? AND ended_at IS NULL AND until IS NOT NULL').get(req.user.id);
    const stoppedOn = stopTimer(req.user.id); // one timer at a time
    const t = now();
    q('INSERT INTO task_time (id, task_id, user_id, started_at, until) VALUES (?, ?, ?, ?, ?)').run(uid(), task.id, req.user.id, t, focus ? t + focus * FOCUS_MINUTE_MS : null);
    if (focus || wasFocus) onFocus(req.user); // colleagues see "Focusing" come (or go) at once
    changed(list);
    if (stoppedOn && stoppedOn !== task.id) { const other = q('SELECT list_id FROM tasks WHERE id = ?').get(stoppedOn); if (other && other.list_id !== list.id) changed(loadList(other.list_id, req.user)); }
    res.status(201).json(timeOf(task.id));
  });
  // { at } (ms) stops it earlier, when you went away (not before it started); { resume: true } then starts it again now,
  // so the time away is left out but the timer carries on.
  r.post('/timer/stop', (req, res) => {
    const run = q('SELECT * FROM task_time WHERE user_id = ? AND ended_at IS NULL').get(req.user.id);
    if (!run) throw notFound('No timer is running');
    let at = now();
    if (req.body?.at != null) {
      const want = Number(req.body.at);
      if (!Number.isFinite(want) || want > at + 60e3) throw bad('Choose a time up to now');
      at = Math.max(run.started_at, Math.min(want, at));
    }
    const resume = req.body?.resume === true && !run.until; // a focus session ends; it isn't carried on
    const taskId = stopTimer(req.user.id, at);
    if (resume) q('INSERT INTO task_time (id, task_id, user_id, started_at) VALUES (?, ?, ?, ?)').run(uid(), taskId, req.user.id, now());
    if (run.until) onFocus(req.user);
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
  // Change one of your own entries: { duration } (a timer's end moves to match) and/or { note } ('' clears it).
  // A timer still running can't be changed (stop it first).
  r.patch('/time/:entry', (req, res) => {
    const e = q('SELECT * FROM task_time WHERE id = ?').get(req.params.entry);
    if (!e || e.user_id !== req.user.id) throw notFound('Time entry not found');
    if (e.ended_at === null) throw bad('Stop the timer first');
    const { list } = taskFor({ ...req, params: { id: e.task_id } });
    let { minutes, ended_at: end, note } = e;
    if (req.body?.duration != null) {
      minutes = parseDuration(req.body.duration);
      if (!minutes || minutes < 1 || minutes > MAX_MINUTES) throw bad('Enter how long, such as 45m, 1h 30m or 2:15 (a day at most)');
      if (!e.manual) end = e.started_at + minutes * 60e3;
    }
    if (req.body?.note !== undefined) note = req.body.note ? str(req.body.note, { max: 300 }) : null;
    q('UPDATE task_time SET minutes = ?, ended_at = ?, note = ? WHERE id = ?').run(minutes, end, note, e.id);
    changed(list);
    res.json(timeOf(e.task_id));
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
    const report = listReport(list.id, String(req.query.from || ''), String(req.query.to || ''), now(), list.rate ? { rate: list.rate, currency: list.currency } : null);
    if (req.query.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${list.name} time ${report.from} to ${report.to}.csv`)}`);
      res.send(`﻿${reportCsv(report)}`);
      return;
    }
    res.json({ ...report, list: list.name, can_bill: list.owner_id === req.user.id });
  });
  // The report in a new spreadsheet in your Drive ({ from, to }); → { id }.
  r.post('/lists/:id/time-report/sheet', async (req, res) => {
    const list = loadList(req.params.id, req.user);
    const report = listReport(list.id, String(req.body?.from || ''), String(req.body?.to || ''), now(), list.rate ? { rate: list.rate, currency: list.currency } : null);
    const { insertFile } = await import('./routes/files.js');
    const sheet = reportSheet(report, list.name);
    const id = insertFile({ owner: req.user.id, parentId: null, name: sheet.name, kind: 'sheet', content: JSON.stringify(sheet.content) });
    res.status(201).json({ id });
  });
  // The list's hourly rate for the time report (its owner only): { rate, currency }, or { rate: null } for none.
  r.put('/lists/:id/rate', (req, res) => {
    const list = loadList(req.params.id, req.user);
    if (list.owner_id !== req.user.id) throw bad('Only the list’s owner can set its rate');
    const b = billingOf(req.body);
    q('UPDATE task_lists SET rate = ?, currency = ? WHERE id = ?').run(b.rate, b.currency, list.id);
    res.json(b);
  });
}

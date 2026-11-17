// Focus sessions on tasks: a timer that stops by itself, counted to its end, with a note to its owner.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-focus-'));
process.env.DATA_DIR = dir;
let server, base, endFocusNow, q;
before(async () => {
  const { createApp } = await import('../src/app.js');
  ({ endFocusNow } = await import('../src/routes/tasks.js'));
  ({ q } = await import('../src/db.js'));
  server = http.createServer(createApp());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
function client() {
  let cookie = '';
  return async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json', ...(cookie && { cookie }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const c = res.headers.get('set-cookie'); if (c) cookie = c.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}

test('a focus session stops by itself at its end, counts just that long, and tells its owner', async () => {
  const a = client();
  assert.equal((await a('POST', '/api/auth/setup', { org_name: 'Acme', domain: 'acme.com', name: 'Olivia Owner', local: 'olivia', password: 'password123' })).status, 200);
  const list = (await a('POST', '/api/tasks/lists', { name: 'Work' })).body.id;
  const task = (await a('POST', `/api/tasks/lists/${list}/tasks`, { title: 'Write the report' })).body;
  assert.equal((await a('POST', `/api/tasks/tasks/${task.id}/timer`, { minutes: 2 })).status, 400, 'too short');
  assert.equal((await a('POST', `/api/tasks/tasks/${task.id}/timer`, { minutes: 25 })).status, 201);
  const running = (await a('GET', '/api/tasks/timer')).body;
  assert.ok(running.until - running.since === 25 * 60e3, 'ends in 25 minutes');
  assert.ok(Math.abs(running.now - Date.now()) < 5000, 'with the server’s clock, for browsers whose clock is off');
  assert.equal(endFocusNow(Date.now() + 10 * 60e3), 0, 'not yet');
  assert.equal(endFocusNow(Date.now() + 26 * 60e3), 1, 'its time is up');
  assert.equal((await a('GET', '/api/tasks/timer')).body, null, 'stopped');
  const time = (await a('GET', `/api/tasks/tasks/${task.id}/time`)).body;
  assert.equal(time.total, 25, 'counted to its end, not to when it was noticed');
  const bell = (await a('GET', '/api/notifications')).body;
  const items = Array.isArray(bell) ? bell : bell.items || bell.notifications;
  assert.ok(items.some((n) => n.title === 'Focus session done: “Write the report”'), JSON.stringify(items).slice(0, 300));
  // Stopped early by hand: what ran, as any timer.
  await a('POST', `/api/tasks/tasks/${task.id}/timer`, { minutes: 50 });
  assert.equal((await a('POST', '/api/tasks/timer/stop')).status, 200);
  assert.equal(endFocusNow(Date.now() + 3600e3), 0, 'already stopped');
  // A plain timer never stops by itself.
  await a('POST', `/api/tasks/tasks/${task.id}/timer`);
  assert.equal(endFocusNow(Date.now() + 5 * 3600e3), 0);
  assert.equal((await a('GET', '/api/tasks/timer')).body.until, null);
});

test('your time on tasks this week (Home): minutes in all and the tasks with the most', async () => {
  const a = client();
  assert.equal((await a('POST', '/api/auth/login', { username: 'olivia@acme.com', password: 'password123' })).status, 200);
  const list = (await a('POST', '/api/tasks/lists', { name: 'Clients' })).body.id;
  const x = (await a('POST', `/api/tasks/lists/${list}/tasks`, { title: 'Audit' })).body;
  const y = (await a('POST', `/api/tasks/lists/${list}/tasks`, { title: 'Invoice' })).body;
  const before = (await a('GET', '/api/tasks/time/mine')).body.minutes;
  await a('POST', `/api/tasks/tasks/${x.id}/time`, { duration: '1h 30m' });
  await a('POST', `/api/tasks/tasks/${y.id}/time`, { duration: '20m' });
  const t = (await a('GET', '/api/tasks/time/mine')).body;
  assert.equal(t.minutes - before, 110);
  assert.equal(t.tasks[0].title, 'Audit', 'the most first');
  assert.equal(t.tasks.find((k) => k.title === 'Invoice').minutes, 20);
});

test('colleagues see “Focusing” while a focus session runs, unless the person set a status of their own', async () => {
  const a = client();
  assert.equal((await a('POST', '/api/auth/login', { username: 'olivia@acme.com', password: 'password123' })).status, 200);
  const me = (await a('GET', '/api/auth/me')).body.user.id;
  const list = (await a('POST', '/api/tasks/lists', { name: 'Deep work' })).body.id;
  const task = (await a('POST', `/api/tasks/lists/${list}/tasks`, { title: 'Write' })).body;
  const statusOf = async () => (await a('GET', '/api/users/directory')).body.find((u) => u.id === me).status;
  await a('POST', '/api/tasks/timer/stop').catch(() => {});
  assert.equal((await statusOf())?.text ?? null, null);
  await a('POST', `/api/tasks/tasks/${task.id}/timer`, { minutes: 30 });
  const s = await statusOf();
  assert.equal(s.text, 'Focusing');
  assert.ok(s.auto && s.until > Date.now() + 25 * 60e3);
  await a('PUT', '/api/users/me/status', { emoji: '🏠', text: 'Working from home' });
  assert.equal((await statusOf()).text, 'Working from home', 'your own status comes first');
  await a('DELETE', '/api/users/me/status');
  await a('POST', '/api/tasks/timer/stop');
  assert.equal((await statusOf())?.text ?? null, null, 'gone when it stops');
  // A plain timer isn't focus time.
  await a('POST', `/api/tasks/tasks/${task.id}/timer`);
  assert.equal((await statusOf())?.text ?? null, null);
  await a('POST', '/api/tasks/timer/stop');
});

test('notifications held during a focus session, for those who ask (Settings → Quiet hours)', async () => {
  const a = client();
  assert.equal((await a('POST', '/api/auth/login', { username: 'olivia@acme.com', password: 'password123' })).status, 200);
  const list = (await a('POST', '/api/tasks/lists', { name: 'Quiet' })).body.id;
  const task = (await a('POST', `/api/tasks/lists/${list}/tasks`, { title: 'Think' })).body;
  await a('POST', `/api/tasks/tasks/${task.id}/timer`, { minutes: 20 });
  assert.equal((await a('GET', '/api/users/me/pause')).body.paused_until, null, 'not unless asked');
  assert.equal((await a('GET', '/api/users/me/quiet-hours')).body.focus, false);
  assert.equal((await a('PUT', '/api/users/me/quiet-hours', { focus: true })).status, 200);
  assert.equal((await a('GET', '/api/users/me/quiet-hours')).body.focus, true);
  const p = (await a('GET', '/api/users/me/pause')).body;
  assert.ok(p.paused_until > Date.now() + 15 * 60e3 && p.focus, JSON.stringify(p));
  await a('POST', '/api/tasks/timer/stop');
  assert.equal((await a('GET', '/api/users/me/pause')).body.paused_until, null, 'over when it stops');
  await a('PUT', '/api/users/me/quiet-hours', { focus: false });
});

test('time on tasks for a range (Calendar → Time insights): only entries started in it', async () => {
  const a = client();
  assert.equal((await a('POST', '/api/auth/login', { username: 'olivia@acme.com', password: 'password123' })).status, 200);
  const list = (await a('POST', '/api/tasks/lists', { name: 'Weeks' })).body.id;
  const task = (await a('POST', `/api/tasks/lists/${list}/tasks`, { title: 'Bookkeeping' })).body;
  const d = (n) => { const x = new Date(); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  await a('POST', `/api/tasks/tasks/${task.id}/time`, { duration: '2h', day: d(-20) });
  await a('POST', `/api/tasks/tasks/${task.id}/time`, { duration: '45m', day: d(-1) });
  const from = Date.parse(`${d(-3)}T00:00:00Z`), to = Date.parse(`${d(1)}T00:00:00Z`);
  const r = (await a('GET', `/api/tasks/time/mine?from=${from}&to=${to}`)).body;
  assert.equal(r.tasks.find((x) => x.title === 'Bookkeeping').minutes, 45, 'the 2 h three weeks ago left out');
  const logged = r.spans.find((x) => x.minutes === 45);
  assert.deepEqual({ ...logged, id: undefined }, { id: undefined, task_id: task.id, start: Date.parse(`${d(-1)}T12:00:00Z`), minutes: 45, logged: true }, 'each entry, for the day bars');
  assert.ok(logged.id, 'with its id, to remove it from the timesheet');
  assert.equal((await a('DELETE', `/api/tasks/time/${logged.id}`)).status, 200);
  assert.ok(!(await a('GET', `/api/tasks/time/mine?from=${from}&to=${to}`)).body.spans.some((x) => x.id === logged.id));
  await a('POST', `/api/tasks/tasks/${task.id}/time`, { duration: '45m', day: d(-1), note: 'Receipts' });
  assert.ok(r.spans.every((x) => x.start >= from && x.start < to && (x.logged || x.end > x.start)), JSON.stringify(r.spans));
  assert.equal((await a('GET', '/api/tasks/time/mine?days=7')).body.spans, undefined, 'only for a range');
  assert.equal((await a('GET', `/api/tasks/time/mine?from=${from}&to=${to}`)).body.spans.find((x) => x.minutes === 45).note, 'Receipts');
  // The timesheet asks for every task (not only the top five).
  for (let i = 0; i < 6; i++) {
    const x = (await a('POST', `/api/tasks/lists/${list}/tasks`, { title: `Chore ${i}` })).body;
    await a('POST', `/api/tasks/tasks/${x.id}/time`, { duration: `${10 + i}m`, day: d(0) });
  }
  assert.equal((await a('GET', `/api/tasks/time/mine?from=${from}&to=${to}`)).body.tasks.length, 5);
  const all = (await a('GET', `/api/tasks/time/mine?from=${from}&to=${to}&all=1`)).body;
  assert.ok(all.tasks.length >= 7 && all.tasks.some((x) => x.title === 'Chore 0'), all.tasks.map((x) => x.title).join());
  assert.ok(all.spans.every((x) => all.tasks.some((t) => t.id === x.task_id)), 'each span belongs to a listed task');
  assert.equal((await a('GET', `/api/tasks/time/mine?from=${to}&to=${from}`)).status, 400);
  assert.equal((await a('GET', `/api/tasks/time/mine?from=0&to=${to}`)).status, 400, 'too long');
});

test('time away left out: stop a timer when you went away, and carry on or not', async () => {
  const a = client();
  assert.equal((await a('POST', '/api/auth/login', { username: 'olivia@acme.com', password: 'password123' })).status, 200);
  const list = (await a('POST', '/api/tasks/lists', { name: 'Away' })).body.id;
  const task = (await a('POST', `/api/tasks/lists/${list}/tasks`, { title: 'Quarterly plan' })).body;
  await a('POST', `/api/tasks/tasks/${task.id}/timer`);
  // As if it started 50 minutes ago and you went away 30 minutes ago.
  const t = Date.now();
  q('UPDATE task_time SET started_at = ? WHERE task_id = ? AND ended_at IS NULL').run(t - 50 * 60e3, task.id);
  assert.equal((await a('POST', '/api/tasks/timer/stop', { at: t + 10 * 60e3 })).status, 400, 'not in the future');
  const r = await a('POST', '/api/tasks/timer/stop', { at: t - 30 * 60e3, resume: true });
  assert.equal(r.status, 200);
  const rows = q('SELECT * FROM task_time WHERE task_id = ? ORDER BY started_at').all(task.id);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].minutes, 20, 'counted up to when you went away');
  assert.equal(rows[1].ended_at, null, 'and carries on from now');
  assert.ok(rows[1].started_at >= t - 1000);
  const run = (await a('GET', '/api/tasks/timer')).body;
  assert.equal(run.task_id, task.id);
  // Stopping "before it started" counts nothing; without resume it stays stopped.
  assert.equal((await a('POST', '/api/tasks/timer/stop', { at: 0 })).status, 200);
  assert.equal((await a('GET', '/api/tasks/timer')).body, null);
  assert.equal(q('SELECT * FROM task_time WHERE id = ?').get(rows[1].id), undefined, 'nothing counted: no 0-minute entry kept');
  assert.equal((await a('POST', '/api/tasks/timer/stop', { at: Date.now() })).status, 404);
  // A focus session isn't carried on.
  await a('POST', `/api/tasks/tasks/${task.id}/timer`, { minutes: 25 });
  await a('POST', '/api/tasks/timer/stop', { at: Date.now(), resume: true });
  assert.equal((await a('GET', '/api/tasks/timer')).body, null);
});

test('a time entry changed: its length (a timer’s end moves too) and its note; only your own, not while running', async () => {
  const a = client();
  assert.equal((await a('POST', '/api/auth/login', { username: 'olivia@acme.com', password: 'password123' })).status, 200);
  const list = (await a('POST', '/api/tasks/lists', { name: 'Edits' })).body.id;
  const task = (await a('POST', `/api/tasks/lists/${list}/tasks`, { title: 'Write up' })).body;
  const added = (await a('POST', `/api/tasks/tasks/${task.id}/time`, { duration: '45m', note: 'Draft' })).body;
  const id = added.entries[0].id;
  const r = await a('PATCH', `/api/tasks/time/${id}`, { duration: '1h 10m', note: 'Draft and edit' });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.total, r.body.entries[0].note], [70, 'Draft and edit']);
  assert.equal((await a('PATCH', `/api/tasks/time/${id}`, { note: '' })).body.entries[0].note ?? null, null);
  assert.equal((await a('PATCH', `/api/tasks/time/${id}`, { duration: 'ages' })).status, 400);
  assert.equal((await a('PATCH', `/api/tasks/time/${id}`, { duration: '25h' })).status, 400);
  // A timer entry: its end moves with its length.
  await a('POST', `/api/tasks/tasks/${task.id}/timer`);
  assert.equal((await a('PATCH', `/api/tasks/time/${(await a('GET', `/api/tasks/tasks/${task.id}/time`)).body.entries.find((x) => x.running).id}`, { duration: '5m' })).status, 400, 'not while running');
  q('UPDATE task_time SET started_at = started_at - 10 * 60000 WHERE task_id = ? AND ended_at IS NULL').run(task.id); // ran 10 minutes
  await a('POST', '/api/tasks/timer/stop');
  const timed = (await a('GET', `/api/tasks/tasks/${task.id}/time`)).body.entries.find((x) => x.id !== id);
  await a('PATCH', `/api/tasks/time/${timed.id}`, { duration: '30m' });
  const row = q('SELECT * FROM task_time WHERE id = ?').get(timed.id);
  assert.deepEqual([row.minutes, row.ended_at - row.started_at], [30, 30 * 60e3]);
  assert.equal((await a('PATCH', '/api/tasks/time/nope', { duration: '5m' })).status, 404);
});

test('a timer stopped within half a minute leaves no entry', async () => {
  const a = client();
  assert.equal((await a('POST', '/api/auth/login', { username: 'olivia@acme.com', password: 'password123' })).status, 200);
  const list = (await a('POST', '/api/tasks/lists', { name: 'Oops' })).body.id;
  const task = (await a('POST', `/api/tasks/lists/${list}/tasks`, { title: 'Started by mistake' })).body;
  await a('POST', `/api/tasks/tasks/${task.id}/timer`);
  const r = (await a('POST', '/api/tasks/timer/stop')).body;
  assert.deepEqual([r.total, r.entries.length], [0, 0]);
  // Starting another timer stops this one the same way.
  await a('POST', `/api/tasks/tasks/${task.id}/timer`);
  const other = (await a('POST', `/api/tasks/lists/${list}/tasks`, { title: 'The real one' })).body;
  await a('POST', `/api/tasks/tasks/${other.id}/timer`);
  assert.equal((await a('GET', `/api/tasks/tasks/${task.id}/time`)).body.entries.length, 0);
  await a('POST', '/api/tasks/timer/stop');
});

test('focus sessions finished today: only ones that ran to their end', async () => {
  const a = client();
  assert.equal((await a('POST', '/api/auth/login', { username: 'olivia@acme.com', password: 'password123' })).status, 200);
  const list = (await a('POST', '/api/tasks/lists', { name: 'Pomodoro' })).body.id;
  const task = (await a('POST', `/api/tasks/lists/${list}/tasks`, { title: 'Focus me' })).body;
  const since = Date.now() - 1000;
  const before = (await a('GET', `/api/tasks/focus/done?since=${since}`)).body.sessions;
  await a('POST', `/api/tasks/tasks/${task.id}/timer`, { minutes: 25 });
  endFocusNow(Date.now() + 26 * 60e3); // ran to its end
  await a('POST', `/api/tasks/tasks/${task.id}/timer`, { minutes: 25 });
  q('UPDATE task_time SET started_at = started_at - 10 * 60000 WHERE ended_at IS NULL').run();
  await a('POST', '/api/tasks/timer/stop'); // stopped early: not counted
  const r = (await a('GET', `/api/tasks/focus/done?since=${since}`)).body;
  assert.equal(r.sessions, before + 1);
  assert.ok(r.minutes >= 25);
  assert.equal((await a('GET', '/api/tasks/focus/done')).status, 400);
  assert.equal((await a('GET', `/api/tasks/focus/done?since=${since}&until=${since + 60e3}`)).body.sessions, 0, 'ended after until: not in that span');
  assert.equal((await a('GET', `/api/tasks/focus/done?since=${since}&until=${Date.now() + 864e5}`)).body.sessions, r.sessions);
});

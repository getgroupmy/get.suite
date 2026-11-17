// Focus sessions on tasks: a timer that stops by itself, counted to its end, with a note to its owner.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-focus-'));
process.env.DATA_DIR = dir;
let server, base, endFocusNow;
before(async () => {
  const { createApp } = await import('../src/app.js');
  ({ endFocusNow } = await import('../src/routes/tasks.js'));
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

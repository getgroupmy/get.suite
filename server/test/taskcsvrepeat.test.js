// A list's download (CSV) says how each task repeats, and Import from CSV brings the repeats back.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-taskcsv-'));
process.env.DATA_DIR = dir;
let server, base, port;
before(async () => {
  const { createApp } = await import('../src/app.js');
  const { attachHub } = await import('../src/hub.js');
  server = http.createServer(createApp());
  attachHub(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  base = `http://127.0.0.1:${port}`;
});
after(() => { server.closeAllConnections?.(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json', ...(cookie && { cookie }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  call.cookie = () => cookie;
  return call;
}
const olivia = client();
test('repeats go out in the CSV and come back in', async () => {
  assert.equal((await olivia('POST', '/api/auth/setup', { org_name: 'Acme', domain: 'acme.com', name: 'Olivia Owner', local: 'olivia', password: 'password123' })).status, 200);
  const list = (await olivia('POST', '/api/tasks/lists', { name: 'Routines' })).body;
  const make = async (title, repeat) => { const t = (await olivia('POST', `/api/tasks/lists/${list.id}/tasks`, { title, due: '2026-11-02' })).body; if (repeat) await olivia('PATCH', `/api/tasks/tasks/${t.id}`, { repeat }); };
  await make('Water plants', 'weekly');
  await make('Team report', 'monthweek:1,3:1');
  await make('Gym', 'every:2:week:1,4');
  await make('One-off', null);
  const res = await fetch(`${base}/api/tasks/lists/${list.id}/export.csv`, { headers: { 'x-requested-with': 'nas-workspace', cookie: olivia.cookie() } });
  assert.equal(res.status, 200);
  const csv = await res.text();
  assert.match(csv.split(/\r?\n/)[0], /,Repeat,/);
  assert.match(csv, /monthweek:1,3:1/);
  const copy = (await olivia('POST', '/api/tasks/lists', { name: 'Routines again' })).body;
  const imp = await fetch(`${base}/api/tasks/lists/${copy.id}/import`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', cookie: olivia.cookie(), 'content-type': 'text/csv' }, body: csv });
  assert.ok(imp.status < 300, await imp.text());
  const tasks = (await olivia('GET', `/api/tasks/lists/${copy.id}/tasks`)).body;
  const by = Object.fromEntries((tasks.tasks || tasks).map((t) => [t.title, t.repeat || null]));
  assert.deepEqual(by, { 'Water plants': 'weekly', 'Team report': 'monthweek:1,3:1', Gym: 'every:2:week:1,4', 'One-off': null });
});

test('Repeat in words, from another app, is understood', async () => {
  const list = (await olivia('POST', '/api/tasks/lists', { name: 'From a spreadsheet' })).body;
  const csv = 'Task,Due,Repeat\r\nStand-up,2026-11-02,Every weekday\r\nRent,2026-11-01,Monthly\r\nNo date,,Weekly\r\nOdd,2026-11-02,Fortnightly-ish\r\n';
  const imp = await fetch(`${base}/api/tasks/lists/${list.id}/import`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', cookie: olivia.cookie(), 'content-type': 'text/csv' }, body: csv });
  assert.ok(imp.status < 300, await imp.text());
  const tasks = (await olivia('GET', `/api/tasks/lists/${list.id}/tasks`)).body;
  const by = Object.fromEntries((tasks.tasks || tasks).map((t) => [t.title, t.repeat || null]));
  assert.deepEqual(by, { 'Stand-up': 'weekdays', Rent: 'monthly', 'No date': null, Odd: null }, 'a repeat needs a due date; unknown words are left out');
});

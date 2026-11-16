// Made offline: a task or note sent with the id the browser gave it is made once however often it is sent.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-offlineids-'));
process.env.DATA_DIR = dir;
let server, base;
before(async () => {
  const { createApp } = await import('../src/app.js');
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


test('a task and a note sent with their own id are made once; someone else cannot take the id; odd ids are ignored', async () => {
  const olivia = client(), mia = client();
  assert.equal((await olivia('POST', '/api/auth/setup', { org_name: 'Acme', domain: 'acme.com', name: 'Olivia Owner', local: 'olivia', password: 'password123' })).status, 200);
  assert.equal((await olivia('POST', '/api/users', { local: 'mia', domain: 'acme.com', name: 'Mia Member', password: 'password123' })).status, 201);
  assert.equal((await mia('POST', '/api/auth/login', { username: 'mia@acme.com', password: 'password123' })).status, 200);
  const list = (await olivia('POST', '/api/tasks/lists', { name: 'Trip' })).body.id;
  const id = 'offline-0123456789abcdef';
  const a = await olivia('POST', `/api/tasks/lists/${list}/tasks`, { id, title: 'Buy a map' });
  assert.equal(a.status, 201);
  assert.equal(a.body.id, id);
  const again = await olivia('POST', `/api/tasks/lists/${list}/tasks`, { id, title: 'Buy a map' });
  assert.equal(again.status, 200, 'sent again: the same task');
  assert.equal(again.body.id, id);
  assert.equal((await olivia('GET', `/api/tasks/lists/${list}/tasks`)).body.filter((t) => t.title === 'Buy a map').length, 1);
  const miaList = (await mia('POST', '/api/tasks/lists', { name: 'Mine' })).body.id;
  assert.equal((await mia('POST', `/api/tasks/lists/${miaList}/tasks`, { id, title: 'Not yours' })).status, 400, 'someone else’s id');
  const odd = await olivia('POST', `/api/tasks/lists/${list}/tasks`, { id: 'x y', title: 'Odd id' });
  assert.equal(odd.status, 201);
  assert.notEqual(odd.body.id, 'x y');

  const nid = 'offline-note-0123456789';
  const n1 = await olivia('POST', '/api/notes', { id: nid, title: 'Ferry', body: 'Pier 3' });
  assert.equal(n1.status, 201);
  assert.equal(n1.body.id, nid);
  assert.equal((await olivia('POST', '/api/notes', { id: nid, title: 'Ferry', body: 'Pier 3' })).status, 200);
  assert.equal((await olivia('GET', '/api/notes')).body.filter((n) => n.title === 'Ferry').length, 1);
  assert.equal((await mia('POST', '/api/notes', { id: nid, title: 'Mine now' })).status, 400);
});

test('an event sent with its own id is made once; someone else cannot take the id', async () => {
  const olivia = client(), mia = client();
  assert.equal((await olivia('POST', '/api/auth/login', { username: 'olivia@acme.com', password: 'password123' })).status, 200);
  assert.equal((await mia('POST', '/api/auth/login', { username: 'mia@acme.com', password: 'password123' })).status, 200);
  const id = 'offEvent0123456789abcdef';
  const start = Date.UTC(2030, 0, 7, 9), end = start + 3600e3;
  const a = await olivia('POST', '/api/events', { id, title: 'Dentist', start, end });
  assert.equal(a.status, 201);
  assert.equal(a.body.id, id);
  const again = await olivia('POST', '/api/events', { id, title: 'Dentist', start, end });
  assert.equal(again.status, 200);
  assert.equal(again.body.title, 'Dentist');
  const listed = (await olivia('GET', `/api/events?from=${start - 1}&to=${end + 1}`)).body;
  assert.equal(listed.filter((e) => e.title === 'Dentist').length, 1);
  assert.equal((await mia('POST', '/api/events', { id, title: 'Mine', start, end })).status, 400);
  const odd = await olivia('POST', '/api/events', { id: 'x', title: 'Odd', start, end });
  assert.notEqual(odd.body.id, 'x');
});

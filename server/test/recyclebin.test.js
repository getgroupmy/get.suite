// Recently deleted: a task list or a form deleted by mistake goes back as it was (tasks, sections, comments,
// members, assignments; questions, co-editors, responses) for 30 days, by its owner only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-bin-'));
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
  return async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json', ...(cookie && { cookie }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}
const olivia = client();
let carolId, carol;

test('setup', async () => {
  assert.equal((await olivia('POST', '/api/auth/setup', { org_name: 'Acme', domain: 'acme.com', name: 'Olivia Owner', local: 'olivia', password: 'password123' })).status, 200);
  carolId = (await olivia('POST', '/api/users', { local: 'carol', domain: 'acme.com', name: 'Carol C', password: 'password123' })).body.id;
  carol = client();
  assert.equal((await carol('POST', '/api/auth/login', { username: 'carol@acme.com', password: 'password123' })).status, 200);
});

test('a shared task list deleted and put back: everything as it was', async () => {
  const list = (await olivia('POST', '/api/tasks/lists', { name: 'Office move' })).body;
  assert.equal((await olivia('PUT', `/api/tasks/lists/${list.id}/members`, { user_ids: [carolId] })).status, 200);
  const sec = (await olivia('POST', `/api/tasks/lists/${list.id}/sections`, { name: 'Week 1' })).body;
  const t1 = (await olivia('POST', `/api/tasks/lists/${list.id}/tasks`, { title: 'Book the van', section_id: sec.id })).body;
  await olivia('PATCH', `/api/tasks/tasks/${t1.id}`, { assignee_id: carolId, section_id: sec.id });
  await carol('POST', `/api/tasks/lists/${list.id}/tasks`, { title: 'Pack the kitchen' });
  assert.equal((await carol('POST', `/api/tasks/tasks/${t1.id}/comments`, { body: 'I can drive it' })).status < 300, true);
  const snapshot = async () => {
    const tasks = (await olivia('GET', `/api/tasks/lists/${list.id}/tasks`)).body;
    const all = (tasks.tasks || tasks).map((t) => [t.title, t.assignee_id, t.section_id]).sort();
    const comments = (await olivia('GET', `/api/tasks/tasks/${t1.id}/comments`)).body;
    return JSON.stringify({ all, comments: (comments.comments || comments).map((c) => c.body), lists: ((await carol('GET', '/api/tasks/lists')).body.lists || (await carol('GET', '/api/tasks/lists')).body).map((l) => l.name) });
  };
  const before = await snapshot();
  const del = await olivia('DELETE', `/api/tasks/lists/${list.id}`);
  assert.ok(del.body.bin_id, JSON.stringify(del.body));
  assert.ok(!JSON.stringify((await carol('GET', '/api/tasks/lists')).body).includes('Office move'), 'gone for Carol too');
  const bin = (await olivia('GET', '/api/tasks/bin')).body;
  assert.deepEqual(bin.map((x) => x.name), ['Office move']);
  assert.equal((await carol('GET', '/api/tasks/bin')).body.length, 0, 'not in Carol’s');
  assert.equal((await carol('POST', `/api/tasks/bin/${del.body.bin_id}/restore`)).status, 404, 'only its owner puts it back');
  const back = await olivia('POST', `/api/tasks/bin/${del.body.bin_id}/restore`);
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.equal(await snapshot(), before);
  assert.equal((await olivia('GET', '/api/tasks/bin')).body.length, 0);
  assert.equal((await olivia('POST', `/api/tasks/bin/${del.body.bin_id}/restore`)).status, 404, 'once');
});

test('a form deleted and put back: questions, co-editor and responses', async () => {
  const f = (await olivia('POST', '/api/forms', { title: 'Lunch', questions: [{ id: 'm', type: 'short', title: 'Meal' }] })).body;
  await olivia('POST', `/api/forms/${f.id}/editors`, { email: 'carol@acme.com' });
  const token = (await olivia('GET', `/api/forms/${f.id}`)).body.token;
  for (const meal of ['Pasta', 'Soup']) assert.ok((await carol('POST', `/api/public/forms/${token}`, { answers: { m: meal } })).status < 300);
  const responses = async () => { const r = (await olivia('GET', `/api/forms/${f.id}/responses`)).body; return JSON.stringify((r.responses || r).map((x) => x.answers)); };
  const before = await responses();
  assert.match(before, /Pasta/);
  const del = await olivia('DELETE', `/api/forms/${f.id}`);
  assert.equal((await olivia('GET', `/api/forms/${f.id}`)).status, 404);
  const bin = (await olivia('GET', '/api/forms/bin/list')).body;
  assert.deepEqual(bin.map((x) => x.name), ['Lunch']);
  assert.equal((await olivia('POST', `/api/forms/bin/${del.body.bin_id}/restore`)).status, 200);
  assert.equal(await responses(), before);
  assert.equal((await carol('GET', `/api/forms/${f.id}`)).status, 200, 'Carol edits it again');
});

test('after 30 days it’s gone for good', async () => {
  const list = (await olivia('POST', '/api/tasks/lists', { name: 'Old list' })).body;
  const del = await olivia('DELETE', `/api/tasks/lists/${list.id}`);
  const { purgeBin } = await import('../src/recyclebin.js');
  assert.equal(purgeBin(Date.now() + 31 * 864e5), 1);
  assert.equal((await olivia('POST', `/api/tasks/bin/${del.body.bin_id}/restore`)).status, 404);
});

test('a booking page deleted and put back: its link works again', async () => {
  const p = (await olivia('POST', '/api/bookings', { title: 'Intro call', duration: 30 })).body;
  const token = p.token || (p.url || '').split('/').pop();
  assert.ok(token, JSON.stringify(p));
  const opens = async () => (await fetch(`${base}/api/public/book/${token}`)).status;
  assert.equal(await opens(), 200);
  const del = await olivia('DELETE', `/api/bookings/${p.id}`);
  assert.ok(del.body.bin_id);
  assert.notEqual(await opens(), 200, 'the link stops working');
  assert.equal((await carol('POST', `/api/bookings/bin/${del.body.bin_id}/restore`)).status, 404);
  assert.equal((await olivia('POST', `/api/bookings/bin/${del.body.bin_id}/restore`)).status, 200);
  assert.equal(await opens(), 200, 'and works again');
});

test('a contact group deleted and put back, with its members', async () => {
  const g = (await olivia('POST', '/api/contacts/groups', { name: 'Suppliers', members: [{ name: 'Ann', email: 'ann@x.example' }, { name: 'Bo', email: 'bo@y.example' }] })).body;
  const groups = async () => JSON.stringify((await olivia('GET', '/api/contacts/groups')).body.map((x) => [x.name, x.members]));
  const before = await groups();
  assert.match(before, /ann@x\.example/);
  const del = await olivia('DELETE', `/api/contacts/groups/${g.id}`);
  assert.doesNotMatch(await groups(), /Suppliers/);
  assert.equal((await olivia('POST', `/api/contacts/groups/bin/${del.body.bin_id}/restore`)).status, 200);
  assert.equal(await groups(), before);
});

test('a meeting room removed by mistake: Undo puts it back with its bookings', async () => {
  const room = (await olivia('POST', '/api/rooms', { name: 'Board room', capacity: 10 })).body;
  assert.ok(room.id, JSON.stringify(room));
  const t = Date.now() + 864e5;
  const ev = (await olivia('POST', '/api/events', { title: 'Quarterly review', start: t, end: t + 3600e3, rooms: [room.id] })).body;
  const roomsOf = async () => { const e = (await olivia('GET', `/api/events?from=${t - 1}&to=${t + 7200e3}`)).body.find((x) => x.id === ev.id); return (e.rooms || []).map((x) => x.name || x.id); };
  assert.equal((await roomsOf()).length, 1);
  assert.equal((await olivia('GET', `/api/rooms/${room.id}/upcoming`)).body.meetings, 1);
  const del = await olivia('DELETE', `/api/rooms/${room.id}`);
  assert.equal(del.body.meetings, 1);
  assert.equal((await roomsOf()).length, 0, 'the meeting lost it');
  assert.equal((await olivia('POST', `/api/rooms/bin/${del.body.bin_id}/restore`)).status, 200);
  assert.equal((await roomsOf()).length, 1, 'and has it again');
});

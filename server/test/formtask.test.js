// Forms → Add each response as a task: on a list the person can add to, titled by a chosen question, with the answers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-formtask-'));
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


test('each response becomes a task on the chosen list, titled by the chosen question', async () => {
  const olivia = client(), mia = client();
  assert.equal((await olivia('POST', '/api/auth/setup', { org_name: 'Acme', domain: 'acme.com', name: 'Olivia Owner', local: 'olivia', password: 'password123' })).status, 200);
  assert.equal((await olivia('POST', '/api/users', { local: 'mia', domain: 'acme.com', name: 'Mia Member', password: 'password123' })).status, 201);
  assert.equal((await mia('POST', '/api/auth/login', { username: 'mia@acme.com', password: 'password123' })).status, 200);
  const it = (await olivia('POST', '/api/tasks/lists', { name: 'IT requests' })).body.id;
  const miasOwn = (await mia('POST', '/api/tasks/lists', { name: 'Mia private' })).body.id;
  const made = (await olivia('POST', '/api/forms', { title: 'IT help' })).body;
  const f = (await olivia('PUT', `/api/forms/${made.id}`, { questions: [{ id: 'what', type: 'short', title: 'What do you need?', required: true }, { id: 'urgency', type: 'choice', title: 'How urgent?', options: ['Today', 'This week'] }] })).body;
  assert.equal((await olivia('PUT', `/api/forms/${f.id}`, { task_list: miasOwn })).status, 404, 'not someone else’s list');
  const set = (await olivia('PUT', `/api/forms/${f.id}`, { task_list: it, task_title: 'what' })).body;
  assert.deepEqual([set.task_list, set.task_title], [it, 'what']);
  assert.equal((await mia('POST', `/api/public/forms/${f.token}`, { answers: { what: 'A new laptop charger', urgency: 'Today' } })).status, 201);
  const tasks = (await olivia('GET', `/api/tasks/lists/${it}/tasks`)).body;
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].title, 'A new laptop charger');
  assert.match(tasks[0].notes, /^From Mia Member\nWhat do you need\?: A new laptop charger\nHow urgent\?: Today$/);
  assert.match(tasks[0].link_url, /\/forms\/[\w-]+\?tab=responses$/);
  // Without a title question: "Response to … from …".
  await olivia('PUT', `/api/forms/${f.id}`, { task_title: null });
  await mia('POST', `/api/public/forms/${f.token}`, { answers: { what: 'Printer' } });
  const again = (await olivia('GET', `/api/tasks/lists/${it}/tasks`)).body;
  assert.equal(again[0].title, 'Response to “IT help” from Mia Member', 'the newest on top');
  // Off: no more tasks.
  await olivia('PUT', `/api/forms/${f.id}`, { task_list: null });
  await mia('POST', `/api/public/forms/${f.token}`, { answers: { what: 'Mouse' } });
  assert.equal((await olivia('GET', `/api/tasks/lists/${it}/tasks`)).body.length, 2);
});

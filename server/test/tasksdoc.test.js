// Tasks → Copy to a document: the list as a checklist (sections as headings, due dates, who, steps), done ones on request.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-tasksdoc-'));
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

test('a list as a document: open tasks as a checklist by section with due date, who and steps; done ones when asked', async () => {
  const olivia = client(), mia = client();
  assert.equal((await olivia('POST', '/api/auth/setup', { org_name: 'Acme', domain: 'acme.com', name: 'Olivia Owner', local: 'olivia', password: 'password123' })).status, 200);
  assert.equal((await olivia('POST', '/api/users', { local: 'mia', domain: 'acme.com', name: 'Mia Member', password: 'password123' })).status, 201);
  assert.equal((await mia('POST', '/api/auth/login', { username: 'mia@acme.com', password: 'password123' })).status, 200);
  const list = (await olivia('POST', '/api/tasks/lists', { name: 'Launch' })).body.id;
  const week = (await olivia('POST', `/api/tasks/lists/${list}/sections`, { name: 'This week' })).body.id;
  const post = (await olivia('POST', `/api/tasks/lists/${list}/tasks`, { title: 'Write the post', due: '2026-12-03', important: true, section_id: week })).body;
  const drafted = (await olivia('POST', `/api/tasks/tasks/${post.id}/steps`, { title: 'Draft' })).body.steps[0];
  await olivia('PATCH', `/api/tasks/tasks/${post.id}/steps/${drafted.id}`, { done: true });
  await olivia('POST', `/api/tasks/tasks/${post.id}/steps`, { title: 'Review' });
  await olivia('POST', `/api/tasks/lists/${list}/tasks`, { title: 'Pick a date' });
  const old = (await olivia('POST', `/api/tasks/lists/${list}/tasks`, { title: 'Book the room' })).body;
  await olivia('PATCH', `/api/tasks/tasks/${old.id}`, { done: true });

  const r = await olivia('POST', `/api/tasks/lists/${list}/doc`, { tz: 'UTC' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.name, 'Launch (tasks)');
  const doc = (await olivia('GET', `/api/files/${r.body.id}/content`)).body.content;
  const text = (n) => (n.text || '') + (n.content || []).map(text).join('');
  const shown = doc.content.map((n) => (n.type === 'taskList' ? `list:${n.content.map((i) => `${i.attrs.checked ? '[x]' : '[ ]'} ${text(i.content[0])}${i.content[1] ? ` {${i.content[1].content.map((x) => `${x.attrs.checked ? 'x' : '-'}${text(x)}`).join(',')}}` : ''}`).join(' | ')}` : `${n.type}:${text(n)}`));
  assert.equal(shown[0], 'heading:Launch');
  assert.match(shown[1], /^paragraph:\d+ \w+ \d{4} · 2 open, 1 done$/);
  assert.deepEqual(shown.slice(2), ['list:[ ] Pick a date', 'heading:This week', 'list:[ ] Write the post — due 3 Dec 2026 · ★ {xDraft,-Review}']);
  // With the done ones; someone who can't see the list can't.
  const all = (await olivia('GET', `/api/files/${(await olivia('POST', `/api/tasks/lists/${list}/doc`, { done: true })).body.id}/content`)).body.content;
  assert.equal(text(all.content.at(-2)), 'Done');
  assert.equal(all.content.at(-1).content[0].attrs.checked, true);
  assert.equal(text(all.content.at(-1)), 'Book the room');
  assert.equal((await mia('POST', `/api/tasks/lists/${list}/doc`, {})).status, 404);
});

// Make a copy: a form's copy has its settings (what's asked of people, what happens with answers); a task
// list's copy has its look, its rate, and each task's estimate and billable or not.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-copies-'));
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
test('a form’s copy keeps its settings', async () => {
  assert.equal((await olivia('POST', '/api/auth/setup', { org_name: 'Acme', domain: 'acme.com', name: 'Olivia Owner', local: 'olivia', password: 'password123' })).status, 200);
  const list = (await olivia('POST', '/api/tasks/lists', { name: 'Requests' })).body;
  const f = (await olivia('POST', '/api/forms', { title: 'IT request', questions: [{ type: 'short', title: 'What do you need?' }] })).body;
  const set = { collect_email: true, send_copy: true, allow_edit: true, show_results: true, progress_bar: true, email_domains: 'acme.com', max_responses: 50, task_list: list.id, task_title: 'IT: {1}', quiz: false, one_per_person: true, confirmation: 'Thanks, we’ll be in touch' };
  const r = await olivia('PUT', `/api/forms/${f.id}`, set);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const copy = (await olivia('POST', `/api/forms/${f.id}/copy`)).body;
  const keys = ['collect_email', 'send_copy', 'allow_edit', 'show_results', 'progress_bar', 'email_domains', 'max_responses', 'task_list', 'task_title', 'one_per_person', 'confirmation', 'questions', 'description', 'audience'];
  const a = (await olivia('GET', `/api/forms/${f.id}`)).body, b = (await olivia('GET', `/api/forms/${copy.id}`)).body;
  const pick = (x, k) => JSON.stringify(k === 'questions' ? x.questions.map((qq) => [qq.type, qq.title]) : x[k] ?? null);
  assert.deepEqual(keys.filter((k) => pick(a, k) !== pick(b, k)).map((k) => `${k}: ${pick(a, k)} → ${pick(b, k)}`), []);
  assert.equal(b.title, 'Copy of IT request');
  assert.equal(b.responses, 0);
});

test('a task list’s copy keeps its colour, emoji, rate and each task’s estimate', async () => {
  const { q } = await import('../src/db.js');
  const { LIST_COLORS } = await import('../src/routes/tasks.js').catch(() => ({}));
  const list = (await olivia('POST', '/api/tasks/lists', { name: 'Month-end' })).body;
  const color = (LIST_COLORS || [])[2] || null;
  const r = await olivia('PATCH', `/api/tasks/lists/${list.id}`, { ...(color && { color }), emoji: '📦' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  q('UPDATE task_lists SET rate = 120, currency = ? WHERE id = ?').run('EUR', list.id);
  const t = (await olivia('POST', `/api/tasks/lists/${list.id}/tasks`, { title: 'Close the books' })).body;
  q('UPDATE tasks SET estimate = 90, nonbillable = 1 WHERE id = ?').run(t.id);
  const copy = (await olivia('POST', `/api/tasks/lists/${list.id}/copy`, {})).body;
  const L = (id) => q('SELECT color, emoji, rate, currency FROM task_lists WHERE id = ?').get(id);
  const T = (id) => q('SELECT title, estimate, nonbillable FROM tasks WHERE list_id = ?').get(id);
  assert.deepEqual({ ...L(copy.id) }, { ...L(list.id) });
  assert.deepEqual({ ...T(copy.id) }, { ...T(list.id) });
});

test('a duplicated task, and the next of a repeating one, stay not billable', async () => {
  const { q } = await import('../src/db.js');
  const list = (await olivia('POST', '/api/tasks/lists', { name: 'Internal' })).body;
  const t = (await olivia('POST', `/api/tasks/lists/${list.id}/tasks`, { title: 'Team meeting', due: '2026-11-23' })).body;
  await olivia('PATCH', `/api/tasks/tasks/${t.id}`, { repeat: 'weekly', priority: 'low' });
  q('UPDATE tasks SET nonbillable = 1, estimate = 60 WHERE id = ?').run(t.id);
  const dup = (await olivia('POST', `/api/tasks/tasks/${t.id}/duplicate`)).body;
  await olivia('PATCH', `/api/tasks/tasks/${t.id}`, { done: true });
  const next = q('SELECT next_id FROM tasks WHERE id = ?').get(t.id).next_id;
  for (const id of [dup.id, next]) assert.deepEqual({ ...q('SELECT nonbillable, estimate, priority FROM tasks WHERE id = ?').get(id) }, { ...q('SELECT nonbillable, estimate, priority FROM tasks WHERE id = ?').get(t.id) });
});

test('a file’s copy in Drive keeps its description, and a document its page setup', async () => {
  const doc = (await olivia('POST', '/api/files/new', { kind: 'doc', name: 'Proposal' })).body;
  const r = await olivia('PATCH', `/api/files/${doc.id}`, { description: 'For the board, final draft', page_setup: { size: 'letter', orientation: 'landscape', margin: 'narrow', watermark: 'DRAFT' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const copy = (await olivia('POST', `/api/files/${doc.id}/copy`, {})).body;
  const a = (await olivia('GET', `/api/files/${doc.id}`)).body, b = (await olivia('GET', `/api/files/${copy.id}`)).body;
  assert.equal(b.name, 'Copy of Proposal');
  assert.equal(b.description, 'For the board, final draft');
  assert.deepEqual(b.page_setup, a.page_setup);
  assert.equal(a.page_setup.watermark, 'DRAFT');
});

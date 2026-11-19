// Saving a form's questions with the ones the editor started from (base_questions) keeps a colleague's
// changes made meanwhile; without them, the questions sent replace what's stored (as before).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-formmerge-'));
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

let cookie = '';
const api = async (method, url, body) => {
  const res = await fetch(base + url, { method, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json', ...(cookie && { cookie }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return { status: res.status, body: await res.json().catch(() => null) };
};

test('two saves from the same starting point: both kept', async () => {
  assert.equal((await api('POST', '/api/auth/setup', { org_name: 'Acme', domain: 'acme.com', name: 'Olivia Owner', local: 'olivia', password: 'password123' })).status, 200);
  const f = (await api('POST', '/api/forms', { title: 'Survey', questions: [{ type: 'short', title: 'Name' }, { type: 'short', title: 'Team' }] })).body;
  const start = (await api('GET', `/api/forms/${f.id}`)).body.questions;
  const [a, b] = start;
  // a colleague: question 2, and a new question 3
  let r = await api('PUT', `/api/forms/${f.id}`, { questions: [a, { ...b, title: 'Team or department' }, { type: 'short', title: 'Desk' }], base_questions: start });
  assert.equal(r.status, 200);
  // this editor, from the same start: question 1
  r = await api('PUT', `/api/forms/${f.id}`, { questions: [{ ...a, title: 'Full name' }, b], base_questions: start });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.questions.map((x) => x.title), ['Full name', 'Team or department', 'Desk']);
  assert.deepEqual((await api('GET', `/api/forms/${f.id}`)).body.questions.map((x) => x.title), ['Full name', 'Team or department', 'Desk']);
});

test('without base_questions: what is sent replaces what is stored', async () => {
  const f = (await api('POST', '/api/forms', { title: 'Plain', questions: [{ type: 'short', title: 'One' }, { type: 'short', title: 'Two' }] })).body;
  const r = await api('PUT', `/api/forms/${f.id}`, { questions: [{ type: 'short', title: 'Only' }] });
  assert.deepEqual(r.body.questions.map((x) => x.title), ['Only']);
});

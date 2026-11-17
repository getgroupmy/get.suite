// Writing sprints kept per person and document (Docs focus mode → Word count).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-sprints-'));
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

test('sprints are kept per person and document, with totals; others and bad ones are refused', async () => {
  const olivia = client(), mia = client();
  assert.equal((await olivia('POST', '/api/auth/setup', { org_name: 'Acme', domain: 'acme.com', name: 'Olivia Owner', local: 'olivia', password: 'password123' })).status, 200);
  assert.equal((await olivia('POST', '/api/users', { local: 'mia', domain: 'acme.com', name: 'Mia Member', password: 'password123' })).status, 201);
  assert.equal((await mia('POST', '/api/auth/login', { username: 'mia@acme.com', password: 'password123' })).status, 200);
  const doc = (await olivia('POST', '/api/files/new', { kind: 'doc', name: 'Essay' })).body;
  const sheet = (await olivia('POST', '/api/files/new', { kind: 'sheet', name: 'Budget' })).body;
  const t = Date.now();
  assert.equal((await olivia('POST', `/api/files/${doc.id}/sprints`, { started: t - 3600e3, minutes: 25, words: 310 })).status, 201);
  const r = await olivia('POST', `/api/files/${doc.id}/sprints`, { started: t - 600e3, minutes: 10, words: -4 });
  assert.equal(r.status, 201);
  assert.deepEqual({ count: r.body.count, words: r.body.words, minutes: r.body.minutes }, { count: 2, words: 306, minutes: 35 });
  assert.deepEqual(r.body.recent.map((x) => x.words), [-4, 310], 'newest first');
  // Sent again (a retry): the same sprint, not a second.
  assert.equal((await olivia('POST', `/api/files/${doc.id}/sprints`, { started: t - 600e3, minutes: 10, words: -4 })).body.count, 2);
  // Someone without the document can't see or add to it; with it shared, they see only their own.
  assert.equal((await mia('GET', `/api/files/${doc.id}/sprints`)).status, 404);
  assert.equal((await mia('POST', `/api/files/${doc.id}/sprints`, { started: t, minutes: 5, words: 1 })).status, 404);
  assert.equal((await olivia('PUT', `/api/files/${doc.id}/shares`, { shares: [{ user_id: (await olivia('GET', '/api/users/directory')).body.find((u) => u.name === 'Mia Member').id, role: 'editor' }] })).status, 200);
  assert.equal((await mia('GET', `/api/files/${doc.id}/sprints`)).body.count, 0);
  // Not for spreadsheets; nonsense refused.
  assert.equal((await olivia('POST', `/api/files/${sheet.id}/sprints`, { started: t, minutes: 5, words: 1 })).status, 400);
  for (const bad of [{ started: t, minutes: 999, words: 1 }, { started: t + 864e5, minutes: 5, words: 1 }, { started: t, minutes: 5, words: 'many' }]) {
    assert.equal((await olivia('POST', `/api/files/${doc.id}/sprints`, bad)).status, 400, JSON.stringify(bad));
  }
});

test('your writing this week (Home): totals and the documents written most in, ones in the trash left out', async () => {
  const olivia = client();
  assert.equal((await olivia('POST', '/api/auth/login', { username: 'olivia@acme.com', password: 'password123' })).status, 200);
  const a = (await olivia('POST', '/api/files/new', { kind: 'doc', name: 'Novel' })).body;
  const b = (await olivia('POST', '/api/files/new', { kind: 'doc', name: 'Letter' })).body;
  const before = (await olivia('GET', '/api/users/me/writing')).body;
  const t = Date.now();
  await olivia('POST', `/api/files/${a.id}/sprints`, { started: t - 7200e3, minutes: 25, words: 500 });
  await olivia('POST', `/api/files/${b.id}/sprints`, { started: t - 3600e3, minutes: 10, words: 80 });
  const w = (await olivia('GET', '/api/users/me/writing')).body;
  assert.equal(w.count - before.count, 2);
  assert.equal(w.words - before.words, 580);
  assert.equal(w.files[0].name, 'Novel', 'the most words first');
  await olivia('PATCH', `/api/files/${b.id}`, { trashed: true });
  assert.ok(!(await olivia('GET', '/api/users/me/writing')).body.files.some((f) => f.name === 'Letter'));
});

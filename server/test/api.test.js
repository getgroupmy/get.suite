import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-test-'));
process.env.DATA_DIR = dir;
const { createApp } = await import('../src/app.js');
const { attachHub } = await import('../src/hub.js');

let server, base;
before(async () => {
  server = http.createServer(createApp({ maxUploadBytes: 1024 * 1024 }));
  attachHub(server);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  return async function call(method, url, body, { raw, headers = {} } = {}) {
    const res = await fetch(base + url, {
      method,
      headers: {
        'x-requested-with': 'nas-workspace',
        ...(cookie && { cookie }),
        ...(body !== undefined && !raw && { 'content-type': 'application/json' }),
        ...headers,
      },
      body: raw ? body : body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : await res.text() };
  };
}

const admin = client();
const bob = client();
let bobId;

test('first-run setup creates an admin', async () => {
  assert.equal((await admin('GET', '/api/auth/status')).body.needsSetup, true);
  const r = await admin('POST', '/api/auth/setup', { username: 'Alice', name: 'Alice A', password: 'correct-horse' });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.username, 'alice');
  assert.equal(r.body.user.is_admin, true);
  assert.equal((await admin('POST', '/api/auth/setup', { username: 'x', name: 'x', password: '12345678' })).status, 409);
});

test('CSRF header is required for writes', async () => {
  const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 403);
});

test('admin creates a user who can log in', async () => {
  const r = await admin('POST', '/api/users', { username: 'bob', name: 'Bob B', password: 'password123' });
  assert.equal(r.status, 201);
  bobId = r.body.id;
  assert.equal((await bob('POST', '/api/auth/login', { username: 'bob', password: 'wrong-pass' })).status, 401);
  const ok = await bob('POST', '/api/auth/login', { username: 'bob', password: 'password123' });
  assert.equal(ok.status, 200);
  assert.equal((await bob('GET', '/api/users')).status, 403, 'non-admin cannot list users');
});

test('drive: folders, uploads, sharing and permissions', async () => {
  const folder = (await admin('POST', '/api/files/folder', { name: 'Projects' })).body;
  const up = await admin('POST', `/api/files/upload?parent=${folder.id}&name=${encodeURIComponent('notes é.txt')}`, 'hello world', { raw: true });
  assert.equal(up.status, 201);
  assert.equal(up.body.name, 'notes é.txt');
  assert.equal(up.body.size, 11);

  const dup = await admin('POST', `/api/files/upload?parent=${folder.id}&name=notes%20%C3%A9.txt`, 'again', { raw: true });
  assert.equal(dup.body.name, 'notes é (1).txt');

  assert.equal((await admin('GET', `/api/files/${up.body.id}/raw`)).body, 'hello world');
  assert.equal((await bob('GET', `/api/files/${up.body.id}/raw`)).status, 404, 'bob cannot see unshared file');

  await admin('PUT', `/api/files/${folder.id}/shares`, { shares: [{ user_id: bobId, role: 'viewer' }] });
  const shared = (await bob('GET', '/api/files?view=shared')).body;
  assert.deepEqual(shared.map((f) => f.name), ['Projects']);
  assert.equal((await bob('GET', `/api/files/${up.body.id}/raw`)).body, 'hello world', 'inherited access');
  assert.equal((await bob('PATCH', `/api/files/${up.body.id}`, { name: 'x.txt' })).status, 403, 'viewer cannot rename');

  const big = await admin('POST', `/api/files/upload?name=big.bin`, Buffer.alloc(2 * 1024 * 1024), { raw: true });
  assert.equal(big.status, 413);
});

test('drive: html uploads are never served inline', async () => {
  const up = await admin('POST', '/api/files/upload?name=evil.html', '<script>alert(1)</script>', { raw: true });
  const res = await admin('GET', `/api/files/${up.body.id}/raw`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/octet-stream');
  assert.match(res.headers.get('content-disposition'), /^attachment/);
  assert.equal((await fetch(`${base}/api/files/${up.body.id}/raw`)).status, 401, 'signed-out request is refused');
});

test('docs: optimistic concurrency', async () => {
  const doc = (await admin('POST', '/api/files/new', { kind: 'doc', name: 'Plan' })).body;
  const c = (await admin('GET', `/api/files/${doc.id}/content`)).body;
  assert.equal(c.content.type, 'doc');
  const s1 = await admin('PUT', `/api/files/${doc.id}/content`, { version: c.file.version, content: { type: 'doc', content: [] } });
  assert.equal(s1.status, 200);
  const stale = await admin('PUT', `/api/files/${doc.id}/content`, { version: c.file.version, content: {} });
  assert.equal(stale.status, 409);
});

test('trash and permanent delete', async () => {
  const f = (await admin('POST', '/api/files/folder', { name: 'Old' })).body;
  await admin('POST', `/api/files/upload?parent=${f.id}&name=a.txt`, 'a', { raw: true });
  await admin('PATCH', `/api/files/${f.id}`, { trashed: true });
  assert.ok((await admin('GET', '/api/files?view=trash')).body.some((x) => x.id === f.id));
  assert.ok(!(await admin('GET', '/api/files')).body.some((x) => x.id === f.id));
  assert.equal((await admin('POST', '/api/files/empty-trash')).body.deleted, 1);
  assert.equal((await admin('GET', `/api/files/${f.id}`)).status, 404);
});

test('cannot move a folder into itself', async () => {
  const a = (await admin('POST', '/api/files/folder', { name: 'A' })).body;
  const b = (await admin('POST', '/api/files/folder', { name: 'B', parent_id: a.id })).body;
  assert.equal((await admin('PATCH', `/api/files/${a.id}`, { parent_id: b.id })).status, 400);
});

test('calendar and contacts are private per user', async () => {
  const ev = await admin('POST', '/api/events', { title: 'Standup', start: 1000, end: 2000 });
  assert.equal(ev.status, 201);
  assert.equal((await admin('GET', '/api/events?from=0&to=5000')).body.length, 1);
  assert.equal((await bob('GET', '/api/events?from=0&to=5000')).body.length, 0);
  assert.equal((await bob('DELETE', `/api/events/${ev.body.id}`)).status, 404);
  assert.equal((await admin('POST', '/api/events', { title: 'Bad', start: 2000, end: 1000 })).status, 400);

  const c = await admin('POST', '/api/contacts', { name: 'Carol', email: 'carol@example.com' });
  assert.equal(c.status, 201);
  assert.equal((await bob('GET', '/api/contacts')).body.length, 0);
});

test('chat: channels and direct messages', async () => {
  const { channels } = (await admin('GET', '/api/chat/channels')).body;
  const general = channels.find((c) => c.name === 'general');
  const m = await admin('POST', `/api/chat/channels/${general.id}/messages`, { body: 'hi all' });
  assert.equal(m.status, 201);
  assert.equal((await bob('GET', `/api/chat/channels/${general.id}/messages`)).body[0].body, 'hi all');

  const dm = (await admin('POST', '/api/chat/dm', { user_id: bobId })).body;
  assert.equal((await admin('POST', '/api/chat/dm', { user_id: bobId })).body.id, dm.id, 'dm is reused');
  await bob('POST', `/api/chat/channels/${dm.id}/messages`, { body: 'secret' });
  const carol = client();
  await admin('POST', '/api/users', { username: 'carol', name: 'Carol', password: 'password123' });
  await carol('POST', '/api/auth/login', { username: 'carol', password: 'password123' });
  assert.equal((await carol('GET', `/api/chat/channels/${dm.id}/messages`)).status, 404, 'outsiders cannot read DMs');
});

test('session cookie is Secure only behind HTTPS (auto mode)', async () => {
  const login = (headers) => fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ username: 'alice', password: 'correct-horse' }),
  });
  assert.doesNotMatch((await login({})).headers.get('set-cookie'), /Secure/);
  assert.match((await login({ 'x-forwarded-proto': 'https' })).headers.get('set-cookie'), /Secure/);
});

test('database backup snapshot is readable and rotated', async () => {
  const { backupDatabase, BACKUP_DIR } = await import('../src/backup.js');
  const { DatabaseSync } = await import('node:sqlite');
  for (let d = 1; d <= 9; d++) backupDatabase({ keep: 7, date: new Date(Date.UTC(2026, 0, d)) });
  const files = fs.readdirSync(BACKUP_DIR).sort();
  assert.equal(files.length, 7);
  assert.equal(files[0], 'workspace-2026-01-03.db');
  const snap = new DatabaseSync(path.join(BACKUP_DIR, files.at(-1)), { readOnly: true });
  assert.ok(snap.prepare('SELECT COUNT(*) AS n FROM users').get().n >= 2);
  snap.close();
});

test('disabling a user signs them out', async () => {
  await admin('PATCH', `/api/users/${bobId}`, { disabled: true });
  assert.equal((await bob('GET', '/api/auth/me')).status, 401);
});

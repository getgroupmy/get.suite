// Live connections end with the session: signing out (here, or everywhere), being suspended or signed out by
// an admin closes the update channel and co-editing connections (code 4401), so someone signed out can't
// keep editing a file that was open. Other people's connections stay open.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import WebSocket from 'ws';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-livesessions-'));
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
  const c = { cookie: '' };
  c.call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json', ...(c.cookie && { cookie: c.cookie }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = res.headers.get('set-cookie'); if (sc) c.cookie = sc.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  // A live connection with this session; resolves once open. `.closed` resolves with the close code.
  c.open = (url) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${url}`, { headers: { cookie: c.cookie } });
    ws.closed = new Promise((r) => ws.on('close', (code) => r(code)));
    ws.on('open', () => resolve(ws));
    ws.on('unexpected-response', (_req, res) => reject(new Error(`refused: ${res.statusCode}`)));
    ws.on('error', reject);
  });
  return c;
}
const within = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r('still open'), ms))]);

const owner = client(), bob = client(), bobPhone = client();
let bobId, doc;

test('setup: a company, Bob, and Bob’s document', async () => {
  assert.equal((await owner.call('POST', '/api/auth/setup', { org_name: 'Acme', domain: 'acme.com', name: 'Olivia Owner', local: 'olivia', password: 'password123' })).status, 200);
  const r = await owner.call('POST', '/api/users', { local: 'bob', domain: 'acme.com', name: 'Bob B', password: 'password123' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  bobId = r.body.id;
  for (const c of [bob, bobPhone]) assert.equal((await c.call('POST', '/api/auth/login', { username: 'bob@acme.com', password: 'password123' })).status, 200);
  doc = (await bob.call('POST', '/api/files/new', { kind: 'doc', name: 'Plans' })).body;
  assert.ok(doc?.id, 'a document');
});

test('signing out closes that session’s connections, not the other device’s', async () => {
  const live = await bob.open('/ws');
  const editing = await bob.open(`/ws/collab/${doc.id}`);
  const phone = await bobPhone.open(`/ws/collab/${doc.id}`);
  await bob.call('POST', '/api/auth/logout');
  assert.equal(await within(live.closed, 2000), 4401);
  assert.equal(await within(editing.closed, 2000), 4401);
  assert.equal(await within(phone.closed, 300), 'still open', 'the phone is still signed in');
  // and the signed-out cookie can't open a new one
  await assert.rejects(bob.open(`/ws/collab/${doc.id}`), /401/);
  phone.close();
});

test('an admin suspending someone closes their open file at once', async () => {
  assert.equal((await bob.call('POST', '/api/auth/login', { username: 'bob@acme.com', password: 'password123' })).status, 200);
  const editing = await bob.open(`/ws/collab/${doc.id}`);
  const mine = await owner.open('/ws');
  const r = await owner.call('POST', '/api/users/bulk', { ids: [bobId], action: 'suspend' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await within(editing.closed, 2000), 4401);
  assert.equal(await within(mine.closed, 300), 'still open', 'the admin stays connected');
  mine.close();
});

test('a session that ends without a request (expired) is closed by the regular check', async () => {
  await owner.call('POST', '/api/users/bulk', { ids: [bobId], action: 'restore' });
  assert.equal((await bob.call('POST', '/api/auth/login', { username: 'bob@acme.com', password: 'password123' })).status, 200);
  const editing = await bob.open(`/ws/collab/${doc.id}`);
  const { q } = await import('../src/db.js');
  const { sweepSessions } = await import('../src/livesessions.js');
  q('UPDATE sessions SET expires_at = ? WHERE user_id = ?').run(Date.now() - 1000, bobId);
  assert.equal(sweepSessions(), 1);
  assert.equal(await within(editing.closed, 2000), 4401);
});

// An open file follows changes to what someone may do with it: made a viewer, unshared, the file locked or
// trashed, their access running out. Their co-editing connection closes (4000: the editor opens again with
// what they may do now), and nothing more from it is taken. Others' connections stay open.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import WebSocket from 'ws';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-collabaccess-'));
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

const owner = client(), bob = client(), carol = client();
let bobId, carolId, doc;
const share = (list) => owner.call('PUT', `/api/files/${doc.id}/shares`, { shares: list });

test('setup: a document shared with Bob and Carol as editors', async () => {
  assert.equal((await owner.call('POST', '/api/auth/setup', { org_name: 'Acme', domain: 'acme.com', name: 'Olivia Owner', local: 'olivia', password: 'password123' })).status, 200);
  for (const [local, name] of [['bob', 'Bob B'], ['carol', 'Carol C']]) {
    const r = await owner.call('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    if (local === 'bob') bobId = r.body.id; else carolId = r.body.id;
  }
  assert.equal((await bob.call('POST', '/api/auth/login', { username: 'bob@acme.com', password: 'password123' })).status, 200);
  assert.equal((await carol.call('POST', '/api/auth/login', { username: 'carol@acme.com', password: 'password123' })).status, 200);
  doc = (await owner.call('POST', '/api/files/new', { kind: 'doc', name: 'Plans' })).body;
  const r = await share([{ user_id: bobId, role: 'editor' }, { user_id: carolId, role: 'editor' }]);
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

test('made a viewer while it’s open: Bob’s connection closes (4000); Carol’s, unchanged, stays', async () => {
  const b = await bob.open(`/ws/collab/${doc.id}`);
  const c = await carol.open(`/ws/collab/${doc.id}`);
  assert.equal((await share([{ user_id: bobId, role: 'viewer' }, { user_id: carolId, role: 'editor' }])).status, 200);
  assert.equal(await within(b.closed, 2000), 4000);
  assert.equal(await within(c.closed, 300), 'still open');
  c.close();
});

test('unshared while it’s open: closed, and can’t open it again', async () => {
  const b = await bob.open(`/ws/collab/${doc.id}`); // (as a viewer)
  assert.equal((await share([{ user_id: carolId, role: 'editor' }])).status, 200);
  assert.equal(await within(b.closed, 2000), 4000);
  await assert.rejects(bob.open(`/ws/collab/${doc.id}`), /404/);
});

test('the file locked while it’s open: the editor’s connection closes (opens again read-only)', async () => {
  const c = await carol.open(`/ws/collab/${doc.id}`);
  const r = await owner.call('PUT', `/api/files/${doc.id}/lock`, { locked: true });
  assert.ok(r.status < 300, JSON.stringify(r.body));
  assert.equal(await within(c.closed, 2000), 4000);
  await owner.call('PUT', `/api/files/${doc.id}/lock`, { locked: false });
});

test('access running out (no request made) is caught by the regular check', async () => {
  const { q } = await import('../src/db.js');
  const { recheckAccess } = await import('../src/collab.js');
  await new Promise((r) => setTimeout(r, 50));
  const c = await carol.open(`/ws/collab/${doc.id}`);
  assert.equal(recheckAccess(), 0, 'nothing changed yet');
  q('UPDATE shares SET expires_at = ? WHERE file_id = ? AND user_id = ?').run(Date.now() - 1000, doc.id, carolId);
  assert.equal(recheckAccess(), 1);
  assert.equal(await within(c.closed, 2000), 4000);
});

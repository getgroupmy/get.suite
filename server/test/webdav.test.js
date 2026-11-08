import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-webdav-'));
process.env.DATA_DIR = dir;
const { createApp } = await import('../src/app.js');

let server, base, cookie, kimId;
before(async () => {
  server = http.createServer(createApp({ maxUploadBytes: 1024 * 1024 }));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  const s = await fetch(`${base}/api/auth/setup`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ org_name: 'Acme', domain: 'acme.com', name: 'Pat', local: 'pat', password: 'password123' }) });
  cookie = s.headers.get('set-cookie').split(';')[0];
  kimId = (await api('POST', '/api/users', { local: 'kim', domain: 'acme.com', name: 'Kim', password: 'password123' })).body.id;
});
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

async function api(method, url, body, who = cookie) {
  const r = await fetch(base + url, { method, headers: { 'x-requested-with': 'nas-workspace', cookie: who, ...(body && { 'content-type': 'application/json' }) }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const auth = (u = 'pat') => `Basic ${Buffer.from(`${u}@acme.com:password123`).toString('base64')}`;
async function dav(method, url, { body, headers = {}, user = 'pat' } = {}) {
  const r = await fetch(base + url, { method, headers: { authorization: auth(user), ...headers }, body });
  return { status: r.status, headers: r.headers, text: await r.text() };
}
const names = (xml) => [...xml.matchAll(/<d:href>([^<]+)<\/d:href>/g)].map((m) => decodeURIComponent(m[1]));

test('connect, make a folder, save, open, list', async () => {
  assert.equal((await fetch(`${base}/dav/files/`, { method: 'PROPFIND' })).status, 401);
  const root = await dav('PROPFIND', '/dav/files/', { headers: { depth: '1' } });
  assert.equal(root.status, 207);
  assert.deepEqual(names(root.text), ['/dav/files/', '/dav/files/Shared with me/', '/dav/files/Shared drives/']);
  assert.match(root.text, /<d:quota-used-bytes>/);
  assert.equal((await dav('MKCOL', '/dav/files/Clients')).status, 201);
  assert.equal((await dav('MKCOL', '/dav/files/Clients')).status, 405, 'already there');
  assert.equal((await dav('MKCOL', '/dav/files/Nope/Deeper')).status, 409, 'parent missing');
  // Windows writes an empty file first, then the content.
  assert.equal((await dav('PUT', '/dav/files/Clients/quote%20%C3%A9.txt', { body: '' })).status, 201);
  assert.equal((await dav('PUT', '/dav/files/Clients/quote%20%C3%A9.txt', { body: 'Price: 100' })).status, 204);
  const got = await dav('GET', '/dav/files/Clients/quote%20%C3%A9.txt');
  assert.equal(got.text, 'Price: 100');
  assert.match(got.headers.get('etag'), /^"/);
  const list = await dav('PROPFIND', '/dav/files/Clients/', { headers: { depth: '1' } });
  assert.deepEqual(names(list.text), ['/dav/files/Clients/', '/dav/files/Clients/quote é.txt']);
  assert.match(list.text, /<d:getcontentlength>10<\/d:getcontentlength>/);
  // The same file in Drive on the web.
  const web = (await api('GET', '/api/files')).body.find((f) => f.name === 'Clients');
  const inside = (await api('GET', `/api/files?parent=${web.id}`)).body;
  assert.deepEqual(inside.map((f) => f.name), ['quote é.txt']);
  assert.equal((await api('GET', `/api/files/${inside[0].id}/versions`)).body.length, 0, 'the empty first write is not a version');
  await dav('PUT', '/dav/files/Clients/quote%20%C3%A9.txt', { body: 'Price: 120' });
  assert.equal((await api('GET', `/api/files/${inside[0].id}/versions`)).body.length, 1, 'saving over it keeps the old one');
  // macOS clutter is accepted but not kept.
  assert.equal((await dav('PUT', '/dav/files/Clients/._quote.txt', { body: 'x' })).status, 201);
  assert.equal((await dav('PUT', '/dav/files/.DS_Store', { body: 'x' })).status, 201);
  assert.deepEqual((await api('GET', `/api/files?parent=${web.id}`)).body.map((f) => f.name), ['quote é.txt']);
});

test('rename, move, copy, delete to trash, locks', async () => {
  await dav('MKCOL', '/dav/files/Archive');
  const mv = await dav('MOVE', '/dav/files/Clients/quote%20%C3%A9.txt', { headers: { destination: `${base}/dav/files/Archive/old-quote.txt` } });
  assert.equal(mv.status, 201);
  assert.equal((await dav('GET', '/dav/files/Archive/old-quote.txt')).text, 'Price: 120');
  assert.equal((await dav('GET', '/dav/files/Clients/quote%20%C3%A9.txt')).status, 404);
  assert.equal((await dav('COPY', '/dav/files/Archive/old-quote.txt', { headers: { destination: '/dav/files/Clients/copy.txt' } })).status, 201);
  assert.equal((await dav('COPY', '/dav/files/Archive/old-quote.txt', { headers: { destination: '/dav/files/Clients/copy.txt', overwrite: 'F' } })).status, 412);
  assert.equal((await dav('MOVE', '/dav/files/Archive/', { headers: { destination: '/dav/files/Archive/Inside/' } })).status, 409, 'not into itself');
  const lock = await dav('LOCK', '/dav/files/Clients/copy.txt', { body: '<?xml version="1.0"?><d:lockinfo xmlns:d="DAV:"><d:lockscope><d:exclusive/></d:lockscope><d:locktype><d:write/></d:locktype></d:lockinfo>' });
  assert.equal(lock.status, 200);
  assert.match(lock.headers.get('lock-token'), /^<opaquelocktoken:/);
  assert.equal((await dav('UNLOCK', '/dav/files/Clients/copy.txt', { headers: { 'lock-token': lock.headers.get('lock-token') } })).status, 204);
  assert.equal((await dav('DELETE', '/dav/files/Clients/copy.txt')).status, 204);
  assert.ok((await api('GET', '/api/files?view=trash')).body.some((f) => f.name === 'copy.txt'), 'deleted files go to the trash');
});

test('shared with me: viewers read, editors write; limits apply', async () => {
  const folder = (await api('GET', '/api/files')).body.find((f) => f.name === 'Archive');
  await api('PUT', `/api/files/${folder.id}/shares`, { shares: [{ user_id: kimId, role: 'viewer' }] });
  const sh = await dav('PROPFIND', '/dav/files/Shared%20with%20me/', { headers: { depth: '1' }, user: 'kim' });
  assert.deepEqual(names(sh.text), ['/dav/files/Shared with me/', '/dav/files/Shared with me/Archive/']);
  assert.equal((await dav('GET', '/dav/files/Shared%20with%20me/Archive/old-quote.txt', { user: 'kim' })).text, 'Price: 120');
  assert.equal((await dav('PUT', '/dav/files/Shared%20with%20me/Archive/old-quote.txt', { body: 'hacked', user: 'kim' })).status, 403, 'viewer');
  assert.equal((await dav('PUT', '/dav/files/Shared%20with%20me/Archive/new.txt', { body: 'x', user: 'kim' })).status, 403);
  await api('PUT', `/api/files/${folder.id}/shares`, { shares: [{ user_id: kimId, role: 'editor' }] });
  assert.equal((await dav('PUT', '/dav/files/Shared%20with%20me/Archive/from-kim.txt', { body: 'hi', user: 'kim' })).status, 201);
  assert.equal((await dav('GET', '/dav/files/Archive/from-kim.txt')).text, 'hi', 'the owner sees it');
  assert.equal((await dav('PROPFIND', '/dav/files/Archive/', { headers: { depth: '0' }, user: 'kim' })).status, 404, 'not in Kim\'s own Drive');
  assert.equal((await dav('PUT', '/dav/files/big.bin', { body: Buffer.alloc(2 * 1024 * 1024) })).status, 413, 'upload size limit');
  // Documents, spreadsheets and presentations stay in the browser.
  await api('POST', '/api/files/new', { kind: 'doc', name: 'Plan' });
  assert.ok(!names((await dav('PROPFIND', '/dav/files/', { headers: { depth: '1' } })).text).some((n) => n.includes('Plan')));
});

test('a lock held by one person stops another from overwriting or deleting', async () => {
  const lk = await dav('LOCK', '/dav/files/Shared%20with%20me/Archive/from-kim.txt', { user: 'kim', headers: { timeout: 'Second-60' }, body: '<?xml version="1.0"?><d:lockinfo xmlns:d="DAV:"><d:lockscope><d:exclusive/></d:lockscope><d:locktype><d:write/></d:locktype><d:owner>Kim on Windows</d:owner></d:lockinfo>' });
  assert.equal(lk.status, 200);
  const token = lk.headers.get('lock-token');
  // Pat reaches the same file by another path (it's in Pat's own Drive): still locked.
  assert.equal((await dav('PUT', '/dav/files/Archive/from-kim.txt', { body: 'overwritten' })).status, 423);
  assert.equal((await dav('DELETE', '/dav/files/Archive/from-kim.txt')).status, 423);
  assert.equal((await dav('DELETE', '/dav/files/Archive/')).status, 423, 'nor the folder it is in');
  assert.match((await dav('PROPFIND', '/dav/files/Archive/from-kim.txt', { headers: { depth: '0' } })).text, /<d:owner>Kim on Windows<\/d:owner>/, 'others see who holds it');
  assert.equal((await dav('PUT', '/dav/files/Shared%20with%20me/Archive/from-kim.txt', { user: 'kim', body: 'saved by Kim', headers: { if: `(${token})` } })).status, 204);
  assert.equal((await dav('UNLOCK', '/dav/files/Archive/from-kim.txt', { headers: { 'lock-token': '<opaquelocktoken:not-it>' } })).status, 409);
  assert.equal((await dav('UNLOCK', '/dav/files/Shared%20with%20me/Archive/from-kim.txt', { user: 'kim', headers: { 'lock-token': token } })).status, 204);
  assert.equal((await dav('PUT', '/dav/files/Archive/from-kim.txt', { body: 'now Pat' })).status, 204);
});

test('shared drives: their own folder, members read and write, the drive itself is protected', async () => {
  const drive = (await api('POST', '/api/files/drives', { name: 'Finance' })).body;
  const root = names((await dav('PROPFIND', '/dav/files/', { headers: { depth: '1' } })).text);
  assert.ok(root.includes('/dav/files/Shared drives/'));
  assert.ok(!root.includes('/dav/files/Finance/'), 'not in My Drive');
  assert.deepEqual(names((await dav('PROPFIND', '/dav/files/Shared%20drives/', { headers: { depth: '1' } })).text), ['/dav/files/Shared drives/', '/dav/files/Shared drives/Finance/']);
  assert.equal((await dav('PROPFIND', '/dav/files/Shared%20drives/Finance/', { headers: { depth: '0' }, user: 'kim' })).status, 404, 'not a member yet');
  await api('PUT', `/api/files/${drive.id}/shares`, { shares: [{ user_id: kimId, role: 'editor' }] });
  assert.ok(!names((await dav('PROPFIND', '/dav/files/Shared%20with%20me/', { headers: { depth: '1' }, user: 'kim' })).text).some((n) => n.includes('Finance')), 'not in Shared with me');
  assert.equal((await dav('PUT', '/dav/files/Shared%20drives/Finance/budget.csv', { body: 'a,b', user: 'kim' })).status, 201);
  assert.equal((await dav('GET', '/dav/files/Shared%20drives/Finance/budget.csv')).text, 'a,b', 'the owner sees Kim’s file');
  assert.equal((await dav('MKCOL', '/dav/files/Shared%20drives/Q4/', { user: 'kim' })).status, 403, 'no new drives from here');
  assert.equal((await dav('DELETE', '/dav/files/Shared%20drives/Finance/', { user: 'kim' })).status, 403, 'only its owner deletes it');
  assert.equal((await dav('MOVE', '/dav/files/Shared%20drives/Finance/', { headers: { destination: '/dav/files/Finance/' } })).status, 403);
  assert.equal((await dav('MOVE', '/dav/files/Shared%20drives/Finance/budget.csv', { headers: { destination: '/dav/files/Shared%20drives/Finance/budget-2026.csv' }, user: 'kim' })).status, 201, 'files inside move as usual');
});

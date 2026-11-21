// /invite and /topic in Chat: people into a channel (told, and a line saying so), the topic with a line saying so.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-chatinvite-'));
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
const login = async (who, email) => assert.equal((await who('POST', '/api/auth/login', { username: email, password: 'password123' })).status, 200);
let ann, ben, cat, eve;
const bodies = async (who, ch) => (await who('GET', `/api/chat/channels/${ch}/messages`)).body.map((m) => m.body);
const sees = async (who, ch) => (await who('GET', '/api/chat/channels')).body.channels.find((c) => c.id === ch);

test('set up', async () => {
  ann = client();
  assert.equal((await ann('POST', '/api/auth/setup', { org_name: 'Acme', domain: 'acme.com', name: 'Ann Owner', local: 'ann', password: 'password123' })).status, 200);
  for (const [local, name] of [['ben', 'Ben Bell'], ['cat', 'Cat Cole']]) assert.equal((await ann('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).status, 201);
  assert.equal((await ann('POST', '/api/orgs', { name: 'Other', domain: 'other.com', admin_name: 'Eve', admin_local: 'eve', admin_password: 'password123' })).status, 201);
  ben = client(); cat = client(); eve = client();
  await login(ben, 'ben@acme.com'); await login(cat, 'cat@acme.com'); await login(eve, 'eve@other.com');
});

test('/invite into a private channel: they become members, are told, and the channel says who was added', async () => {
  const ch = (await ann('POST', '/api/chat/channels', { name: 'secret-plans', private: true })).body.id;
  assert.equal(await sees(ben, ch), undefined);
  const r = await ann('POST', `/api/chat/channels/${ch}/invite`, { usernames: ['@Ben@acme.com', 'cat@acme.com', 'ann@acme.com'] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.added.map((u) => u.name), ['Ben Bell', 'Cat Cole']);
  assert.ok(await sees(ben, ch));
  assert.deepEqual(await bodies(ben, ch), ['➕ Added Ben Bell and Cat Cole to #secret-plans']);
  const bell = (await ben('GET', '/api/notifications')).body;
  const items = bell.items || bell.notifications || bell;
  assert.ok(items.some((n) => n.title === 'Ann Owner added you to #secret-plans' && n.link === `/chat/${ch}`), JSON.stringify(items).slice(0, 300));
  // Again: nobody new, nothing posted.
  const again = (await ann('POST', `/api/chat/channels/${ch}/invite`, { usernames: ['ben@acme.com'] })).body;
  assert.deepEqual([again.added.length, again.already.map((u) => u.name)], [0, ['Ben Bell']]);
  assert.equal((await bodies(ann, ch)).length, 1);
  // Someone not in the company, or no one at all, is refused; outsiders can't invite.
  const bad = await ann('POST', `/api/chat/channels/${ch}/invite`, { usernames: ['eve@other.com'] });
  assert.equal(bad.status, 400); assert.match(bad.body.error, /eve@other\.com/);
  assert.equal((await ann('POST', `/api/chat/channels/${ch}/invite`, { usernames: [] })).status, 400);
  assert.equal((await eve('POST', `/api/chat/channels/${ch}/invite`, { usernames: ['eve@other.com'] })).status, 404);
});

test('/invite in an open channel brings back someone who left', async () => {
  const ch = (await ann('POST', '/api/chat/channels', { name: 'lunch' })).body.id;
  assert.equal((await ben('POST', `/api/chat/channels/${ch}/leave`)).status, 200);
  assert.equal((await sees(ben, ch)).left, true);
  const r = (await cat('POST', `/api/chat/channels/${ch}/invite`, { usernames: ['ben@acme.com', 'ann@acme.com'] })).body;
  assert.deepEqual(r.added.map((u) => u.name), ['Ben Bell']);
  assert.deepEqual(r.already.map((u) => u.name), ['Ann Owner']);
  assert.equal((await sees(ben, ch)).left, undefined);
  assert.deepEqual(await bodies(ann, ch), ['➕ Added Ben Bell to #lunch']);
  const dm = (await ann('POST', '/api/chat/dm', { user_id: (await ben('GET', '/api/auth/me')).body.user.id })).body;
  assert.equal((await ann('POST', `/api/chat/channels/${dm.id}/invite`, { usernames: ['cat@acme.com'] })).status, 400, 'not in a direct message');
});

test('/topic: the topic changes and the channel says so; the settings box changes it quietly', async () => {
  const ch = (await ann('POST', '/api/chat/channels', { name: 'launch' })).body.id;
  assert.equal((await ben('PATCH', `/api/chat/channels/${ch}`, { topic: 'Launch on the 3rd', say: true })).status, 200);
  assert.equal((await sees(ann, ch)).topic, 'Launch on the 3rd');
  assert.deepEqual(await bodies(ann, ch), ['📝 Set the topic: Launch on the 3rd']);
  await ben('PATCH', `/api/chat/channels/${ch}`, { topic: 'Launch on the 3rd', say: true }); // the same: nothing said
  await ben('PATCH', `/api/chat/channels/${ch}`, { topic: 'Quietly changed' });
  await ben('PATCH', `/api/chat/channels/${ch}`, { topic: '', say: true });
  assert.deepEqual(await bodies(ann, ch), ['📝 Set the topic: Launch on the 3rd', '📝 Cleared the topic']);
});

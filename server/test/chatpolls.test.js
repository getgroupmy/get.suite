// Chat polls: anonymous (counts only: nobody sees who chose what) and closing by themselves at a set time.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-chatpolls-'));
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
let ann, ben, ch;
test('set up', async () => {
  ann = client();
  assert.equal((await ann('POST', '/api/auth/setup', { org_name: 'Acme', domain: 'acme.com', name: 'Ann Owner', local: 'ann', password: 'password123' })).status, 200);
  assert.equal((await ann('POST', '/api/users', { local: 'ben', domain: 'acme.com', name: 'Ben Bell', password: 'password123' })).status, 201);
  ben = client(); await login(ben, 'ben@acme.com');
  ch = (await ann('POST', '/api/chat/channels', { name: 'team' })).body.id;
});

test('anonymous: everyone sees how many chose each option, nobody who; you see your own choice', async () => {
  const poll = (await ann('POST', `/api/chat/channels/${ch}/messages`, { poll: { question: 'Is the workload OK?', options: ['Yes', 'Too much'], anonymous: true } })).body;
  assert.equal(poll.poll.anonymous, true);
  const v = (await ben('POST', `/api/chat/messages/${poll.id}/vote`, { options: ['o2'] })).body;
  assert.deepEqual(v.poll.mine, ['o2'], 'the voter’s own choice, in the answer to their vote');
  await ann('POST', `/api/chat/messages/${poll.id}/vote`, { options: ['o1'] });
  const seenBy = async (who) => (await who('GET', `/api/chat/channels/${ch}/messages`)).body.find((m) => m.id === poll.id).poll;
  for (const [who, mine] of [[ann, ['o1']], [ben, ['o2']]]) {
    const p = await seenBy(who);
    assert.deepEqual(p.options.map((o) => [o.count, o.votes.length]), [[1, 0], [1, 0]], 'counts, no names');
    assert.deepEqual(p.mine, mine);
    assert.equal(p.voters, 2);
  }
  assert.ok(!JSON.stringify(await seenBy(ann)).includes('Ben Bell'), 'not even the asker');
  // The conversation's download: counts.
  const txt = await fetch(`${base}/api/chat/channels/${ch}/export?format=txt`, { headers: { cookie: (await (async () => { const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'ann@acme.com', password: 'password123' }) }); return r.headers.get('set-cookie').split(';')[0]; })()) } }).then((r) => r.text());
  assert.match(txt, /Is the workload OK\? — Yes 1, Too much 1/);
  // An ordinary poll still says who.
  const open = (await ann('POST', `/api/chat/channels/${ch}/messages`, { poll: { question: 'Lunch?', options: ['Pizza', 'Sushi'] } })).body;
  await ben('POST', `/api/chat/messages/${open.id}/vote`, { options: ['o1'] });
  assert.deepEqual((await seenBy(ann).then(() => ann('GET', `/api/chat/channels/${ch}/messages`))).body.find((m) => m.id === open.id).poll.options[0].votes.map((x) => x.name), ['Ben Bell']);
});

test('closing by itself: votes until then, closed after; reopening clears a passed closing time', async () => {
  assert.equal((await ann('POST', `/api/chat/channels/${ch}/messages`, { poll: { question: 'x', options: ['a', 'b'], closes_at: Date.now() + 1000 } })).status, 400, 'too soon');
  const closesAt = Date.now() + 61e3;
  const poll = (await ann('POST', `/api/chat/channels/${ch}/messages`, { poll: { question: 'Friday drinks?', options: ['Yes', 'No'], closes_at: closesAt } })).body;
  assert.equal(poll.poll.closes_at, closesAt);
  assert.equal(poll.poll.closed_at, undefined);
  assert.equal((await ben('POST', `/api/chat/messages/${poll.id}/vote`, { options: ['o1'] })).status, 200);
  // Its time passes (made so here: the stored closing time moved into the past).
  const { q } = await import('../src/db.js');
  const stored = JSON.parse(q('SELECT poll FROM messages WHERE id = ?').get(poll.id).poll);
  q('UPDATE messages SET poll = ? WHERE id = ?').run(JSON.stringify({ ...stored, closes_at: Date.now() - 1000 }), poll.id);
  const p = (await ben('GET', `/api/chat/channels/${ch}/messages`)).body.find((m) => m.id === poll.id).poll;
  assert.ok(p.closed_at, 'shown closed');
  const late = await ben('POST', `/api/chat/messages/${poll.id}/vote`, { options: ['o2'] });
  assert.equal(late.status, 400); assert.match(late.body.error, /closed/);
  // Reopened by whoever asked: open for good (its passed closing time gone).
  assert.equal((await ann('POST', `/api/chat/messages/${poll.id}/poll/close`, { closed: false })).status, 200);
  assert.equal((await ben('POST', `/api/chat/messages/${poll.id}/vote`, { options: ['o2'] })).status, 200);
});

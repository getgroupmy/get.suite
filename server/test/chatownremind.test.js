// Reminders of your own in Chat (/remind me to call Kim in 2h): listed with message reminders, due in the bell.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-ownremind-'));
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
const bell = async (who) => { const b = (await who('GET', '/api/notifications')).body; return b.items || b.notifications || b; };

test('set up', async () => {
  ann = client();
  assert.equal((await ann('POST', '/api/auth/setup', { org_name: 'Acme', domain: 'acme.com', name: 'Ann Owner', local: 'ann', password: 'password123' })).status, 200);
  assert.equal((await ann('POST', '/api/users', { local: 'ben', domain: 'acme.com', name: 'Ben Bell', password: 'password123' })).status, 201);
  ben = client(); await login(ben, 'ben@acme.com');
  ch = (await ann('POST', '/api/chat/channels', { name: 'launch' })).body.id;
});

test('a reminder of your own: listed (soonest first, with message reminders), only yours, cancellable', async () => {
  const m = (await ann('POST', `/api/chat/channels/${ch}/messages`, { body: 'Ship it' })).body;
  assert.equal((await ann('POST', `/api/chat/messages/${m.id}/remind`, { at: Date.now() + 3 * 36e5 })).status, 200);
  const r = await ann('POST', `/api/chat/channels/${ch}/reminders`, { text: 'call Kim', at: Date.now() + 2 * 36e5 });
  assert.equal(r.status, 201);
  const list = (await ann('GET', '/api/chat/reminders')).body;
  assert.deepEqual(list.map((x) => x.own ? `own:${x.text}:#${x.channel}` : `msg:${x.body}`), ['own:call Kim:#launch', 'msg:Ship it']);
  assert.deepEqual((await ben('GET', '/api/chat/reminders')).body, [], 'only yours');
  assert.equal((await ben('DELETE', `/api/chat/reminders/own/${r.body.id}`)).status, 404);
  assert.equal((await ann('DELETE', `/api/chat/reminders/own/${r.body.id}`)).status, 200);
  assert.deepEqual((await ann('GET', '/api/chat/reminders')).body.map((x) => !!x.own), [false]);
});

test('checked: something to remind of, a time from a minute to a year ahead, a conversation you can see', async () => {
  assert.equal((await ann('POST', `/api/chat/channels/${ch}/reminders`, { text: '', at: Date.now() + 36e5 })).status, 400);
  assert.equal((await ann('POST', `/api/chat/channels/${ch}/reminders`, { text: 'x', at: Date.now() - 1000 })).status, 400);
  assert.equal((await ann('POST', `/api/chat/channels/${ch}/reminders`, { text: 'x', at: Date.now() + 400 * 864e5 })).status, 400);
  const priv = (await ann('POST', '/api/chat/channels', { name: 'secret', private: true })).body.id;
  assert.equal((await ben('POST', `/api/chat/channels/${priv}/reminders`, { text: 'x', at: Date.now() + 36e5 })).status, 404);
});

test('when it’s due: in the bell, linking to the conversation, and gone from the list', async () => {
  const { sendDueChat } = await import('../src/routes/chat.js');
  const at = Date.now() + 60e3;
  await ben('POST', `/api/chat/channels/${ch}/reminders`, { text: 'send the slides', at });
  sendDueChat(at - 1000);
  assert.ok(!(await bell(ben)).some((n) => /send the slides/.test(n.title)), 'not yet');
  sendDueChat(at + 1000);
  const n = (await bell(ben)).find((x) => x.title === 'Reminder: send the slides');
  assert.ok(n, JSON.stringify(await bell(ben)).slice(0, 300));
  assert.equal(n.link, `/chat/${ch}`);
  assert.equal(n.body, 'You asked in #launch');
  assert.deepEqual((await ben('GET', '/api/chat/reminders')).body, []);
});

test('for a colleague: they get it (from you), you keep it listed until then, and can cancel it', async () => {
  const { sendDueChat } = await import('../src/routes/chat.js');
  const at = Date.now() + 5 * 60e3;
  const r = await ann('POST', `/api/chat/channels/${ch}/reminders`, { text: 'send the slides', at, for: '@Ben@acme.com' });
  assert.equal(r.status, 201);
  assert.equal(r.body.for_name, 'Ben Bell');
  const mine = (await ann('GET', '/api/chat/reminders')).body.find((x) => x.id === r.body.id);
  assert.equal(mine.for_name, 'Ben Bell');
  assert.ok(!(await ben('GET', '/api/chat/reminders')).body.some((x) => x.id === r.body.id), 'not Ben’s to cancel');
  assert.equal((await ann('POST', `/api/chat/channels/${ch}/reminders`, { text: 'x', at, for: 'nobody@acme.com' })).status, 400);
  sendDueChat(at + 1000);
  const n = (await bell(ben)).find((x) => x.title === 'Reminder from Ann Owner: send the slides');
  assert.ok(n);
  assert.equal(n.link, `/chat/${ch}`);
  assert.equal(n.body, 'Set in #launch');
  assert.ok(!(await bell(ann)).some((x) => /send the slides/.test(x.title)), 'not Ann');
  assert.ok(!(await ann('GET', '/api/chat/reminders')).body.some((x) => x.id === r.body.id));
  // In a private channel Ben isn't in: reminded all the same, without the link there.
  const priv = (await ann('POST', '/api/chat/channels', { name: 'hush', private: true })).body.id;
  const at2 = Date.now() + 5 * 60e3;
  await ann('POST', `/api/chat/channels/${priv}/reminders`, { text: 'book the dinner', at: at2, for: 'ben@acme.com' });
  sendDueChat(at2 + 1000);
  const n2 = (await bell(ben)).find((x) => x.title === 'Reminder from Ann Owner: book the dinner');
  assert.equal(n2.link, '/chat'); assert.ok(!n2.body);
  // Cancelled: nobody is reminded.
  const at3 = Date.now() + 5 * 60e3;
  const r3 = (await ann('POST', `/api/chat/channels/${ch}/reminders`, { text: 'never mind', at: at3, for: 'ben@acme.com' })).body;
  assert.equal((await ann('DELETE', `/api/chat/reminders/own/${r3.id}`)).status, 200);
  sendDueChat(at3 + 1000);
  assert.ok(!(await bell(ben)).some((x) => /never mind/.test(x.title)));
});

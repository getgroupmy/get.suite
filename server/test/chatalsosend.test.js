// A thread reply also sent to the conversation: shown there too (saying which thread it's in), changed and deleted
// together, found once by search, refused where only some people may post.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-chatalso-'));
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

let ann, ben, ch, top;
const list = async (who = ann) => (await who('GET', `/api/chat/channels/${ch}/messages`)).body;
const thread = async (who = ann) => (await who('GET', `/api/chat/messages/${top.id}/replies`)).body;

test('set up: Ann and Ben in a channel, a message with a thread', async () => {
  ann = client();
  assert.equal((await ann('POST', '/api/auth/setup', { org_name: 'Acme', domain: 'acme.com', name: 'Ann Owner', local: 'ann', password: 'password123' })).status, 200);
  assert.equal((await ann('POST', '/api/users', { local: 'ben', domain: 'acme.com', name: 'Ben Member', password: 'password123' })).status, 201);
  ben = client(); assert.equal((await ben('POST', '/api/auth/login', { username: 'ben@acme.com', password: 'password123' })).status, 200);
  ch = (await ann('POST', '/api/chat/channels', { name: 'launch' })).body.id;
  top = (await ann('POST', `/api/chat/channels/${ch}/messages`, { body: 'Which date for the launch?' })).body;
});

test('a reply sent to the conversation too: in the thread, and below in the conversation saying which thread', async () => {
  await ann('POST', `/api/chat/channels/${ch}/read`);
  const r = await ben('POST', `/api/chat/channels/${ch}/messages`, { body: 'The 3rd works for everyone', parent_id: top.id, also_send: true });
  assert.equal(r.status, 201);
  assert.equal(r.body.parent_id, top.id);
  assert.ok(r.body.echo_id);
  const t = await thread();
  assert.deepEqual(t.replies.map((m) => m.body), ['The 3rd works for everyone'], 'once in the thread');
  const msgs = await list();
  assert.deepEqual(msgs.map((m) => m.body), ['Which date for the launch?', 'The 3rd works for everyone']);
  const copy = msgs[1];
  assert.equal(copy.id, r.body.echo_id);
  assert.equal(copy.parent_id, null);
  assert.equal(copy.user_name, 'Ben Member');
  assert.deepEqual(copy.echo, { reply_id: r.body.id, parent_id: top.id, parent: { user_name: 'Ann Owner', body: 'Which date for the launch?', deleted: false } });
  assert.equal(msgs[0].reply_count, 1, 'the thread counts it once');
  const mine = (await ann('GET', '/api/chat/channels')).body.channels.find((x) => x.id === ch);
  assert.equal(mine.unread, 2, 'Ann (in the thread) has the reply and its copy in the conversation unread');
  // A plain reply stays in the thread.
  await ben('POST', `/api/chat/channels/${ch}/messages`, { body: 'Or the 4th', parent_id: top.id });
  assert.equal((await list()).length, 2);
});

test('replying to the copy replies in its thread; search finds it once', async () => {
  const copy = (await list())[1];
  const r = (await ann('POST', `/api/chat/channels/${ch}/messages`, { body: 'The 3rd then', parent_id: copy.id })).body;
  assert.equal(r.parent_id, top.id);
  assert.equal((await list())[1].reply_count, 0, 'the copy has no thread of its own');
  const found = (await ann('GET', `/api/chat/search?q=${encodeURIComponent('works for everyone')}`)).body;
  assert.equal(found.length, 1);
  assert.equal(found[0].parent_id, top.id, 'as the reply in the thread');
});

test('changing either changes both; deleting either deletes both', async () => {
  let copy = (await list())[1];
  assert.equal((await ben('PATCH', `/api/chat/messages/${copy.id}`, { body: 'The 3rd works for all of us' })).status, 200);
  assert.equal((await thread()).replies[0].body, 'The 3rd works for all of us');
  assert.ok((await thread()).replies[0].edited_at);
  assert.equal((await ann('PATCH', `/api/chat/messages/${copy.id}`, { body: 'nope' })).status, 404, 'only the writer');
  const reply = (await thread()).replies[0];
  assert.equal((await ben('PATCH', `/api/chat/messages/${reply.id}`, { body: 'The 3rd, then' })).status, 200);
  copy = (await list())[1];
  assert.equal(copy.body, 'The 3rd, then');
  // Delete the copy: the reply goes too.
  assert.equal((await ben('DELETE', `/api/chat/messages/${copy.id}`)).status, 200);
  assert.deepEqual((await list()).map((m) => m.body), ['Which date for the launch?']);
  assert.deepEqual((await thread()).replies.map((m) => m.body), ['Or the 4th', 'The 3rd then']);
  assert.equal((await list())[0].reply_count, 2);
  // Delete the reply: the copy goes too.
  const r2 = (await ben('POST', `/api/chat/channels/${ch}/messages`, { body: 'Booked the room', parent_id: top.id, also_send: true })).body;
  assert.equal((await list()).length, 2);
  assert.equal((await ben('DELETE', `/api/chat/messages/${r2.id}`)).status, 200);
  assert.equal((await list()).length, 1);
});

test('the thread’s message deleted: the copy says so; only some may post: the reply can only stay in the thread', async () => {
  const t2 = (await ann('POST', `/api/chat/channels/${ch}/messages`, { body: 'Snacks?' })).body;
  await ben('POST', `/api/chat/channels/${ch}/messages`, { body: 'Crisps', parent_id: t2.id, also_send: true });
  await ann('DELETE', `/api/chat/messages/${t2.id}`); // kept as "This message was deleted": it has a reply
  const copy = (await list()).find((m) => m.body === 'Crisps');
  assert.equal(copy.echo.parent.deleted, true);
  assert.equal(copy.echo.parent.body, '');
  // A poll in a thread stays there.
  assert.equal((await ben('POST', `/api/chat/channels/${ch}/messages`, { poll: { question: 'Day?', options: ['Mon', 'Tue'] }, parent_id: top.id, also_send: true })).status, 400);
  // An announcement channel: Ben may reply in threads but not post in the conversation.
  const me = (await ann('GET', '/api/auth/me')).body.user;
  assert.equal((await ann('PATCH', `/api/chat/channels/${ch}`, { posters: [me.id] })).status, 200);
  const before = (await thread()).replies.length;
  assert.equal((await ben('POST', `/api/chat/channels/${ch}/messages`, { body: 'Me too', parent_id: top.id, also_send: true })).status, 403);
  assert.equal((await thread()).replies.length, before, 'nothing half-sent');
  assert.equal((await ben('POST', `/api/chat/channels/${ch}/messages`, { body: 'Me too', parent_id: top.id })).status, 201);
});

test('saved to Drive as a document: a heading a day, who and when in bold, replies in a quote; a reply also sent counted once', async () => {
  const r = await ben('POST', `/api/chat/channels/${ch}/save-doc`, { tz: 'Europe/London' });
  assert.equal(r.status, 201);
  assert.equal(r.body.name, 'launch (chat)');
  const doc = (await ben('GET', `/api/files/${r.body.id}/content`)).body.content;
  const flat = (n) => (n.text || '') + (n.content || []).map(flat).join(n.type === 'blockquote' ? '|' : '');
  const blocks = doc.content.map((n) => `${n.type === 'heading' ? `H${n.attrs.level}` : n.type === 'blockquote' ? 'Q' : 'P'}:${flat(n)}`);
  assert.equal(blocks[0], 'H1:#launch');
  assert.match(blocks[1], /^P:Saved /);
  assert.match(blocks[2], /^H2:\w+day, \d+ \w+ \d{4}$/);
  assert.ok(doc.content.some((n) => n.type === 'paragraph' && n.content?.[0]?.marks?.[0]?.type === 'bold' && n.content[0].text === 'Ann Owner'));
  assert.ok(doc.content.some((n) => n.type === 'blockquote'), 'replies in a quote');
  const text = JSON.stringify(doc);
  assert.equal(text.split('Crisps').length - 1, 1, 'the reply also sent to the conversation: once');
  // In Drive, Ben's (not Ann's), in My Drive.
  assert.equal((await ann('GET', `/api/files/${r.body.id}`)).status, 404);
  const outsider = (await ben('POST', '/api/chat/channels', { name: 'empty-one' })).body.id;
  assert.equal((await ben('POST', `/api/chat/channels/${outsider}/save-doc`, {})).status, 400, 'nothing in it yet');
});

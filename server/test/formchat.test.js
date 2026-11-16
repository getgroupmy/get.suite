// Forms → Post each response in a Chat channel: the answers arrive as a message from "Forms"; only channels the
// person can write in, never direct messages; an archived channel just stops getting them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-formchat-'));
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

test('responses go to the chosen channel as a message from Forms', async () => {
  const olivia = client(), mia = client();
  assert.equal((await olivia('POST', '/api/auth/setup', { org_name: 'Acme', domain: 'acme.com', name: 'Olivia Owner', local: 'olivia', password: 'password123' })).status, 200);
  assert.equal((await olivia('POST', '/api/users', { local: 'mia', domain: 'acme.com', name: 'Mia Member', password: 'password123' })).status, 201);
  assert.equal((await mia('POST', '/api/auth/login', { username: 'mia@acme.com', password: 'password123' })).status, 200);
  const leads = (await olivia('POST', '/api/chat/channels', { name: 'leads' })).body;
  const secret = (await mia('POST', '/api/chat/channels', { name: 'mia-private', private: true })).body;
  const miaId = (await mia('GET', '/api/auth/me')).body.user.id;
  const dm = (await olivia('POST', '/api/chat/dm', { user_id: miaId })).body.id;
  const made = (await olivia('POST', '/api/forms', { title: 'Contact us' })).body;
  const f = (await olivia('PUT', `/api/forms/${made.id}`, { questions: [{ id: 'name', type: 'short', title: 'Your name', required: true }, { id: 'topic', type: 'choice', title: 'Topic', options: ['Sales', 'Support'] }] })).body;
  // Not a channel she can't see, nor a direct message.
  assert.equal((await olivia('PUT', `/api/forms/${f.id}`, { chat_channel: secret.id })).status, 404);
  const r = await olivia('PUT', `/api/forms/${f.id}`, { chat_channel: dm });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /not a direct message/);
  assert.equal((await olivia('PUT', `/api/forms/${f.id}`, { chat_channel: leads.id })).body.chat_channel, leads.id);
  assert.equal((await mia('POST', `/api/public/forms/${f.token}`, { answers: { name: 'Pat Lee', topic: 'Sales' } })).status, 201);
  const msgs = (await mia('GET', `/api/chat/channels/${leads.id}/messages`)).body;
  const list = Array.isArray(msgs) ? msgs : msgs.messages;
  const m = list.find((x) => x.bot === 'Forms');
  assert.ok(m, JSON.stringify(list));
  assert.match(m.body, /^New response to “Contact us” from Mia Member\nYour name: Pat Lee\nTopic: Sales\nAll responses: http:\/\/127\.0\.0\.1:\d+\/forms\/[\w-]+\?tab=responses$/);
  // Turned off: no more posts. Archived channel: the response still goes in, nothing is posted.
  assert.equal((await olivia('PUT', `/api/forms/${f.id}`, { chat_channel: null })).body.chat_channel, null);
  await mia('POST', `/api/public/forms/${f.token}`, { answers: { name: 'Sam' } });
  assert.equal(((await mia('GET', `/api/chat/channels/${leads.id}/messages`)).body.messages || (await mia('GET', `/api/chat/channels/${leads.id}/messages`)).body).filter((x) => x.bot === 'Forms').length, 1);
  await olivia('PUT', `/api/forms/${f.id}`, { chat_channel: leads.id });
  assert.equal((await olivia('PATCH', `/api/chat/channels/${leads.id}`, { archived: true })).status, 200);
  assert.equal((await mia('POST', `/api/public/forms/${f.token}`, { answers: { name: 'Kim' } })).status, 201);
  assert.equal((await olivia('GET', `/api/forms/${f.id}/responses`)).body.responses.length, 3);
});

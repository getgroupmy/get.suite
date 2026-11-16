// Someone who knows (or guesses) the id of another person's private thing can't read, change or delete it:
// a colleague it isn't shared with, and an admin of another company on the same server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-idor-'));
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

let owner, mia, eve;
const ids = {};
test('set up: an owner with private things; a colleague and another company’s admin', async () => {
  owner = client();
  assert.equal((await owner('POST', '/api/auth/setup', { org_name: 'Acme', domain: 'acme.com', name: 'Olivia Owner', local: 'olivia', password: 'password123' })).status, 200);
  assert.equal((await owner('POST', '/api/users', { local: 'mia', domain: 'acme.com', name: 'Mia Member', password: 'password123' })).status, 201);
  assert.equal((await owner('POST', '/api/orgs', { name: 'Evil Corp', domain: 'evil.com', admin_name: 'Eve Admin', admin_local: 'eve', admin_password: 'password123' })).status, 201);
  mia = client(); assert.equal((await mia('POST', '/api/auth/login', { username: 'mia@acme.com', password: 'password123' })).status, 200);
  eve = client(); assert.equal((await eve('POST', '/api/auth/login', { username: 'eve@evil.com', password: 'password123' })).status, 200);
  ids.doc = (await owner('POST', '/api/files/new', { kind: 'doc', name: 'Salaries', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'secret salaries' }] }] } })).body.id;
  ids.folder = (await owner('POST', '/api/files/folder', { name: 'HR' })).body.id;
  ids.note = (await owner('POST', '/api/notes', { title: 'Private note', body: 'secret note' })).body.id;
  ids.contact = (await owner('POST', '/api/contacts', { name: 'Secret Contact', email: 'secret@x.com' })).body.id;
  ids.event = (await owner('POST', '/api/events', { title: 'Secret meeting', start: Date.now() + 864e5, end: Date.now() + 864e5 + 36e5 })).body.id;
  const ls = (await owner('GET', '/api/tasks/lists')).body;
  ids.list = (Array.isArray(ls) ? ls : ls.lists)[0].id;
  ids.task = (await owner('POST', `/api/tasks/lists/${ids.list}/tasks`, { title: 'Secret task' })).body.id;
  ids.form = (await owner('POST', '/api/forms', { title: 'Secret form' })).body.id;
  ids.channel = (await owner('POST', '/api/chat/channels', { name: 'board', private: true })).body.id;
  await owner('POST', `/api/chat/channels/${ids.channel}/messages`, { body: 'secret board talk' });
  ids.comment = (await owner('POST', `/api/comments/${ids.doc}`, { body: 'secret comment', anchor: { quote: 'secret' } })).body.comment.id;
  for (const [k, v] of Object.entries(ids)) assert.ok(v, k);
});

const ATTEMPTS = () => [
  ['read a document', 'GET', `/api/files/${ids.doc}`], ['read its content', 'GET', `/api/files/${ids.doc}/content`], ['read its text', 'GET', `/api/files/${ids.doc}/text`],
  ['rename it', 'PATCH', `/api/files/${ids.doc}`, { name: 'pwned' }], ['overwrite it', 'PUT', `/api/files/${ids.doc}/content`, { content: { type: 'doc', content: [] } }],
  ['share it with themselves', 'PUT', `/api/files/${ids.doc}/shares`, { shares: [] }], ['copy it', 'POST', `/api/files/${ids.doc}/copy`, {}], ['delete it', 'DELETE', `/api/files/${ids.doc}`],
  ['list its versions', 'GET', `/api/files/${ids.doc}/versions`], ['read its comments', 'GET', `/api/comments/${ids.doc}`],
  ['comment on it', 'POST', `/api/comments/${ids.doc}`, { body: 'x', anchor: { quote: 'secret' } }],
  ['edit a comment', 'PATCH', `/api/comments/${ids.doc}/${ids.comment}`, { body: 'pwned' }],
  ['list a folder', 'GET', `/api/files?parent=${ids.folder}`], ['put a file in a folder', 'POST', '/api/files/new', { kind: 'doc', name: 'x', parent_id: ids.folder }],
  ['change a note', 'PATCH', `/api/notes/${ids.note}`, { title: 'pwned' }], ['delete a note', 'DELETE', `/api/notes/${ids.note}`],
  ['change a contact', 'PATCH', `/api/contacts/${ids.contact}`, { name: 'pwned' }], ['delete a contact', 'DELETE', `/api/contacts/${ids.contact}`],
  ['change an event', 'PATCH', `/api/events/${ids.event}`, { title: 'pwned' }], ['delete an event', 'DELETE', `/api/events/${ids.event}`],
  ['read a task list', 'GET', `/api/tasks/lists/${ids.list}/tasks`], ['add to a task list', 'POST', `/api/tasks/lists/${ids.list}/tasks`, { title: 'x' }],
  ['rename a task list', 'PATCH', `/api/tasks/lists/${ids.list}`, { name: 'pwned' }], ['change a task', 'PATCH', `/api/tasks/tasks/${ids.task}`, { title: 'pwned' }],
  ['delete a task', 'DELETE', `/api/tasks/tasks/${ids.task}`],
  ['read a form', 'GET', `/api/forms/${ids.form}`], ['change a form', 'PUT', `/api/forms/${ids.form}`, { title: 'pwned' }], ['read its responses', 'GET', `/api/forms/${ids.form}/responses`], ['delete a form', 'DELETE', `/api/forms/${ids.form}`],
  ['read a private channel', 'GET', `/api/chat/channels/${ids.channel}/messages`], ['post in it', 'POST', `/api/chat/channels/${ids.channel}/messages`, { body: 'x' }],
];

for (const [who, name] of [['mia', 'a colleague it isn’t shared with'], ['eve', 'another company’s admin']]) {
  test(`${name} can’t read, change or delete any of it by its id`, async () => {
    const as = who === 'mia' ? mia : eve;
    const let_through = [];
    for (const [what, method, url, body] of ATTEMPTS()) {
      const r = await as(method, url, body);
      if (r.status < 400 || ![401, 403, 404].includes(r.status) || /secret/.test(JSON.stringify(r.body))) let_through.push(`${what}: ${method} ${url} → ${r.status} ${JSON.stringify(r.body).slice(0, 100)}`);
    }
    assert.deepEqual(let_through, []);
  });
}

for (const [who, name] of [['mia', 'a colleague'], ['eve', 'another company’s admin']]) {
  test(`searching doesn’t find them for ${name}`, async () => {
    const as = who === 'mia' ? mia : eve;
    const found = [];
    for (const url of ['/api/files?view=search&q=secret', '/api/files?view=search&q=Salaries', '/api/chat/search?q=secret', '/api/notes?q=secret', '/api/events/search?q=Secret', '/api/tasks/search?q=Secret', '/api/contacts', '/api/forms', '/api/comments/search?q=secret']) {
      const r = await as('GET', url);
      if (/secret|Salaries/i.test(JSON.stringify(r.body))) found.push(`${url} → ${JSON.stringify(r.body).slice(0, 120)}`);
    }
    assert.deepEqual(found, []);
  });
}
test('(the owner’s own searches do find them: the searches work)', async () => {
  assert.match(JSON.stringify((await owner('GET', '/api/files?view=search&q=Salaries')).body), /Salaries/);
  assert.match(JSON.stringify((await owner('GET', '/api/chat/search?q=secret')).body), /secret board talk/);
});

test('…and everything is as it was', async () => {
  assert.equal((await owner('GET', `/api/files/${ids.doc}`)).body.name, 'Salaries');
  assert.match(JSON.stringify((await owner('GET', `/api/files/${ids.doc}/content`)).body), /secret salaries/);
  assert.equal((await owner('GET', '/api/notes')).body.find((n) => n.id === ids.note)?.title, 'Private note');
  assert.equal((await owner('GET', '/api/contacts')).body.find((c) => c.id === ids.contact)?.name, 'Secret Contact');
  assert.equal((await owner('GET', `/api/forms/${ids.form}`)).body.title, 'Secret form');
  assert.equal((await owner('GET', `/api/files?parent=${ids.folder}`)).body.length, 0);
  assert.match(JSON.stringify((await owner('GET', `/api/comments/${ids.doc}`)).body), /secret comment/);
});

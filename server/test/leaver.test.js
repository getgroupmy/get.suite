// Deleting someone's account doesn't take their colleagues' shared work with it: a shared task list, a form
// with co-editors and a shared note go to the colleague given their files, or else to someone they were shared
// with. What nobody else had goes with the account.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-leaver-'));
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
  let cookie = '';
  return async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json', ...(cookie && { cookie }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}
const admin = client();
const people = {};
const signIn = async (local) => { const c = client(); assert.equal((await c('POST', '/api/auth/login', { username: `${local}@acme.com`, password: 'password123' })).status, 200); return c; };

// Someone's work: a list shared with Carol (with a task of hers), a private list, a form Carol co-edits (with
// a response), a private form, a note shared with Carol, a private note.
async function workOf(local) {
  const me = await signIn(local);
  const shared = (await me('POST', '/api/tasks/lists', { name: `${local} team list` })).body;
  assert.equal((await me('PUT', `/api/tasks/lists/${shared.id}/members`, { user_ids: [people.carol.id] })).status, 200);
  assert.equal((await people.carol.c('POST', `/api/tasks/lists/${shared.id}/tasks`, { title: 'Carol’s task' })).status, 201);
  const own = (await me('POST', '/api/tasks/lists', { name: `${local} private list` })).body;
  const form = (await me('POST', '/api/forms', { title: `${local} survey` })).body;
  assert.equal((await me('POST', `/api/forms/${form.id}/editors`, { email: 'carol@acme.com' })).status < 300, true);
  const solo = (await me('POST', '/api/forms', { title: `${local} private form` })).body;
  const note = (await me('POST', '/api/notes', { title: `${local} shared note` })).body;
  assert.equal((await me('PUT', `/api/notes/${note.id}/shares`, { user_ids: [people.carol.id] })).status, 200);
  const mine = (await me('POST', '/api/notes', { title: `${local} private note` })).body;
  const cal = (await me('POST', '/api/events/calendars', { name: `${local} team calendar` })).body;
  assert.equal((await me('PUT', `/api/events/calendars/${cal.id}/members`, { members: [{ id: people.carol.id, can_edit: true }] })).status, 200);
  const day = 864e5, t = Date.now();
  for (const [title, at] of [[`${local} past offsite`, t - 30 * day], [`${local} next offsite`, t + 30 * day]]) {
    const r = await me('POST', '/api/events', { title, start: at, end: at + 3600e3, calendar_id: cal.id });
    assert.ok(r.status < 300, JSON.stringify(r.body));
  }
  const supplier = (await me('POST', '/api/contacts', { name: `${local} supplier`, shared: true })).body;
  return { shared, own, form, solo, note, mine, cal, supplier };
}
const lists = async (c) => ((await c('GET', '/api/tasks/lists')).body.lists || (await c('GET', '/api/tasks/lists')).body).map((l) => l.name);
const forms = async (c) => { const b = (await c('GET', '/api/forms')).body; return (b.forms || b).map((f) => f.title); };
const calendarEvents = async (c) => { const t = Date.now(); return ((await c('GET', `/api/events?from=${t - 60 * 864e5}&to=${t + 60 * 864e5}`)).body || []).map((e) => e.title); };
const contacts = async (c) => (await c('GET', '/api/contacts')).body.map((x) => x.name);
const notes = async (c) => { const b = (await c('GET', '/api/notes')).body; return (b.notes || b).map((n) => n.title); };

test('setup: a company with Bob, Carol and Dan', async () => {
  assert.equal((await admin('POST', '/api/auth/setup', { org_name: 'Acme', domain: 'acme.com', name: 'Olivia Owner', local: 'olivia', password: 'password123' })).status, 200);
  for (const [local, name] of [['bob', 'Bob B'], ['carol', 'Carol C'], ['dan', 'Dan D'], ['eve', 'Eve E']]) {
    const r = await admin('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    people[local] = { id: r.body.id };
  }
  people.carol.c = await signIn('carol');
  people.dan.c = await signIn('dan');
});

test('deleted with nobody given their files: what they shared goes to Carol, the rest goes', async () => {
  const w = await workOf('bob');
  const r = await admin('DELETE', `/api/users/${people.bob.id}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.handed_over, { lists: 1, forms: 1, notes: 1, calendars: 1, contacts: 1 });
  const evs = await calendarEvents(people.carol.c);
  for (const n of ['bob past offsite', 'bob next offsite']) assert.ok(evs.includes(n), `${n} on Carol's calendar (${evs})`);
  assert.ok((await contacts(admin)).includes('bob supplier'), 'the company contact, now kept by the admin');
  assert.ok((await people.carol.c('GET', '/api/contacts?scope=company')).body.some((x) => x.name === 'bob supplier'), 'and still seen by everyone');
  const c = people.carol.c;
  assert.ok((await lists(c)).includes('bob team list'));
  const tasks = (await c('GET', `/api/tasks/lists/${w.shared.id}/tasks`)).body;
  assert.ok(JSON.stringify(tasks).includes('Carol’s task'), 'her task is still there');
  assert.ok((await forms(c)).includes('bob survey'));
  assert.ok((await notes(c)).includes('bob shared note'));
  // Carol owns them now: she can share them on
  assert.equal((await c('PUT', `/api/tasks/lists/${w.shared.id}/members`, { user_ids: [people.dan.id] })).status, 200);
  // the private ones went with the account
  const { q } = await import('../src/db.js');
  for (const [t, id] of [['task_lists', w.own.id], ['forms', w.solo.id], ['notes', w.mine.id]]) assert.equal(q(`SELECT 1 FROM ${t} WHERE id = ?`).get(id), undefined, `${t} private`);
});

test('deleted with their files given to Dan: Dan gets all of it, Carol keeps her access', async () => {
  const w = await workOf('eve');
  const r = await admin('DELETE', `/api/users/${people.eve.id}?transfer_to=${people.dan.id}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.handed_over, { lists: 2, forms: 2, notes: 2, calendars: 1, contacts: 1 });
  for (const n of ['eve past offsite', 'eve next offsite']) assert.ok((await calendarEvents(people.carol.c)).includes(n), `${n} still on Carol's calendar`);
  for (const n of ['eve past offsite', 'eve next offsite']) assert.ok((await calendarEvents(people.dan.c)).includes(n), `${n} on Dan's`);
  const sup = (await people.dan.c('GET', '/api/contacts')).body.find((x) => x.name === 'eve supplier');
  assert.equal(sup?.owner_id, people.dan.id, 'the company contact is Dan’s');
  const d = people.dan.c, c = people.carol.c;
  for (const n of ['eve team list', 'eve private list']) assert.ok((await lists(d)).includes(n), n);
  for (const n of ['eve survey', 'eve private form']) assert.ok((await forms(d)).includes(n), n);
  for (const n of ['eve shared note', 'eve private note']) assert.ok((await notes(d)).includes(n), n);
  assert.ok((await lists(c)).includes('eve team list'), 'Carol still on the list');
  assert.ok((await forms(c)).includes('eve survey'), 'Carol still edits the form');
  assert.ok((await notes(c)).includes('eve shared note'), 'Carol still has the note');
  void w;
});

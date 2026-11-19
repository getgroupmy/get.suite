// Download your data, then bring that .zip back in (another account, another server): events, contacts,
// task lists and notes come back with what they had; so do mail labels, filters that label mail, and the
// vacation reply.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-takeoutrt-'));
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
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json', ...(cookie && { cookie }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  call.cookie = () => cookie;
  return call;
}
const olivia = client(), kim = client();
test('the whole round trip', async () => {
  assert.equal((await olivia('POST', '/api/auth/setup', { org_name: 'Acme', domain: 'acme.com', name: 'Olivia Owner', local: 'olivia', password: 'password123' })).status, 200);
  await olivia('POST', '/api/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  assert.equal((await kim('POST', '/api/auth/login', { username: 'kim@acme.com', password: 'password123' })).status, 200);
  const start = Date.UTC(2026, 11, 2, 2, 0);
  await olivia('POST', '/api/events', { title: 'Board review', location: 'Room 4', start, end: start + 3600e3, tz: 'Asia/Kuala_Lumpur', rrule: { freq: 'monthly', nths: [1, 3], wd: 3 }, color: '#d50000', show_as: 'free', private: true });
  await olivia('POST', '/api/contacts', { name: 'Grace Hopper', email: 'grace@navy.example', custom_fields: [{ label: 'Badge', value: 'B-42' }], dates: [{ label: 'Anniversary', date: '1930-06-15' }] });
  const list = (await olivia('POST', '/api/tasks/lists', { name: 'Routines' })).body;
  const t = (await olivia('POST', `/api/tasks/lists/${list.id}/tasks`, { title: 'Team report', due: '2026-12-07' })).body;
  await olivia('PATCH', `/api/tasks/tasks/${t.id}`, { repeat: 'monthweek:1,3:1', repeat_until: '2027-06-30', priority: 'high' });
  const n = (await olivia('POST', '/api/notes', { title: 'Shopping', items: [{ text: 'Milk', done: true }], color: '#fff8b8', pinned: true, labels: ['home'] })).body;
  await olivia('PATCH', `/api/notes/${n.id}`, { remind_at: Date.now() + 5 * 864e5, remind_repeat: 'weekly' });

  const zip = Buffer.from(await (await fetch(`${base}/api/takeout`, { headers: { 'x-requested-with': 'nas-workspace', cookie: olivia.cookie() } })).arrayBuffer());
  const r = await fetch(`${base}/api/takeout/restore`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', cookie: kim.cookie(), 'content-type': 'application/zip' }, body: zip });
  assert.ok(r.status < 300, await r.text());

  const ev = async (c) => (await c('GET', `/api/events?from=${start - 864e5}&to=${start + 90 * 864e5}`)).body.find((e) => e.title === 'Board review');
  const pickEv = (e) => [e.location, e.tz, JSON.stringify(e.rrule), e.show_as, !!e.private, e.color];
  assert.deepEqual(pickEv(await ev(kim)), pickEv(await ev(olivia)), 'the event');
  const ct = async (c) => (await c('GET', '/api/contacts')).body.find((x) => x.name === 'Grace Hopper');
  const pickCt = (x) => [x.email, JSON.stringify(x.custom_fields), JSON.stringify(x.dates)];
  assert.deepEqual(pickCt(await ct(kim)), pickCt(await ct(olivia)), 'the contact');
  const task = async (c) => { const ls = (await c('GET', '/api/tasks/lists')).body; const l = (ls.lists || ls).find((x) => x.name.startsWith('Routines')); const ts = (await c('GET', `/api/tasks/lists/${l.id}/tasks`)).body; return (ts.tasks || ts)[0]; };
  const pickT = (x) => [x.title, x.due, x.repeat, x.repeat_until, x.priority];
  assert.deepEqual(pickT(await task(kim)), pickT(await task(olivia)), 'the task');
  const note = async (c) => { const all = (await c('GET', '/api/notes')).body; return (all.notes || all).find((x) => x.title === 'Shopping'); };
  const pickN = (x) => [JSON.stringify(x.items.map((i) => [i.text, i.done])), JSON.stringify(x.labels), x.color, !!x.pinned, x.remind_at, x.remind_repeat];
  assert.deepEqual(pickN(await note(kim)), pickN(await note(olivia)), 'the note');
});

test('mail labels, a filter that labels mail, and the vacation reply come back too', async () => {
  const { q } = await import('../src/db.js');
  const me = (await olivia('GET', '/api/auth/me')).body.user;
  const kimId = (await kim('GET', '/api/auth/me')).body.user.id;
  q('INSERT INTO mail_labels (id, user_id, name, color, keyword, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('lab-clients-1', me.id, 'Clients', '#188038', 'nwl_labclients1', Date.now());
  const rule = { id: 'r1', name: 'Client mail', enabled: true, match: 'all', conditions: [{ field: 'from', op: 'contains', value: '@client.example' }], actions: { label: 'lab-clients-1' } };
  q('INSERT INTO mail_rules (user_id, rules, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET rules = excluded.rules').run(me.id, JSON.stringify([rule]), Date.now());
  q(`INSERT INTO vacations (user_id, enabled, subject, body, start_date, end_date, updated_at) VALUES (?, 1, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET enabled = 1, subject = excluded.subject, body = excluded.body, start_date = excluded.start_date, end_date = excluded.end_date`)
    .run(me.id, 'Away until Monday', 'I’m away; back on Monday.\nUrgent: ring the office.', '2030-01-01', '2030-01-10', Date.now());
  const zip = Buffer.from(await (await fetch(`${base}/api/takeout`, { headers: { 'x-requested-with': 'nas-workspace', cookie: olivia.cookie() } })).arrayBuffer());
  const r = await fetch(`${base}/api/takeout/restore`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', cookie: kim.cookie(), 'content-type': 'application/zip' }, body: zip });
  assert.ok(r.status < 300, await r.text());
  const label = q('SELECT id, name, color FROM mail_labels WHERE user_id = ? AND name = ?').get(kimId, 'Clients');
  assert.deepEqual([label?.name, label?.color], ['Clients', '#188038']);
  const kimRules = JSON.parse(q('SELECT rules FROM mail_rules WHERE user_id = ?').get(kimId)?.rules || '[]');
  const theirs = kimRules.find((x) => x.name === 'Client mail');
  assert.equal(theirs?.actions?.label, label.id, 'the filter labels mail with Kim’s own Clients label');
  const v = q('SELECT enabled, subject, body, start_date, end_date FROM vacations WHERE user_id = ?').get(kimId);
  assert.deepEqual({ ...v }, { enabled: 1, subject: 'Away until Monday', body: 'I’m away; back on Monday.\nUrgent: ring the office.', start_date: '2030-01-01', end_date: '2030-01-10' });
});

test('contact groups come back, with who is in each; a name already used isn’t doubled', async () => {
  const members = [{ name: 'Ann Lee', email: 'ann@x.example' }, { name: 'Bo Chan', email: 'bo@y.example' }];
  assert.ok((await olivia('POST', '/api/contacts/groups', { name: 'Suppliers', members })).status < 300);
  const zip = Buffer.from(await (await fetch(`${base}/api/takeout`, { headers: { 'x-requested-with': 'nas-workspace', cookie: olivia.cookie() } })).arrayBuffer());
  for (let i = 0; i < 2; i++) {
    const r = await fetch(`${base}/api/takeout/restore`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', cookie: kim.cookie(), 'content-type': 'application/zip' }, body: zip });
    assert.ok(r.status < 300, await r.text());
  }
  const groups = (await kim('GET', '/api/contacts/groups')).body.filter((g) => g.name === 'Suppliers');
  assert.equal(groups.length, 1, 'once, even brought in twice');
  assert.deepEqual(groups[0].members.map((m) => [m.name, m.email]), members.map((m) => [m.name, m.email]));
});

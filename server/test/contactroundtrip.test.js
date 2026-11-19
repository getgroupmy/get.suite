// Out and back in: a contact with everything filled in (vCard), an event (.ics) and notes (Markdown) are
// the same after Export and Import.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-contactrt-'));
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
test('a full contact through Export and Import', async () => {
  assert.equal((await olivia('POST', '/api/auth/setup', { org_name: 'Acme', domain: 'acme.com', name: 'Olivia Owner', local: 'olivia', password: 'password123' })).status, 200);
  await olivia('POST', '/api/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  assert.equal((await kim('POST', '/api/auth/login', { username: 'kim@acme.com', password: 'password123' })).status, 200);
  const full = { name: 'Grace Hopper', email: 'grace@navy.example', phone: '+1 555 0100', company: 'Navy', title: 'Rear Admiral', website: 'https://navy.example',
    address: '1 Pentagon\nArlington', notes: 'Met at the conference; likes “quotes”, commas', birthday: '1906-12-09',
    more_emails: [{ type: 'home', value: 'grace@home.example' }], more_phones: [{ type: 'work', value: '+1 555 0199' }],
    dates: [{ label: 'Anniversary', date: '1930-06-15' }], custom_fields: [{ label: 'Badge', value: 'B-42' }] };
  const made = (await olivia('POST', '/api/contacts', full)).body;
  assert.ok(made.id, JSON.stringify(made));
  const vcf = await (await fetch(`${base}/api/contacts/export`, { headers: { 'x-requested-with': 'nas-workspace', cookie: olivia.cookie() } })).text();
  const imp = await fetch(`${base}/api/contacts/import`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', cookie: kim.cookie(), 'content-type': 'text/vcard' }, body: vcf });
  assert.ok(imp.status < 300, await imp.text());
  const mine = (await olivia('GET', '/api/contacts')).body.find((c) => c.id === made.id);
  const theirs = (await kim('GET', '/api/contacts')).body.find((c) => c.name === 'Grace Hopper');
  const keys = ['name', 'email', 'phone', 'company', 'title', 'website', 'address', 'notes', 'birthday', 'more_emails', 'more_phones', 'dates', 'custom_fields'];
  const diff = keys.filter((k) => JSON.stringify(mine[k] ?? null) !== JSON.stringify(theirs?.[k] ?? null)).map((k) => `${k}: ${JSON.stringify(mine[k])} → ${JSON.stringify(theirs?.[k])}`);
  assert.deepEqual(diff, []);
});

test('a full event through Export and Import', async () => {
  const start = Date.UTC(2026, 11, 3, 2, 0);
  const made = (await olivia('POST', '/api/events', { title: 'Board review', location: 'Room 4', description: 'Quarterly numbers, “draft”; bring laptops', start, end: start + 5400e3,
    tz: 'Asia/Kuala_Lumpur', rrule: { freq: 'weekly', byday: [3, 5], count: 6 }, color: '#d50000', reminders: [{ minutes: 30, method: 'popup' }], show_as: 'free', private: true })).body;
  assert.ok(made.id, JSON.stringify(made));
  const ics = await (await fetch(`${base}/api/events/export`, { headers: { 'x-requested-with': 'nas-workspace', cookie: olivia.cookie() } })).text();
  const imp = await fetch(`${base}/api/events/import`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', cookie: kim.cookie(), 'content-type': 'text/calendar' }, body: ics });
  assert.ok(imp.status < 300, await imp.text());
  const get = async (c) => (await c('GET', `/api/events?from=${start - 864e5}&to=${start + 60 * 864e5}`)).body.find((e) => e.title === 'Board review');
  const mine = await get(olivia), theirs = await get(kim);
  assert.ok(theirs, 'imported');
  const keys = ['title', 'location', 'description', 'all_day', 'tz', 'rrule', 'exdates', 'show_as', 'private', 'color'];
  const diff = keys.filter((k) => JSON.stringify(mine[k] ?? null) !== JSON.stringify(theirs[k] ?? null)).map((k) => `${k}: ${JSON.stringify(mine[k])} → ${JSON.stringify(theirs[k])}`);
  assert.deepEqual(diff, []);
  // The same occurrences (the file starts the series on its first one: a Thursday start, repeating Wed and Fri, is Friday the 4th).
  const { expand } = await import('../src/calmath.js');
  const days = (e) => expand(e, start - 864e5, start + 60 * 864e5).map((o) => [o.start, o.end]);
  assert.deepEqual(days(theirs), days(mine));
});

test('notes through Download (.md) and Import notes: text, checklist, labels, colour, pinned, archived', async () => {
  const a = (await olivia('POST', '/api/notes', { title: 'Shopping', items: [{ text: 'Milk', done: true }, { text: 'Eggs', done: false }], color: '#fff8b8', pinned: true, labels: ['home'] })).body;
  const b = (await olivia('POST', '/api/notes', { title: 'Old idea', body: 'Line one\nLine two' })).body;
  await olivia('PATCH', `/api/notes/${b.id}`, { archived: true, color: '#d4e4ed' });
  const files = [];
  for (const n of [a, b]) files.push({ name: `${n.title}.md`, text: await (await fetch(`${base}/api/notes/${n.id}/export.md`, { headers: { 'x-requested-with': 'nas-workspace', cookie: olivia.cookie() } })).text() });
  assert.match(files[0].text, /^---\ncolor: "#fff8b8"\npinned: true\n---\n/);
  const imp = await kim('POST', '/api/notes/import', { files });
  assert.ok(imp.status < 300, JSON.stringify(imp.body));
  const pick = (n) => [n.title, n.body || '', (n.items || []).map((i) => [i.text, i.done]), n.labels, n.color, !!n.pinned, !!n.archived];
  const list = async (c) => { const r = (await c('GET', '/api/notes?archived=all')).body; const all = r.notes || r; const arch = (await c('GET', '/api/notes?archived=1')).body; return [...all, ...((arch.notes || arch) || [])]; };
  const find = async (c, title) => (await list(c)).find((n) => n.title === title);
  for (const t of ['Shopping', 'Old idea']) assert.deepEqual(pick(await find(kim, t)), pick(await find(olivia, t)), t);
});

test('a note’s reminder (to come, repeating) through Download (.md) and Import notes; one gone by is left out', async () => {
  const soon = Date.now() + 3 * 864e5;
  const n = (await olivia('POST', '/api/notes', { title: 'Water the plants', body: 'All of them' })).body;
  const r = await olivia('PATCH', `/api/notes/${n.id}`, { remind_at: soon, remind_repeat: 'weekly', remind_tz: 'Europe/London' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const text = await (await fetch(`${base}/api/notes/${n.id}/export.md`, { headers: { 'x-requested-with': 'nas-workspace', cookie: olivia.cookie() } })).text();
  assert.match(text, /reminder: \d{4}-.*\nreminder_repeat: weekly\nreminder_zone: Europe\/London/);
  const old = text.replace(/reminder: [^\n]+/, 'reminder: 2020-01-01T09:00:00.000Z').replace('Water the plants', 'Old reminder');
  assert.ok((await kim('POST', '/api/notes/import', { files: [{ name: 'a.md', text }, { name: 'b.md', text: old }] })).status < 300);
  const all = (await kim('GET', '/api/notes')).body;
  const got = (all.notes || all).find((x) => x.title === 'Water the plants');
  assert.deepEqual([got.remind_at, got.remind_repeat], [r.body.remind_at ?? soon, 'weekly']);
  assert.equal((all.notes || all).find((x) => x.title === 'Old reminder').remind_at, null, 'a reminder that has gone by isn’t brought back');
});

test('a repeating event with one occurrence moved and one cancelled, through Export and Import', async () => {
  const start = Date.UTC(2027, 0, 4, 9, 0); // Mondays from 4 January 2027
  const ev = (await olivia('POST', '/api/events', { title: 'Weekly sync', start, end: start + 1800e3, tz: 'UTC', rrule: { freq: 'weekly', byday: [1], count: 5 } })).body;
  const wk = 7 * 864e5;
  // the 2nd one an hour later, on its own; the 3rd cancelled
  const moved = await olivia('POST', '/api/events', { title: 'Weekly sync', start: start + wk + 3600e3, end: start + wk + 5400e3, tz: 'UTC', recurrence_of: { id: ev.id, occurrence: start + wk } });
  assert.ok(moved.status < 300, JSON.stringify(moved.body));
  assert.equal((await olivia('PATCH', `/api/events/${ev.id}`, { exdates: [start + wk, start + 2 * wk] })).status, 200);
  const days = async (c) => {
    const list = (await c('GET', `/api/events?from=${start - 864e5}&to=${start + 6 * wk}`)).body.filter((e) => e.title === 'Weekly sync');
    const { expand } = await import('../src/calmath.js');
    return list.flatMap((e) => expand(e, start - 864e5, start + 6 * wk)).map((o) => new Date(o.start).toISOString().slice(0, 16)).sort();
  };
  const before = await days(olivia);
  assert.deepEqual(before, ['2027-01-04T09:00', '2027-01-11T10:00', '2027-01-25T09:00', '2027-02-01T09:00']);
  const ics = await (await fetch(`${base}/api/events/export`, { headers: { 'x-requested-with': 'nas-workspace', cookie: olivia.cookie() } })).text();
  assert.match(ics, /RECURRENCE-ID/);
  const imp = await fetch(`${base}/api/events/import`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', cookie: kim.cookie(), 'content-type': 'text/calendar' }, body: ics });
  assert.ok(imp.status < 300);
  assert.deepEqual(await days(kim), before);
});

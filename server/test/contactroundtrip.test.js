// Out and back in: a contact with everything filled in (vCard), and an event (.ics), are the same after
// Export and Import.
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

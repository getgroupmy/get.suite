// A phone changing something made on the web (its contact or calendar app sends the whole card or event
// back): what the phone doesn't know about is kept: a contact's custom fields, dates, extra numbers and
// reminder to keep in touch; an event's colour, guests, reminders, attachments, video meeting and the like.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-davkeep-'));
process.env.DATA_DIR = dir;
const { createApp } = await import('../src/app.js');

let server, base, me;
before(async () => {
  server = http.createServer(createApp());
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  const j = (url, body, cookie) => fetch(base + url, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json', ...(cookie && { cookie }) }, body: JSON.stringify(body) });
  const setup = await j('/api/auth/setup', { org_name: 'Acme', domain: 'acme.com', name: 'Pat Phone', local: 'pat', password: 'password123' });
  const cookie = setup.headers.get('set-cookie').split(';')[0];
  me = (await setup.json()).user;
  await (await j('/api/users', { local: 'kim', domain: 'acme.com', name: 'Kim', password: 'password123' }, cookie)).json();
  web.cookie = cookie;
});
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const web = { cookie: '' };
const api = async (method, url, body) => {
  const r = await fetch(base + url, { method, headers: { 'x-requested-with': 'nas-workspace', cookie: web.cookie, ...(body && { 'content-type': 'application/json' }) }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const basic = (u, p) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;
async function dav(method, url, { body, depth, auth = basic('pat@acme.com', 'password123'), headers = {} } = {}) {
  const r = await fetch(base + url, { method, redirect: 'manual', headers: { ...(auth && { authorization: auth }), ...(depth !== undefined && { depth: String(depth) }), ...(body && { 'content-type': 'application/xml; charset=utf-8' }), ...headers }, body });
  return { status: r.status, headers: r.headers, text: await r.text() };
}
const propfind = (props) => `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/"><d:prop>${props}</d:prop></d:propfind>`;
const skip = (o, keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

test('a contact made on the web, renamed on a phone: everything else kept', async () => {
  const made = (await api('POST', '/api/contacts', {
    name: 'Grace Hopper', email: 'grace@navy.example', phone: '+1 555 0100', company: 'Navy', title: 'Rear Admiral', website: 'https://navy.example',
    address: '1 Pentagon', notes: 'Met at the conference', birthday: '1906-12-09',
    more_emails: [{ type: 'home', value: 'grace@home.example' }], more_phones: [{ type: 'work', value: '+1 555 0199' }],
    dates: [{ label: 'Anniversary', date: '1930-06-15' }], custom_fields: [{ label: 'Badge', value: 'B-42' }],
  })).body;
  await api('PATCH', `/api/contacts/${made.id}`, { touch_days: 30 });
  const before = (await api('GET', '/api/contacts')).body.find((x) => x.id === made.id);
  const book = `/dav/addressbooks/${me.id}/default/`;
  const card = (await dav('GET', `${book}${made.id}.vcf`)).text;
  assert.match(card, /FN:Grace Hopper/);
  const changed = card.replace(/^FN:.*$/m, 'FN:Grace B. Hopper').replace(/^N:.*$/m, 'N:Hopper;Grace;B.;;');
  const put = await dav('PUT', `${book}${made.id}.vcf`, { body: changed, headers: { 'content-type': 'text/vcard' } });
  assert.ok(put.status < 300, `PUT: ${put.status}`);
  const after = (await api('GET', '/api/contacts')).body.find((x) => x.id === made.id);
  assert.equal(after.name, 'Grace B. Hopper');
  const volatile = ['name', 'updated_at', 'etag', 'vcard_extra', 'dav_name', 'vcard_uid', 'sync_at'];
  assert.deepEqual(skip(after, volatile), skip(before, volatile));
});

test('an event made on the web, retitled on a phone: everything else kept', async () => {
  const start = Date.UTC(2026, 11, 3, 2, 0), end = start + 3600e3;
  const file = (await api('POST', '/api/files/new', { kind: 'doc', name: 'Agenda' })).body;
  const made = (await api('POST', '/api/events', {
    title: 'Board review', location: 'Room 4', description: 'Quarterly numbers', color: '#d50000', start, end,
    guests: ['kim@acme.com'], reminders: [{ minutes: 30, method: 'popup' }], private: true, show_as: 'free', tz: 'Asia/Kuala_Lumpur', attachments: [file.id],
  })).body;
  assert.ok(made.id, JSON.stringify(made));
  const list = async () => (await api('GET', `/api/events?from=${start - 864e5}&to=${end + 864e5}`)).body.find((x) => x.id === made.id);
  const before = await list();
  assert.equal(before.attachments?.length, 1, 'the attachment is on it');
  const cal = `/dav/calendars/${me.id}/default/`;
  const pf = await dav('PROPFIND', cal, { depth: 1, body: propfind('<d:getetag/>') });
  const all = [...pf.text.matchAll(/<d:href>([^<]+\.ics)<\/d:href>/g)].map((m) => m[1]);
  let ics = null, at = null;
  for (const h of all) { const t = (await dav('GET', h)).text; if (t.includes('SUMMARY:Board review')) { ics = t; at = h; break; } }
  assert.ok(ics, 'the event on the phone');
  const put = await dav('PUT', at, { body: ics.replace(/^SUMMARY:.*$/m, 'SUMMARY:Board review (moved online)'), headers: { 'content-type': 'text/calendar' } });
  assert.ok(put.status < 300, `PUT: ${put.status}`);
  const after = await list();
  assert.equal(after.title, 'Board review (moved online)');
  const volatile = ['title', 'updated_at', 'etag', 'dav_name', 'ical_uid', 'sequence', 'ics_extra', 'dtstamp'];
  assert.deepEqual(skip(after, volatile), skip(before, volatile));
});

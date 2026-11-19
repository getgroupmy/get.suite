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

test('a phone’s “fifth Monday of the month” repeats here too, and goes back the same', async () => {
  const cal = `/dav/calendars/${me.id}/default/`;
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Apple Inc.//iOS 18.0//EN', 'BEGIN:VEVENT', 'UID:FIFTH-MONDAY-1',
    'DTSTART;TZID=Europe/London:20261130T100000', 'DTEND;TZID=Europe/London:20261130T110000', 'SUMMARY:Fifth Monday social',
    'RRULE:FREQ=MONTHLY;BYDAY=5MO', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  assert.equal((await dav('PUT', `${cal}FIFTH-MONDAY-1.ics`, { body: ics, headers: { 'content-type': 'text/calendar' } })).status, 201);
  const ev = (await api('GET', `/api/events?from=${Date.UTC(2026, 10, 1)}&to=${Date.UTC(2027, 5, 30)}`)).body.find((e) => e.title === 'Fifth Monday social');
  assert.deepEqual([ev.rrule.freq, ev.rrule.nth, ev.rrule.wd], ['monthly', 5, 1], 'a repeating event, not a one-off');
  const { expand } = await import('../src/calmath.js');
  const days = expand(ev, Date.UTC(2026, 10, 1), Date.UTC(2027, 5, 30)).map((o) => new Date(o.start).toISOString().slice(0, 10));
  assert.deepEqual(days, ['2026-11-30', '2027-03-29', '2027-05-31']);
  const back = (await dav('GET', `${cal}FIFTH-MONDAY-1.ics`)).text;
  assert.match(back, /RRULE:FREQ=MONTHLY;BYDAY=5MO/);
});

test('“every Monday and Wednesday of the month” from a phone: those days every week, on both sides', async () => {
  const cal = `/dav/calendars/${me.id}/default/`;
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Google Inc//Google Calendar 70.9054//EN', 'BEGIN:VEVENT', 'UID:MON-WED-MONTH-1',
    'DTSTART;TZID=Europe/London:20261102T090000', 'DTEND;TZID=Europe/London:20261102T093000', 'SUMMARY:Stand-up',
    'RRULE:FREQ=MONTHLY;BYDAY=MO,WE;COUNT=6', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  assert.equal((await dav('PUT', `${cal}MON-WED-MONTH-1.ics`, { body: ics, headers: { 'content-type': 'text/calendar' } })).status, 201);
  const ev = (await api('GET', `/api/events?from=${Date.UTC(2026, 10, 1)}&to=${Date.UTC(2026, 11, 31)}`)).body.find((e) => e.title === 'Stand-up');
  assert.ok(ev.rrule, 'a repeat, not a one-off');
  const { expand } = await import('../src/calmath.js');
  const days = expand(ev, Date.UTC(2026, 10, 1), Date.UTC(2026, 11, 31)).map((o) => new Date(o.start).toISOString().slice(0, 10));
  assert.deepEqual(days, ['2026-11-02', '2026-11-04', '2026-11-09', '2026-11-11', '2026-11-16', '2026-11-18']);
  assert.match((await dav('GET', `${cal}MON-WED-MONTH-1.ics`)).text, /RRULE:FREQ=WEEKLY;.*BYDAY=MO,WE|RRULE:FREQ=WEEKLY;BYDAY=MO,WE/);
});

test('“the first and third Monday” from a phone repeats here, and goes back the same', async () => {
  const cal = `/dav/calendars/${me.id}/default/`;
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Apple Inc.//iOS 18.0//EN', 'BEGIN:VEVENT', 'UID:FIRST-THIRD-1',
    'DTSTART;TZID=Europe/London:20261102T180000', 'DTEND;TZID=Europe/London:20261102T200000', 'SUMMARY:Committee',
    'RRULE:FREQ=MONTHLY;BYDAY=1MO,3MO', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  assert.equal((await dav('PUT', `${cal}FIRST-THIRD-1.ics`, { body: ics, headers: { 'content-type': 'text/calendar' } })).status, 201);
  const ev = (await api('GET', `/api/events?from=${Date.UTC(2026, 10, 1)}&to=${Date.UTC(2027, 0, 31)}`)).body.find((e) => e.title === 'Committee');
  assert.deepEqual(ev.rrule, { freq: 'monthly', nths: [1, 3], wd: 1 });
  const { expand } = await import('../src/calmath.js');
  assert.deepEqual(expand(ev, Date.UTC(2026, 10, 1), Date.UTC(2027, 0, 31)).map((o) => new Date(o.start).toISOString().slice(0, 10)),
    ['2026-11-02', '2026-11-16', '2026-12-07', '2026-12-21', '2027-01-04', '2027-01-18']);
  assert.match((await dav('GET', `${cal}FIRST-THIRD-1.ics`)).text, /RRULE:FREQ=MONTHLY;BYDAY=1MO,3MO/);
  // and the same rule from the web: checked, and kept
  const t = Date.UTC(2026, 10, 2, 18);
  const made = await api('POST', '/api/events', { title: 'Book club', start: t, end: t + 3600e3, rrule: { freq: 'monthly', nths: [3, 1], wd: 1 } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.deepEqual(made.body.rrule.nths, [1, 3]);
  assert.equal((await api('POST', '/api/events', { title: 'x', start: t, end: t + 1, rrule: { freq: 'monthly', nths: [7], wd: 1 } })).status, 400);
});

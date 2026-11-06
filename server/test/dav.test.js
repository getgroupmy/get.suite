import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-dav-'));
process.env.DATA_DIR = dir;
const { createApp } = await import('../src/app.js');
const { q } = await import('../src/db.js');
const { dovecotHash } = await import('../src/mail/crypt.js');

let server, base, me, other;
before(async () => {
  server = http.createServer(createApp());
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  const j = (url, body, cookie) => fetch(base + url, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json', ...(cookie && { cookie }) }, body: JSON.stringify(body) });
  const setup = await j('/api/auth/setup', { org_name: 'Acme', domain: 'acme.com', name: 'Pat Phone', local: 'pat', password: 'password123' });
  const cookie = setup.headers.get('set-cookie').split(';')[0];
  me = (await setup.json()).user;
  other = await (await j('/api/users', { local: 'kim', domain: 'acme.com', name: 'Kim', password: 'password123' }, cookie)).json();
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
const IPHONE_EVENT = (summary, extra = '') => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Apple Inc.//iOS 18.0//EN', 'BEGIN:VEVENT', 'UID:7F2A-IPHONE-1',
  'DTSTART;TZID=Asia/Kuala_Lumpur:20261110T093000', 'DTEND;TZID=Asia/Kuala_Lumpur:20261110T103000', `SUMMARY:${summary}`, extra, 'BEGIN:VALARM', 'TRIGGER:-PT15M', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR'].filter(Boolean).join('\r\n');

test('discovery: well-known address, sign-in required, principal and homes', async () => {
  assert.equal((await dav('PROPFIND', '/.well-known/caldav', { auth: null })).headers.get('location'), '/dav/');
  const opts = await dav('OPTIONS', '/dav/', { auth: null });
  assert.match(opts.headers.get('dav'), /calendar-access/);
  const anon = await dav('PROPFIND', '/dav/', { auth: null, depth: 0 });
  assert.equal(anon.status, 401);
  assert.match(anon.headers.get('www-authenticate'), /^Basic/);
  assert.equal((await dav('PROPFIND', '/dav/', { auth: basic('pat@acme.com', 'wrong'), depth: 0 })).status, 401);
  const root = await dav('PROPFIND', '/dav/', { depth: 0, body: propfind('<d:current-user-principal/>') });
  assert.equal(root.status, 207);
  assert.ok(root.text.includes(`<d:current-user-principal><d:href>/dav/principals/${me.id}/</d:href>`));
  const pr = await dav('PROPFIND', `/dav/principals/${me.id}/`, { depth: 0, body: propfind('<c:calendar-home-set/><d:displayname/><d:nonsense/>') });
  assert.ok(pr.text.includes(`<cal:calendar-home-set><d:href>/dav/calendars/${me.id}/</d:href>`));
  assert.ok(pr.text.includes('<d:displayname>Pat Phone</d:displayname>'));
  assert.match(pr.text, /<d:nonsense\/><\/d:prop><d:status>HTTP\/1.1 404/, 'unknown properties reported as missing');
  const home = await dav('PROPFIND', `/dav/calendars/${me.id}/`, { depth: 1 });
  assert.ok(home.text.includes(`/dav/calendars/${me.id}/default/`));
  assert.ok(home.text.includes('<cal:calendar/>'));
  assert.equal((await dav('PROPFIND', `/dav/calendars/${other.id}/default/`, { depth: 1 })).status, 403, 'someone else\'s calendar');
  const failures = q("SELECT COUNT(*) AS n FROM auth_failures WHERE service = 'dav'").get().n;
  assert.ok(failures >= 1, 'wrong passwords are recorded by sign-in protection');
});

test('events: a phone creates, lists, reads, changes and deletes; the web calendar follows', async () => {
  const cal = `/dav/calendars/${me.id}/default/`;
  const before = await dav('PROPFIND', cal, { depth: 0, body: propfind('<cs:getctag/>') });
  const ctag0 = /<cs:getctag>([^<]+)</.exec(before.text)[1];
  const put = await dav('PUT', `${cal}7F2A-IPHONE-1.ics`, { body: IPHONE_EVENT('Supplier call'), headers: { 'content-type': 'text/calendar', 'if-none-match': '*' } });
  assert.equal(put.status, 201);
  const etag = put.headers.get('etag');
  assert.match(etag, /^"[0-9a-f]+"$/);
  const list = (await api('GET', `/api/events?from=${Date.UTC(2026, 10, 9)}&to=${Date.UTC(2026, 10, 12)}`)).body;
  assert.equal(list.length, 1);
  assert.deepEqual([list[0].title, new Date(list[0].start).toISOString()], ['Supplier call', '2026-11-10T01:30:00.000Z']);
  assert.equal((await dav('PUT', `${cal}7F2A-IPHONE-1.ics`, { body: IPHONE_EVENT('x'), headers: { 'if-none-match': '*' } })).status, 412, 'create-only on an existing one');

  // Listing: the event with its ETag; the calendar's ctag changed.
  const pf = await dav('PROPFIND', cal, { depth: 1, body: propfind('<d:getetag/><cs:getctag/>') });
  assert.ok(pf.text.includes(`<d:href>${cal}7F2A-IPHONE-1.ics</d:href>`));
  assert.ok(pf.text.includes(`<d:getetag>${etag.replace(/"/g, '&quot;')}</d:getetag>`));
  assert.notEqual(/<cs:getctag>([^<]+)</.exec(pf.text)[1], ctag0);
  const mg = await dav('REPORT', cal, { depth: 1, body: `<?xml version="1.0"?><c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><d:href>${cal}7F2A-IPHONE-1.ics</d:href><d:href>${cal}gone.ics</d:href></c:calendar-multiget>` });
  assert.equal(mg.status, 207);
  assert.match(mg.text, /SUMMARY:Supplier call/);
  assert.match(mg.text, /UID:7F2A-IPHONE-1/, 'the phone\'s UID is kept');
  assert.match(mg.text, /gone\.ics<\/d:href><d:status>HTTP\/1.1 404/);
  const get = await dav('GET', `${cal}7F2A-IPHONE-1.ics`);
  assert.equal(get.headers.get('etag'), etag);
  assert.match(get.text, /^BEGIN:VCALENDAR/);

  // Events made on the web appear on the phone, as <id>.ics.
  const w = (await api('POST', '/api/events', { title: 'Made on the web', start: Date.UTC(2026, 10, 11, 3), end: Date.UTC(2026, 10, 11, 4), tz: 'Asia/Kuala_Lumpur' })).body;
  const query = await dav('REPORT', cal, { depth: 1, body: '<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"/></c:filter></c:calendar-query>' });
  assert.ok(query.text.includes(`${w.id}.ics`));
  assert.match(query.text, /SUMMARY:Made on the web/);

  // Changing it: a stale ETag is refused; the right one works.
  assert.equal((await dav('PUT', `${cal}7F2A-IPHONE-1.ics`, { body: IPHONE_EVENT('Moved'), headers: { 'if-match': '"stale"' } })).status, 412);
  const upd = await dav('PUT', `${cal}7F2A-IPHONE-1.ics`, { body: IPHONE_EVENT('Supplier call (moved)', 'RRULE:FREQ=WEEKLY;COUNT=4'), headers: { 'if-match': etag } });
  assert.equal(upd.status, 204);
  const ev = (await api('GET', `/api/events?from=${Date.UTC(2026, 10, 9)}&to=${Date.UTC(2026, 10, 12)}`)).body.find((e) => e.ical_uid === '7F2A-IPHONE-1') ;
  assert.equal(ev.title, 'Supplier call (moved)');
  assert.deepEqual(ev.rrule, { freq: 'weekly', count: 4 });
  // Editing on the web changes what the phone gets.
  await api('PATCH', `/api/events/${w.id}`, { title: 'Renamed on the web' });
  assert.match((await dav('GET', `${cal}${w.id}.ics`)).text, /SUMMARY:Renamed on the web/);

  assert.equal((await dav('DELETE', `${cal}7F2A-IPHONE-1.ics`)).status, 204);
  assert.equal((await dav('GET', `${cal}7F2A-IPHONE-1.ics`)).status, 404);
  assert.equal((await api('GET', `/api/events?from=${Date.UTC(2026, 10, 9)}&to=${Date.UTC(2026, 10, 12)}`)).body.length, 1);
  assert.equal((await dav('PUT', `${cal}bad.ics`, { body: 'not a calendar' })).status, 415);
});

test('contacts: a phone adds a card; the web edits it; nothing on the card is lost', async () => {
  const book = `/dav/addressbooks/${me.id}/default/`;
  const card = ['BEGIN:VCARD', 'VERSION:3.0', 'N:Tan;Mei Ling;;;', 'FN:Mei Ling Tan', 'ORG:Harbour Logistics', 'EMAIL;type=INTERNET;type=pref:mei@harbour.example',
    'TEL;type=CELL:+60 12-345 6789', 'item1.ADR:;;1 Jalan Pantai;George Town;;10300;Malaysia', 'BDAY:1990-04-01', 'UID:CARD-1', 'END:VCARD'].join('\r\n');
  assert.equal((await dav('PUT', `${book}CARD-1.vcf`, { body: card })).status, 201);
  const c = (await api('GET', '/api/contacts')).body.find((x) => x.vcard_uid === 'CARD-1');
  assert.deepEqual([c.name, c.email, c.phone, c.company], ['Mei Ling Tan', 'mei@harbour.example', '+60 12-345 6789', 'Harbour Logistics']);
  await api('PATCH', `/api/contacts/${c.id}`, { phone: '+60 12-000 0000' });
  const back = (await dav('GET', `${book}CARD-1.vcf`)).text;
  assert.match(back, /TEL;TYPE=CELL:\+60 12-000 0000/);
  assert.match(back, /item1\.ADR:;;1 Jalan Pantai/, 'the address the web doesn\'t show is still there');
  assert.match(back, /BDAY:1990-04-01/);
  const pf = await dav('PROPFIND', book, { depth: 1, body: '<d:propfind xmlns:d="DAV:"><d:prop><d:getetag/></d:prop></d:propfind>' });
  assert.ok(pf.text.includes(`${book}CARD-1.vcf`));
  const made = (await api('POST', '/api/contacts', { name: 'From the web', email: 'web@example.com' })).body;
  const mg = await dav('REPORT', book, { body: `<card:addressbook-multiget xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:prop><d:getetag/><card:address-data/></d:prop><d:href>${book}${made.id}.vcf</d:href></card:addressbook-multiget>` });
  assert.match(mg.text, /FN:From the web/);
  assert.equal((await dav('DELETE', `${book}CARD-1.vcf`)).status, 204);
  assert.ok(!(await api('GET', '/api/contacts')).body.some((x) => x.vcard_uid === 'CARD-1'));
});

test('two-step verification: the account password stops working here; the mail-app password works', async () => {
  q("INSERT INTO two_factor (user_id, secret, enabled) VALUES (?, 'JBSWY3DPEHPK3PXP', 1)").run(me.id);
  assert.equal((await dav('PROPFIND', '/dav/', { depth: 0 })).status, 401);
  q('UPDATE users SET mail_app_hash = ? WHERE id = ?').run(dovecotHash('abcd-efgh-ijkl-mnop', 5000), me.id);
  assert.equal((await dav('PROPFIND', '/dav/', { depth: 0, auth: basic('pat@acme.com', 'abcd-efgh-ijkl-mnop') })).status, 207);
  q('DELETE FROM two_factor WHERE user_id = ?').run(me.id);
});

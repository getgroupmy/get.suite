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
  await new Promise((r) => setTimeout(r, 1100)); // a second later the file (and ETag) must be the same
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
  // Deleted on the phone: still in Contacts → Trash, and put back from there it's on the phone again.
  const binned = (await api('GET', '/api/contacts/trash')).body.contacts;
  assert.equal(binned.length, 1);
  assert.equal((await api('POST', `/api/contacts/trash/${binned[0].id}/restore`)).status, 200);
  const again = await dav('PROPFIND', book, { depth: 1, body: '<d:propfind xmlns:d="DAV:"><d:prop><d:getetag/></d:prop></d:propfind>' });
  assert.ok(again.text.includes(`${book}CARD-1.vcf`), 'the same card name on the phone');
});

test('two-step verification: the account password stops working here; the mail-app password works', async () => {
  q("INSERT INTO two_factor (user_id, secret, enabled) VALUES (?, 'JBSWY3DPEHPK3PXP', 1)").run(me.id);
  assert.equal((await dav('PROPFIND', '/dav/', { depth: 0 })).status, 401);
  q('UPDATE users SET mail_app_hash = ? WHERE id = ?').run(dovecotHash('abcd-efgh-ijkl-mnop', 5000), me.id);
  assert.equal((await dav('PROPFIND', '/dav/', { depth: 0, auth: basic('pat@acme.com', 'abcd-efgh-ijkl-mnop') })).status, 207);
  q('DELETE FROM two_factor WHERE user_id = ?').run(me.id);
});

test('repeating events: one occurrence changed on the web or the phone shows on both', async () => {
  const cal = `/dav/calendars/${me.id}/default/`;
  const t = Date.UTC(2026, 11, 7, 9); // Monday 9:00 UTC
  const series = (await api('POST', '/api/events', { title: 'Standup', start: t, end: t + 18e5, rrule: { freq: 'weekly' }, tz: 'UTC' })).body;
  // On the web: move the second one ("this event"), the way the calendar does it.
  const second = t + 7 * 864e5;
  await api('PATCH', `/api/events/${series.id}`, { exdates: [second] });
  await api('POST', '/api/events', { title: 'Standup (moved)', start: second + 36e5, end: second + 36e5 + 18e5, tz: 'UTC', recurrence_of: { id: series.id, occurrence: second } });
  const ics = (await dav('GET', `${cal}${series.id}.ics`)).text;
  assert.match(ics, /RECURRENCE-ID:20261214T090000Z/);
  assert.match(ics, /SUMMARY:Standup \(moved\)/);
  const list = await dav('PROPFIND', cal, { depth: 1, body: '<d:propfind xmlns:d="DAV:"><d:prop><d:getetag/></d:prop></d:propfind>' });
  assert.equal((list.text.match(/Standup|\.ics/g) || []).filter((x) => x === '.ics').length, (await api('GET', `/api/events?from=0&to=${8.64e15}`)).body.filter((e) => !e.recur_parent).length, 'the changed occurrence travels inside its series');

  // On the phone: change the third one, cancel the fourth, and keep the web's change.
  const third = second + 7 * 864e5, fourth = third + 7 * 864e5;
  const phone = ics.replace('END:VCALENDAR', [
    'BEGIN:VEVENT', `UID:${series.id}@workspace`, 'RECURRENCE-ID:20261221T090000Z', 'DTSTART:20261221T130000Z', 'DTEND:20261221T133000Z', 'SUMMARY:Standup (afternoon)', 'END:VEVENT',
    'BEGIN:VEVENT', `UID:${series.id}@workspace`, 'RECURRENCE-ID:20261228T090000Z', 'DTSTART:20261228T090000Z', 'DTEND:20261228T093000Z', 'STATUS:CANCELLED', 'SUMMARY:Standup', 'END:VEVENT',
    'END:VCALENDAR'].join('\r\n'));
  assert.equal((await dav('PUT', `${cal}${series.id}.ics`, { body: phone })).status, 204);
  const web = (await api('GET', `/api/events?from=${t - 864e5}&to=${t + 60 * 864e5}`)).body;
  const master = web.find((e) => e.id === series.id);
  assert.deepEqual(master.exdates.sort(), [second, third, fourth].sort());
  const children = web.filter((e) => e.recur_parent === series.id).map((e) => [e.title, e.recur_id]).sort();
  assert.deepEqual(children, [['Standup (afternoon)', third], ['Standup (moved)', second]]);
  // Deleting the series removes its changed occurrences too.
  await dav('DELETE', `${cal}${series.id}.ics`);
  assert.equal((await api('GET', `/api/events?from=${t - 864e5}&to=${t + 60 * 864e5}`)).body.filter((e) => e.title.startsWith('Standup')).length, 0);
});

test('invitations: they appear on the guest\'s phone, and Accept or delete there answers', async () => {
  const kimAuth = basic('kim@acme.com', 'password123');
  const t = Date.UTC(2026, 11, 9, 10);
  const ev = (await api('POST', '/api/events', { title: 'Budget review', start: t, end: t + 36e5, guests: ['kim@acme.com'], tz: 'UTC' })).body;
  const kcal = `/dav/calendars/${other.id}/default/`;
  const ics = (await dav('GET', `${kcal}${ev.id}.ics`, { auth: kimAuth })).text;
  assert.match(ics, /ORGANIZER;CN="Pat Phone":mailto:pat@acme\.com/);
  assert.match(ics.replace(/\r\n /g, ''), /ATTENDEE;CN="Kim";ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:kim@acme\.com/);
  const accepted = ics.replace(/\r\n /g, '').replace('PARTSTAT=NEEDS-ACTION', 'PARTSTAT=ACCEPTED').replace('SUMMARY:Budget review', 'SUMMARY:Renamed by Kim');
  assert.equal((await dav('PUT', `${kcal}${ev.id}.ics`, { auth: kimAuth, body: accepted })).status, 204);
  const mine = (await api('GET', `/api/events?from=${t - 864e5}&to=${t + 864e5}`)).body.find((e) => e.id === ev.id);
  assert.equal(mine.guests[0].status, 'yes');
  assert.equal(mine.title, 'Budget review', 'a guest can only answer, not change the event');
  assert.equal((await dav('DELETE', `${kcal}${ev.id}.ics`, { auth: kimAuth })).status, 204);
  assert.equal((await api('GET', `/api/events?from=${t - 864e5}&to=${t + 864e5}`)).body.find((e) => e.id === ev.id).guests[0].status, 'no', 'deleting it declines');
  assert.ok(!(await dav('PROPFIND', kcal, { auth: kimAuth, depth: 1 })).text.includes(ev.id), 'and it leaves the phone');
});

test('Outlook on Windows: a repeating event in a Windows time zone keeps its local time', async () => {
  const cal = `/dav/calendars/${me.id}/default/`;
  const tz = 'BEGIN:VTIMEZONE\r\nTZID:Pacific Standard Time\r\nBEGIN:STANDARD\r\nDTSTART:16011104T020000\r\nRRULE:FREQ=YEARLY;BYDAY=1SU;BYMONTH=11\r\nTZOFFSETFROM:-0700\r\nTZOFFSETTO:-0800\r\nEND:STANDARD\r\nBEGIN:DAYLIGHT\r\nDTSTART:16010311T020000\r\nRRULE:FREQ=YEARLY;BYDAY=2SU;BYMONTH=3\r\nTZOFFSETFROM:-0800\r\nTZOFFSETTO:-0700\r\nEND:DAYLIGHT\r\nEND:VTIMEZONE\r\n';
  const body = `BEGIN:VCALENDAR\r\nPRODID:-//Microsoft Corporation//Outlook 16.0 MIMEDIR//EN\r\nVERSION:2.0\r\n${tz}BEGIN:VEVENT\r\nUID:OUTLOOK-TZ-1\r\nSUMMARY:Standup\r\nDTSTART;TZID="Pacific Standard Time":20261026T090000\r\nDTEND;TZID="Pacific Standard Time":20261026T091500\r\nRRULE:FREQ=WEEKLY;BYDAY=MO\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
  assert.equal((await dav('PUT', `${cal}OUTLOOK-TZ-1.ics`, { body, headers: { 'content-type': 'text/calendar' } })).status, 201);
  const row = q("SELECT start, tz FROM events WHERE ical_uid = 'OUTLOOK-TZ-1'").get();
  assert.equal(new Date(row.start).toISOString(), '2026-10-26T16:00:00.000Z'); // 9:00 at -07:00
  assert.equal(row.tz, 'America/Los_Angeles');
  const back = await dav('GET', `${cal}OUTLOOK-TZ-1.ics`);
  assert.match(back.text, /DTSTART;TZID=America\/Los_Angeles:20261026T090000/); // phones get it as 9:00 Los Angeles time
  assert.match(back.text, /TZID:America\/Los_Angeles/);
});

test('reminders: set on the phone they show on the web, and the other way round', async () => {
  const cal = `/dav/calendars/${me.id}/default/`;
  const body = (alarm) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Apple Inc.//iOS 18.0//EN\r\nBEGIN:VEVENT\r\nUID:REMIND-1\r\nSUMMARY:Dentist\r\nDTSTART:20261120T013000Z\r\nDTEND:20261120T023000Z\r\n${alarm}END:VEVENT\r\nEND:VCALENDAR\r\n`;
  const put = await dav('PUT', `${cal}REMIND-1.ics`, { body: body('BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT15M\r\nEND:VALARM\r\nBEGIN:VALARM\r\nACTION:AUDIO\r\nTRIGGER:-P1D\r\nEND:VALARM\r\n'), headers: { 'content-type': 'text/calendar' } });
  assert.equal(put.status, 201);
  const ev = () => api('GET', `/api/events?from=${Date.UTC(2026, 10, 19)}&to=${Date.UTC(2026, 10, 21)}`).then((r) => r.body.find((e) => e.ical_uid === 'REMIND-1'));
  assert.deepEqual((await ev()).reminders, [15, 1440]);
  const etag = put.headers.get('etag');
  assert.deepEqual((await api('PUT', `/api/events/${(await ev()).id}/reminders`, { reminders: [30] })).body, { reminders: [30] });
  const back = await dav('GET', `${cal}REMIND-1.ics`);
  assert.match(back.text, /TRIGGER:-PT30M/);
  assert.doesNotMatch(back.text, /TRIGGER:-PT15M/);
  assert.notEqual(back.headers.get('etag'), etag, 'the phone sees it changed');
  await dav('PUT', `${cal}REMIND-1.ics`, { body: body(''), headers: { 'content-type': 'text/calendar' } });
  assert.deepEqual((await ev()).reminders, [], 'removed on the phone');
});

test('contacts: a phone\'s photo shows on the web, and a web photo goes to the phone', async () => {
  const book = `/dav/addressbooks/${me.id}/default/`;
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64');
  const b64 = PNG.toString('base64');
  const card = ['BEGIN:VCARD', 'VERSION:3.0', 'FN:Photo Phone', 'EMAIL:pp@example.com', `PHOTO;ENCODING=b;TYPE=PNG:${b64.slice(0, 40)}`, ` ${b64.slice(40)}`, 'UID:CARD-PHOTO', 'END:VCARD'].join('\r\n');
  assert.equal((await dav('PUT', `${book}CARD-PHOTO.vcf`, { body: card })).status, 201);
  const c = (await api('GET', '/api/contacts')).body.find((x) => x.vcard_uid === 'CARD-PHOTO');
  assert.ok(c.photo_at, 'the photo arrived');
  const back = (await dav('GET', `${book}CARD-PHOTO.vcf`)).text.replace(/\r\n[ \t]/g, '');
  assert.equal((back.match(/^PHOTO/gm) || []).length, 1, 'one photo on the card');
  assert.ok(back.includes(`PHOTO;ENCODING=b;TYPE=PNG:${b64}`));
});

test('calendars of your own: each is a calendar on the phone, with its name, colour and events', async () => {
  const fam = (await api('POST', '/api/events/calendars', { name: 'Family & friends', color: '#8e24aa' })).body;
  const t = Date.UTC(2026, 11, 5, 9);
  const play = (await api('POST', '/api/events', { title: 'School play', start: t, end: t + 3600e3, calendar_id: fam.id, color: '#8e24aa' })).body;
  const work = (await api('POST', '/api/events', { title: 'Quarterly review', start: t, end: t + 3600e3 })).body;
  // The home lists the main calendar and Family, each with its name and colour.
  const home = await dav('PROPFIND', `/dav/calendars/${me.id}/`, { depth: 1, body: propfind('<d:displayname/><d:resourcetype/><x:calendar-color xmlns:x="http://apple.com/ns/ical/"/>') });
  assert.ok(home.text.includes(`/dav/calendars/${me.id}/${fam.id}/`));
  assert.ok(home.text.includes('<d:displayname>Family &amp; friends</d:displayname>'));
  assert.ok(home.text.includes('#8E24AAFF'));
  // Each calendar has just its own events.
  const famList = await dav('PROPFIND', `/dav/calendars/${me.id}/${fam.id}/`, { depth: 1 });
  assert.ok(famList.text.includes(`${play.id}.ics`));
  assert.ok(!famList.text.includes(`${work.id}.ics`));
  const mainList = await dav('PROPFIND', `/dav/calendars/${me.id}/default/`, { depth: 1 });
  assert.ok(mainList.text.includes(`${work.id}.ics`));
  assert.ok(!mainList.text.includes(`${play.id}.ics`));
  assert.equal((await dav('GET', `/dav/calendars/${me.id}/default/${play.id}.ics`)).status, 404, 'not in the main calendar');
  assert.match((await dav('GET', `/dav/calendars/${me.id}/${fam.id}/${play.id}.ics`)).text, /SUMMARY:School play/);
  const report = await dav('REPORT', `/dav/calendars/${me.id}/${fam.id}/`, { depth: 1, body: '<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop></c:calendar-query>' });
  assert.ok(report.text.includes('School play') && !report.text.includes('Quarterly review'));
  assert.equal((await dav('PROPFIND', `/dav/calendars/${me.id}/nope/`, { depth: 0 })).status, 404);

  // An event made on the phone in Family goes in Family, in its colour.
  const ev = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:FAM-PHONE-1', 'DTSTART:20261206T100000Z', 'DTEND:20261206T110000Z', 'SUMMARY:Grandma visit', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  assert.equal((await dav('PUT', `/dav/calendars/${me.id}/${fam.id}/fam-phone-1.ics`, { body: ev, headers: { 'content-type': 'text/calendar', 'if-none-match': '*' } })).status, 201);
  const day = (await api('GET', `/api/events?from=${Date.UTC(2026, 11, 6)}&to=${Date.UTC(2026, 11, 7)}`)).body.find((e) => e.title === 'Grandma visit');
  assert.deepEqual([day.calendar_id, day.color], [fam.id, '#8e24aa']);
  // Moving it to the main calendar on the phone: put there with the same UID, then deleted from Family.
  assert.equal((await dav('PUT', `/dav/calendars/${me.id}/default/moved.ics`, { body: ev, headers: { 'content-type': 'text/calendar', 'if-none-match': '*' } })).status, 201);
  assert.equal((await dav('DELETE', `/dav/calendars/${me.id}/${fam.id}/fam-phone-1.ics`)).status, 404, 'already moved');
  const moved = (await api('GET', `/api/events?from=${Date.UTC(2026, 11, 6)}&to=${Date.UTC(2026, 11, 7)}`)).body.filter((e) => e.title === 'Grandma visit');
  assert.equal(moved.length, 1, 'one event, not a copy');
  assert.deepEqual([moved[0].id, moved[0].calendar_id, moved[0].color], [day.id, null, null]);

  // Renaming and recolouring it on the phone is kept; its events in the old colour follow.
  const pp = '<?xml version="1.0"?><d:propertyupdate xmlns:d="DAV:" xmlns:x="http://apple.com/ns/ical/"><d:set><d:prop><d:displayname>Home</d:displayname><x:calendar-color>#0B8043FF</x:calendar-color></d:prop></d:set></d:propertyupdate>';
  assert.equal((await dav('PROPPATCH', `/dav/calendars/${me.id}/${fam.id}/`, { body: pp })).status, 207);
  const cals = (await api('GET', '/api/events/calendars')).body;
  assert.deepEqual([cals[0].name, cals[0].color], ['Home', '#0b8043']);
  assert.equal((await api('GET', `/api/events?from=${t - 1}&to=${t + 1}`)).body.find((e) => e.title === 'School play').color, '#0b8043');
  // The main calendar's name stays; new calendars are made in Workspace.
  await dav('PROPPATCH', `/dav/calendars/${me.id}/default/`, { body: pp });
  assert.ok((await dav('PROPFIND', `/dav/calendars/${me.id}/default/`, { depth: 0, body: propfind('<d:displayname/>') })).text.includes('<d:displayname>Workspace</d:displayname>'));
  assert.equal((await dav('MKCALENDAR', `/dav/calendars/${me.id}/new-one/`)).status, 403);
  // Someone else's calendar id isn't reachable.
  assert.equal((await dav('PROPFIND', `/dav/calendars/${other.id}/${fam.id}/`, { depth: 0 })).status, 403);
});

test('calendars colleagues share: on the phone too, read-only unless you may make changes', async () => {
  // Kim shares two calendars with Pat: one to see, one to change.
  const kim = { cookie: '' };
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'kim@acme.com', password: 'password123' }) });
  kim.cookie = login.headers.get('set-cookie').split(';')[0];
  const k = async (method, url, body) => { const r = await fetch(base + url, { method, headers: { 'x-requested-with': 'nas-workspace', cookie: kim.cookie, ...(body && { 'content-type': 'application/json' }) }, body: body && JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
  const see = (await k('POST', '/api/events/calendars', { name: 'Kim travel', color: '#d50000' })).body;
  const edit = (await k('POST', '/api/events/calendars', { name: 'Rota', color: '#616161' })).body;
  const t = Date.UTC(2026, 11, 8, 9);
  const trip = (await k('POST', '/api/events', { title: 'Kim in Paris', start: t, end: t + 3600e3, calendar_id: see.id, color: '#d50000' })).body;
  await k('PUT', `/api/events/calendars/${see.id}/members`, { members: [{ id: me.id, can_edit: false }] });
  await k('PUT', `/api/events/calendars/${edit.id}/members`, { members: [{ id: me.id, can_edit: true }] });

  const home = await dav('PROPFIND', `/dav/calendars/${me.id}/`, { depth: 1, body: propfind('<d:displayname/><d:current-user-privilege-set/>') });
  assert.ok(home.text.includes(`/dav/calendars/${me.id}/${see.id}/`));
  assert.ok(home.text.includes('<d:displayname>Kim travel (Kim)</d:displayname>'));
  const seeProps = await dav('PROPFIND', `/dav/calendars/${me.id}/${see.id}/`, { depth: 0, body: propfind('<d:current-user-privilege-set/>') });
  assert.ok(!seeProps.text.includes('<d:write/>'), 'read-only');
  assert.ok((await dav('PROPFIND', `/dav/calendars/${me.id}/${edit.id}/`, { depth: 0, body: propfind('<d:current-user-privilege-set/>') })).text.includes('<d:write/>'));
  const list = await dav('PROPFIND', `/dav/calendars/${me.id}/${see.id}/`, { depth: 1 });
  assert.ok(list.text.includes(`${trip.id}.ics`));
  assert.match((await dav('GET', `/dav/calendars/${me.id}/${see.id}/${trip.id}.ics`)).text, /SUMMARY:Kim in Paris/);
  // Read-only: no changes from the phone.
  const ev = (uidv, title) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', `UID:${uidv}`, 'DTSTART:20261209T080000Z', 'DTEND:20261209T090000Z', `SUMMARY:${title}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  assert.equal((await dav('PUT', `/dav/calendars/${me.id}/${see.id}/x.ics`, { body: ev('X-1', 'Nope'), headers: { 'content-type': 'text/calendar' } })).status, 403);
  assert.equal((await dav('DELETE', `/dav/calendars/${me.id}/${see.id}/${trip.id}.ics`)).status, 403);
  // The one Pat may change: an event added on the phone is Kim's, in Rota, and Kim is told.
  assert.equal((await dav('PUT', `/dav/calendars/${me.id}/${edit.id}/shift.ics`, { body: ev('SHIFT-1', 'Pat on call'), headers: { 'content-type': 'text/calendar', 'if-none-match': '*' } })).status, 201);
  const kims = (await k('GET', `/api/events?from=${Date.UTC(2026, 11, 9)}&to=${Date.UTC(2026, 11, 10)}`)).body.find((e) => e.title === 'Pat on call');
  assert.deepEqual([kims.role, kims.calendar_id, kims.color], ['organizer', edit.id, '#616161']);
  assert.ok(JSON.stringify((await k('GET', '/api/notifications')).body).includes('Pat Phone added “Pat on call” in Rota'));
  assert.equal((await dav('DELETE', `/dav/calendars/${me.id}/${edit.id}/shift.ics`)).status, 204);
  assert.equal((await k('GET', `/api/events?from=${Date.UTC(2026, 11, 9)}&to=${Date.UTC(2026, 11, 10)}`)).body.filter((e) => e.title === 'Pat on call').length, 0);
  // Renaming from the phone isn't Pat's to do.
  const pp = '<?xml version="1.0"?><d:propertyupdate xmlns:d="DAV:"><d:set><d:prop><d:displayname>Mine</d:displayname></d:prop></d:set></d:propertyupdate>';
  await dav('PROPPATCH', `/dav/calendars/${me.id}/${edit.id}/`, { body: pp });
  assert.equal((await k('GET', '/api/events/calendars')).body.find((c) => c.id === edit.id).name, 'Rota');
  // Unshared: gone from the phone.
  await k('PUT', `/api/events/calendars/${see.id}/members`, { members: [] });
  assert.equal((await dav('PROPFIND', `/dav/calendars/${me.id}/${see.id}/`, { depth: 0 })).status, 404);
});

test('contacts: dates and fields of your own sync with phones both ways', async () => {
  const card = ['BEGIN:VCARD', 'VERSION:3.0', 'UID:DATES-1', 'FN:Dee Dates', 'item1.X-ABDATE:2012-08-08', 'item1.X-ABLabel:_$!<Anniversary>!$_', 'X-WORKSPACE-FIELD;LABEL="Locker":42', 'END:VCARD'].join('\r\n');
  assert.equal((await dav('PUT', `/dav/addressbooks/${me.id}/default/dates-1.vcf`, { body: card, headers: { 'content-type': 'text/vcard' } })).status, 201);
  const mine = (await api('GET', '/api/contacts')).body.find((c) => c.name === 'Dee Dates');
  assert.deepEqual(mine.dates, [{ label: 'Anniversary', date: '2012-08-08' }]);
  assert.deepEqual(mine.custom_fields, [{ label: 'Locker', value: '42' }]);
  await api('PATCH', `/api/contacts/${mine.id}`, { dates: [{ label: 'Anniversary', date: '2012-08-09' }] });
  const back = (await dav('GET', `/dav/addressbooks/${me.id}/default/dates-1.vcf`)).text;
  assert.match(back, /X-ABDATE:2012-08-09/);
  assert.doesNotMatch(back, /2012-08-08/, 'the old date isn’t kept beside it');
  assert.match(back, /X-WORKSPACE-FIELD;LABEL="Locker":42/);
});

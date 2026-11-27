// Calendar files (.ics) and contact cards (.vcf) kept in Drive: their preview lists what's in them, and they're added to
// Calendar or Contacts from there (once: what's already there isn't doubled), refused for view-only files with downloading off.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-cardfiles-'));
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
  return async (method, url, body, raw) => {
    const res = await fetch(base + url, { method, headers: { 'x-requested-with': 'nas-workspace', ...(raw ? {} : { 'content-type': 'application/json' }), ...(cookie && { cookie }) }, body: raw || (body === undefined ? undefined : JSON.stringify(body)) });
    const c = res.headers.get('set-cookie'); if (c) cookie = c.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}

const ICS = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN',
  'BEGIN:VEVENT', 'UID:kick-1@test', 'DTSTART:20261203T100000Z', 'DTEND:20261203T113000Z', 'SUMMARY:Kick-off', 'LOCATION:Room 4', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:fair-2@test', 'DTSTART;VALUE=DATE:20261210', 'DTEND;VALUE=DATE:20261211', 'SUMMARY:Trade fair', 'RRULE:FREQ=YEARLY', 'END:VEVENT',
  'END:VCALENDAR', ''].join('\r\n');
const VCF = ['BEGIN:VCARD', 'VERSION:3.0', 'FN:Rosa Diaz', 'EMAIL:rosa@supplier.example', 'TEL:+44 20 7946 0000', 'ORG:Supplier Ltd', 'END:VCARD',
  'BEGIN:VCARD', 'VERSION:3.0', 'FN:Tom Ng', 'EMAIL:tom@supplier.example', 'END:VCARD', ''].join('\r\n');

test('a calendar file in Drive: its events listed, then added to Calendar once', async () => {
  const ann = client();
  assert.equal((await ann('POST', '/api/auth/setup', { org_name: 'Acme', domain: 'acme.com', name: 'Ann Owner', local: 'ann', password: 'password123' })).status, 200);
  const benId = (await ann('POST', '/api/users', { local: 'ben', domain: 'acme.com', name: 'Ben Member', password: 'password123' })).body.id;
  const ben = client(); assert.equal((await ben('POST', '/api/auth/login', { username: 'ben@acme.com', password: 'password123' })).status, 200);
  const ics = (await ann('POST', '/api/files/upload?name=Events.ics', null, Buffer.from(ICS))).body;
  assert.equal(ics.mime, 'text/calendar');
  const cards = await ann('GET', `/api/files/${ics.id}/cards`);
  assert.equal(cards.status, 200, JSON.stringify(cards.body));
  assert.equal(cards.body.kind, 'calendar');
  assert.equal(cards.body.total, 2);
  assert.deepEqual(cards.body.events.map((e) => [e.title, e.start, e.all_day, e.location, e.repeats]),
    [['Kick-off', Date.UTC(2026, 11, 3, 10), false, 'Room 4', false], ['Trade fair', Date.UTC(2026, 11, 10), true, null, true]]);
  const r = await ann('POST', `/api/files/${ics.id}/add-events`, { tz: 'UTC' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.added, r.body.skipped], [2, 0]);
  const evs = (await ann('GET', `/api/events?from=${Date.UTC(2026, 11, 1)}&to=${Date.UTC(2026, 11, 31)}`)).body;
  assert.ok(evs.some((e) => e.title === 'Kick-off' && e.location === 'Room 4'));
  assert.deepEqual([(await ann('POST', `/api/files/${ics.id}/add-events`, {})).body.added, (await ann('POST', `/api/files/${ics.id}/add-events`, {})).body.skipped], [0, 2]);
  // Someone it isn't shared with can't see it; a viewer can add it, until downloading is turned off.
  assert.equal((await ben('GET', `/api/files/${ics.id}/cards`)).status, 404);
  assert.equal((await ben('POST', `/api/files/${ics.id}/add-events`, {})).status, 404);
  assert.equal((await ann('PUT', `/api/files/${ics.id}/shares`, { shares: [{ user_id: benId, role: 'viewer' }] })).status, 200);
  assert.equal((await ben('POST', `/api/files/${ics.id}/add-events`, {})).body.added, 2);
  assert.equal((await ann('PATCH', `/api/files/${ics.id}`, { no_download: true })).status, 200);
  assert.equal((await ben('GET', `/api/files/${ics.id}/cards`)).status, 200); // looking is still fine
  assert.equal((await ben('POST', `/api/files/${ics.id}/add-events`, {})).status, 403);
  // Not a calendar file
  const txt = (await ann('POST', '/api/files/upload?name=notes.txt', null, Buffer.from('hello'))).body;
  assert.equal((await ann('GET', `/api/files/${txt.id}/cards`)).status, 400);
  assert.equal((await ann('POST', `/api/files/${txt.id}/add-events`, {})).status, 400);

  // Contact cards: listed, then added to Contacts once.
  const vcf = (await ann('POST', '/api/files/upload?name=Suppliers.vcf', null, Buffer.from(VCF))).body;
  assert.equal(vcf.mime, 'text/vcard');
  const people = (await ann('GET', `/api/files/${vcf.id}/cards`)).body;
  assert.equal(people.kind, 'contacts');
  assert.equal(people.total, 2);
  assert.deepEqual(people.contacts[0], { name: 'Rosa Diaz', email: 'rosa@supplier.example', phone: '+44 20 7946 0000', company: 'Supplier Ltd' });
  const add = await ann('POST', '/api/contacts/from-file', { file: vcf.id });
  assert.equal(add.status, 200, JSON.stringify(add.body));
  assert.equal(add.body.added, 2);
  assert.equal((await ann('POST', '/api/contacts/from-file', { file: vcf.id })).body.added, 0);
  const mine = (await ann('GET', '/api/contacts')).body;
  assert.ok((Array.isArray(mine) ? mine : mine.contacts).some((c) => c.email === 'rosa@supplier.example' && c.company === 'Supplier Ltd'));
  assert.equal((await ann('POST', '/api/contacts/from-file', { file: ics.id })).status, 400);
  assert.equal((await ben('POST', '/api/contacts/from-file', { file: vcf.id })).status, 404);

  // A file that isn't in Drive (an attachment, a chat file): its text read the same way.
  const read = await ann('POST', '/api/files/read-cards?name=invite.ics&tz=UTC', null, ICS);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.deepEqual([read.body.kind, read.body.total, read.body.events[0].title], ['calendar', 2, 'Kick-off']);
  const readV = (await ann('POST', '/api/files/read-cards?name=card.vcf', null, VCF)).body;
  assert.deepEqual([readV.kind, readV.total, readV.contacts[1].name], ['contacts', 2, 'Tom Ng']);
  assert.equal((await ann('POST', '/api/files/read-cards?name=notes.txt', null, 'hi')).status, 400);
  assert.equal((await ann('POST', '/api/files/read-cards?name=x.ics', null, 'not a calendar')).status, 400);
  assert.equal((await client()('POST', '/api/files/read-cards?name=x.ics', null, ICS)).status, 401);
});

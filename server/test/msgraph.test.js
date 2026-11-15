import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-msgraph-'));
const { createOrg } = await import('../src/tenancy.js');
const { q, FILES_DIR } = await import('../src/db.js');
const { rruleOf, graphEventToIcs, graphContactToVcard } = await import('../src/migrate/msgraph.js');
const { parseIcsEvent } = await import('../src/ics.js');
const { contactsFromFile } = await import('../src/contactfiles.js');
const { bringMsData } = await import('../src/mail/msimport.js');

test('Outlook repeats become RRULEs', () => {
  assert.equal(rruleOf({ pattern: { type: 'weekly', interval: 2, daysOfWeek: ['monday', 'thursday'] }, range: { type: 'numbered', numberOfOccurrences: 10 } }), 'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;COUNT=10');
  assert.equal(rruleOf({ pattern: { type: 'relativeMonthly', interval: 1, daysOfWeek: ['friday'], index: 'last' }, range: { type: 'noEnd' } }), 'RRULE:FREQ=MONTHLY;BYDAY=-1FR');
  assert.equal(rruleOf({ pattern: { type: 'absoluteYearly', interval: 1, dayOfMonth: 9, month: 12 }, range: { type: 'endDate', endDate: '2030-12-31' } }), 'RRULE:FREQ=YEARLY;BYMONTHDAY=9;BYMONTH=12;UNTIL=20301231T235959Z');
  assert.equal(rruleOf({ pattern: { type: 'daily', interval: 1 }, range: { type: 'noEnd' } }), 'RRULE:FREQ=DAILY');
  assert.equal(rruleOf(null), null);
});

test('Outlook events and contacts become entries', () => {
  const e = parseIcsEvent(graphEventToIcs({ id: 'x', iCalUId: 'abc', subject: 'Review', type: 'singleInstance', start: { dateTime: '2026-12-03T09:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-12-03T10:00:00.0000000', timeZone: 'UTC' }, location: { displayName: 'Room 4' }, body: { contentType: 'html', content: '<p>Agenda<br>1. Plan</p>' } }), { tz: 'UTC' });
  assert.deepEqual([e.title, e.start, e.location, e.uid], ['Review', Date.UTC(2026, 11, 3, 9), 'Room 4', 'abc']);
  assert.match(e.description, /Agenda\n1\. Plan/);
  const series = parseIcsEvent(graphEventToIcs({ id: 's', subject: 'Standup', type: 'seriesMaster', start: { dateTime: '2026-12-07T08:00:00.0000000' }, end: { dateTime: '2026-12-07T08:15:00.0000000' }, recurrence: { pattern: { type: 'weekly', interval: 1, daysOfWeek: ['monday'] }, range: { type: 'noEnd' } } }), { tz: 'UTC' });
  assert.equal(series.rrule.freq, 'weekly');
  assert.equal(graphEventToIcs({ id: 'o', type: 'occurrence', start: { dateTime: 'x' }, end: { dateTime: 'y' } }), null, 'occurrences come from their series');
  assert.equal(graphEventToIcs({ id: 'c', isCancelled: true, start: { dateTime: 'x' }, end: { dateTime: 'y' } }), null);
  const [c] = contactsFromFile(graphContactToVcard({ id: 'c1', displayName: 'Katherine Johnson', givenName: 'Katherine', surname: 'Johnson', emailAddresses: [{ address: 'kj@nasa.gov' }], mobilePhone: '+1 555 0101', companyName: 'NASA', jobTitle: 'Mathematician', birthday: '1918-08-26T00:00:00Z', personalNotes: 'Orbits' })).contacts;
  assert.deepEqual([c.name, c.email, c.company, c.title, c.birthday, c.notes], ['Katherine Johnson', 'kj@nasa.gov', 'NASA', 'Mathematician', '1918-08-26', 'Orbits']);
});

test('calendars, contacts and OneDrive from Microsoft Graph', async () => {
  let port;
  const g = http.createServer((req, res) => {
    const json = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    if (req.url.startsWith('/download/')) { res.setHeader('content-type', 'application/octet-stream'); return res.end(`contents of ${req.url.slice(10)}`); }
    if (req.headers.authorization !== 'Bearer eyJ.graph') { res.statusCode = 401; return json({ error: { message: 'Access token is empty.' } }); }
    if (req.url.startsWith('/v1.0/me/calendars?')) return json({ value: [{ id: 'main', name: 'Calendar', isDefaultCalendar: true }, { id: 'proj', name: 'Projects' }] });
    if (req.url.startsWith('/v1.0/me/calendars/main/events2')) return json({ value: [{ id: 'e2', subject: 'Holiday', type: 'singleInstance', isAllDay: true, start: { dateTime: '2026-12-25T00:00:00.0000000' }, end: { dateTime: '2026-12-26T00:00:00.0000000' } }] });
    if (req.url.startsWith('/v1.0/me/calendars/main/events')) return json({ value: [{ id: 'e1', iCalUId: 'e1-uid', subject: 'Review', type: 'singleInstance', start: { dateTime: '2026-12-03T09:00:00.0000000' }, end: { dateTime: '2026-12-03T10:00:00.0000000' } }], '@odata.nextLink': `http://127.0.0.1:${port}/v1.0/me/calendars/main/events2` });
    if (req.url.startsWith('/v1.0/me/calendars/proj/events')) return json({ value: [{ id: 'e3', subject: 'Kickoff', type: 'singleInstance', start: { dateTime: '2026-12-10T14:00:00.0000000' }, end: { dateTime: '2026-12-10T15:00:00.0000000' } }] });
    if (req.url.startsWith('/v1.0/me/contacts')) return json({ value: [{ id: 'c1', displayName: 'Katherine Johnson', emailAddresses: [{ address: 'kj@nasa.gov' }] }] });
    if (req.url.startsWith('/v1.0/me/drive/root/children')) return json({ value: [{ id: 'f1', name: 'Reports', folder: { childCount: 1 } }, { id: 'n1', name: 'notes.txt', file: {}, size: 22, '@microsoft.graph.downloadUrl': `http://127.0.0.1:${port}/download/notes.txt` }, { id: 'nb', name: 'Notebook', package: { type: 'oneNote' } }] });
    if (req.url.startsWith('/v1.0/me/drive/items/f1/children')) return json({ value: [{ id: 'q3', name: 'Q3.xlsx', file: {}, size: 20, '@microsoft.graph.downloadUrl': `http://127.0.0.1:${port}/download/Q3.xlsx` }] });
    res.statusCode = 404; json({});
  });
  await new Promise((r) => g.listen(0, '127.0.0.1', r));
  port = g.address().port;
  process.env.MS_GRAPH_URL = `http://127.0.0.1:${port}`;
  try {
    const { userId } = createOrg({ name: 'Acme', domain: 'acme.com', adminName: 'Ana', adminLocal: 'ana', adminPassword: 'password123' });
    const user = q('SELECT * FROM users WHERE id = ?').get(userId);
    const steps = [];
    const r = await bringMsData(user, 'eyJ.graph', (s) => steps.push(s));
    assert.deepEqual(steps, ['calendar', 'contacts', 'drive']);
    assert.deepEqual([r.calendar.added, r.calendar.calendars, r.contacts.added], [3, ['Projects'], 1]);
    assert.equal(r.drive.files, 2, 'the OneNote notebook left out');
    assert.match(r.drive.folder, /^From Microsoft \d{4}-\d\d-\d\d$/);
    const q3 = q("SELECT f.storage, p.name AS parent FROM files f JOIN files p ON p.id = f.parent_id WHERE f.owner_id = ? AND f.name = 'Q3.xlsx'").get(userId);
    assert.equal(q3.parent, 'Reports', 'its folder kept');
    assert.equal(fs.readFileSync(path.join(FILES_DIR, q3.storage), 'utf8'), 'contents of Q3.xlsx');
    const again = await bringMsData(user, 'eyJ.graph');
    assert.deepEqual([again.calendar.added, again.contacts.added], [0, 0]);
    await assert.rejects(bringMsData(user, 'bad'), /Couldn’t read your Microsoft calendars: Access token is empty/);
  } finally { g.close(); delete process.env.MS_GRAPH_URL; }
});

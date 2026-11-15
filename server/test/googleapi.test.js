import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventToIcs, calendarIcs, personToVcard } from '../src/migrate/googleapi.js';
import { parseIcsEvent } from '../src/ics.js';
import { contactsFromFile } from '../src/contactfiles.js';

test('Google Calendar events become calendar entries: timed, all-day, repeating, cancelled left out', () => {
  const timed = eventToIcs({ id: 'a1', iCalUID: 'a1@google.com', summary: 'Board, Q4', location: 'Room 2', description: 'Agenda<br>1. Budget', start: { dateTime: '2026-12-03T09:00:00+08:00' }, end: { dateTime: '2026-12-03T10:00:00+08:00' } });
  const e = parseIcsEvent(timed, { tz: 'UTC' });
  assert.equal(e.title, 'Board, Q4');
  assert.equal(e.start, Date.UTC(2026, 11, 3, 1));
  assert.equal(e.location, 'Room 2');
  assert.match(e.description, /Agenda\n1\. Budget/);
  assert.equal(e.uid, 'a1@google.com');
  const allDay = parseIcsEvent(eventToIcs({ id: 'b', summary: 'Holiday', start: { date: '2026-12-25' }, end: { date: '2026-12-26' } }), { tz: 'UTC' });
  assert.equal(!!allDay.all_day, true);
  const rep = parseIcsEvent(eventToIcs({ id: 'c', summary: 'Standup', start: { dateTime: '2026-12-07T09:00:00+01:00', timeZone: 'Europe/Berlin' }, end: { dateTime: '2026-12-07T09:15:00+01:00', timeZone: 'Europe/Berlin' }, recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO,WE'] }), { tz: 'UTC' });
  assert.equal(rep.rrule.freq, 'weekly');
  assert.equal(rep.start, Date.UTC(2026, 11, 7, 8));
  assert.equal(eventToIcs({ id: 'd', status: 'cancelled', start: { date: '2026-01-01' }, end: { date: '2026-01-02' } }), null);
  const cal = calendarIcs([{ id: 'x', summary: 'X', start: { date: '2026-01-01' }, end: { date: '2026-01-02' } }, { status: 'cancelled' }]);
  assert.equal((cal.match(/BEGIN:VEVENT/g) || []).length, 1);
});

test('Google contacts become contacts', () => {
  const card = personToVcard({ resourceName: 'people/c123', names: [{ displayName: 'Grace Hopper', givenName: 'Grace', familyName: 'Hopper' }], emailAddresses: [{ value: 'grace@navy.mil', type: 'work' }, { value: 'grace@home.example' }],
    phoneNumbers: [{ value: '+1 555 0100', type: 'mobile' }], organizations: [{ name: 'US Navy', title: 'Rear Admiral' }], birthdays: [{ date: { year: 1906, month: 12, day: 9 } }], biographies: [{ value: 'COBOL' }] });
  const [c] = contactsFromFile(card).contacts;
  assert.equal(c.name, 'Grace Hopper');
  assert.equal(c.email, 'grace@navy.mil');
  assert.equal(c.company, 'US Navy');
  assert.equal(c.title, 'Rear Admiral');
  assert.equal(c.birthday, '1906-12-09');
  assert.equal(c.notes, 'COBOL');
  assert.ok(c.more_emails?.length >= 1 || JSON.stringify(c).includes('grace@home.example'));
  assert.equal(personToVcard({ resourceName: 'people/x' }), null, 'nothing to call them');
});

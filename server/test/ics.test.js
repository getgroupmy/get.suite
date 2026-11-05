import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIcs, transitions, offsetAt, fold, escapeText } from '../src/ics.js';

const unfold = (s) => s.replace(/\r\n /g, '');
const lines = (s) => unfold(s).split('\r\n');
const base = { title: 'Planning', location: 'Room 2, floor 3', description: 'Agenda:\nbudget; hires', all_day: 0 };
const who = { uid: 'abc@mail.acme.com', organizer: { name: 'Olivia Owner', email: 'olivia@acme.com' }, attendees: [{ email: 'client@example.com', name: 'Cli "Ent"', status: 'needs' }], now: Date.UTC(2026, 10, 1) };

test('a one-off event in UTC, with escaped text and an attendee', () => {
  const ics = buildIcs({ ...base, start: Date.UTC(2026, 10, 10, 14), end: Date.UTC(2026, 10, 10, 15) }, { ...who, tz: 'Europe/London', sequence: 2 });
  const l = lines(ics);
  assert.ok(ics.endsWith('\r\n') && !/[^\r]\n/.test(ics), 'CRLF line endings');
  for (const x of ['METHOD:REQUEST', 'UID:abc@mail.acme.com', 'SEQUENCE:2', 'DTSTART:20261110T140000Z', 'DTEND:20261110T150000Z', 'DTSTAMP:20261101T000000Z',
    'SUMMARY:Planning', 'LOCATION:Room 2\\, floor 3', 'DESCRIPTION:Agenda:\\nbudget\\; hires', 'STATUS:CONFIRMED',
    'ORGANIZER;CN="Olivia Owner":mailto:olivia@acme.com',
    'ATTENDEE;CN="Cli  Ent";ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:client@example.com']) assert.ok(l.includes(x), x);
  assert.ok(!ics.includes('VTIMEZONE'));
});

test('cancel, and all-day events as dates (the end date is the day after)', () => {
  const s = Date.UTC(2026, 10, 9, 23); // 10 Nov, 00:00 in Berlin (UTC+1)
  const ics = buildIcs({ ...base, all_day: 1, start: s, end: s + 2 * 864e5 - 1 }, { ...who, method: 'CANCEL', tz: 'Europe/Berlin' });
  const l = lines(ics);
  assert.ok(l.includes('DTSTART;VALUE=DATE:20261110'));
  assert.ok(l.includes('DTEND;VALUE=DATE:20261112'), 'two days');
  assert.ok(l.includes('METHOD:CANCEL') && l.includes('STATUS:CANCELLED'));
});

test('repeating events: local time with a VTIMEZONE, rule, skipped dates', () => {
  // Weekly Mon/Thu at 9:00 New York from Wed 4 Nov 2026: starts on Thu 5 Nov (the first listed day).
  const s = Date.UTC(2026, 10, 4, 14); // 9:00 EST
  const ics = buildIcs({ ...base, start: s, end: s + 36e5, rrule: { freq: 'weekly', interval: 2, byday: [1, 4], until: Date.UTC(2027, 5, 1) }, exdates: [Date.UTC(2026, 10, 19, 14)] },
    { ...who, tz: 'America/New_York' });
  const l = lines(ics);
  assert.ok(l.includes('DTSTART;TZID=America/New_York:20261105T090000'), l.find((x) => x.startsWith('DTSTART;TZID')));
  assert.ok(l.includes('DTEND;TZID=America/New_York:20261105T100000'));
  assert.ok(l.includes('RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;UNTIL=20270601T000000Z'));
  assert.ok(l.includes('EXDATE;TZID=America/New_York:20261119T090000'));
  assert.ok(l.includes('BEGIN:VTIMEZONE') && l.includes('TZID:America/New_York'));
  // Spring forward on 14 March 2027 at 2:00 local.
  const i = l.indexOf('DTSTART:20270314T020000');
  assert.ok(i > 0, 'clock change listed');
  assert.deepEqual(l.slice(i - 1, i + 4), ['BEGIN:DAYLIGHT', 'DTSTART:20270314T020000', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'END:DAYLIGHT']);
  const daily = lines(buildIcs({ ...base, start: s, end: s + 36e5, rrule: { freq: 'daily', count: 5 } }, { ...who, tz: 'America/New_York' }));
  assert.ok(daily.includes('RRULE:FREQ=DAILY;COUNT=5'));
});

test('time zone changes and offsets', () => {
  const t = transitions('Europe/London', Date.UTC(2026, 0, 1), Date.UTC(2027, 0, 1));
  assert.deepEqual(t.map((x) => [new Date(x.at).toISOString(), x.from, x.to]), [['2026-03-29T01:00:00.000Z', 0, 60], ['2026-10-25T01:00:00.000Z', 60, 0]]);
  assert.equal(offsetAt(Date.UTC(2026, 6, 1), 'Asia/Kolkata'), 330);
  assert.deepEqual(transitions('Asia/Kolkata', Date.UTC(2026, 0, 1), Date.UTC(2027, 0, 1)), []);
});

test('folding at 75 octets keeps characters whole', () => {
  const long = 'SUMMARY:' + 'é'.repeat(60);
  const out = fold([long]);
  assert.ok(out.split('\r\n').every((x) => Buffer.byteLength(x) <= 75));
  assert.equal(unfold(out).trim(), long);
  assert.equal(escapeText('a,b;c\\d\ne'), 'a\\,b\\;c\\\\d\\ne');
});

import { parseReply } from '../src/mail/rsvp.js';
test('reading replies from Outlook and Gmail', () => {
  const outlook = ['BEGIN:VCALENDAR', 'METHOD:REPLY', 'BEGIN:VEVENT', 'UID:ev1@mail.acme.com',
    'ATTENDEE;PARTSTAT=ACCEPTED;CN=Dana Client:mailto:Dana@Clients-Test.example', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  assert.deepEqual(parseReply(outlook), { uid: 'ev1@mail.acme.com', answers: [{ email: 'dana@clients-test.example', status: 'yes' }] });
  // Gmail folds long lines; tentative and declined.
  const gmail = 'BEGIN:VCALENDAR\r\nMETHOD:REPLY\r\nBEGIN:VEVENT\r\nUID:ev2@mail.acme.com\r\nATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=TENTATIVE;CN=x@gmai\r\n l.com;X-NUM-GUESTS=0:mailto:x@gmail.com\r\nEND:VEVENT\r\nEND:VCALENDAR';
  assert.deepEqual(parseReply(gmail).answers, [{ email: 'x@gmail.com', status: 'maybe' }]);
  assert.equal(parseReply(outlook.replace('METHOD:REPLY', 'METHOD:REQUEST')), null, 'only replies');
  assert.equal(parseReply(outlook.replace('ACCEPTED', 'DELEGATED')), null);
});

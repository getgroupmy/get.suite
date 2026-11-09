import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIcsEvent, buildIcs } from '../src/ics.js';
import { parseVcard, buildVcard } from '../src/vcard.js';
import { verifyDovecotHash, dovecotHash } from '../src/mail/crypt.js';

const ics = (...lines) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...lines, 'END:VCALENDAR'].join('\r\n');

test('reading an event from an iPhone: time zone, text, alarm ignored', () => {
  const e = parseIcsEvent(ics('BEGIN:VTIMEZONE', 'TZID:Asia/Kuala_Lumpur', 'END:VTIMEZONE', 'BEGIN:VEVENT', 'UID:ABC-123', 'DTSTART;TZID=Asia/Kuala_Lumpur:20261110T093000',
    'DTEND;TZID=Asia/Kuala_Lumpur:20261110T103000', 'SUMMARY:Supplier call\\, Penang', 'LOCATION:Room 2', 'DESCRIPTION:Line one\\nLine two',
    'BEGIN:VALARM', 'TRIGGER:-PT15M', 'DESCRIPTION:Reminder', 'END:VALARM', 'END:VEVENT'));
  assert.equal(e.uid, 'ABC-123');
  assert.equal(new Date(e.start).toISOString(), '2026-11-10T01:30:00.000Z');
  assert.equal(e.end - e.start, 36e5);
  assert.deepEqual([e.title, e.location, e.description, e.tz, e.all_day], ['Supplier call, Penang', 'Room 2', 'Line one\nLine two', 'Asia/Kuala_Lumpur', 0]);
});

test('all-day events, UTC times, durations', () => {
  const a = parseIcsEvent(ics('BEGIN:VEVENT', 'UID:x', 'DTSTART;VALUE=DATE:20261224', 'DTEND;VALUE=DATE:20261227', 'SUMMARY:Holiday', 'END:VEVENT'), { tz: 'Europe/London' });
  assert.equal(a.all_day, 1);
  assert.equal(new Date(a.start).toISOString(), '2026-12-24T00:00:00.000Z');
  assert.equal(Math.round((a.end + 1 - a.start) / 864e5), 3, 'three days');
  const u = parseIcsEvent(ics('BEGIN:VEVENT', 'UID:y', 'DTSTART:20261110T140000Z', 'DURATION:PT1H30M', 'END:VEVENT'));
  assert.equal(u.end - u.start, 5.4e6);
  assert.equal(u.title, 'Untitled event');
  assert.equal(parseIcsEvent(ics('BEGIN:VTODO', 'END:VTODO')).error, 'No event in this calendar file');
});

test('repeat rules: supported ones are kept, others become one-off', () => {
  const ev = (rule, ...more) => parseIcsEvent(ics('BEGIN:VEVENT', 'UID:r', 'DTSTART;TZID=Europe/London:20261102T090000', 'DTEND;TZID=Europe/London:20261102T100000', `RRULE:${rule}`, ...more, 'END:VEVENT'));
  assert.deepEqual(ev('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;COUNT=10').rrule, { freq: 'weekly', interval: 2, byday: [1, 4], count: 10 });
  const until = ev('FREQ=DAILY;UNTIL=20261130T235959Z', 'EXDATE;TZID=Europe/London:20261105T090000,20261106T090000');
  assert.equal(until.rrule.until, Date.UTC(2026, 10, 30, 23, 59, 59));
  assert.deepEqual(until.exdates, [Date.UTC(2026, 10, 5, 9), Date.UTC(2026, 10, 6, 9)]);
  assert.deepEqual(ev('FREQ=MONTHLY;BYMONTHDAY=2').rrule, { freq: 'monthly' });
  assert.deepEqual(ev('FREQ=MONTHLY;BYDAY=2MO').rrule, { freq: 'monthly', nth: 2, wd: 1 }, 'the second Monday');
  assert.deepEqual(ev('FREQ=MONTHLY;BYSETPOS=-1;BYDAY=FR').rrule, { freq: 'monthly', nth: -1, wd: 5 }, 'the last Friday');
  assert.equal(ev('FREQ=MONTHLY;BYDAY=5MO').rrule, null, 'the fifth Monday: not supported, one-off');
});

test('our own calendar files read back the same', () => {
  const e = { id: 'e1', title: 'Board, Q4; final', location: 'HQ', description: 'a\nb', start: Date.UTC(2026, 10, 2, 9), end: Date.UTC(2026, 10, 2, 10), all_day: 0,
    rrule: { freq: 'weekly', byday: [1, 3], until: Date.UTC(2027, 0, 1) }, exdates: [Date.UTC(2026, 10, 4, 9)] };
  const back = parseIcsEvent(buildIcs(e, { method: null, uid: 'e1@x', tz: 'Europe/London' }));
  assert.deepEqual([back.title, back.location, back.description, back.start, back.end], [e.title, e.location, e.description, e.start, e.end]);
  assert.deepEqual(back.rrule, e.rrule);
  assert.deepEqual(back.exdates, e.exdates);
  assert.ok(!buildIcs(e, { method: null, uid: 'e1@x' }).includes('METHOD:'), 'no METHOD in stored calendar objects');
});

test('contact cards: fields Workspace shows, everything else kept', () => {
  const card = ['BEGIN:VCARD', 'VERSION:3.0', 'PRODID:-//Apple Inc.//iPhone OS 18//EN', 'N:Tan;Mei Ling;;;', 'FN:Mei Ling Tan', 'ORG:Harbour Logistics;Sales',
    'EMAIL;type=INTERNET;type=WORK:mei@harbour.example', 'EMAIL;type=INTERNET;type=HOME;type=pref:meiling@home.example',
    'TEL;type=CELL;type=VOICE;type=pref:+60 12-345 6789', 'TEL;type=WORK:+60 4-123 4567', 'item1.ADR;type=WORK:;;1 Jalan Pantai;George Town;;10300;Malaysia',
    'BDAY:1990-04-01', 'NOTE:Met at the trade fair\\, Penang', 'UID:5D3A-11', 'END:VCARD'].join('\r\n');
  const c = parseVcard(card);
  assert.deepEqual([c.uid, c.name, c.email, c.phone, c.company, c.notes], ['5D3A-11', 'Mei Ling Tan', 'meiling@home.example', '+60 12-345 6789', 'Harbour Logistics', 'Met at the trade fair, Penang']);
  // The other address and number are shown too (not just kept on the card).
  assert.deepEqual(c.more_emails, [{ type: 'work', value: 'mei@harbour.example' }]);
  assert.deepEqual(c.more_phones, [{ type: 'work', value: '+60 4-123 4567' }]);
  assert.doesNotMatch(c.vcard_extra, /EMAIL|TEL/);
  assert.match(c.vcard_extra, /item1\.ADR/);
  assert.equal(c.birthday, '1990-04-01');
  assert.doesNotMatch(c.vcard_extra, /BDAY/);
  assert.ok(!/PRODID|^FN/m.test(c.vcard_extra));
  // Written back: Workspace's fields, then the rest; reading it again gives the same.
  const again = parseVcard(buildVcard({ id: 'c1', ...c, vcard_uid: c.uid }));
  assert.deepEqual(again, c);
  assert.equal(parseVcard('hello').error, 'Not a contact card');
  assert.equal(parseVcard('BEGIN:VCARD\r\nN:Lee;Sam;;Dr.;\r\nEND:VCARD').name, 'Dr. Sam Lee', 'no FN: from N');
});

test('mail-app passwords (Dovecot format) verify', () => {
  const h = dovecotHash('abcd-efgh-ijkl-mnop', 5000);
  assert.equal(verifyDovecotHash('abcd-efgh-ijkl-mnop', h), true);
  assert.equal(verifyDovecotHash('abcd-efgh-ijkl-mnoq', h), false);
  assert.equal(verifyDovecotHash('x', null), false);
});

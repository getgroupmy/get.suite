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

// ---- time zones as Outlook (Windows) and others name them
import { parseIcsEvent, ianaFor, resolveZone } from '../src/ics.js';
const cal = (tzBlock, ev) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${tzBlock}BEGIN:VEVENT\r\nUID:x1\r\nSUMMARY:Call\r\n${ev}END:VEVENT\r\nEND:VCALENDAR\r\n`;
const WEU = 'BEGIN:VTIMEZONE\r\nTZID:W. Europe Standard Time\r\nBEGIN:STANDARD\r\nDTSTART:16010101T030000\r\nTZOFFSETFROM:+0200\r\nTZOFFSETTO:+0100\r\nRRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10\r\nEND:STANDARD\r\nBEGIN:DAYLIGHT\r\nDTSTART:16010101T020000\r\nTZOFFSETFROM:+0100\r\nTZOFFSETTO:+0200\r\nRRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3\r\nEND:DAYLIGHT\r\nEND:VTIMEZONE\r\n';

test('Windows zone names from Outlook map to IANA zones', () => {
  assert.equal(ianaFor('W. Europe Standard Time'), 'Europe/Berlin');
  assert.equal(ianaFor('"Singapore Standard Time"'), 'Asia/Singapore');
  assert.equal(ianaFor('eastern standard time'), 'America/New_York');
  assert.equal(ianaFor('/mozilla.org/20050126_1/America/New_York'), 'America/New_York');
  assert.equal(ianaFor('Asia/Kuala_Lumpur'), 'Asia/Kuala_Lumpur');
  assert.equal(ianaFor('Customized Time Zone'), null);
  const e = parseIcsEvent(cal(WEU, 'DTSTART;TZID=W. Europe Standard Time:20260115T090000\r\nDTEND;TZID=W. Europe Standard Time:20260115T100000\r\nRRULE:FREQ=WEEKLY;BYDAY=TH\r\n'), { tz: 'Asia/Kuala_Lumpur' });
  assert.equal(new Date(e.start).toISOString(), '2026-01-15T08:00:00.000Z');
  assert.equal(e.tz, 'Europe/Berlin');
  assert.deepEqual(e.rrule, { freq: 'weekly', byday: [4] });
});

test("a zone Workspace doesn't know by name is read from the file's VTIMEZONE", () => {
  const custom = WEU.replace('TZID:W. Europe Standard Time', 'TZID:Customized Time Zone');
  const summer = parseIcsEvent(cal(custom, 'DTSTART;TZID="Customized Time Zone":20260715T090000\r\nDTEND;TZID="Customized Time Zone":20260715T093000\r\n'), { tz: 'UTC' });
  assert.equal(new Date(summer.start).toISOString(), '2026-07-15T07:00:00.000Z'); // +02:00 in summer
  assert.equal(new Date(summer.end).toISOString(), '2026-07-15T07:30:00.000Z');
  assert.equal(offsetAt(Date.UTC(2026, 6, 1), summer.tz), 120); // kept under a zone with the same clock changes
  assert.equal(offsetAt(Date.UTC(2026, 0, 1), summer.tz), 60);
  // the day of the change: 29 March 2026, 02:00 local → 03:00
  const z = resolveZone('Customized Time Zone', { 'Customized Time Zone': [] }, 'UTC');
  assert.equal(z, 'UTC'); // an empty definition falls back
  const kl = 'BEGIN:VTIMEZONE\r\nTZID:(UTC+08:00) Kuala Lumpur\\, Singapore\r\nBEGIN:STANDARD\r\nDTSTART:16010101T000000\r\nTZOFFSETFROM:+0800\r\nTZOFFSETTO:+0800\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\n';
  const e = parseIcsEvent(cal(kl, 'DTSTART;TZID="(UTC+08:00) Kuala Lumpur, Singapore":20261201T100000\r\nDTEND;TZID="(UTC+08:00) Kuala Lumpur, Singapore":20261201T110000\r\n'), { tz: 'Asia/Kuala_Lumpur' });
  assert.equal(new Date(e.start).toISOString(), '2026-12-01T02:00:00.000Z');
  assert.equal(e.tz, 'Asia/Kuala_Lumpur'); // the person's own zone, as it keeps the same clock
});

test('US daylight-saving rules from a VTIMEZONE, either side of the change', () => {
  const us = 'BEGIN:VTIMEZONE\r\nTZID:My Eastern\r\nBEGIN:STANDARD\r\nDTSTART:16011104T020000\r\nRRULE:FREQ=YEARLY;BYDAY=1SU;BYMONTH=11\r\nTZOFFSETFROM:-0400\r\nTZOFFSETTO:-0500\r\nEND:STANDARD\r\nBEGIN:DAYLIGHT\r\nDTSTART:16010311T020000\r\nRRULE:FREQ=YEARLY;BYDAY=2SU;BYMONTH=3\r\nTZOFFSETFROM:-0500\r\nTZOFFSETTO:-0400\r\nEND:DAYLIGHT\r\nEND:VTIMEZONE\r\n';
  const at = (local) => new Date(parseIcsEvent(cal(us, `DTSTART;TZID=My Eastern:${local}\r\n`), { tz: 'UTC' }).start).toISOString();
  assert.equal(at('20260307T120000'), '2026-03-07T17:00:00.000Z'); // the day before: -05:00
  assert.equal(at('20260308T120000'), '2026-03-08T16:00:00.000Z'); // 8 March 2026 is the 2nd Sunday: -04:00
  assert.equal(at('20261101T120000'), '2026-11-01T17:00:00.000Z'); // 1 November: back to -05:00
  const e = parseIcsEvent(cal(us, 'DTSTART;TZID=My Eastern:20260601T090000\r\n'), { tz: 'America/New_York' });
  assert.equal(e.tz, 'America/New_York');
});

test('an unknown zone with no definition uses the person\'s own', () => {
  const e = parseIcsEvent(cal('', 'DTSTART;TZID=Somewhere Else:20260601T090000\r\n'), { tz: 'Asia/Tokyo' });
  assert.equal(new Date(e.start).toISOString(), '2026-06-01T00:00:00.000Z');
  assert.equal(e.tz, 'Asia/Tokyo');
});

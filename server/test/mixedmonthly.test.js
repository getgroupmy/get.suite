// Monthly repeats on mixed weekdays of the month (as phones and Outlook can write them): the first Monday and the
// third Tuesday, or every Monday and Wednesday of every other month. Read from a calendar file, shown, written back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIcsEvent, buildIcs } from '../src/ics.js';
import { expand, describeRule, shiftWeekdays } from '../src/calmath.js';

const cal = (rule, start = '20261102T090000') => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:m1\r\nDTSTART;TZID=Europe/London:${start}\r\nDTEND;TZID=Europe/London:${start.slice(0, 9)}100000\r\nSUMMARY:Board\r\nRRULE:${rule}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
const days = (ev, months = 3) => expand(ev, ev.start, ev.start + months * 31 * 864e5).map((o) => new Date(o.start).toISOString().slice(0, 10));

test('the first Monday and the third Tuesday: read, its dates, its words', () => {
  const e = parseIcsEvent(cal('FREQ=MONTHLY;BYDAY=1MO,3TU'), { tz: 'UTC' });
  assert.deepEqual(e.rrule, { freq: 'monthly', mdays: [[1, 1], [3, 2]] });
  assert.deepEqual(days(e).slice(0, 6), ['2026-11-02', '2026-11-17', '2026-12-07', '2026-12-15', '2027-01-04', '2027-01-19']);
  assert.equal(describeRule(e.rrule, e.start, 'en-GB'), 'Monthly on the first Monday and the third Tuesday');
});

test('every Monday and Wednesday of every other month', () => {
  const e = parseIcsEvent(cal('FREQ=MONTHLY;INTERVAL=2;BYDAY=MO,WE;COUNT=12'), { tz: 'UTC' });
  assert.equal(e.rrule.interval, 2);
  const d = days(e, 4);
  assert.deepEqual(d.slice(0, 9), ['2026-11-02', '2026-11-04', '2026-11-09', '2026-11-11', '2026-11-16', '2026-11-18', '2026-11-23', '2026-11-25', '2026-11-30']);
  assert.deepEqual(d.slice(9), ['2027-01-04', '2027-01-06', '2027-01-11'], 'December skipped; twelve in all');
  assert.equal(describeRule(e.rrule, e.start, 'en-GB'), 'Every 2 months on every Monday and every Wednesday, 12 times');
});

test('written back the way it came, and read again the same', () => {
  for (const rule of ['FREQ=MONTHLY;BYDAY=1MO,3TU', 'FREQ=MONTHLY;INTERVAL=2;BYDAY=MO,WE', 'FREQ=MONTHLY;BYDAY=2TH,-1FR']) {
    const e = parseIcsEvent(cal(rule), { tz: 'UTC' });
    const out = buildIcs(e, { method: 'PUBLISH', uid: 'm1', tz: 'Europe/London', organizer: { email: 'a@acme.com', name: 'A' } });
    const line = /RRULE:(.*)/.exec(out)[1].trim();
    assert.equal(line, rule, `${rule} written as ${line}`);
    assert.deepEqual(parseIcsEvent(out, { tz: 'UTC' }).rrule, e.rrule);
  }
});

test('a series that starts on a day it doesn’t include begins on its first real day', () => {
  // Starts Sunday 1 November: the first Monday (the 2nd) is the first one, in the file too.
  const e = parseIcsEvent(cal('FREQ=MONTHLY;BYDAY=1MO,3TU', '20261101T090000'), { tz: 'UTC' });
  const out = buildIcs(e, { method: 'PUBLISH', uid: 'm1', tz: 'Europe/London', organizer: { email: 'a@acme.com', name: 'A' } });
  assert.match(out, /DTSTART;TZID=Europe\/London:20261102T090000/);
});

test('moved a day later: the first Tuesday and the third Wednesday', () => {
  assert.deepEqual(shiftWeekdays({ freq: 'monthly', mdays: [[1, 1], [3, 2]] }, 1), { freq: 'monthly', mdays: [[1, 2], [3, 3]] });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freeSlots, zonedTime } from '../src/routes/booking.js';

const page = { days: [1, 2, 3, 4, 5], from_min: 9 * 60, to_min: 12 * 60, duration: 60, tz: 'Asia/Kuala_Lumpur', notice_hours: 1, days_ahead: 7 };

test('wall-clock times in a time zone', () => {
  assert.equal(new Date(zonedTime(2026, 10, 9, 9 * 60, 'Asia/Kuala_Lumpur')).toISOString(), '2026-11-09T01:00:00.000Z');
  assert.equal(new Date(zonedTime(2026, 2, 30, 9 * 60, 'Europe/London')).toISOString(), '2026-03-30T08:00:00.000Z', 'after the clocks change');
  assert.equal(new Date(zonedTime(2026, 2, 27, 9 * 60, 'Europe/London')).toISOString(), '2026-03-27T09:00:00.000Z', 'before');
});

test('free slots: weekdays only, within the hours, after the notice, around busy times', () => {
  const now = Date.parse('2026-11-06T01:30:00Z'); // Fri 9:30 in Kuala Lumpur
  const busy = [{ start: Date.parse('2026-11-09T02:00:00Z'), end: Date.parse('2026-11-09T02:30:00Z') }]; // Mon 10:00–10:30
  const days = freeSlots(page, busy, now);
  assert.equal(days[0].date, '2026-11-06');
  assert.deepEqual(days[0].slots.map((t) => new Date(t).toISOString()), ['2026-11-06T03:00:00.000Z'], 'Friday: only 11:00 is an hour ahead');
  assert.equal(days[1].date, '2026-11-09', 'the weekend is skipped');
  assert.deepEqual(days[1].slots.map((t) => new Date(t).toISOString().slice(11, 16)), ['01:00', '03:00'], 'Monday 10:00 is busy');
  assert.equal(days.length, 5);
});

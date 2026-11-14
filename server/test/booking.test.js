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

test('free slots: a gap kept around busy times, and a limit of bookings a day', () => {
  const now = Date.parse('2026-11-06T01:30:00Z'); // Fri 9:30 in Kuala Lumpur
  const busy = [{ start: Date.parse('2026-11-09T02:00:00Z'), end: Date.parse('2026-11-09T02:30:00Z') }]; // Mon 10:00–10:30
  const mon = (p, booked = []) => freeSlots(p, busy, now, booked).find((d) => d.date === '2026-11-09')?.slots.map((t) => new Date(t).toISOString().slice(11, 16));
  assert.deepEqual(mon({ ...page, buffer_min: 0 }), ['01:00', '03:00']);
  assert.deepEqual(mon({ ...page, buffer_min: 30 }), ['03:00'], '9:00–10:00 ends right at 10:00: too close');
  assert.deepEqual(mon({ ...page, buffer_min: 60 }), undefined, '11:00 starts only 30 minutes after: no times left on Monday');
  const tue = Date.parse('2026-11-10T01:00:00Z');
  const days = (p, booked) => freeSlots(p, [], now, booked).map((d) => d.date);
  assert.ok(days({ ...page, max_per_day: 1 }, [tue]).includes('2026-11-09'));
  assert.ok(!days({ ...page, max_per_day: 1 }, [tue]).includes('2026-11-10'), 'Tuesday has its one booking');
  assert.ok(days({ ...page, max_per_day: 2 }, [tue]).includes('2026-11-10'));
  assert.ok(days({ ...page, max_per_day: 0 }, [tue, tue, tue]).includes('2026-11-10'), '0: no limit');
});

test('free slots: none on a company holiday', () => {
  const now = Date.parse('2026-11-06T01:30:00Z');
  const open = freeSlots(page, [], now).map((d) => d.date);
  assert.ok(open.includes('2026-11-10'));
  const closed = freeSlots(page, [], now, [], new Set(['2026-11-10'])).map((d) => d.date);
  assert.ok(!closed.includes('2026-11-10'));
  assert.deepEqual(closed, open.filter((d) => d !== '2026-11-10'));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readHours, withinHours, hoursText, DEFAULT_HOURS } from '../src/workhours.js';

test('working hours are checked', () => {
  assert.deepEqual(readHours({ days: [5, 1, 1, 9], start: 480, end: 960, tz: 'Europe/Berlin' }), { days: [1, 5], start: 480, end: 960, tz: 'Europe/Berlin' });
  assert.throws(() => readHours({ days: [], start: 480, end: 960 }), /working day/);
  assert.throws(() => readHours({ days: [1], start: 600, end: 610 }), /half an hour/);
  assert.equal(readHours({ days: [1], start: 0, end: 1440, tz: 'Nowhere/Land' }).tz, 'UTC');
});

test('a time is inside someone’s hours in their own time zone', () => {
  const berlin = { days: [1, 2, 3, 4, 5], start: 9 * 60, end: 17 * 60, tz: 'Europe/Berlin' };
  const mon = Date.UTC(2026, 10, 9); // Monday 9 November 2026; Berlin is UTC+1
  assert.equal(withinHours(mon + 8 * 36e5, mon + 9 * 36e5, berlin), true, '9:00–10:00 in Berlin');
  assert.equal(withinHours(mon + 7.5 * 36e5, mon + 8.5 * 36e5, berlin), false, 'starts 8:30 in Berlin');
  assert.equal(withinHours(mon + 15.5 * 36e5, mon + 16.5 * 36e5, berlin), false, 'ends 17:30 in Berlin');
  assert.equal(withinHours(mon + 15 * 36e5, mon + 16 * 36e5, berlin), true, 'ends right at 17:00');
  assert.equal(withinHours(mon - 2 * 864e5 + 10 * 36e5, mon - 2 * 864e5 + 11 * 36e5, berlin), false, 'Saturday');
  assert.equal(withinHours(mon + 10 * 36e5, mon + 11 * 36e5, { ...DEFAULT_HOURS, tz: 'UTC' }), true);
});

test('hours read nicely', () => {
  assert.equal(hoursText(DEFAULT_HOURS), 'Mon–Fri 9:00–17:00');
  assert.equal(hoursText({ days: [1, 3, 5], start: 510, end: 840 }), 'Mon, Wed, Fri 8:30–14:00');
});

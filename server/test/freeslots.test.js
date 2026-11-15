import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freeSlots, mergeBusy } from '../src/freeslots.js';

const at = (d, h, m = 0) => Date.UTC(2026, 11, d, h, m); // December 2026 (the 7th is a Monday)
const show = (slots) => slots.map((s) => `${new Date(s.start).toISOString().slice(8, 16)}-${new Date(s.end).toISOString().slice(11, 16)}`);

test('busy times are joined', () => {
  assert.deepEqual(mergeBusy([[5, 10], [1, 3], [8, 12], [12, 13], [20, 20]]), [[1, 3], [5, 13]]);
});

test('the gaps in a working day, earliest first', () => {
  const busy = [[at(7, 9), at(7, 10)], [at(7, 11), at(7, 12, 30)], [at(7, 12), at(7, 15)]];
  assert.deepEqual(show(freeSlots({ busy, from: at(7, 0), to: at(8, 0), minutes: 60 })), ['07T10:00-11:00', '07T15:00-16:00']);
  assert.deepEqual(show(freeSlots({ busy, from: at(7, 0), to: at(8, 0), minutes: 120 })), ['07T15:00-17:00']);
  assert.deepEqual(show(freeSlots({ busy, from: at(7, 0), to: at(8, 0), minutes: 180 })), [], 'nothing long enough');
});

test('starting now: the next quarter hour; weekends skipped unless asked', () => {
  assert.deepEqual(show(freeSlots({ from: at(11, 16, 7), to: at(15, 0), minutes: 30, max: 2 })), ['11T16:15-16:45', '14T09:00-09:30'], 'Friday afternoon, then Monday');
  assert.deepEqual(show(freeSlots({ from: at(11, 16, 7), to: at(15, 0), minutes: 30, max: 2, weekends: true })), ['11T16:15-16:45', '12T09:00-09:30']);
});

test('working hours in the person’s time zone', () => {
  // 9:00 in Kuala Lumpur (UTC+8) is 01:00 UTC.
  assert.deepEqual(show(freeSlots({ from: at(7, 0), to: at(8, 0), minutes: 60, tz: 'Asia/Kuala_Lumpur', max: 1 })), ['07T01:00-02:00']);
  assert.deepEqual(show(freeSlots({ from: at(7, 0), to: at(8, 0), minutes: 30, dayStart: 13, dayEnd: 14, max: 5 })), ['07T13:00-13:30']);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuickEvent, ruleFromRepeat } from './quickevent.js';

const today = '2026-11-13'; // a Friday
const at = (d, h, m = 0) => new Date(2026, 10, d, h, m).getTime();
const when = (e) => [e.title, e.start, e.end, e.all_day];

test('a day and a time: the default length', () => {
  assert.deepEqual(when(parseQuickEvent('Lunch with Kim tomorrow 1pm', { today })), ['Lunch with Kim', at(14, 13), at(14, 14), 0]);
  assert.deepEqual(when(parseQuickEvent('Standup on mon 9:30', { today, minutes: 15 })), ['Standup', at(16, 9, 30), at(16, 9, 45), 0]);
  assert.deepEqual(when(parseQuickEvent('Call at 15:00', { today, minutes: 30 })), ['Call', at(13, 15), at(13, 15, 30), 0], 'a time alone: today');
});

test('a length or a range sets the end', () => {
  assert.deepEqual(when(parseQuickEvent('Dentist friday 10am for 45 minutes', { today })), ['Dentist', at(20, 10), at(20, 10, 45), 0]);
  assert.deepEqual(when(parseQuickEvent('Review tomorrow 2pm for 1.5 hours', { today })), ['Review', at(14, 14), at(14, 15, 30), 0]);
  assert.deepEqual(when(parseQuickEvent('Coffee tomorrow at 8am for half an hour', { today })), ['Coffee', at(14, 8), at(14, 8, 30), 0]);
  assert.deepEqual(when(parseQuickEvent('Workshop 24 Nov 3-5pm', { today })), ['Workshop', at(24, 15), at(24, 17), 0]);
  assert.deepEqual(when(parseQuickEvent('Planning tomorrow 11-1pm', { today })), ['Planning', at(14, 11), at(14, 13), 0], 'starts in the morning');
  assert.deepEqual(when(parseQuickEvent('Interview 10:30 to 11:15 tomorrow', { today })), ['Interview', at(14, 10, 30), at(14, 11, 15), 0]);
  assert.deepEqual(when(parseQuickEvent('Offsite from 9 to 11am on monday', { today })), ['Offsite', at(16, 9), at(16, 11), 0]);
  assert.deepEqual(when(parseQuickEvent('Run for an hour tomorrow', { today })), ['Run', at(14, 9), at(14, 10), 0], 'a day and a length: from 9:00');
});

test('a day alone: all day', () => {
  assert.deepEqual(when(parseQuickEvent('Company holiday 24 Dec', { today })), ['Company holiday', new Date(2026, 11, 24).getTime(), new Date(2026, 11, 25).getTime() - 1, 1]);
});

test('repeats become the calendar\'s rule', () => {
  const e = parseQuickEvent('1:1 with Ana every 2 weeks on tue 10am', { today });
  assert.equal(e.title, '1:1 with Ana');
  assert.equal(e.start, at(17, 10));
  assert.deepEqual(e.rrule, { freq: 'weekly', interval: 2, byday: [2] });
  assert.deepEqual(parseQuickEvent('Gym every weekday 7am', { today }).rrule, { freq: 'weekly', byday: [1, 2, 3, 4, 5] });
  assert.deepEqual(parseQuickEvent('Team lunch friday 12pm weekly', { today }).rrule, { freq: 'weekly', byday: [5] });
  assert.deepEqual(ruleFromRepeat('monthly', at(13, 9)), { freq: 'monthly' });
  assert.deepEqual(ruleFromRepeat('every:3:month', at(13, 9)), { freq: 'monthly', interval: 3 });
  assert.equal(ruleFromRepeat(null, 0), null);
});

test('task-only words stay in the title; numbers that aren\'t times too', () => {
  assert.equal(parseQuickEvent('Launch #marketing ! with @kim tomorrow 3pm', { today }).title, 'Launch #marketing ! with @kim');
  const e = parseQuickEvent('Dinner for 2-3 people friday 7pm', { today });
  assert.deepEqual(when(e), ['Dinner for 2-3 people', at(20, 19), at(20, 20), 0]);
});

test('only a day and time: no title; nothing to go on: null', () => {
  assert.deepEqual(when(parseQuickEvent('tomorrow 3pm', { today })), ['', at(14, 15), at(14, 16), 0]);
  assert.equal(parseQuickEvent('Think about the roadmap', { today }), null);
  assert.equal(parseQuickEvent('', { today }), null);
});

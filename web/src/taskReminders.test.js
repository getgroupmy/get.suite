import { test } from 'node:test';
import assert from 'node:assert/strict';
import { morningSummary, untilMorning, comingTimed } from './taskReminders.js';

const now = new Date(2026, 10, 6, 10, 0);
test('the morning note: due today and overdue, in words', () => {
  assert.equal(morningSummary([], now), null);
  assert.equal(morningSummary([{ title: 'Later', due: '2026-11-20' }], now), null);
  assert.equal(morningSummary([{ title: 'Pay rent', due: '2026-11-06' }], now).text, '“Pay rent” is due today');
  const m = morningSummary([{ title: 'a', due: '2026-11-06' }, { title: 'b', due: '2026-11-06' }, { title: 'c', due: '2026-11-01' }, { title: 'd', due: '2026-11-01', done: true }], now);
  assert.deepEqual(m, { text: '2 tasks are due today, and 1 is overdue', dueToday: 2, overdue: 1 });
  assert.equal(morningSummary([{ title: 'c', due: '2026-11-01' }, { title: 'e', due: '2026-10-01' }], now).text, '2 are overdue');
});

test('when the morning note is due', () => {
  assert.equal(untilMorning(new Date(2026, 10, 6, 10, 0)), 0);
  assert.equal(untilMorning(new Date(2026, 10, 6, 8, 30)), 30 * 6e4);
});

test('timed tasks still to come today or tomorrow, soonest first', () => {
  const now = new Date(2026, 10, 6, 15, 0).getTime();
  const tasks = [
    { id: 'a', due: '2026-11-06', due_time: '16:00' },
    { id: 'b', due: '2026-11-06', due_time: '14:00' }, // past
    { id: 'c', due: '2026-11-06', due_time: '15:30' },
    { id: 'd', due: '2026-11-06' }, // no time
    { id: 'e', due: '2026-11-07', due_time: '09:00' },
    { id: 'f', due: '2026-11-08', due_time: '09:00' }, // more than a day away
    { id: 'g', due: '2026-11-06', due_time: '17:00', done: true },
  ];
  assert.deepEqual(comingTimed(tasks, now).map((x) => x.task.id), ['c', 'a', 'e']);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { morningSummary, untilMorning } from './taskReminders.js';

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

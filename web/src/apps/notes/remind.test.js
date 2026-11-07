import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quickTimes, reminderText } from './remind.js';

test('quick reminder times', () => {
  const sat10 = new Date(2026, 10, 7, 10, 0); // Saturday 10:00
  const q = quickTimes(sat10);
  assert.deepEqual(q.map(([l]) => l), ['Later today', 'Tomorrow', 'Next week']);
  assert.equal(new Date(q[0][1]).getHours(), 18);
  assert.equal(new Date(q[1][1]).getDate(), 8);
  assert.equal(new Date(q[2][1]).getDay(), 1, 'Monday');
  assert.equal(new Date(q[2][1]).getDate(), 9);
  assert.deepEqual(quickTimes(new Date(2026, 10, 7, 19, 0)).map(([l]) => l), ['Tomorrow', 'Next week'], 'no "later today" in the evening');
  const mon = quickTimes(new Date(2026, 10, 9, 9, 0));
  assert.equal(new Date(mon[2][1]).getDate(), 16, 'a Monday picks the next one');
});

test('reminder text', () => {
  const now = new Date(2026, 10, 7, 10, 0);
  assert.match(reminderText(new Date(2026, 10, 7, 18, 0).getTime(), now), /^Today, (18[:.]00|06[:.]00 PM)$/);
  assert.match(reminderText(new Date(2026, 10, 8, 8, 0).getTime(), now), /^Tomorrow, /);
});

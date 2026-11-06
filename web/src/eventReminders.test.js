import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dueReminders, startsIn } from './eventReminders.js';

test('which reminders are due', () => {
  const now = Date.UTC(2026, 10, 6, 8, 0);
  const ev = (id, startMin, reminders, extra = {}) => ({ id, start: now + startMin * 6e4, end: now + (startMin + 30) * 6e4, reminders, ...extra });
  const due = dueReminders([
    ev('a', 15, [10, 30]), // 10 before: in 5 minutes; 30 before: 15 minutes ago (too late)
    ev('b', 2, [5]), // 3 minutes ago: still shown
    ev('c', 60 * 30, [10]), // tomorrow afternoon: beyond the horizon
    ev('d', 20, [10], { role: 'guest', my_status: 'no' }), // declined
    ev('e', -40, [0]), // already over
  ], now);
  assert.deepEqual(due.map((d) => `${d.ev.id}:${d.minutes}`), ['b:5', 'a:10']);
  assert.equal(due[0].key, `b@${now + 2 * 6e4}:5`);
});

test('when it starts, in words', () => {
  const now = Date.UTC(2026, 10, 6, 8, 0);
  assert.equal(startsIn({ start: now + 10 * 6e4 }, now), 'in 10 minutes');
  assert.equal(startsIn({ start: now + 6e4 }, now), 'in 1 minute');
  assert.equal(startsIn({ start: now + 60 * 6e4 }, now), 'in 1 hour');
  assert.equal(startsIn({ start: now }, now), 'now');
  assert.match(startsIn({ start: now + 90 * 6e4 }, now), /^at /);
});

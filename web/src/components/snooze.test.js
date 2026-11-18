import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snoozeTimes } from './snooze.js';

test('snooze times: later today while still today, tomorrow at 9, next Monday at 9', () => {
  const wed = new Date(2026, 10, 18, 14, 30); // a Wednesday afternoon
  const t = snoozeTimes(wed);
  assert.deepEqual(t.map((x) => x.label), ['Later today', 'Tomorrow', 'Next week']);
  assert.equal(t[0].at, wed.getTime() + 3 * 3600e3);
  assert.equal(t[1].at, new Date(2026, 10, 19, 9, 0).getTime());
  assert.equal(t[2].at, new Date(2026, 10, 23, 9, 0).getTime());
  // Late in the evening: no "later today"; on a Monday, next week is the Monday after.
  assert.deepEqual(snoozeTimes(new Date(2026, 10, 18, 22, 0)).map((x) => x.label), ['Tomorrow', 'Next week']);
  assert.equal(snoozeTimes(new Date(2026, 10, 23, 8, 0)).at(-1).at, new Date(2026, 10, 30, 9, 0).getTime());
});

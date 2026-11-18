import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byDay, dayHeading } from './bellday.js';

test('notifications under Today, Yesterday, Earlier this week and Older', () => {
  const now = new Date(2026, 10, 18, 9, 0);
  const at = (d, h) => new Date(2026, 10, d, h).getTime();
  assert.equal(dayHeading(at(18, 0), now), 'Today');
  assert.equal(dayHeading(at(17, 23), now), 'Yesterday');
  assert.equal(dayHeading(at(17, 0), now), 'Yesterday');
  assert.equal(dayHeading(at(16, 23), now), 'Earlier this week');
  assert.equal(dayHeading(at(11, 0), now), 'Earlier this week');
  assert.equal(dayHeading(at(10, 23), now), 'Older');
  const groups = byDay([{ id: 1, created_at: at(18, 8) }, { id: 2, created_at: at(18, 1) }, { id: 3, created_at: at(15, 1) }, { id: 4, created_at: at(1, 1) }], now);
  assert.deepEqual(groups.map((g) => [g.heading, g.items.map((x) => x.id)]), [['Today', [1, 2]], ['Earlier this week', [3]], ['Older', [4]]]);
  assert.deepEqual(byDay([], now), []);
});

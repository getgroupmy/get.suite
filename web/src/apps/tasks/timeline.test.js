import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, daysFrom, mondayOf, barOf, timelineRange, dragChange } from './timeline.js';

test('days: adding, counting, the Monday of a week', () => {
  assert.equal(addDays('2026-12-30', 3), '2027-01-02');
  assert.equal(daysFrom('2026-02-27', '2026-03-02'), 3);
  assert.equal(mondayOf('2026-11-08'), '2026-11-02'); // a Sunday
  assert.equal(mondayOf('2026-11-09'), '2026-11-09');
});

test('a task as a bar: start to due, or just its due day', () => {
  assert.deepEqual(barOf({ start: '2026-12-01', due: '2026-12-04' }), { from: '2026-12-01', to: '2026-12-04' });
  assert.deepEqual(barOf({ due: '2026-12-04' }), { from: '2026-12-04', to: '2026-12-04' });
  assert.equal(barOf({ start: '2026-12-01' }), null);
});

test('the strip starts a week before the earliest bar and covers the latest', () => {
  const r = timelineRange([{ start: '2026-11-18', due: '2026-11-20' }, { due: '2027-03-01' }], '2026-11-25');
  assert.equal(r.from, '2026-11-09');
  assert.ok(daysFrom(r.from, '2027-03-01') < r.days);
  assert.equal(r.days % 7, 0);
  assert.deepEqual(timelineRange([], '2026-11-25'), { from: '2026-11-16', days: 42 });
});

test('dragging: the whole bar, its end, or its start', () => {
  const t = { start: '2026-12-01', due: '2026-12-04' };
  assert.deepEqual(dragChange(t, 'move', 2), { start: '2026-12-03', due: '2026-12-06' });
  assert.deepEqual(dragChange({ due: '2026-12-04' }, 'move', -1), { due: '2026-12-03' });
  assert.deepEqual(dragChange(t, 'end', 3), { due: '2026-12-07' });
  assert.deepEqual(dragChange(t, 'end', -9), { due: '2026-12-01' }, 'not before the start');
  assert.deepEqual(dragChange({ due: '2026-12-04' }, 'start', -2), { start: '2026-12-02' });
  assert.deepEqual(dragChange(t, 'start', 9), { start: '2026-12-04' }, 'not after the due date');
  assert.deepEqual(dragChange(t, 'move', 0), {});
});

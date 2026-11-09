import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planGroup, groupPlanned } from './planned.js';

test('which group a due date falls in', () => {
  const today = '2026-11-09';
  assert.equal(planGroup('2026-11-01', today), 'overdue');
  assert.equal(planGroup('2026-11-09', today), 'today');
  assert.equal(planGroup('2026-11-10', today), 'tomorrow');
  assert.equal(planGroup('2026-11-16', today), 'week');
  assert.equal(planGroup('2026-11-17', today), 'later');
  assert.equal(planGroup('2026-12-31', '2026-12-30'), 'tomorrow', 'across the year');
  assert.equal(planGroup(null, today), null);
});

test('grouped, in order, without empty groups', () => {
  const g = groupPlanned([{ id: 1, due: '2026-11-20' }, { id: 2, due: '2026-11-08' }, { id: 3, due: '2026-11-09' }, { id: 4 }], '2026-11-09');
  assert.deepEqual(g.map((x) => [x.key, x.tasks.map((t) => t.id)]), [['overdue', [2]], ['today', [3]], ['later', [1]]]);
});

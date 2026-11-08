import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addGroup, removeGroups, toggleGroup, collapsedOn, toggleAt, adjustGroups } from './groups.js';

test('grouping rows and columns: add, refuse overlaps, collapse, ungroup', () => {
  let g = addGroup(null, 'row', 2, 5);
  g = addGroup(g, 'col', 1, 3);
  assert.equal(addGroup(g, 'row', 4, 8), null, 'overlaps');
  g = addGroup(g, 'row', 8, 9);
  assert.deepEqual(g.map((x) => [x.axis, x.from, x.to]), [['col', 1, 3], ['row', 2, 5], ['row', 8, 9]]);
  assert.deepEqual([...collapsedOn(g, 'row')], []);
  g = toggleGroup(g, 'row', 2);
  assert.deepEqual([...collapsedOn(g, 'row')], [2, 3, 4, 5]);
  assert.equal(toggleAt(g, 'row').get(6).from, 2, 'the − / + just after it');
  assert.deepEqual(removeGroups(g, 'row', 3, 3).map((x) => x.from), [1, 8]);
  assert.equal(removeGroups([{ axis: 'row', from: 1, to: 2 }], 'row', 0, 9), null);
});

test('groups move with inserted and deleted rows', () => {
  const g = [{ axis: 'row', from: 4, to: 6, collapsed: true }, { axis: 'col', from: 0, to: 1 }];
  assert.deepEqual(adjustGroups(g, { axis: 'row', at: 0, count: 2 })[1], { axis: 'row', from: 6, to: 8, collapsed: true });
  assert.deepEqual(adjustGroups(g, { axis: 'row', at: 5, count: 1 })[1], { axis: 'row', from: 4, to: 7, collapsed: true }, 'inside: it grows');
  assert.deepEqual(adjustGroups(g, { axis: 'row', at: 5, count: -1 })[1], { axis: 'row', from: 4, to: 5, collapsed: true }, 'inside: it shrinks');
  assert.deepEqual(adjustGroups(g, { axis: 'row', at: 1, count: -2 })[1], { axis: 'row', from: 2, to: 4, collapsed: true }, 'before: it moves up');
  assert.equal(adjustGroups(g, { axis: 'row', at: 3, count: -5 }).length, 1, 'all deleted: gone');
  assert.deepEqual(adjustGroups(g, { axis: 'row', at: 3, count: -2 })[1], { axis: 'row', from: 3, to: 4, collapsed: true }, 'overlapping its start');
});

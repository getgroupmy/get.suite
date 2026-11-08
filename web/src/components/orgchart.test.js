import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orgTree, chainOf } from './orgchart.js';

test('org chart: a tree from managers, with people on their own after', () => {
  const people = [
    { id: 'e', name: 'Eve', manager_id: 'm' }, { id: 'c', name: 'Cleo' }, { id: 'm', name: 'Max', manager_id: 'c' },
    { id: 'a', name: 'Al', manager_id: 'm' }, { id: 'z', name: 'Zed' }, { id: 'x', name: 'Xi', manager_id: 'gone' }, { id: 'b', name: 'Bo' },
  ];
  const t = orgTree(people);
  assert.deepEqual(t.map((p) => p.name), ['Cleo', 'Bo', 'Xi', 'Zed']);
  assert.deepEqual(t[0].reports.map((p) => p.name), ['Max']);
  assert.deepEqual(t[0].reports[0].reports.map((p) => p.name), ['Al', 'Eve']);
  assert.deepEqual(chainOf(people, 'e').map((p) => p.name), ['Max', 'Cleo']);
  assert.deepEqual(chainOf(people, 'c'), []);
});

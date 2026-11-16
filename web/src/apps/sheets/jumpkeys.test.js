import test from 'node:test';
import assert from 'node:assert/strict';
import { dataEdge, lastUsed } from './jumpkeys.js';

const grid = (keys) => { const s = new Set(keys); return (c, r) => s.has(`${c},${r}`); };
const size = { cols: 26, rows: 100 };

test('within a run of data, Ctrl+Down goes to its last cell', () => {
  const f = grid(['0,0', '0,1', '0,2', '0,3', '0,10']);
  assert.deepEqual(dataEdge(f, 0, 0, 0, 1, size), { c: 0, r: 3 });
});
test('from the end of a run, it goes to the start of the next', () => {
  const f = grid(['0,0', '0,1', '0,2', '0,3', '0,10', '0,11']);
  assert.deepEqual(dataEdge(f, 0, 3, 0, 1, size), { c: 0, r: 10 });
});
test('from an empty cell, to the next filled one', () => {
  const f = grid(['0,40']);
  assert.deepEqual(dataEdge(f, 0, 5, 0, 1, size), { c: 0, r: 40 });
  assert.deepEqual(dataEdge(f, 0, 90, 0, -1, size), { c: 0, r: 40 });
});
test('with nothing further, to the edge of the sheet', () => {
  const f = grid([]);
  assert.deepEqual(dataEdge(f, 0, 5, 0, 1, size), { c: 0, r: 99 });
  assert.deepEqual(dataEdge(f, 3, 5, 1, 0, size), { c: 25, r: 5 });
  assert.deepEqual(dataEdge(f, 3, 5, -1, 0, size), { c: 0, r: 5 });
  assert.deepEqual(dataEdge(f, 0, 0, 0, -1, size), { c: 0, r: 0 }, 'already at the edge');
});
test('Ctrl+End finds the last used row and column, ignoring cleared cells', () => {
  assert.deepEqual(lastUsed({ A1: 'x', C5: '1', B9: '2', Z200: '' }), { c: 2, r: 8 });
  assert.deepEqual(lastUsed({}), { c: 0, r: 0 });
});

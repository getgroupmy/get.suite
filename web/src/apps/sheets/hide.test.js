import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setHidden, anyHidden, hiddenRuns, adjustHide } from './hide.js';
import { applyStructure } from './structure.js';

test('hide and unhide rows and columns', () => {
  let h = setHidden(null, 'row', 2, 3);
  assert.deepEqual(h, { rows: [2, 3] });
  h = setHidden(h, 'col', 1, 1);
  assert.deepEqual(h, { rows: [2, 3], cols: [1] });
  assert.ok(anyHidden(h, 'row', 0, 2));
  assert.ok(!anyHidden(h, 'col', 2, 5));
  h = setHidden(h, 'row', 0, 5, true);
  assert.deepEqual(h, { cols: [1] });
  assert.equal(setHidden(h, 'col', 0, 3, true), null, 'nothing left hidden');
});

test('runs of hidden indexes', () => {
  assert.deepEqual(hiddenRuns([5, 1, 2, 3, 7]), [[1, 3], [5, 5], [7, 7]]);
  assert.deepEqual(hiddenRuns(undefined), []);
});

test('hidden rows and columns move with inserts and deletes', () => {
  const h = { rows: [2, 5], cols: [3] };
  assert.deepEqual(adjustHide(h, { axis: 'row', at: 0, count: 2 }), { rows: [4, 7], cols: [3] });
  assert.deepEqual(adjustHide(h, { axis: 'row', at: 2, count: -1 }), { rows: [4], cols: [3] });
  assert.deepEqual(adjustHide(h, { axis: 'col', at: 3, count: -1 }), { rows: [2, 5] });
  assert.equal(adjustHide({ cols: [3] }, { axis: 'col', at: 3, count: -1 }), null);
  const s = applyStructure({ cells: { A1: '1' }, hide: { rows: [3] } }, { axis: 'row', at: 0, count: 1 });
  assert.deepEqual(s.hide, { rows: [4] });
  assert.equal('hide' in applyStructure({ cells: {}, hide: { rows: [0] } }, { axis: 'row', at: 0, count: -1 }), false);
});

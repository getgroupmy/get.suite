import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heightOf, setHeights, cleanHeights, adjustRowHeights, DEFAULT_H } from './rowheights.js';
import { applyStructure } from './structure.js';

test('setting and clearing row heights', () => {
  const h = setHeights(null, 1, 3, 80);
  assert.deepEqual(h, { 2: 80, 3: 80, 4: 80 });
  assert.equal(heightOf(h, 2), 80);
  assert.equal(heightOf(h, 0), null);
  assert.deepEqual(setHeights(h, 2, 2, ''), { 2: 80, 4: 80 }, 'empty: the standard height');
  assert.deepEqual(setHeights({ 5: 40 }, 4, 4, DEFAULT_H), null, 'the standard height is not stored');
  assert.deepEqual(setHeights(null, 0, 0, 5000), { 1: 600 }, 'at most 600');
  assert.deepEqual(setHeights(null, 0, 0, 2), { 1: 16 }, 'at least 16');
  assert.deepEqual(cleanHeights({ '03': 40.4, x: 9, 0: 50, 7: 'big' }), { 3: 40 });
});

test('row heights move with inserted and deleted rows', () => {
  const h = { 2: 40, 5: 80, 9: 120 };
  assert.deepEqual(adjustRowHeights(h, { axis: 'row', at: 2, count: 2 }), { 2: 40, 7: 80, 11: 120 }, 'two rows above row 3');
  assert.deepEqual(adjustRowHeights(h, { axis: 'row', at: 3, count: -3 }), { 2: 40, 6: 120 }, 'rows 4–6 deleted: row 5 goes, row 9 moves up');
  assert.equal(adjustRowHeights(h, { axis: 'col', at: 0, count: 1 }), h);
  const sheet = applyStructure({ cells: { A5: 'x' }, rowHeights: { 5: 80 } }, { axis: 'row', at: 0, count: 1 });
  assert.deepEqual(sheet.rowHeights, { 6: 80 });
  assert.deepEqual(sheet.cells, { A6: 'x' });
});

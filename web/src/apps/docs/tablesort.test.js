import { test } from 'node:test';
import assert from 'node:assert/strict';
import { numberOf, sortOrder } from './tablesort.js';

test('numbers in cells: separators, currency, percent, minus', () => {
  assert.deepEqual(['1,200', '$3.50', '-4', '12%', '€ 5', '−$2', 'abc', '1.2.3', ''].map(numberOf), [1200, 3.5, -4, 12, 5, -2, null, null, null]);
});

test('sorted A to Z and Z to A: numbers by value before words, words alphabetically (2 before 10), empty cells last', () => {
  const keys = ['Pears', '$1,200', '', 'apples', '350', 'Item 10', 'Item 2', '-5'];
  assert.deepEqual(sortOrder(keys).map((i) => keys[i]), ['-5', '350', '$1,200', 'apples', 'Item 2', 'Item 10', 'Pears', '']);
  assert.deepEqual(sortOrder(keys, true).map((i) => keys[i]), ['Pears', 'Item 10', 'Item 2', 'apples', '$1,200', '350', '-5', '']);
  // Stable: equal values keep their order.
  assert.deepEqual(sortOrder(['b', 'A', 'a', 'B']), [1, 2, 0, 3]);
});

test('a totals row: each column of figures added up, written like its numbers; "Total" first', async () => {
  const { totalsRow } = await import('./tablesort.js');
  const rows = [['Item', 'Cost', 'Qty', 'Share', 'Note'], ['Chairs', '$1,200.00', '3', '12%', 'blue'], ['Desks', '$350', '1,000', '8.5%', ''], ['Lamps', '', '2', '', 'x']];
  assert.deepEqual(totalsRow(rows, true), ['Total', '$1,550.00', '1,005', '20.5%', '']);
  assert.deepEqual(totalsRow([['10', 'a'], ['-15', 'b']]), ['-5', ''], 'a first column of figures is added up too (no "Total" over it)');
  assert.equal(totalsRow([['Item'], ['x']], true), null);
});

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

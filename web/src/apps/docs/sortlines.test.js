import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sortedOrder } from './sortlines.js';

const sorted = (list, desc) => sortedOrder(list, desc).map((i) => list[i]);

test('sort lines: A to Z, numbers as numbers, capitals ignored, blanks last', () => {
  assert.deepEqual(sorted(['pear', 'Apple', 'banana']), ['Apple', 'banana', 'pear']);
  assert.deepEqual(sorted(['Item 10', 'Item 2', 'Item 1']), ['Item 1', 'Item 2', 'Item 10']);
  assert.deepEqual(sorted(['b', '', 'a']), ['a', 'b', '']);
  assert.deepEqual(sorted(['b', '', 'a'], true), ['b', 'a', ''], 'Z to A: blanks still last');
  assert.deepEqual(sortedOrder(['x', 'X', 'a']), [2, 0, 1], 'equal lines keep their order');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moveTo, moveBy } from './order.js';

test('dragging a card onto another takes its place', () => {
  assert.deepEqual(moveTo(['a', 'b', 'c', 'd'], 'd', 'b'), ['a', 'd', 'b', 'c'], 'from later: before it');
  assert.deepEqual(moveTo(['a', 'b', 'c', 'd'], 'a', 'c'), ['b', 'c', 'a', 'd'], 'from earlier: after it');
  assert.deepEqual(moveTo(['a', 'b'], 'a', 'a'), ['a', 'b']);
  assert.deepEqual(moveTo(['a', 'b'], 'x', 'a'), ['a', 'b']);
});

test('a place earlier or later, not past the ends', () => {
  assert.deepEqual(moveBy(['a', 'b', 'c'], 'b', -1), ['b', 'a', 'c']);
  assert.deepEqual(moveBy(['a', 'b', 'c'], 'b', 1), ['a', 'c', 'b']);
  assert.deepEqual(moveBy(['a', 'b', 'c'], 'a', -1), ['a', 'b', 'c']);
  assert.deepEqual(moveBy(['a', 'b', 'c'], 'c', 1), ['a', 'b', 'c']);
});

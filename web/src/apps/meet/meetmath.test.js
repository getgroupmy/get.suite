import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCode, columnsFor, whoIsHere, elapsed } from './meetmath.js';

test('parseCode accepts codes, spaced codes and links', () => {
  assert.equal(parseCode('abc-defg-hij'), 'abc-defg-hij');
  assert.equal(parseCode(' ABC DEFG HIJ '), 'abc-defg-hij');
  assert.equal(parseCode('abcdefghij'), 'abc-defg-hij');
  assert.equal(parseCode('https://work.example.com/meet/xyz-wxyz-abc?x=1'), 'xyz-wxyz-abc');
  assert.equal(parseCode('abc-defg'), null);
  assert.equal(parseCode('abc-defg-hi1'), null);
});

test('grid and text helpers', () => {
  assert.deepEqual([1, 2, 4, 5, 8].map(columnsFor), [1, 2, 2, 3, 3]);
  assert.equal(whoIsHere([]), 'No one else is here yet');
  assert.equal(whoIsHere(['Mia', 'Max']), 'Mia and Max are here');
  assert.equal(whoIsHere(['Mia', 'Max', 'Ann']), 'Mia, Max and 1 other are here');
  assert.equal(whoIsHere(['Mia', 'Max', 'Ann', 'Bo']), 'Mia, Max and 2 others are here');
  assert.equal(elapsed(5000), '0:05');
  assert.equal(elapsed(3723000), '1:02:03');
});

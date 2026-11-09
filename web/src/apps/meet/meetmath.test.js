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

test('spotlight: the pinned person, else whoever presents, else nobody', async () => {
  const { spotlightOf } = await import('./meetmath.js');
  const me = { id: 'me', me: true, state: {} }, kim = { id: 'k', state: {} }, ann = { id: 'a', state: { screen: true } };
  assert.equal(spotlightOf([me, kim], null), null);
  assert.equal(spotlightOf([me, kim, ann], null), 'a', 'a presenter is shown big');
  assert.equal(spotlightOf([me, kim, ann], 'k'), 'k', 'pinning wins');
  assert.equal(spotlightOf([me, ann], 'gone'), 'a', 'a pin on someone who left is let go');
  assert.equal(spotlightOf([{ ...me, state: { screen: true } }, kim], null), null, 'not your own screen');
  assert.equal(spotlightOf([me], 'me'), null, 'alone: no spotlight');
});

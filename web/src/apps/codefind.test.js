import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findInLines, piecesOf } from './codefind.js';

test('matches on every line, ignoring case, not overlapping', () => {
  const lines = ['SELECT total FROM orders', 'where Total > 10', 'aaaa'];
  assert.deepEqual(findInLines(lines, 'total'), [{ line: 0, start: 7, end: 12 }, { line: 1, start: 6, end: 11 }]);
  assert.deepEqual(findInLines(lines, 'aa').map((m) => m.start), [0, 2]);
  assert.deepEqual(findInLines(lines, ''), []);
  assert.deepEqual(findInLines(lines, 'missing'), []);
  assert.equal(findInLines(['x x x x'], 'x', 2).length, 2, 'stops at the most asked for');
});

test('a line in pieces around its matches, numbered among all matches', () => {
  assert.deepEqual(piecesOf('where Total > 10', [{ start: 6, end: 11 }], 3),
    [{ text: 'where ', hit: -1 }, { text: 'Total', hit: 3 }, { text: ' > 10', hit: -1 }]);
  assert.deepEqual(piecesOf('ab', [{ start: 0, end: 2 }], 0), [{ text: 'ab', hit: 0 }]);
  assert.deepEqual(piecesOf('', [], 0), [{ text: '', hit: -1 }]);
});

import { countIn, replaceAllIn } from './codefind.js';

test('replace all: literal, ignoring case unless asked, $ and regex characters mean themselves', () => {
  const t = 'env: Staging\nurl: https://staging.shop/a.b\n';
  assert.equal(countIn(t, 'staging'), 2);
  assert.equal(countIn(t, 'staging', true), 1);
  assert.equal(replaceAllIn(t, 'staging', 'prod'), 'env: prod\nurl: https://prod.shop/a.b\n');
  assert.equal(replaceAllIn(t, 'staging', 'prod', true), 'env: Staging\nurl: https://prod.shop/a.b\n');
  assert.equal(replaceAllIn('a.b a.b', 'a.b', '$1'), '$1 $1');
  assert.equal(replaceAllIn('aaa', 'aa', 'b'), 'ba', 'not overlapping');
  assert.equal(replaceAllIn('x', '', 'y'), 'x');
});

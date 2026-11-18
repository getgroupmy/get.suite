import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ptOf, spacingChoices, PARA_SPACE } from './typography.js';

test('space before / after: only pt, from 0 to 72, counts', () => {
  assert.equal(ptOf('12pt'), 12);
  assert.equal(ptOf(' 6.25pt '), 6.3);
  assert.equal(ptOf('0pt'), null, 'no space is no attribute');
  assert.equal(ptOf('16px'), null, 'a web page’s own margins pasted in don’t count');
  assert.equal(ptOf('100pt'), null);
  assert.equal(ptOf(''), null);
});

test('the spacing menu offers to add space, or to remove what a paragraph has', () => {
  const plain = spacingChoices({});
  assert.deepEqual(plain.slice(-2), [['before-on', 'Add space before paragraph'], ['after-on', 'Add space after paragraph']]);
  assert.equal(plain[0][1], '↕ Spacing');
  assert.deepEqual(spacingChoices({ spaceBefore: PARA_SPACE }).slice(-2).map(([v]) => v), ['before-off', 'after-on']);
  assert.equal(spacingChoices({ spaceAfter: 6 }).at(-1)[1], 'Remove space after paragraph');
});

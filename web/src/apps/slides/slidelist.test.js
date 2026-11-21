import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indentLines } from './slidelist.js';
import { slideListLines } from '../docs/liststyle.js';

test('Tab: the lines under the cursor (or selection) a level in; Shift+Tab out; never past the last level or below the first', () => {
  const v = 'Plan\nCosts\nPeople';
  assert.deepEqual(indentLines(v, 6, 6, 1), { text: 'Plan\n\tCosts\nPeople', first: 1, total: 1 }, 'the cursor in "Costs"');
  assert.deepEqual(indentLines(v, 6, 16, 1), { text: 'Plan\n\tCosts\n\tPeople', first: 1, total: 2 }, 'a selection over two lines');
  assert.deepEqual(indentLines('Plan\n\tCosts', 6, 6, -1), { text: 'Plan\nCosts', first: -1, total: -1 });
  assert.equal(indentLines('Plan', 0, 0, -1).text, 'Plan', 'already at the first level');
  assert.equal(indentLines('\t\t\tDeep', 0, 0, 1).text, '\t\t\tDeep', 'already at the last level');
});

test('levels: numbers count at each level, starting again under a new point; points under others show –', () => {
  const n = slideListLines('Plan\n\tCosts\n\tPeople\nDo\n\tOne', 'lower-roman');
  assert.deepEqual(n.map((l) => [l.level, l.marker, l.text]), [[0, 'i.', 'Plan'], [1, 'i.', 'Costs'], [1, 'ii.', 'People'], [0, 'ii.', 'Do'], [1, 'i.', 'One']]);
  assert.deepEqual(slideListLines('A\n\tB', 'check').map((l) => l.marker), ['✓', '–']);
  assert.equal(slideListLines('\t\t\t\t\tToo deep', 'disc')[0].level, 3);
});

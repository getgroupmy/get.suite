import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEvaluator } from './formula.js';
import { columnStats } from './colstats.js';

const cells = { A1: 'Status', A2: 'Done', A3: 'Open', A4: 'Done', A6: 'Done', B1: 'Cost', B2: '10', B3: '30', B4: '=B2+B3', B5: '5', B6: 'n/a' };
const value = createEvaluator(cells);

test('counts, different values and the most frequent ones', () => {
  const s = columnStats(value, 0, 0, 5, { header: true });
  assert.deepEqual([s.rows, s.filled, s.empty, s.unique], [5, 4, 1, 2]);
  assert.deepEqual(s.frequent, [{ label: 'Done', count: 3 }, { label: 'Open', count: 1 }]);
  assert.equal(s.numbers, null, 'no numbers in a text column');
});

test('numbers: sum, average, median, smallest, largest (formulas by their results)', () => {
  const s = columnStats(value, 1, 0, 5, { header: true });
  assert.deepEqual(s.numbers, { count: 4, sum: 85, average: 21.25, median: 20, min: 5, max: 40 });
  assert.equal(s.filled, 5, 'text in a number column still counts as filled');
  assert.equal(columnStats(value, 1, 1, 3).numbers.median, 30, 'odd count: the middle one');
});

test('the heading row counts when it isn\'t one', () => {
  assert.equal(columnStats(value, 0, 0, 5).frequent.some((f) => f.label === 'Status'), true);
  assert.equal(columnStats(value, 0, 0, 5, { top: 1 }).frequent.length, 1);
});

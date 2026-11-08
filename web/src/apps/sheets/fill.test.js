import { test } from 'node:test';
import assert from 'node:assert/strict';
import { continueSeries, fillCells, fillTarget, selectionStats } from './fill.js';

test('fill: series carry on', () => {
  assert.deepEqual(continueSeries(['1', '2'], 3), ['3', '4', '5']);
  assert.deepEqual(continueSeries(['10', '20'], 2), ['30', '40']);
  assert.deepEqual(continueSeries(['0.5', '0.75'], 2), ['1', '1.25']);
  assert.deepEqual(continueSeries(['7'], 2), ['7', '7'], 'one number repeats');
  assert.deepEqual(continueSeries(['1', '5', '2'], 4), ['1', '5', '2', '1'], 'uneven steps repeat');
  assert.deepEqual(continueSeries(['Item 1'], 2), ['Item 2', 'Item 3']);
  assert.deepEqual(continueSeries(['Week 2', 'Week 4'], 2), ['Week 6', 'Week 8']);
  assert.deepEqual(continueSeries(['Q-09'], 2), ['Q-10', 'Q-11']);
  assert.deepEqual(continueSeries(['Mon'], 3), ['Tue', 'Wed', 'Thu']);
  assert.deepEqual(continueSeries(['saturday'], 2), ['sunday', 'monday']);
  assert.deepEqual(continueSeries(['Nov', 'Dec'], 2), ['Jan', 'Feb']);
  assert.deepEqual(continueSeries(['JANUARY', 'MARCH'], 2), ['MAY', 'JULY']);
  assert.deepEqual(continueSeries(['Q3'], 2), ['Q4', 'Q1']);
  assert.deepEqual(continueSeries(['yes', 'no'], 3), ['yes', 'no', 'yes']);
  assert.deepEqual(continueSeries(['=A1*2'], 2, (i) => [0, i + 1]), ['=A2*2', '=A3*2']);
  assert.deepEqual(continueSeries([undefined], 2), ['', '']);
});

test('fill: down, up, right and left over a box', () => {
  const cells = { A1: '1', A2: '2', B1: '=A1+1', B2: '=A2+1' };
  assert.deepEqual(fillCells(cells, { c1: 0, r1: 0, c2: 1, r2: 1 }, { c1: 0, r1: 0, c2: 1, r2: 3 }), { A3: '3', A4: '4', B3: '=A3+1', B4: '=A4+1' });
  assert.deepEqual(fillCells({ A5: '10', A6: '20' }, { c1: 0, r1: 4, c2: 0, r2: 5 }, { c1: 0, r1: 2, c2: 0, r2: 5 }), { A4: '0', A3: '-10' });
  assert.deepEqual(fillCells({ A1: 'Jan' }, { c1: 0, r1: 0, c2: 0, r2: 0 }, { c1: 0, r1: 0, c2: 2, r2: 0 }), { B1: 'Feb', C1: 'Mar' });
  assert.deepEqual(fillCells({ C1: '=D1' }, { c1: 2, r1: 0, c2: 2, r2: 0 }, { c1: 1, r1: 0, c2: 2, r2: 0 }), { B1: '=C1' });
  assert.deepEqual(fillTarget({ c1: 0, r1: 0, c2: 0, r2: 1 }, 1, 6), { c1: 0, r1: 0, c2: 0, r2: 6 });
  assert.deepEqual(fillTarget({ c1: 2, r1: 2, c2: 2, r2: 2 }, 0, 3), { c1: 0, r1: 2, c2: 2, r2: 2 });
  assert.equal(fillTarget({ c1: 0, r1: 0, c2: 1, r2: 1 }, 1, 1), null);
});

test('selection stats', () => {
  assert.deepEqual(selectionStats([1, 2, 'x', null, 3]), { count: 4, numbers: 3, sum: 6, average: 2, min: 1, max: 3 });
  assert.deepEqual(selectionStats(['a', '']), { count: 1, numbers: 0 });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meetsCondition, cleanCondition, describeCondition, CONDITIONS } from './filtercond.js';
import { createEvaluator } from './formula.js';
import { hiddenRows, adjustFilter, columnFiltered } from './filter.js';

test('text conditions ignore case', () => {
  assert.equal(meetsCondition({ op: 'contains', a: 'OG' }, 'Logo'), true);
  assert.equal(meetsCondition({ op: 'notcontains', a: 'og' }, 'Logo'), false);
  assert.equal(meetsCondition({ op: 'starts', a: 'lo' }, 'Logo'), true);
  assert.equal(meetsCondition({ op: 'ends', a: 'GO' }, 'Logo'), true);
  assert.equal(meetsCondition({ op: 'is', a: 'logo' }, 'Logo'), true);
  assert.equal(meetsCondition({ op: 'is', a: 'log' }, 'Logo'), false);
  assert.equal(meetsCondition({ op: 'empty' }, ''), true);
  assert.equal(meetsCondition({ op: 'empty' }, null), true);
  assert.equal(meetsCondition({ op: 'notempty' }, 0), true);
  assert.equal(meetsCondition({ op: 'contains', a: 'TRUE' }, true), true);
});

test('number conditions leave out cells that are not numbers', () => {
  assert.equal(meetsCondition({ op: 'gt', a: '10' }, 12), true);
  assert.equal(meetsCondition({ op: 'gt', a: '10' }, '9'), false);
  assert.equal(meetsCondition({ op: 'gte', a: '10' }, '10'), true);
  assert.equal(meetsCondition({ op: 'lt', a: '1,000' }, '999'), true);
  assert.equal(meetsCondition({ op: 'lte', a: '50%' }, 0.5), true);
  assert.equal(meetsCondition({ op: 'gt', a: '10' }, 'abc'), false);
  assert.equal(meetsCondition({ op: 'gt', a: '10' }, ''), false);
  assert.equal(meetsCondition({ op: 'eq', a: '5' }, '5.0'), true);
  assert.equal(meetsCondition({ op: 'neq', a: '5' }, 6), true);
  assert.equal(meetsCondition({ op: 'eq', a: 'Done' }, 'done'), true, 'equal to text compares text');
  assert.equal(meetsCondition({ op: 'between', a: '10', b: '1' }, 5), true, 'either order');
  assert.equal(meetsCondition({ op: 'between', a: '1', b: '10' }, 10), true, 'ends included');
  assert.equal(meetsCondition({ op: 'notbetween', a: '1', b: '10' }, 11), true);
  assert.equal(meetsCondition({ op: 'notbetween', a: '1', b: '10' }, 'x'), false);
});

test('half-made conditions do nothing', () => {
  assert.equal(cleanCondition({ op: 'gt', a: ' ' }), null);
  assert.equal(cleanCondition({ op: 'between', a: '1' }), null);
  assert.equal(cleanCondition({ op: 'nope' }), null);
  assert.deepEqual(cleanCondition({ op: 'empty', a: 'x' }), { op: 'empty' });
  assert.equal(meetsCondition({ op: 'gt' }, 'anything'), true);
  assert.equal(describeCondition({ op: 'between', a: '1', b: '5' }), 'Is between 1 and 5');
  assert.equal(describeCondition({ op: 'gt', a: '10' }), 'Greater than 10');
  assert.equal(CONDITIONS.length, 15);
});

test('a filter hides rows that fail its conditions, together with ticked-off values', () => {
  const cells = { A1: 'Item', B1: 'Cost', C1: 'Status', A2: 'Pens', B2: '4', C2: 'Done', A3: 'Desk', B3: '250', C3: 'Open', A4: 'Lamp', B4: '=B2*10', C4: 'Done', A5: 'Ink', B5: '12', C5: 'Open' };
  const value = createEvaluator(cells);
  assert.deepEqual([...hiddenRows({ range: 'A1:C5', hidden: {}, cond: { B: { op: 'gt', a: '10' } } }, cells, value)], [1]);
  assert.deepEqual([...hiddenRows({ range: 'A1:C5', hidden: { C: ['Open'] }, cond: { B: { op: 'gt', a: '10' } } }, cells, value)].sort(), [1, 2, 4]);
  assert.deepEqual([...hiddenRows({ range: 'A1:C5', hidden: {}, cond: { A: { op: 'contains', a: 'n' } } }, cells, value)], [2, 3], 'Desk and Lamp have no n');
  assert.equal(columnFiltered({ hidden: {}, cond: { B: { op: 'gt', a: '1' } } }, 'B'), true);
  assert.equal(columnFiltered({ hidden: { B: [] }, cond: { B: { op: 'gt' } } }, 'B'), false);
});

test('conditions follow their column when columns move', () => {
  const f = { range: 'A1:C5', hidden: {}, cond: { B: { op: 'gt', a: '1' } } };
  assert.deepEqual(adjustFilter(f, { axis: 'col', at: 0, count: 1 }), { range: 'B1:D5', hidden: {}, cond: { C: { op: 'gt', a: '1' } } });
  assert.deepEqual(adjustFilter(f, { axis: 'col', at: 1, count: -1 }), { range: 'A1:B5', hidden: {} });
});

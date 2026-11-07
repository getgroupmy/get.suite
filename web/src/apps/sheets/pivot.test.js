import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPivot, pivotCells, compareKeys, sourceTable, BLANK } from './pivot.js';

const table = [
  ['Region', 'Product', 'Sales'],
  ['North', 'Tea', 10],
  ['South', 'Tea', 5],
  ['North', 'Coffee', '7'],
  ['North', 'Tea', 3],
  ['', 'Coffee', 2],
  ['', '', ''], // empty rows are ignored
];

test('rows only: sum per group, with a grand total', () => {
  assert.deepEqual(buildPivot(table, { rows: 0, value: 2, fn: 'sum' }), [
    ['Region', 'Sum of Sales'], ['North', 20], ['South', 5], [BLANK, 2], ['Grand total', 27],
  ]);
});

test('rows and columns', () => {
  assert.deepEqual(buildPivot(table, { rows: 0, cols: 1, value: 2, fn: 'sum' }), [
    ['Sum of Sales', 'Coffee', 'Tea', 'Grand total'],
    ['North', 7, 13, 20],
    ['South', '', 5, 5],
    [BLANK, 2, '', 2],
    ['Grand total', 9, 18, 27],
  ]);
});

test('count, average, min and max', () => {
  assert.deepEqual(buildPivot(table, { rows: 1 }).slice(1), [['Coffee', 2], ['Tea', 3], ['Grand total', 5]], 'count of rows');
  assert.deepEqual(buildPivot(table, { rows: 0, value: 2, fn: 'average' })[1], ['North', 6.66666666667]);
  assert.deepEqual(buildPivot(table, { rows: 0, value: 2, fn: 'max' })[1], ['North', 10]);
  assert.deepEqual(buildPivot(table, { rows: 0, value: 2, fn: 'min' }).at(-1), ['Grand total', 2]);
});

test('ordering: numbers, then text, blanks last', () => {
  assert.deepEqual([BLANK, 'b', 10, 'A', 2].sort(compareKeys), [2, 10, 'A', 'b', BLANK]);
});

test('as cells: headings and totals bold, formulas never run', () => {
  const { cells, formats } = pivotCells([['Sum of x', 'Total'], ['=evil', 3], ['Grand total', 3]]);
  assert.equal(cells.A2, ' =evil');
  assert.equal(cells.B2, '3');
  assert.deepEqual(formats.A1, { b: true });
  assert.ok(formats.B3);
});

test('sourceTable reads the columns down to the last row', () => {
  const vals = { A1: 'h', B1: 'v', A2: 'x', B2: 1, A3: 'y', B3: 2 };
  assert.deepEqual(sourceTable({ c1: 0, c2: 1, r1: 0 }, (k) => vals[k] ?? '', 2), [['h', 'v'], ['x', 1], ['y', 2]]);
});

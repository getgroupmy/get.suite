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

test('pivot: several values side by side, a filter, shares of the total, sorted by value', async () => {
  const { buildPivotTable, valuesOf, pivotCells } = await import('./pivot.js');
  const t = [['Region', 'Product', 'Sales'], ['North', 'Tea', 10], ['South', 'Tea', 5], ['North', 'Coffee', 7], ['East', 'Tea', 30], ['North', 'Tea', 3]];
  assert.deepEqual(buildPivotTable(t, { rows: 0, values: [{ col: 2, fn: 'sum' }, { col: null, fn: 'count' }] }).grid,
    [['Region', 'Sum of Sales', 'Count of rows'], ['East', 30, 1], ['North', 20, 3], ['South', 5, 1], ['Grand total', 55, 5]]);
  assert.deepEqual(buildPivotTable(t, { rows: 0, value: 2, fn: 'sum', filter: { col: 1, hide: ['Coffee'] }, sort: 'desc' }).grid,
    [['Region', 'Sum of Sales'], ['East', 30], ['North', 13], ['South', 5], ['Grand total', 48]]);
  const pct = buildPivotTable(t, { rows: 0, value: 2, fn: 'sum', show: 'percent', sort: 'asc' });
  assert.deepEqual(pct.grid, [['Region', 'Sum of Sales'], ['South', 0.0909090909091], ['North', 0.363636363636], ['East', 0.545454545455], ['Grand total', 1]]);
  assert.deepEqual(pivotCells(pct.grid, { percent: true }).formats.B2, { b: true, num: 'percent', dp: 1 });
  assert.deepEqual(valuesOf(t, 1), [{ key: 'Coffee', count: 1 }, { key: 'Tea', count: 4 }]);
});

test('pivot: dates grouped by month, quarter or year', async () => {
  const { buildPivotTable, groupKey } = await import('./pivot.js');
  const t = [['Date', 'Sales'], ['2026-01-15', 10], ['2026-02-03', 5], ['2026-04-20', 7], ['2025-12-31', 1], ['not a date', 2]];
  assert.deepEqual(buildPivotTable(t, { rows: 0, value: 1, fn: 'sum', group: 'month' }).grid.map((r) => r[0]), ['Date', '2025-12', '2026-01', '2026-02', '2026-04', 'not a date', 'Grand total']);
  assert.deepEqual(buildPivotTable(t, { rows: 0, value: 1, fn: 'sum', group: 'quarter' }).grid.slice(1, -1), [['2025 Q4', 1], ['2026 Q1', 15], ['2026 Q2', 7], ['not a date', 2]]);
  assert.deepEqual(buildPivotTable(t, { rows: 0, value: 1, fn: 'sum', group: 'year' }).grid.slice(1, 3), [[2025, 1], [2026, 22]]);
  assert.equal(groupKey('2026-11-09 14:30', 'month'), '2026-11');
});

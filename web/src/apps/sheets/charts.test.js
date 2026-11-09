import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chartData, parseRange, rangeText, dataRegion, niceScale, shortNumber, pieSlices } from './charts.js';

const sheet = (rows) => (k) => {
  const m = /^([A-Z]+)(\d+)$/.exec(k);
  const c = m[1].charCodeAt(0) - 65, r = Number(m[2]) - 1;
  return rows[r]?.[c] ?? null;
};

test('ranges', () => {
  assert.deepEqual(parseRange('c6:a1'), { c1: 0, r1: 0, c2: 2, r2: 5 });
  assert.deepEqual(parseRange('$B$2'), { c1: 1, r1: 1, c2: 1, r2: 1 });
  assert.equal(parseRange('nope'), null);
  assert.equal(rangeText({ c1: 0, r1: 0, c2: 2, r2: 5 }), 'A1:C6');
});

test('headers and labels are found', () => {
  const d = chartData('A1:C4', sheet([['Month', 'Sales', 'Costs'], ['Jan', 10, 4], ['Feb', 12, 5], ['Mar', 9, null]]));
  assert.deepEqual(d.categories, ['Jan', 'Feb', 'Mar']);
  assert.deepEqual(d.series, [{ name: 'Sales', values: [10, 12, 9] }, { name: 'Costs', values: [4, 5, null] }]);
});

test('numbers only: rows are numbered, series are named', () => {
  const d = chartData('A1:B2', sheet([[1, 2], [3, 4]]));
  assert.deepEqual(d.categories, ['1', '2']);
  assert.deepEqual(d.series.map((s) => s.name), ['Series 1', 'Series 2']);
});

test('a single column with a heading', () => {
  const d = chartData('A1:A3', sheet([['Visitors'], [5], [7]]));
  assert.deepEqual(d.series, [{ name: 'Visitors', values: [5, 7] }]);
});

test('empty trailing rows are dropped; no numbers is an error', () => {
  assert.equal(chartData('A1:B50', sheet([['x', 'y'], ['a', 1]])).categories.length, 1);
  assert.match(chartData('A1:B2', sheet([['a', 'b'], ['c', 'd']])).error, /no numbers/);
  assert.match(chartData('zz', sheet([])).error, /Choose cells/);
});

test('the data around a cell', () => {
  const rows = [['Month', 'Sales'], ['Jan', 1], ['Feb', 2], [null, null], [null, 'x']];
  const has = (c, r) => rows[r]?.[c] != null;
  assert.equal(rangeText(dataRegion({ c: 1, r: 1 }, has)), 'A1:B3');
});

test('nice scales and short numbers', () => {
  assert.deepEqual(niceScale(3, 97).ticks, [0, 20, 40, 60, 80, 100]);
  const s = niceScale(-12, 30);
  assert.ok(s.lo <= -12 && s.hi >= 30 && s.ticks.includes(0));
  assert.deepEqual(niceScale(0, 0).ticks.slice(0, 2), [0, 0.2]);
  assert.equal(shortNumber(1200), '1.2K');
  assert.equal(shortNumber(3500000), '3.5M');
  assert.equal(shortNumber(0.25), '0.25');
});

test('pie slices fold the smallest into Other', () => {
  const cats = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const p = pieSlices({ categories: cats, series: [{ name: 'n', values: [8, 7, 6, 5, 4, 3, 2, -1] }] });
  assert.equal(p.length, 6);
  assert.deepEqual(p.at(-1), { ...p.at(-1), name: 'Other', value: 5 });
  assert.ok(Math.abs(p.at(-1).end - 1) < 1e-9);
});

test('more chart types: stacked pieces and scatter points', async () => {
  const { stackedRuns, scatterOf, CHART_TYPES, isStacked, isRound, isHorizontal } = await import('./charts.js');
  assert.equal(CHART_TYPES.length, 11);
  assert.deepEqual([isStacked('stackedBar'), isRound('doughnut'), isHorizontal('stackedBar'), isHorizontal('column')], [true, true, true, false]);
  const runs = stackedRuns([{ values: [10, -5, null] }, { values: [20, -3, 4] }, { values: [5, 2, 0] }], 3);
  assert.deepEqual(runs, [[[0, 10], [-5, 0], null], [[10, 30], [-8, -5], [0, 4]], [[30, 35], [0, 2], null]]);
  // Rows without names: the first column of numbers is X.
  const a = scatterOf({ categories: ['1', '2', '3'], series: [{ name: 'Height', values: [150, 160, null] }, { name: 'Weight', values: [50, 61, 70] }] });
  assert.deepEqual(a, { xName: 'Height', points: [{ name: 'Weight', values: [[150, 50], [160, 61]] }] });
  // Numeric row names are X; text names are 1, 2, 3.
  assert.deepEqual(scatterOf({ categories: ['2020', '2021'], series: [{ name: 'Sales', values: [5, 7] }] }).points[0].values, [[2020, 5], [2021, 7]]);
  assert.deepEqual(scatterOf({ categories: ['Ann', 'Bo'], series: [{ name: 'Score', values: [5, 7] }] }).points[0].values, [[1, 5], [2, 7]]);
});

test('histogram: numbers counted into round, equal ranges', async () => {
  const { histogramOf } = await import('./charts.js');
  const data = { categories: [], series: [{ name: 'Height', values: [151, 158, 160, 162, 165, 168, 171, 175, 179, 188, null] }] };
  const h = histogramOf(data);
  assert.deepEqual(h.bins, [[150, 160], [160, 170], [170, 180], [180, 190]]);
  assert.deepEqual(h.series[0].values, [2, 4, 3, 1], 'on the line counts in the higher range');
  assert.deepEqual(h.categories, ['150–160', '160–170', '170–180', '180–190']);
  assert.equal(h.series[0].name, 'Height (count)');
  assert.deepEqual(histogramOf(data, 2).series[0].values.reduce((a, b) => a + b), 10, 'every number is counted');
  const same = histogramOf({ categories: [], series: [{ name: 'Series 1', values: [5, 5, 5] }] });
  assert.equal(same.series[0].values.reduce((a, b) => a + b), 3);
  assert.equal(same.series[0].name, 'Count');
  assert.ok(histogramOf({ categories: [], series: [] }).error);
});

test('waterfall: changes add up, with a total at the end', async () => {
  const { waterfallOf } = await import('./charts.js');
  const w = waterfallOf({ categories: ['Start', 'Sales', 'Costs', 'Tax'], series: [{ name: 'Cash', values: [100, 50, -80, null] }] });
  assert.deepEqual(w.categories, ['Start', 'Sales', 'Costs', 'Tax', 'Total']);
  assert.deepEqual(w.steps, [{ from: 0, to: 100, kind: 'up' }, { from: 100, to: 150, kind: 'up' }, { from: 150, to: 70, kind: 'down' }, { from: 70, to: 70, kind: 'up' }, { from: 0, to: 70, kind: 'total' }]);
  assert.deepEqual(w.series[0].values, [100, 50, -80, null, 70]);
});

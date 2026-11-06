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

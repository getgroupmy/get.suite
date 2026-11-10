import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chartsIn, chartNow, chartChanged } from './linkedchart.js';

const content = { sheets: [
  { name: 'Data', cells: { A1: 'Month', B1: 'Sales', A2: 'Jan', B2: '10', A3: 'Feb', B3: '=B2*2' } },
  { name: 'Charts', cells: {}, charts: { c1: { title: 'Sales', type: 'line', range: 'A1:B3', x: 0, y: 0, w: 300, h: 200 } } },
] };

test('the charts in a spreadsheet, and one as it is now (formulas from other sheets worked out)', () => {
  assert.deepEqual(chartsIn(content), [{ id: 'c1', title: 'Sales', type: 'line', sheet: 'Charts' }]);
  content.sheets[0].charts = { c0: { title: '', type: 'pie', range: 'A1:B3' } };
  assert.deepEqual(chartsIn(content).map((c) => c.id), ['c0', 'c1']);
  delete content.sheets[0].charts;
  // The chart's range is read on the sheet the chart is on.
  const moved = { sheets: [{ name: 'S', cells: content.sheets[0].cells, charts: { c1: content.sheets[1].charts.c1 } }] };
  const now = chartNow(moved, 'c1');
  assert.equal(now.chartType, 'line');
  assert.deepEqual(now.data.categories, ['Jan', 'Feb']);
  assert.deepEqual(now.data.series, [{ name: 'Sales', values: [10, 20] }]);
  assert.equal(chartNow(moved, 'nope'), null);
  const item = { type: 'chart', title: 'Sales', chartType: 'line', data: now.data };
  assert.equal(chartChanged(item, now), false);
  moved.sheets[0].cells = { ...moved.sheets[0].cells, B2: '15' };
  assert.equal(chartChanged(item, chartNow(moved, 'c1')), true);
  assert.equal(chartChanged(item, null), false, 'gone or not readable: nothing to update');
});

test('a linked chart leaves out the rows the spreadsheet hides (slicer, filter, Hide row)', () => {
  const sheet = { name: 'S', cells: { A1: 'Rep', B1: 'Sales', A2: 'Ana', B2: '10', A3: 'Ben', B3: '4', A4: 'Cleo', B4: '7', A5: 'Dev', B5: '5' },
    charts: { k: { type: 'column', range: 'A1:B5', title: 'Sales' } },
    slicers: { s: { range: 'A1:B5', col: 'A', hidden: ['Ben'] } }, filter: { range: 'A1:B5', hidden: { A: ['Dev'] } }, hide: { rows: [3] } };
  assert.deepEqual(chartNow({ sheets: [sheet] }, 'k').data.categories, ['Ana']);
});

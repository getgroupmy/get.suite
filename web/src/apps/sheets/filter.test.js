import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEvaluator } from './formula.js';
import { hiddenRows, columnValues, adjustFilter, filterArea, filterLabel } from './filter.js';

const cells = { A1: 'Task', B1: 'Status', C1: 'Cost', A2: 'Logo', B2: 'Done', C2: '10', A3: 'Site', B3: 'Open', C3: '20', A4: 'Flyer', C4: '=C2+C3', A5: 'Ads', B5: 'Done', C5: '5' };
const value = createEvaluator(cells);

test('rows with a hidden value are hidden; the headings never are', () => {
  assert.deepEqual([...hiddenRows({ range: 'A1:C5', hidden: { B: ['Done'] } }, cells, value)], [1, 4]);
  assert.deepEqual([...hiddenRows({ range: 'A1:C5', hidden: { B: [''] } }, cells, value)], [3], 'empty cells');
  assert.deepEqual([...hiddenRows({ range: 'A1:C5', hidden: { C: ['30'] } }, cells, value)], [3], 'formula results');
  assert.deepEqual([...hiddenRows({ range: 'A1:C5', hidden: { B: ['Done'], C: ['20'] } }, cells, value)].sort(), [1, 2, 4]);
  assert.deepEqual([...hiddenRows({ range: 'A1:C5', hidden: {} }, cells, value)], []);
  assert.deepEqual([...hiddenRows(null, cells, value)], []);
});

test('the range takes in rows added below it', () => {
  const more = { ...cells, A7: 'New', B7: 'Done' };
  assert.equal(filterArea({ range: 'A1:C5' }, more).r2, 6);
  assert.deepEqual([...hiddenRows({ range: 'A1:C5', hidden: { B: ['Done'] } }, more, createEvaluator(more))], [1, 4, 6]);
});

test('a column’s values, sorted, empty last, with counts', () => {
  assert.deepEqual(columnValues({ range: 'A1:C5' }, cells, value, 1), [{ label: 'Done', count: 2 }, { label: 'Open', count: 1 }, { label: '', count: 1 }]);
  assert.equal(filterLabel(null), '');
  assert.equal(filterLabel(true), 'TRUE');
});

test('inserting and deleting rows and columns', () => {
  const f = { range: 'A1:C5', hidden: { B: ['Done'] } };
  assert.deepEqual(adjustFilter(f, { axis: 'col', at: 0, count: 1 }), { range: 'B1:D5', hidden: { C: ['Done'] } });
  assert.deepEqual(adjustFilter(f, { axis: 'row', at: 2, count: 2 }), { range: 'A1:C7', hidden: { B: ['Done'] } });
  assert.equal(adjustFilter(f, { axis: 'row', at: 0, count: -1 }), null, 'headings deleted: filter gone');
  assert.deepEqual(adjustFilter(f, { axis: 'col', at: 1, count: -1 }), { range: 'A1:B5', hidden: {} }, 'its column deleted');
});

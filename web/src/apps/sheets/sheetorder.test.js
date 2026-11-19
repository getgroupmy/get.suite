import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placesAfter, moveSheet, copyName, copySheet } from './sheetorder.js';

test('where each sheet ends up: moved, copied, removed', () => {
  assert.deepEqual(placesAfter(4, { move: [0, 2] }), [2, 0, 1, 3]);
  assert.deepEqual(placesAfter(4, { move: [3, 1] }), [0, 2, 3, 1]);
  assert.deepEqual(placesAfter(4, { move: [1, 2] }), [0, 2, 1, 3]);
  assert.deepEqual(placesAfter(3, { move: [0, 5] }), [0, 1, 2], 'nowhere to go: unchanged');
  assert.deepEqual(placesAfter(3, { copy: 0 }), [0, 2, 3]);
  assert.deepEqual(placesAfter(3, { copy: 2 }), [0, 1, 2]);
  assert.deepEqual(placesAfter(4, { remove: 1 }), [0, null, 1, 2]);
  // the places and the sheets agree
  const names = ['A', 'B', 'C', 'D'];
  for (const [from, to] of [[0, 2], [3, 1], [1, 2], [2, 0]]) {
    const moved = moveSheet(names, from, to);
    placesAfter(4, { move: [from, to] }).forEach((p, i) => assert.equal(moved[p], names[i]));
  }
});

test('a copy\'s name is new, whatever the case', () => {
  assert.equal(copyName('Budget', ['Budget']), 'Copy of Budget');
  assert.equal(copyName('Budget', ['Budget', 'copy of budget']), 'Copy of Budget 2');
  assert.equal(copyName('Budget', ['Budget', 'Copy of Budget', 'Copy of Budget 2']), 'Copy of Budget 3');
  assert.ok(copyName('A very long sheet name indeed here', []).length <= 30);
});

test('a copy holds the same, with new ids for charts, slicers and filter views, and tables without their names', () => {
  let n = 0;
  const sheet = { name: 'Sales', cells: { A1: 'x' }, formats: { A1: { b: 1 } }, tabColor: '#e53935',
    charts: { c1: { id: 'c1', type: 'line', range: 'A1:B3' } }, slicers: { s1: { id: 's1', col: 'A' } }, views: { v1: { id: 'v1', name: 'Filter 1' } },
    bands: [{ range: 'A1:B9', name: 'Orders', even: '#eee' }], rules: [{ id: 'r1', range: 'A1:A9' }] };
  const copy = copySheet(sheet, ['Sales'], () => `n${++n}`);
  assert.equal(copy.name, 'Copy of Sales');
  assert.deepEqual([copy.cells, copy.formats, copy.tabColor, copy.rules], [sheet.cells, sheet.formats, sheet.tabColor, sheet.rules]);
  assert.deepEqual(copy.charts, { n1: { id: 'n1', type: 'line', range: 'A1:B3' } });
  assert.deepEqual(Object.keys(copy.slicers), ['n2']);
  assert.deepEqual(copy.views, { n3: { id: 'n3', name: 'Filter 1' } });
  assert.deepEqual(copy.bands, [{ range: 'A1:B9', even: '#eee' }]);
  copy.cells.A1 = 'changed';
  assert.equal(sheet.cells.A1, 'x', 'a copy, not the same');
  assert.equal(sheet.charts.c1.id, 'c1');
});

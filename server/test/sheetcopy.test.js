import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freeSheetName, sheetCopyFor } from '../src/sheetcopy.js';

test('a copied sheet keeps its name when it\'s free there, else "Copy of …"', () => {
  assert.equal(freeSheetName('Budget', ['Notes']), 'Budget');
  assert.equal(freeSheetName('Budget', ['budget']), 'Copy of Budget');
  assert.equal(freeSheetName('Budget', ['Budget', 'Copy of Budget']), 'Copy of Budget 2');
});

test('the copy: everything, with new ids for charts, slicers and filter views, tables without their names, shown', () => {
  let n = 0;
  const sheet = { name: 'Sales', hidden: true, tabColor: '#e53935', cells: { A1: 'x' }, charts: { c1: { id: 'c1', type: 'line' } }, slicers: { s1: { id: 's1' } }, views: { v1: { id: 'v1', name: 'Filter 1' } }, bands: [{ range: 'A1:B9', name: 'Orders' }] };
  const copy = sheetCopyFor(sheet, ['Sales'], () => `n${++n}`);
  assert.deepEqual(copy, { name: 'Copy of Sales', tabColor: '#e53935', cells: { A1: 'x' }, charts: { n1: { id: 'n1', type: 'line' } }, slicers: { n2: { id: 'n2' } }, views: { n3: { id: 'n3', name: 'Filter 1' } }, bands: [{ range: 'A1:B9' }] });
  assert.equal(sheet.charts.c1.id, 'c1', 'the original untouched');
  assert.ok(sheetCopyFor({ name: 'A', charts: { x: { id: 'x' } } }, []).charts, 'real ids by default');
});

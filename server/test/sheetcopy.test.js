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

test('formulas reading the sheets given come as their values; the rest stay formulas', async () => {
  const { cellsWithValuesFrom } = await import('../src/office/sheetvalues.js');
  const data = { sheets: [
    { name: 'Budget', cells: { A1: '=Plan!B2*2', A2: "='Old Plan'!A1+1", A3: '=MyPlan!A1', A4: '=B1+1', B1: '4', A5: '=SUM(Plan!rates)', A6: '=Budget!B1', A7: '=rates*2' }, names: { rates: 'B1' } },
    { name: 'Plan', cells: { B2: '21', C1: '0.5', C2: '0.25' }, names: { rates: 'C1:C2' } },
    { name: 'Old Plan', cells: { A1: '9' } },
    { name: 'MyPlan', cells: { A1: '7' } },
  ] };
  const read = [data.sheets[1], data.sheets[2]];
  assert.deepEqual(cellsWithValuesFrom(data, 0, read), { A1: '42', A2: '10', A3: '=MyPlan!A1', A4: '=B1+1', B1: '4', A5: '0.75', A6: '=Budget!B1', A7: '=rates*2' }, 'its own name stays its own');
  assert.equal(cellsWithValuesFrom(data, 0, [data.sheets[0]]).A6, '4', 'itself by its name, when that name goes');
  assert.equal(cellsWithValuesFrom(data, 0, []), data.sheets[0].cells, 'nothing to read: as it was');
});

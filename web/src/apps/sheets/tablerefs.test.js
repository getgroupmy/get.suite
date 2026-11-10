import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tablesOf, plainTableRefs } from './tablerefs.js';
import { bookEvaluator } from './formula.js';
import { cleanBand } from './bands.js';

const sheets = () => [
  { name: 'Data', cells: { A1: 'Item', B1: 'Unit price', C1: 'Qty', A2: 'Tea', B2: '2', C2: '10', A3: 'Coffee', B3: '3', C3: '5', A4: 'Cake', B4: '4', C4: '1' }, bands: [{ range: 'A1:C3', name: 'Sales', header: true }] },
  { name: 'Q4 report', cells: {} },
];

test('a named band is a table: its columns from the heading row; rows typed under it belong to it', () => {
  const [t] = tablesOf(sheets());
  assert.deepEqual({ ...t }, { name: 'Sales', sheet: 'Data', c1: 0, c2: 2, r1: 1, r2: 4, header: true, totals: false, columns: ['Item', 'Unit price', 'Qty'] });
  const withFooter = tablesOf([{ ...sheets()[0], bands: [{ range: 'A1:C3', name: 'Sales', footer: true }] }])[0];
  assert.equal(withFooter.r2, 3, 'a table with a total row stays as it is');
  assert.deepEqual(tablesOf([{ name: 'S', cells: {}, bands: [{ range: 'A1:B2' }] }]), [], 'only named ones');
});

test('structured references written as ranges', () => {
  const tables = tablesOf(sheets());
  assert.equal(plainTableRefs('SUM(Sales[Qty])', tables, 9, 5, 'Data'), 'SUM(C2:C4)');
  assert.equal(plainTableRefs('SUM(Sales[[Unit price]:[Qty]])', tables, 9, 5, 'Data'), 'SUM(B2:C4)');
  assert.equal(plainTableRefs('ROWS(Sales)', tables, 9, 5, 'Data'), 'ROWS(A2:C4)');
  assert.equal(plainTableRefs('COUNTA(Sales[#All])&Sales[#Headers]', tables, 9, 5, 'Data'), 'COUNTA(A1:C4)&A1:C1');
  assert.equal(plainTableRefs('[@Qty]*[@[Unit price]]', tables, 3, 3, 'Data'), 'C3*B3', 'beside the table, on its rows');
  assert.equal(plainTableRefs('SUM(Sales[Qty])', tables, 1, 0, 'Q4 report'), 'SUM(Data!C2:C4)', 'from another sheet');
  assert.equal(plainTableRefs('"Sales[Qty]"&SalesTax', tables, 1, 0, 'Data'), '"Sales[Qty]"&SalesTax', 'text and longer names left alone');
  assert.equal(plainTableRefs('Sales[Nope]', tables, 1, 0, 'Data'), 'Sales[Nope]', 'unknown columns left (and fail)');
});

test('formulas use them, and follow the table as it grows', () => {
  const s = sheets();
  s[0].cells.D2 = '=[@Qty]*[@[Unit price]]';
  s[0].cells.F1 = '=SUM(Sales[Qty])';
  s[1].cells.A1 = '=SUMPRODUCT(Sales[Unit price], Sales[Qty])';
  assert.equal(bookEvaluator(s, 0)('D2'), 20);
  assert.equal(bookEvaluator(s, 0)('F1'), 16);
  assert.equal(bookEvaluator(s, 1)('A1'), 2 * 10 + 3 * 5 + 4 * 1);
  s[0].cells.A5 = 'Juice'; s[0].cells.C5 = '4';
  assert.equal(bookEvaluator(s, 0)('F1'), 20, 'a new row under it counts');
});

test('the band keeps a valid name only', () => {
  assert.equal(cleanBand({ range: 'A1:B5', name: ' Sales ' }).name, 'Sales');
  assert.equal(cleanBand({ range: 'A1:B5', name: 'A1' }).name, undefined);
  assert.equal(cleanBand({ range: 'A1:B5', name: 'two words' }).name, undefined);
});

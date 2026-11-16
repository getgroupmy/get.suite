import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendRows } from '../src/sheetrows.js';

const book = (cells, name = 'Sheet1', more = []) => ({ sheets: [{ name, cells }, ...more] });

test('rows go after the last used row, from the table’s first column', () => {
  const r = appendRows(book({ B1: 'Item', C1: 'Cost', B2: 'Taxi', C2: '12', D9: '' }), { rows: [['Lunch', 18.5], ['Hotel', 240, true]] });
  assert.equal(r.range, 'B3:D4');
  assert.deepEqual([r.sheet, r.added], ['Sheet1', 2]);
  const c = r.content.sheets[0].cells;
  assert.deepEqual([c.B3, c.C3, c.B4, c.C4, c.D4], ['Lunch', '18.5', 'Hotel', '240', 'TRUE']);
  assert.equal(c.B1, 'Item', 'what was there stays');
});

test('a sheet by name (any capitals); an empty one starts at A1; empty cells are skipped', () => {
  const r = appendRows(book({ A1: 'x' }, 'Main', [{ name: 'Expenses', cells: {} }]), { sheet: 'expenses', rows: [['a', null, 'c']] });
  assert.deepEqual([r.sheet, r.range], ['Expenses', 'A1:C1']);
  assert.deepEqual(r.content.sheets[1].cells, { A1: 'a', C1: 'c' });
  assert.deepEqual(r.content.sheets[0].cells, { A1: 'x' }, 'the other sheet untouched');
});

test('refused: no rows, too many, bad cells, an unknown sheet, a pivot table', () => {
  assert.throws(() => appendRows(book({}), { rows: [] }), /Give the rows/);
  assert.throws(() => appendRows(book({}), { rows: Array(501).fill(['x']) }), /At most 500/);
  assert.throws(() => appendRows(book({}), { rows: [[{ a: 1 }]] }), /text, a number/);
  assert.throws(() => appendRows(book({}), { rows: ['not a list'] }), /list of at most/);
  assert.throws(() => appendRows(book({}, 'Main'), { sheet: 'Nope', rows: [['x']] }), /No sheet called “Nope”: it has “Main”/);
  assert.throws(() => appendRows({ sheets: [{ name: 'P', pivot: {}, cells: {} }] }, { rows: [['x']] }), /pivot table/);
});

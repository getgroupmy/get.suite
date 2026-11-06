import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adjustFormula, adjustKey, adjustRange, applyStructure, sortRange, looksLikeHeader } from './structure.js';
import { createEvaluator } from './formula.js';

const ins = (axis, at, count = 1) => ({ axis, at, count });
const del = (axis, at, count = 1) => ({ axis, at, count: -count });

test('inserting rows moves references at and below it, ranges grow', () => {
  assert.equal(adjustFormula('=A1+A2+A3', ins('row', 1)), '=A1+A3+A4'); // a row inserted before row 2
  assert.equal(adjustFormula('=SUM(B2:B10)', ins('row', 4, 2)), '=SUM(B2:B12)');
  assert.equal(adjustFormula('=SUM(B2:B10)', ins('row', 1)), '=SUM(B3:B11)'); // at the top of the range: it moves
  assert.equal(adjustFormula('=$A$5*2', ins('row', 0)), '=$A$6*2'); // fixed references follow the cell too
  assert.equal(adjustFormula('="A1 stays"&A1', ins('row', 0)), '="A1 stays"&A2');
  assert.equal(adjustFormula('plain A1', ins('row', 0)), 'plain A1');
});

test('deleting rows: references to deleted cells become #REF!, ranges shrink', () => {
  assert.equal(adjustFormula('=A1+A2+A3', del('row', 1)), '=A1+#REF!+A2');
  assert.equal(adjustFormula('=SUM(B2:B10)', del('row', 4, 2)), '=SUM(B2:B8)');
  assert.equal(adjustFormula('=SUM(B2:B4)', del('row', 1, 3)), '=SUM(#REF!)');
  assert.equal(adjustFormula('=SUM(B2:B6)', del('row', 0, 3)), '=SUM(B1:B3)'); // the first rows of the range went
  assert.equal(adjustFormula('=SUM(B2:B6)', del('row', 4, 5)), '=SUM(B2:B4)'); // the last rows went
});

test('columns work the same way', () => {
  assert.equal(adjustFormula('=A1+B1+C1', ins('col', 1)), '=A1+C1+D1');
  assert.equal(adjustFormula('=SUM(A1:C1)', del('col', 1)), '=SUM(A1:B1)');
  assert.equal(adjustFormula('=Z1', ins('col', 25)), '=AA1');
  assert.equal(adjustKey('C3', del('col', 2)), null);
  assert.equal(adjustKey('D3', del('col', 2)), 'C3');
  assert.equal(adjustRange('A1:D9', del('col', 0, 2)), 'A1:B9');
  assert.equal(adjustRange('B1:C9', del('col', 0, 4)), null);
});

test('the whole sheet follows: cells, formats, widths and charts', () => {
  const sheet = { name: 'S', cells: { A1: 'x', A2: '5', A3: '=A2*2' }, formats: { A2: { b: true } }, colWidths: { B: 150 }, charts: { c1: { range: 'A1:A3' }, c2: { range: 'A2:A2' } } };
  const out = applyStructure(sheet, del('row', 1));
  assert.deepEqual(out.cells, { A1: 'x', A2: '=#REF!*2' });
  assert.deepEqual(out.formats, {});
  assert.deepEqual(out.charts, { c1: { range: 'A1:A2' } });
  assert.equal(createEvaluator(out.cells)('A2').error, '#REF!');
  assert.deepEqual(applyStructure(sheet, ins('col', 0)).colWidths, { C: 150 });
});

test('sorting rows by a column, numbers then text, empty cells last; formulas move with their row', () => {
  const sheet = { cells: { A1: 'Name', B1: 'Score', A2: 'bob', B2: '7', C2: '=B2*2', A3: 'Amy', B3: '10', C3: '=B3*2', A4: 'cat', C4: '=B4*2', A5: 'dan', B5: '2', C5: '=B5*2' }, formats: { A3: { b: true } } };
  const ev = createEvaluator(sheet.cells);
  const range = { c1: 0, r1: 0, c2: 2, r2: 4 };
  assert.equal(looksLikeHeader(range, ev), true);
  const up = sortRange(sheet, range, 1, { header: true, value: ev });
  assert.deepEqual([up.cells.A2, up.cells.A3, up.cells.A4, up.cells.A5], ['dan', 'bob', 'Amy', 'cat']);
  assert.equal(up.cells.C2, '=B2*2');
  assert.equal(up.cells.B5, undefined);
  assert.deepEqual(up.formats, { A4: { b: true } });
  assert.equal(up.cells.A1, 'Name');
  const down = sortRange(sheet, range, 0, { header: true, desc: true, value: ev });
  assert.deepEqual([down.cells.A2, down.cells.A3, down.cells.A4, down.cells.A5], ['dan', 'cat', 'bob', 'Amy']);
  assert.equal(looksLikeHeader({ c1: 0, r1: 1, c2: 1, r2: 4 }, ev), false);
});

test('conditional formatting ranges follow rows and columns', () => {
  const sheet = { cells: {}, rules: [{ id: 'r1', range: 'B2:B10', when: 'gt', value: '1' }, { id: 'r2', range: 'C2:C3', when: 'empty' }] };
  assert.deepEqual(applyStructure(sheet, ins('row', 4)).rules.map((r) => r.range), ['B2:B11', 'C2:C3']);
  assert.deepEqual(applyStructure(sheet, del('col', 2)).rules.map((r) => r.range), ['B2:B10'], 'a rule whose cells are all deleted goes');
});

test('dropdowns and tick boxes follow inserted and deleted rows', () => {
  const sheet = { cells: {}, validations: [{ id: 'v', range: 'B2:B5', type: 'list', values: ['a'] }, { id: 'w', range: 'C3:C3', type: 'checkbox' }] };
  const ins = applyStructure(sheet, { axis: 'row', at: 0, count: 2 });
  assert.deepEqual(ins.validations.map((v) => v.range), ['B4:B7', 'C5:C5']);
  const delRow = applyStructure(sheet, { axis: 'row', at: 2, count: -1 });
  assert.deepEqual(delRow.validations.map((v) => v.range), ['B2:B4'], 'the one on the deleted row goes');
});

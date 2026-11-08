import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nameProblem, cleanTarget, targetOf } from './names.js';
import { createEvaluator, shiftFormula } from './formula.js';
import { applyStructure } from './structure.js';

test('names: what makes a good one', () => {
  assert.equal(nameProblem('Tax'), null);
  assert.equal(nameProblem('Q1_sales'), null);
  assert.match(nameProblem(''), /name/);
  assert.match(nameProblem('A1'), /cell/);
  assert.match(nameProblem('abc12'), /cell/);
  assert.match(nameProblem('true'), /value/);
  assert.match(nameProblem('2tax'), /starting with a letter/);
  assert.match(nameProblem('my tax'), /letters/);
  assert.match(nameProblem('TAX', { Tax: 'B1' }), /already a range called Tax/);
  assert.equal(nameProblem('TAX', { Tax: 'B1' }, 'Tax'), null, 'renaming itself');
});

test('names: targets', () => {
  assert.equal(cleanTarget('a2 : a10'), 'A2:A10');
  assert.equal(cleanTarget('$B$1'), 'B1');
  assert.equal(cleanTarget('B1:B1'), 'B1');
  assert.equal(cleanTarget('hello'), null);
  assert.equal(targetOf({ Sales: 'A2:A4' }, 'sales'), 'A2:A4');
  assert.equal(targetOf({ Sales: 'A2:A4' }, 'nope'), null);
});

test('names in formulas', () => {
  const cells = { A2: '10', A3: '20', A4: '30', B1: '0.5', C1: '=SUM(Sales)*tax', C2: '=Missing+1', C3: '=q1_rate*2', D1: '=0.25' };
  const get = createEvaluator(cells, { Sales: 'A2:A4', Tax: 'B1', Q1_rate: 'D1' });
  assert.equal(get('C1'), 30);
  assert.deepEqual(get('C2'), { error: '#NAME?' });
  assert.equal(get('C3'), 0.5);
  assert.deepEqual(createEvaluator(cells)('C1'), { error: '#NAME?' }, 'without the names');
  // Copying a formula leaves names alone (q1_rate2 is not a cell).
  assert.equal(shiftFormula('=SUM(Sales)+q1_rate2+A1', 1, 1), '=SUM(Sales)+q1_rate2+B2');
});

test('names move with inserted and deleted rows', () => {
  const sheet = { cells: { A2: '1' }, names: { Sales: 'A2:A10', Tax: 'B1', Gone: 'C5' } };
  const after = applyStructure(sheet, { axis: 'row', at: 0, count: 2 });
  assert.deepEqual(after.names, { Sales: 'A4:A12', Tax: 'B3', Gone: 'C7' });
  const del = applyStructure(sheet, { axis: 'row', at: 4, count: -1 });
  assert.deepEqual(del.names, { Sales: 'A2:A9', Tax: 'B1' });
  // Formulas referring to the name don't change.
  assert.equal(applyStructure({ cells: { A1: '=SUM(Sales)+abc_d2' } }, { axis: 'row', at: 0, count: 1 }).cells.A2, '=SUM(Sales)+abc_d2');
});

test('references to other sheets', async () => {
  const { bookEvaluator, sheetPrefix } = await import('./formula.js');
  const sheets = [
    { name: 'Summary', cells: { A1: "=Data!A1*2", A2: "=SUM('Q1 data'!B1:B3)", A3: '=Gone!A1', A4: '=data!Total', A5: '=Data!B1', B1: '=Data!C1' } },
    { name: 'Data', cells: { A1: '21', B1: '=Summary!B1', C1: '=Summary!A5' }, names: { Total: 'A1' } },
    { name: 'Q1 data', cells: { B1: '1', B2: '2', B3: '3' } },
  ];
  const get = bookEvaluator(sheets, 0);
  assert.equal(get('A1'), 42);
  assert.equal(get('A2'), 6);
  assert.deepEqual(get('A3'), { error: '#REF!' });
  assert.deepEqual(get('A5'), { error: '#CIRC!' }, 'a loop across sheets');
  assert.equal(get('A4'), 21, 'a named range on another sheet');
  assert.deepEqual(bookEvaluator([{ name: 'S', cells: { A1: '=Data!Nope' } }, sheets[1]], 0)('A1'), { error: '#NAME?' });
  assert.equal(sheetPrefix('Data'), 'Data');
  assert.equal(sheetPrefix('Q1 data'), "'Q1 data'");
  assert.equal(sheetPrefix('A1'), "'A1'");
  assert.equal(sheetPrefix("Bob's"), "'Bob''s'");
});

test('other sheets: inserting rows and renaming sheets', async () => {
  const { adjustOtherSheets, renameSheetRefs } = await import('./structure.js');
  const sheets = [
    { name: 'Summary', cells: { A1: "=Data!A2+A2+'Data'!B2:B3", A2: '5' } },
    { name: 'Data', cells: { A2: '1', B1: '=A2+Summary!A2+Data!A2' } },
  ];
  // Two rows inserted at the top of Data: Summary's references into Data move; its own don't.
  const after = adjustOtherSheets(sheets, 1, { axis: 'row', at: 0, count: 2 });
  assert.equal(after[0].cells.A1, "=Data!A4+A2+'Data'!B4:B5");
  const data = applyStructure(sheets[1], { axis: 'row', at: 0, count: 2 });
  assert.equal(data.cells.B3, '=A4+Summary!A2+Data!A4');
  assert.equal(renameSheetRefs("=Data!A1+'data'!B2+Other!C1+\"Data!A1\"", 'Data', 'Q1 data'), "='Q1 data'!A1+'Q1 data'!B2+Other!C1+\"Data!A1\"");
});

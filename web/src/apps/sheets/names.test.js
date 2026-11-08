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

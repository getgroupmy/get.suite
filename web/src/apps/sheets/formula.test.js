import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEvaluator, colName, colIndex, shiftFormula, display } from './formula.js';

const ev = (cells) => createEvaluator(cells);

test('column names', () => {
  assert.equal(colName(0), 'A');
  assert.equal(colName(25), 'Z');
  assert.equal(colName(26), 'AA');
  assert.equal(colName(701), 'ZZ');
  assert.equal(colIndex('AA'), 26);
});

test('arithmetic and precedence', () => {
  const g = ev({ A1: '=1+2*3', A2: '=(1+2)*3', A3: '=2^3^1', A4: '=-2^2', A5: '=50%', A6: '=10/4' });
  assert.equal(g('A1'), 7);
  assert.equal(g('A2'), 9);
  assert.equal(g('A3'), 8);
  assert.equal(g('A4'), 4);
  assert.equal(g('A5'), 0.5);
  assert.equal(g('A6'), 2.5);
});

test('references, ranges and functions', () => {
  const g = ev({ A1: '1', A2: '2', A3: '3', A4: 'text', B1: '=SUM(A1:A4)', B2: '=AVERAGE(A1:A3)', B3: '=A1+A2*A3',
    B4: '=MAX(A1:A3, 10)', B5: '=COUNT(A1:A4)', B6: '=COUNTA(A1:A4)', B7: '=IF(A1>0, "pos", "neg")',
    B8: '=CONCAT(A4, "-", A1)', B9: '=A4&"!"', C1: '=SUMIF(A1:A3, ">1")', C2: '=COUNTIF(A1:A4, "text")',
    C3: '=ROUND(2/3, 2)', C4: '=MEDIAN(A1:A3, 4)', C5: '=empty+1', C6: '=E99*2' });
  assert.equal(g('B1'), 6);
  assert.equal(g('B2'), 2);
  assert.equal(g('B3'), 7);
  assert.equal(g('B4'), 10);
  assert.equal(g('B5'), 3);
  assert.equal(g('B6'), 4);
  assert.equal(g('B7'), 'pos');
  assert.equal(g('B8'), 'text-1');
  assert.equal(g('B9'), 'text!');
  assert.equal(g('C1'), 5);
  assert.equal(g('C2'), 1);
  assert.equal(g('C3'), 0.67);
  assert.equal(g('C4'), 2.5);
  assert.deepEqual(g('C5'), { error: '#NAME?' });
  assert.equal(g('C6'), 0, 'empty cells count as 0');
});

test('errors propagate and cycles are detected', () => {
  const g = ev({ A1: '=1/0', A2: '=A1+1', B1: '=B2', B2: '=B1', C1: '="a"*2', D1: '=IFERROR(1/0, "x")', E1: '=SUM(', E2: '=FOO(1)' });
  assert.deepEqual(g('A1'), { error: '#DIV/0!' });
  assert.deepEqual(g('A2'), { error: '#DIV/0!' });
  assert.deepEqual(g('B1'), { error: '#CIRC!' });
  assert.deepEqual(g('C1'), { error: '#VALUE!' });
  assert.equal(g('D1'), 'x');
  assert.deepEqual(g('E1'), { error: '#ERROR!' });
  assert.deepEqual(g('E2'), { error: '#NAME?' });
});

test('IF short-circuits', () => {
  const g = ev({ A1: '=IF(TRUE, 1, 1/0)' });
  assert.equal(g('A1'), 1);
});

test('shifting references', () => {
  assert.equal(shiftFormula('=A1+$B$2+B$3+"A1"', 1, 2), '=B3+$B$2+C$3+"A1"');
  assert.equal(shiftFormula('=SUM(A1:A3)', 0, 1), '=SUM(A2:A4)');
  assert.equal(shiftFormula('=A1', -1, 0), '=#REF!');
});

test('display', () => {
  assert.equal(display(0.1 + 0.2), '0.3');
  assert.equal(display(true), 'TRUE');
  assert.equal(display({ error: '#REF!' }), '#REF!');
});

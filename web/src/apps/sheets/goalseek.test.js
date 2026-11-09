import test from 'node:test';
import assert from 'node:assert/strict';
import { goalSeek, cellOf, tidy } from './goalseek.js';

const book = (cells, more = []) => [{ name: 'Sheet1', cells }, ...more];

test('cell addresses', () => {
  assert.equal(cellOf(' b3 '), 'B3');
  assert.equal(cellOf('$C$12'), 'C12');
  assert.equal(cellOf('B0'), null);
  assert.equal(cellOf('B'), null);
  assert.equal(cellOf('A1:B2'), null);
});

test('a straight line: the price that gives a profit', () => {
  // profit = units * price - costs
  const s = book({ B1: 500, B2: 12, B3: 4000, B4: '=B1*B2-B3' });
  const r = goalSeek(s, 0, 'B4', '10000', 'B2');
  assert.equal(r.value, 28);
  assert.equal(r.result, 10000);
  assert.equal(s[0].cells.B2, 12, 'the sheet is not changed');
});

test('curves, other sheets, an empty cell to start from', () => {
  assert.equal(goalSeek(book({ A1: 3, A2: '=A1^2' }), 0, 'A2', 2, 'A1').value, tidy(Math.SQRT2));
  // Loan: payment for a rate, via PMT-like formula; find the rate.
  const loan = book({ B1: 0.01, B2: 60, B3: 20000, B4: '=B3*B1/(1-(1+B1)^-B2)' });
  const r = goalSeek(loan, 0, 'B4', 400, 'B1');
  assert.ok(Math.abs(r.result - 400) < 1e-6, JSON.stringify(r));
  assert.ok(r.value > 0.006 && r.value < 0.008);
  const two = book({ A1: 5, A2: '=A1*Rates!A1' }, [{ name: 'Rates', cells: { A1: 2 } }]);
  assert.equal(goalSeek(two, 0, 'A2', 30, 'A1').value, 15, 'formulas using other sheets');
  assert.equal(goalSeek(book({ A1: '', A2: '=A1*3+1' }), 0, 'A2', 10, 'A1').value, 3);
  // Flat until 50: the first tries change nothing, so it looks further out.
  const step = goalSeek(book({ A1: 1, A2: '=IF(A1>50,A1-40,0)' }), 0, 'A2', 20, 'A1');
  assert.ok(Math.abs(step.value - 60) < 1e-6 && Math.abs(step.result - 20) < 1e-6, JSON.stringify(step));
});

test('what it refuses, in words', () => {
  const s = book({ A1: 5, A2: '=A1*2', A3: 7, A4: 'text', A5: '=A1' });
  assert.match(goalSeek(s, 0, 'A1', 3, 'A3').error, /A1 needs a formula/);
  assert.match(goalSeek(s, 0, 'A2', 3, 'A5').error, /A5 has a formula/);
  assert.match(goalSeek(s, 0, 'A2', 3, 'A4').error, /needs a number/);
  assert.match(goalSeek(s, 0, 'A2', 'lots', 'A1').error, /type a number/);
  assert.match(goalSeek(s, 0, 'A2', 3, 'A3').error, /Changing A3 doesn't change A2/);
  assert.match(goalSeek(s, 0, 'nope', 3, 'A1').error, /Set cell/);
  assert.match(goalSeek(book({ A1: 1, A2: '=A1^2' }), 0, 'A2', -4, 'A1').error, /No value of A1/);
  assert.match(goalSeek(book({ A1: 1, A2: '="x"&A1' }), 0, 'A2', 4, 'A1').error, /doesn't come to a number/);
});

test('tidy', () => {
  assert.equal(tidy(1.9999999999997), 2);
  assert.equal(tidy(0), 0);
  assert.equal(tidy(0.1 + 0.2), 0.3);
});

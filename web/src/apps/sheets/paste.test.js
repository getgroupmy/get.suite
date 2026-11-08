import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pasteSpecial } from './paste.js';
import { shiftFormula } from './formula.js';

// Copied from A1:B2: a label, a number with a format, and a formula with its result.
const clip = {
  origin: { c: 0, r: 0 },
  raws: [['Total', '=B2*2'], ['x', '21']],
  vals: [['Total', '42'], ['x', '21']],
  fmts: [[{ b: 1 }, null], [null, { num: 'currency' }]],
};

test('values only: what the cells showed, formulas turned into their results; formatting untouched', () => {
  const p = pasteSpecial(clip, { c: 3, r: 5 }, 'values', shiftFormula);
  assert.deepEqual(p.cells, { D6: 'Total', E6: '42', D7: 'x', E7: '21' });
  assert.deepEqual(p.formats, {});
});

test('formatting only: no values', () => {
  const p = pasteSpecial(clip, { c: 3, r: 5 }, 'formats', shiftFormula);
  assert.deepEqual(p.cells, {});
  assert.deepEqual(p.formats, { D6: { b: 1 }, E6: null, D7: null, E7: { num: 'currency' } });
});

test('transposed: rows become columns, formulas moved to where their cell lands', () => {
  const p = pasteSpecial(clip, { c: 3, r: 5 }, 'transpose', shiftFormula);
  // B1 (=B2*2) lands in D7: 2 columns right and 6 rows down of where it was.
  assert.deepEqual(p.cells, { D6: 'Total', D7: '=D8*2', E6: 'x', E7: '21' });
  assert.equal(p.cells.D7, shiftFormula('=B2*2', 2, 6));
  assert.deepEqual(p.formats, { D6: { b: 1 }, D7: null, E6: null, E7: { num: 'currency' } });
  assert.deepEqual(p.size, { rows: 2, cols: 2 });
  const wide = pasteSpecial({ origin: { c: 0, r: 0 }, raws: [['a', 'b', 'c']], vals: [['a', 'b', 'c']], fmts: [[null, null, null]] }, { c: 0, r: 0 }, 'transpose', shiftFormula);
  assert.deepEqual(Object.keys(wide.cells), ['A1', 'A2', 'A3']);
  assert.deepEqual(wide.size, { rows: 3, cols: 1 });
});

test('all: as a normal paste', () => {
  const p = pasteSpecial(clip, { c: 0, r: 2 }, 'all', shiftFormula);
  assert.deepEqual(p.cells, { A3: 'Total', B3: '=B4*2', A4: 'x', B4: '21' });
});

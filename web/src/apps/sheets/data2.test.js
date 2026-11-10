import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trimText, changeCase, mapText } from './data.js';

test('trim whitespace: ends, runs inside, tabs and non-breaking spaces; lines kept', () => {
  assert.equal(trimText('  Acme   Trading\t Ltd  '), 'Acme Trading Ltd');
  assert.equal(trimText(' first line  \n   second '), 'first line\nsecond');
  assert.equal(trimText('   '), '');
});

test('change case: upper, lower, title, sentence', () => {
  assert.equal(changeCase('kuala lumpur', 'upper'), 'KUALA LUMPUR');
  assert.equal(changeCase('ÉCOLE Normale', 'lower'), 'école normale');
  assert.equal(changeCase("o'neil-smith of jOHN's farm (east)", 'title'), "O'Neil-Smith Of John's Farm (East)");
  assert.equal(changeCase('HELLO THERE. how are you? fine!  ok', 'sentence'), 'Hello there. How are you? Fine!  Ok');
  assert.equal(changeCase('x', 'other'), 'x');
});

test('mapText: only text in the range; formulas, numbers and others left; empty results cleared', () => {
  const sheet = { cells: { A1: '  Name ', A2: '=TRIM(B2)', A3: 42, A4: '   ', B1: ' outside ', A5: 'Done' } };
  const out = mapText(sheet, { c1: 0, r1: 0, c2: 0, r2: 4 }, trimText);
  assert.deepEqual(out.cells, { A1: 'Name', A2: '=TRIM(B2)', A3: 42, B1: ' outside ', A5: 'Done' });
  assert.equal(out.changed, 2);
  assert.equal(sheet.cells.A1, '  Name ', 'the sheet itself untouched');
});

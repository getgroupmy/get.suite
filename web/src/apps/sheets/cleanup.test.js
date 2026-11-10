import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanupSuggestions, fixSpelling, fixSpaces, looksLikeHeader } from './cleanup.js';

const sheet = { cells: {
  A1: 'Region', B1: 'Rep', C1: 'Sales',
  A2: 'North', B2: 'Ann', C2: '10',
  A3: 'north', B3: ' Ben  Smith ', C3: '20',
  A4: 'NORTH', B4: 'Cy', C4: '30',
  A5: 'South', B5: 'Ann', C5: '=C2*2',
  A6: 'North', B6: 'Ann', C6: '10',
  A7: 'south ', B7: 'Dee', C7: '5',
} };
const range = { c1: 0, c2: 2, r1: 0, r2: 6 };
const value = (k) => sheet.cells[k] ?? '';

test('cleanup: headings guessed; spaces, spellings and duplicate rows found', () => {
  assert.equal(looksLikeHeader(sheet, range), true);
  assert.equal(looksLikeHeader({ cells: { A1: 'a', A2: 'b' } }, { c1: 0, c2: 0, r1: 0, r2: 1 }), false);
  const s = cleanupSuggestions(sheet, range, value, { header: true });
  assert.deepEqual(s.map((x) => x.kind), ['spaces', 'spelling', 'duplicates']);
  assert.equal(s[0].count, 2, '" Ben  Smith " and "south "');
  const sp = s[1];
  assert.equal(sp.col, 'A');
  assert.deepEqual(sp.groups.map((g) => [g.to, g.forms]), [['North', ['North', 'north', 'NORTH']], ['South', ['South', 'south']]]);
  assert.equal(sp.count, 3, 'north, NORTH and south');
  assert.equal(s[2].count, 1, 'row 6 repeats row 2');
  assert.deepEqual(cleanupSuggestions({ cells: { A1: 'x', A2: 'y' } }, { c1: 0, c2: 0, r1: 0, r2: 1 }, (k) => ({ A1: 'x', A2: 'y' })[k]), []);
});

test('cleanup: fixes change only text cells, never the headings or formulas', () => {
  const s = cleanupSuggestions(sheet, range, value, { header: true });
  const sp = fixSpelling(sheet, range, s[1], { header: true });
  assert.deepEqual(['A2', 'A3', 'A4', 'A7'].map((k) => sp.cells[k]), ['North', 'North', 'North', 'South']);
  assert.equal(sp.changed, 3);
  const tidy = fixSpaces(sheet, range, { header: true });
  assert.equal(tidy.cells.B3, 'Ben Smith');
  assert.equal(tidy.cells.C5, '=C2*2');
  assert.equal(tidy.changed, 2);
  const noHead = cleanupSuggestions({ cells: { A1: 'yes', A2: 'Yes' } }, { c1: 0, c2: 0, r1: 0, r2: 1 }, () => '', { header: false });
  assert.equal(noHead[0].kind, 'spelling');
});

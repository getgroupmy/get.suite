import { test } from 'node:test';
import assert from 'node:assert/strict';
import { separatorFor, parseTable } from './csvtable.js';

test('quoted cells keep their commas, quotes and line breaks; a BOM and CRLF are handled', () => {
  const t = '﻿Name,Note,Price\r\n"Oak desk","Big, heavy",120\r\n"Chair ""Ola""","two\nlines",40\r\n';
  assert.deepEqual(parseTable(t).rows, [['Name', 'Note', 'Price'], ['Oak desk', 'Big, heavy', '120'], ['Chair "Ola"', 'two\nlines', '40']]);
  assert.equal(parseTable(t).more, false);
});

test('empty cells and a last line without a line break', () => {
  assert.deepEqual(parseTable('a,,c\n,b,').rows, [['a', '', 'c'], ['', 'b', '']]);
  assert.deepEqual(parseTable('').rows, []);
});

test('the separator: tab for .tsv, semicolon when the first line uses it, else comma', () => {
  assert.equal(separatorFor('x.tsv', 'a,b,c'), '\t');
  assert.equal(separatorFor('x.csv', 'Name;Price;Note\n1;2;3'), ';');
  assert.equal(separatorFor('x.csv', '"a;b";c,d'), ',', 'what is inside quotes does not count');
  assert.equal(separatorFor('x.csv', 'single'), ',');
  assert.deepEqual(parseTable('a\tb\n1\t2', '\t').rows, [['a', 'b'], ['1', '2']]);
});

test('at most maxRows, saying more were left out', () => {
  const t = Array.from({ length: 10 }, (_, i) => `r${i},x`).join('\n');
  const p = parseTable(t, ',', 4);
  assert.equal(p.rows.length, 4);
  assert.equal(p.rows[3][0], 'r3');
  assert.equal(p.more, true);
  assert.equal(parseTable(t, ',', 10).more, false);
});

import { sortRows, filterRows, numberOf } from './csvtable.js';

test('numbers read as numbers: thousands, signs, decimals, percentages', () => {
  assert.equal(numberOf('1,234.5'), 1234.5);
  assert.equal(numberOf('-3'), -3);
  assert.equal(numberOf('12%'), 12);
  assert.equal(numberOf('12 apples'), null);
  assert.equal(numberOf(''), null);
});

test('sorting: numbers by value, words naturally, empty cells last, ties in file order', () => {
  const rows = [['Lamp', '25'], ['desk', '120'], ['Chair', '9'], ['Item 10', ''], ['Item 9', '9']];
  assert.deepEqual(sortRows(rows, 1).map((r) => r[0]), ['Chair', 'Item 9', 'Lamp', 'desk', 'Item 10']);
  assert.deepEqual(sortRows(rows, 1, -1).map((r) => r[0]), ['desk', 'Lamp', 'Chair', 'Item 9', 'Item 10']);
  assert.deepEqual(sortRows(rows, 0).map((r) => r[0]), ['Chair', 'desk', 'Item 9', 'Item 10', 'Lamp']);
});

test('filtering keeps rows with a cell containing the words, ignoring case', () => {
  const rows = [['Lamp', 'Lyon'], ['Desk', 'Paris'], ['Chair', 'lyon']];
  assert.deepEqual(filterRows(rows, 'LYON').map((r) => r[0]), ['Lamp', 'Chair']);
  assert.equal(filterRows(rows, '  ').length, 3);
});

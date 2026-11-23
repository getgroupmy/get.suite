import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findError, findElsewhere, findCells, replaceEntry, replaceAll } from './find.js';

const cells = { A1: 'Apple pie', B1: '12', A2: 'apple', B2: '=B1*10', C2: 'Pineapple', A3: 'pear', B3: '=A2&" tart"' };
const shown = (k) => ({ B2: 120, B3: 'apple tart' }[k] ?? cells[k]);
const keys = (m) => m.map((x) => x.key);

test('finds by what cells show, in reading order', () => {
  assert.deepEqual(keys(findCells(cells, shown, 'apple')), ['A1', 'A2', 'C2', 'B3']);
  assert.deepEqual(keys(findCells(cells, shown, 'Apple', { matchCase: true })), ['A1']);
  assert.deepEqual(keys(findCells(cells, shown, 'apple', { wholeCell: true })), ['A2']);
  assert.deepEqual(keys(findCells(cells, shown, '120')), ['B2']);
  assert.deepEqual(keys(findCells(cells, shown, '')), []);
  assert.deepEqual(keys(findCells(cells, shown, 'a.p')), []); // no regex surprises
});

test('formulas option searches formula text; hidden rows are skipped', () => {
  assert.deepEqual(keys(findCells(cells, shown, 'B1', { formulas: true })), ['B2']);
  assert.deepEqual(keys(findCells(cells, shown, 'B1')), []);
  assert.deepEqual(keys(findCells(cells, shown, 'apple', {}, new Set([1]))), ['A1', 'B3']);
});

test('replacing changes entries but leaves formulas alone unless asked', () => {
  assert.equal(replaceEntry('Apple pie', 'apple', 'Cherry'), 'Cherry pie');
  assert.equal(replaceEntry('apple apple', 'apple', '$1'), '$1 $1');
  assert.equal(replaceEntry('=B1*10', '10', '20'), null);
  assert.equal(replaceEntry('=B1*10', '10', '20', { formulas: true }), '=B1*20');
  assert.equal(replaceEntry('pear', 'apple', 'x'), null);
  const m = findCells(cells, shown, 'apple');
  const r = replaceAll(cells, m, 'apple', 'plum');
  assert.deepEqual(r.updates, { A1: 'plum pie', A2: 'plum', C2: 'Pineplum' });
  assert.equal(r.count, 3);
  assert.equal(r.skipped, 1); // B3 shows "apple tart" through its formula
});

test('accents don\'t matter in a sheet\'s find unless matchDiacritics; replacing takes the word as written', () => {
  const cells = { A1: 'Café', A2: 'cafe crème', A3: 'tea' };
  const shown = (k) => cells[k];
  assert.deepEqual(findCells(cells, shown, 'cafe').map((m) => m.key), ['A1', 'A2']);
  assert.deepEqual(findCells(cells, shown, 'café', { matchDiacritics: true }).map((m) => m.key), ['A1']);
  assert.deepEqual(findCells(cells, shown, 'cafe', { wholeCell: true }).map((m) => m.key), ['A1'], 'the whole cell, accents aside');
  assert.equal(replaceEntry('cafe crème', 'creme', 'cream'), 'cafe cream');
  assert.equal(replaceEntry('Café', 'café', 'Bar', { matchDiacritics: true }), 'Bar');
});

test('where else in the workbook: the other sheets with matches, hidden ones and formulas left out', () => {
  const sheets = [
    { name: 'Jan', cells: { A1: 'Rent', A2: 'Café' } },
    { name: 'Feb', cells: { A1: 'rent', B4: 'Rent rebate', C1: '=A1&" rent"', D1: 5 } },
    { name: 'Notes', cells: { A1: 'nothing' } },
    { name: 'Old', hidden: true, cells: { A1: 'Rent' } },
    { name: 'Mar', cells: { A1: 'cafe' } },
  ];
  assert.deepEqual(findElsewhere(sheets, 0, 'rent'), [{ index: 1, name: 'Feb', count: 2 }]);
  assert.deepEqual(findElsewhere(sheets, 0, 'rent', { formulas: true }), [{ index: 1, name: 'Feb', count: 3 }]);
  assert.deepEqual(findElsewhere(sheets, 0, 'rent', { wholeCell: true }), [{ index: 1, name: 'Feb', count: 1 }]);
  assert.deepEqual(findElsewhere(sheets, 1, 'café').map((x) => x.name), ['Jan', 'Mar']);
  assert.deepEqual(findElsewhere(sheets, 1, 'café', { matchDiacritics: true }).map((x) => x.name), ['Jan']);
  assert.deepEqual(findElsewhere(sheets, 0, '5'), [{ index: 1, name: 'Feb', count: 1 }], 'numbers too');
  assert.deepEqual(findElsewhere(sheets, 0, ''), []);
});

test('a regular expression: found as written, groups in the replacement, and a bad one says so', () => {
  const cells = { A1: 'INV-2024-07', A2: 'inv-2025-11', A3: 'Invoice', B1: '=A1&"!"', C1: '  padded' };
  const shown = (k) => (k === 'B1' ? 'INV-2024-07!' : cells[k]);
  assert.deepEqual(findCells(cells, shown, '\\d{4}-\\d{2}', { regex: true }).map((m) => m.key), ['A1', 'B1', 'A2']);
  assert.deepEqual(findCells(cells, shown, '^inv-\\d+', { regex: true, matchCase: true }).map((m) => m.key), ['A2']);
  assert.deepEqual(findCells(cells, shown, 'inv.*', { regex: true, wholeCell: true }).map((m) => m.key), ['A1', 'B1', 'A2', 'A3']);
  assert.equal(replaceEntry('INV-2024-07', '(\\d{4})-(\\d{2})', '$2/$1', { regex: true }), 'INV-07/2024');
  assert.equal(replaceEntry('  padded', '^\\s+', '', { regex: true }), 'padded');
  assert.equal(replaceEntry('a.b', '.', '$1', {}), 'a$1b', 'without it a dot is a dot and $1 is text');
  assert.equal(replaceEntry('=A1&"!"', '\\d', '9', { regex: true }), null, 'formulas are left alone');
  assert.deepEqual(findCells(cells, shown, '(', { regex: true }), []);
  assert.match(findError('(', { regex: true }), /valid regular expression/);
  assert.equal(findError('(', {}), null);
  assert.equal(findError('\\d+', { regex: true }), null);
  assert.deepEqual(findElsewhere([{ name: 'A', cells: {} }, { name: 'B', cells: { A1: 'x12', A2: 'y' } }], 0, '\\d+', { regex: true }), [{ index: 1, name: 'B', count: 1 }]);
});

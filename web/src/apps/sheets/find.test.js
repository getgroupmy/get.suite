import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findCells, replaceEntry, replaceAll } from './find.js';

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

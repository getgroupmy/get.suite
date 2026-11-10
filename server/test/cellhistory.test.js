import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cellHistory } from '../src/office/cellhistory.js';

const book = (cells, name = 'Budget') => ({ sheets: [{ name: 'Intro', cells: {} }, { name, cells }] });

test('cell history: each change, what it was before, who and when; unchanged versions skipped', () => {
  const states = [
    { content: book({ B4: '=SUM(B1:B3)' }), by: 'kim', at: 40 },
    { content: book({ B4: '150' }), by: 'ann', at: 30 },
    { content: book({ B4: '150', C1: 'x' }), by: 'bo', at: 20 }, // B4 not touched in this one
    { content: book({ B4: '100' }), by: 'ann', at: 10 },
    { content: book({}), by: 'ann', at: 5 },
  ];
  assert.deepEqual(cellHistory(states, { index: 1, name: 'Budget', cell: 'B4' }), [
    { value: '=SUM(B1:B3)', before: '150', by: 'kim', at: 40 },
    { value: '150', before: '100', by: 'bo', at: 20 },
    { value: '100', before: '', by: 'ann', at: 10 },
  ]);
  assert.deepEqual(cellHistory(states, { index: 1, cell: 'Z9' }), [], 'never filled');
});

test('cell history: the sheet found by name when it moved, by place when it was renamed; cleared cells shown as empty', () => {
  const moved = [{ content: { sheets: [{ name: 'Budget', cells: { A1: '2' } }] }, by: 'a', at: 2 }, { content: book({ A1: '1' }), by: 'b', at: 1 }];
  assert.deepEqual(cellHistory(moved, { index: 0, name: 'Budget', cell: 'A1' }).map((x) => x.value), ['2', '1']);
  const renamed = [{ content: book({ A1: '' }, 'Costs'), by: 'a', at: 2 }, { content: book({ A1: '1' }), by: 'b', at: 1 }];
  assert.deepEqual(cellHistory(renamed, { index: 1, name: 'Costs', cell: 'A1' }), [{ value: '', before: '1', by: 'a', at: 2 }, { value: '1', before: '', by: 'b', at: 1 }]);
  assert.equal(cellHistory(Array.from({ length: 80 }, (_, i) => ({ content: book({ A1: String(80 - i) }), by: 'x', at: 80 - i })), { index: 1, cell: 'A1' }).length, 50, 'at most 50');
});

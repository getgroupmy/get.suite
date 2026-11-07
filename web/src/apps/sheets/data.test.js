import { test } from 'node:test';
import assert from 'node:assert/strict';
import { removeDuplicates, splitColumn, detectSeparator } from './data.js';
import { createEvaluator } from './formula.js';

const sheetOf = (cells) => ({ cells });
const run = (cells, range, opts) => { const ev = createEvaluator(cells); return removeDuplicates(sheetOf(cells), range, { value: ev, ...opts }); };

test('remove duplicates: whole rows, case and spaces ignored, first kept, rows close up', () => {
  const cells = { A1: 'Name', B1: 'City', A2: 'Ann', B2: 'Leeds', A3: 'Bob', B3: 'York', A4: 'ann ', B4: 'LEEDS', A5: 'Ann', B5: 'York', A6: 'Bob', B6: 'York', C2: 'outside' };
  const out = run(cells, { c1: 0, c2: 1, r1: 0, r2: 5 }, { header: true });
  assert.equal(out.removed, 2);
  assert.equal(out.kept, 3);
  assert.deepEqual([2, 3, 4, 5, 6].map((r) => [out.cells[`A${r}`], out.cells[`B${r}`]]), [['Ann', 'Leeds'], ['Bob', 'York'], ['Ann', 'York'], [undefined, undefined], [undefined, undefined]]);
  assert.equal(out.cells.A1, 'Name');
  assert.equal(out.cells.C2, 'outside', 'outside the range untouched');
});

test('remove duplicates: by what cells show, with formulas shifted as rows move', () => {
  const cells = { A1: '5', B1: '=A1*2', A2: '5', B2: '10', A3: '7', B3: '=A3*2' };
  const out = run(cells, { c1: 0, c2: 1, r1: 0, r2: 2 }, {});
  assert.equal(out.removed, 1, '=A1*2 shows 10, like the plain 10');
  assert.equal(out.cells.B2, '=A2*2', 'moved up a row');
  assert.equal(out.cells.A3, undefined);
});

test('split text to columns: detected or chosen separator, trimmed, over the cells to the right', () => {
  const cells = { A1: 'Ann, Leeds, 31', A2: 'Bob,York', A3: '=1+1', A4: 'Cat', B2: 'old' };
  const out = splitColumn({ cells }, { c1: 0, c2: 0, r1: 0, r2: 3 });
  assert.equal(out.sep, ',');
  assert.equal(out.columns, 3);
  assert.equal(out.overwritten, 1);
  assert.deepEqual([out.cells.A1, out.cells.B1, out.cells.C1, out.cells.A2, out.cells.B2], ['Ann', 'Leeds', '31', 'Bob', 'York']);
  assert.equal(out.cells.A3, '=1+1');
  assert.equal(out.cells.A4, 'Cat');
  const spaced = splitColumn({ cells: { A1: 'Kim   Park' } }, { c1: 0, c2: 0, r1: 0, r2: 0 }, ' ');
  assert.deepEqual([spaced.cells.A1, spaced.cells.B1, spaced.cells.C1], ['Kim', 'Park', undefined], 'runs of spaces count once');
  assert.equal(detectSeparator(['a;b', 'c;d', 'e,f']), ';');
  assert.equal(detectSeparator(['a\tb,c']), '\t');
});

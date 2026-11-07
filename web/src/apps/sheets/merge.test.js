import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeLayout, mergeAt, addMerge, removeMerges, growToMerges, stepWithMerges } from './merge.js';
import { applyStructure } from './structure.js';

test('layout: spans for the top-left cell, covered cells hidden', () => {
  const { spans, covered } = mergeLayout(['A1:C1', 'B3:C4']);
  assert.deepEqual([spans.get('A1').colSpan, spans.get('A1').rowSpan], [3, 1]);
  assert.deepEqual([spans.get('B3').colSpan, spans.get('B3').rowSpan], [2, 2]);
  assert.deepEqual([...covered.keys()].sort(), ['B1', 'B4', 'C1', 'C3', 'C4']);
  assert.equal(covered.get('C4'), 'B3');
});

test('adding replaces overlapping merges; single cells are not merged; unmerging', () => {
  let m = addMerge([], 'A1:B2');
  assert.deepEqual(m, ['A1:B2']);
  m = addMerge(m, 'B2:C3');
  assert.deepEqual(m, ['B2:C3']);
  assert.deepEqual(addMerge(m, 'E5:E5'), m);
  m = addMerge(m, 'E1:F1');
  assert.deepEqual(removeMerges(m, { c1: 2, r1: 2, c2: 2, r2: 2 }), ['E1:F1']);
  assert.deepEqual(mergeAt(m, 5, 0), { c1: 4, r1: 0, c2: 5, r2: 0 });
  assert.equal(mergeAt(m, 6, 0), null);
});

test('selections grow to whole merges; the cursor moves over them', () => {
  assert.deepEqual(growToMerges(['B1:C2'], { c1: 0, r1: 1, c2: 1, r2: 1 }), { c1: 0, r1: 0, c2: 2, r2: 1 });
  const lim = { cols: 10, rows: 10 };
  assert.deepEqual(stepWithMerges(['B1:D1'], 0, 0, 1, 0, lim), { c: 1, r: 0 }, 'into: top-left');
  assert.deepEqual(stepWithMerges(['B1:D1'], 1, 0, 1, 0, lim), { c: 4, r: 0 }, 'out: past its edge');
  assert.deepEqual(stepWithMerges(['B1:D2'], 1, 0, 0, 1, lim), { c: 1, r: 2 });
  assert.deepEqual(stepWithMerges(['B1:D2'], 2, 2, 0, -1, lim), { c: 1, r: 0 }, 'up into it');
});

test('inserting and deleting rows and columns moves merges with the cells', () => {
  const sheet = { cells: { A1: 'Title' }, merges: ['A1:C1', 'B3:C4'] };
  assert.deepEqual(applyStructure(sheet, { axis: 'col', at: 1, count: 1 }).merges, ['A1:D1', 'C3:D4'], 'a column inside widens it');
  assert.deepEqual(applyStructure(sheet, { axis: 'row', at: 0, count: 1 }).merges, ['A2:C2', 'B4:C5']);
  assert.deepEqual(applyStructure(sheet, { axis: 'col', at: 1, count: -2 }).merges, [], 'shrunk to one cell: gone');
});

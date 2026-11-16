import test from 'node:test';
import assert from 'node:assert/strict';
import { rowTops, rowWindow, ROW_H } from './rowwindow.js';

const nums = (l) => l.filter((x) => typeof x === 'number');
const gaps = (l) => l.filter((x) => typeof x === 'object').map((g) => g.gap);

test('row tops follow set heights and skip hidden rows', () => {
  const t = rowTops(4, (r) => (r === 1 ? 50 : null), new Set([2]));
  assert.deepEqual([...t], [0, ROW_H, ROW_H + 50, ROW_H + 50, 2 * ROW_H + 50]);
});

test('only the rows in view are drawn, with gaps for the rest keeping the sheet its height', () => {
  const t = rowTops(20000, () => null);
  const l = rowWindow(t, 100 * ROW_H, 140 * ROW_H);
  assert.equal(nums(l)[0], 100);
  assert.equal(nums(l).at(-1), 140);
  assert.deepEqual(gaps(l), [100 * ROW_H, (20000 - 141) * ROW_H]);
  const total = gaps(l).reduce((a, b) => a + b, 0) + nums(l).length * ROW_H;
  assert.equal(total, 20000 * ROW_H);
});

test('the top of the sheet has no gap above, the end none below', () => {
  const t = rowTops(1000, () => null);
  assert.equal(rowWindow(t, 0, 500)[0], 0);
  const end = rowWindow(t, 999 * ROW_H, 1001 * ROW_H);
  assert.equal(end.at(-1), 999);
});

test('frozen rows are always drawn, before the gap', () => {
  const t = rowTops(5000, () => null);
  const l = rowWindow(t, 3000 * ROW_H, 3010 * ROW_H, { frozen: 2 });
  assert.deepEqual(l.slice(0, 2), [0, 1]);
  assert.equal(l[2].gap, 2998 * ROW_H);
  assert.equal(l[3], 3000);
});

test('a merged cell reaching into the window is drawn from its top row to its end', () => {
  const t = rowTops(5000, () => null);
  const spans = new Map([['B95', { rowSpan: 10, colSpan: 1 }], ['C120', { rowSpan: 30, colSpan: 2 }]]);
  const l = nums(rowWindow(t, 100 * ROW_H, 120 * ROW_H, { spans }));
  assert.equal(l[0], 94);
  assert.equal(l.at(-1), 148);
});

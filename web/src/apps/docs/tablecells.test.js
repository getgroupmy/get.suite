import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cellColor, CELL_COLORS } from './tablecells.js';

test('a cell colour from what a style says', () => {
  assert.equal(cellColor('#FEF7E0'), '#fef7e0');
  assert.equal(cellColor('#abc'), '#aabbcc');
  assert.equal(cellColor('rgb(230, 244, 234)'), '#e6f4ea');
  assert.equal(cellColor('rgba(0, 0, 0, 0)'), null, 'transparent is none');
  assert.equal(cellColor('#ffffff'), null, 'white is none');
  assert.equal(cellColor('red'), null);
  assert.equal(cellColor(''), null);
  assert.ok(!CELL_COLORS.some(([v]) => v === '#f1f3f4'), 'not the heading row’s own grey (that one isn’t kept as a colour)');
});

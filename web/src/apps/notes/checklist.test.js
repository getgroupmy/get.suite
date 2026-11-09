import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indent, moveItem, tick, untickAll, dropTicked, tidy } from './checklist.js';

const L = (spec) => spec.split(' ').map((s) => ({ id: s.replace(/[>*]/g, ''), text: s.replace(/[>*]/g, ''), done: s.includes('*'), ...(s.startsWith('>') && { indent: 1 }) }));
const S = (items) => items.map((x) => `${x.indent ? '>' : ''}${x.id}${x.done ? '*' : ''}`).join(' ');

test('sub-items: Tab under the item above; never the first', () => {
  assert.equal(S(indent(L('a b c'), 'b', 1)), 'a >b c');
  assert.equal(S(indent(L('a >b c'), 'b', -1)), 'a b c');
  assert.equal(S(indent(L('a b'), 'a', 1)), 'a b');
  assert.equal(S(tidy(L('>a b'))), 'a b');
});

test('moving an item takes its sub-items with it', () => {
  assert.equal(S(moveItem(L('a >a1 >a2 b c'), 'b', -1)), 'b a >a1 >a2 c', 'up past a whole block');
  assert.equal(S(moveItem(L('a >a1 b c'), 'a', 1)), 'b a >a1 c', 'down with its sub-item');
  assert.equal(S(moveItem(L('a b >b1 c'), 'a', 1)), 'b >b1 a c', 'down past a block');
  assert.equal(S(moveItem(L('a >a1 >a2 b'), 'a2', -1)), 'a >a2 >a1 b', 'a sub-item moves on its own');
  assert.equal(S(moveItem(L('a b'), 'a', -1)), 'a b');
  assert.equal(S(moveItem(L('a >a1'), 'a', 1)), 'a >a1');
});

test('ticking a main item ticks its sub-items; untick all; delete ticked', () => {
  assert.equal(S(tick(L('a >a1 >a2 b'), 'a', true)), 'a* >a1* >a2* b');
  assert.equal(S(tick(L('a >a1 b'), 'a1', true)), 'a >a1* b');
  assert.equal(S(untickAll(L('a* >a1* b'))), 'a >a1 b');
  assert.equal(S(dropTicked(L('a* >a1 b >b1* c'))), 'a1 b c', 'a sub-item left on top becomes a main item');
});

test('dragging an item onto another', async () => {
  const { moveItemTo } = await import('./checklist.js');
  assert.equal(S(moveItemTo(L('a b c d'), 'd', 'b')), 'a d b c');
  assert.equal(S(moveItemTo(L('a >a1 b c'), 'a', 'c')), 'b c a >a1');
  assert.equal(S(moveItemTo(L('a b'), 'a', 'a')), 'a b');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moveTo, moveBy } from './order.js';

test('dragging a card onto another takes its place', () => {
  assert.deepEqual(moveTo(['a', 'b', 'c', 'd'], 'd', 'b'), ['a', 'd', 'b', 'c'], 'from later: before it');
  assert.deepEqual(moveTo(['a', 'b', 'c', 'd'], 'a', 'c'), ['b', 'c', 'a', 'd'], 'from earlier: after it');
  assert.deepEqual(moveTo(['a', 'b'], 'a', 'a'), ['a', 'b']);
  assert.deepEqual(moveTo(['a', 'b'], 'x', 'a'), ['a', 'b']);
});

test('a place earlier or later, not past the ends', () => {
  assert.deepEqual(moveBy(['a', 'b', 'c'], 'b', -1), ['b', 'a', 'c']);
  assert.deepEqual(moveBy(['a', 'b', 'c'], 'b', 1), ['a', 'c', 'b']);
  assert.deepEqual(moveBy(['a', 'b', 'c'], 'a', -1), ['a', 'b', 'c']);
  assert.deepEqual(moveBy(['a', 'b', 'c'], 'c', 1), ['a', 'b', 'c']);
});

test('sorting notes: last edited, newest, by title (or text), or as they are', async () => {
  const { sortNotes } = await import('./order.js');
  const notes = [
    { id: 'a', title: 'Zebra', updated_at: 1, created_at: 3 },
    { id: 'b', title: '', body: 'apples to buy', updated_at: 3, created_at: 1 },
    { id: 'c', title: 'Mango', updated_at: 2, created_at: 2 },
  ];
  assert.deepEqual(sortNotes(notes, 'mine').map((n) => n.id), ['a', 'b', 'c']);
  assert.deepEqual(sortNotes(notes, 'edited').map((n) => n.id), ['b', 'c', 'a']);
  assert.deepEqual(sortNotes(notes, 'created').map((n) => n.id), ['a', 'c', 'b']);
  assert.deepEqual(sortNotes(notes, 'title').map((n) => n.id), ['b', 'c', 'a']);
  assert.deepEqual(notes.map((n) => n.id), ['a', 'b', 'c'], 'the list given is left alone');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanStroke, makeBoard, MAX_POINTS } from '../src/meetboard.js';

test('whiteboard strokes are checked: kinds, colours, sizes, points kept on the board', () => {
  assert.deepEqual(cleanStroke({ id: 'abcd1', kind: 'pen', color: '#D93025', size: 8, points: [[10.123, 20], [2000, -5], ['x', 1], [30, 40]] }),
    { id: 'abcd1', kind: 'pen', color: '#d93025', size: 8, points: [[10.1, 20], [1000, 0], [30, 40]] });
  assert.deepEqual(cleanStroke({ id: 'abcd2', kind: 'box', color: 'red', size: 3, points: [[0, 0], [5, 5], [100, 50]] }),
    { id: 'abcd2', kind: 'box', color: '#202124', size: 4, points: [[0, 0], [100, 50]] }, 'a shape: two corners; an unknown colour or size: the default');
  assert.equal(cleanStroke({ id: 'abcd3', kind: 'erase', color: '#000000', points: [[1, 1]] }).color, '#ffffff', 'the eraser paints the board');
  assert.equal(cleanStroke({ id: 'abcd4', kind: 'laser', points: [[1, 1]] }), null);
  assert.equal(cleanStroke({ id: '<b>', kind: 'pen', points: [[1, 1]] }), null);
  assert.equal(cleanStroke({ id: 'abcd5', kind: 'pen', points: [] }), null);
  assert.equal(cleanStroke({ id: 'abcd6', kind: 'pen', points: Array.from({ length: 5000 }, (_, i) => [i % 1000, 1]) }).points.length, MAX_POINTS);
});

test('a board: strokes in order, undo takes back your own last one, clear', () => {
  const b = makeBoard();
  assert.ok(b.add({ id: 'st-1', kind: 'pen', points: [[1, 1]] }, 'ann'));
  assert.ok(b.add({ id: 'st-2', kind: 'line', points: [[1, 1], [2, 2]] }, 'bob'));
  assert.ok(b.add({ id: 'st-3', kind: 'box', points: [[1, 1], [2, 2]] }, 'ann'));
  assert.equal(b.add({ id: 'st-3', kind: 'box', points: [[1, 1]] }, 'ann'), null, 'the same stroke twice');
  assert.equal(b.undo('ann').id, 'st-3');
  assert.equal(b.undo('ann').id, 'st-1');
  assert.equal(b.undo('ann'), null);
  assert.deepEqual(b.strokes.map((s) => s.id), ['st-2']);
  b.clear();
  assert.equal(b.strokes.length, 0);
});

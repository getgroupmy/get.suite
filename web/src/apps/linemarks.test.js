import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineAnchor, placeMark, placeMarks, lineLabel, MARK_TEXT } from './linemarks.js';

const file = ['a = 1', 'b = 2', '', 'print(a + b)'];
test('a comment stays on its line while the line reads the same', () => {
  assert.deepEqual(placeMark(file, lineAnchor(2, 'b = 2')), { line: 2, moved: false, lost: false });
});
test('lines added or removed above it: the comment follows its line', () => {
  assert.deepEqual(placeMark(['# sums', '', ...file], lineAnchor(4, 'print(a + b)')), { line: 6, moved: true, lost: false });
  assert.deepEqual(placeMark(file.slice(1), lineAnchor(4, 'print(a + b)')), { line: 3, moved: true, lost: false });
});
test('of two lines that read the same, the nearer one is taken', () => {
  const l = ['x', 'end', 'y', 'z', 'end', 'w'];
  assert.equal(placeMark(l, lineAnchor(4, 'end')).line, 5);
  assert.equal(placeMark(l, lineAnchor(3, 'end')).line, 2);
});
test('a rewritten or removed line: the comment stays at its old number, marked as changed, within the file', () => {
  assert.deepEqual(placeMark(file, lineAnchor(2, 'b = 3')), { line: 2, moved: false, lost: true });
  assert.deepEqual(placeMark(file, lineAnchor(90, 'gone')), { line: 4, moved: false, lost: true });
  assert.deepEqual(placeMark([], lineAnchor(3, 'gone')), { line: 1, moved: false, lost: true });
});
test('a blank line is not followed to some other blank line', () => {
  assert.deepEqual(placeMark(['a', 'b', 'c', ''], lineAnchor(2, '')), { line: 2, moved: false, lost: true });
  assert.deepEqual(placeMark(file, lineAnchor(3, '')), { line: 3, moved: false, lost: false });
});
test('very long lines are compared by their start', () => {
  const long = 'x'.repeat(MARK_TEXT + 50);
  const a = lineAnchor(1, long);
  assert.equal(a.text.length, MARK_TEXT);
  assert.deepEqual(placeMark(['', long], a), { line: 2, moved: true, lost: false });
});
test('several comments: each one placed, and gathered by line', () => {
  const { placed, byLine } = placeMarks(file, [{ id: 'p', ...lineAnchor(1, 'a = 1') }, { id: 'q', ...lineAnchor(1, 'print(a + b)') }, { id: 'r', ...lineAnchor(4, 'print(a + b)') }]);
  assert.equal(placed.q.line, 4);
  assert.deepEqual([...byLine], [[1, ['p']], [4, ['q', 'r']]]);
  assert.deepEqual(placeMarks(file, null), { placed: {}, byLine: new Map() });
});
test('labels', () => {
  assert.equal(lineLabel({ line: 12 }, null), 'Line 12');
  assert.equal(lineLabel({ line: 12 }, { line: 14 }), 'Line 14');
  assert.equal(lineLabel({ line: 12 }, { line: 12, lost: true }), 'Line 12 (since changed)');
});

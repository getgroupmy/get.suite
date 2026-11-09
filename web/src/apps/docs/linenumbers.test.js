import test from 'node:test';
import assert from 'node:assert/strict';
import { groupLines, columnLeft } from './linenumbers.js';

test('line boxes on the same line merge; wrapped lines and the next column are new lines', () => {
  const rects = [
    { top: 100, bottom: 120, left: 50 }, { top: 102, bottom: 118, left: 140 }, // one line: a bold word, then plain text
    { top: 124, bottom: 144, left: 50 }, // wrapped
    { top: 148, bottom: 168, left: 50 },
    { top: 100, bottom: 120, left: 400 }, // the rest of the paragraph at the top of the next column
  ];
  assert.deepEqual(groupLines(rects), [
    { top: 100, bottom: 120, left: 50 }, { top: 124, bottom: 144, left: 50 }, { top: 148, bottom: 168, left: 50 }, { top: 100, bottom: 120, left: 400 },
  ]);
  assert.deepEqual(groupLines([]), []);
  // A taller box (big text) on the same line widens it.
  assert.deepEqual(groupLines([{ top: 100, bottom: 120, left: 50 }, { top: 96, bottom: 126, left: 80 }]), [{ top: 96, bottom: 126, left: 50 }]);
});

test('the column a line is in', () => {
  assert.equal(columnLeft(300, 100, 600), 100, 'one column');
  // two columns of 276 with 48 between: 100–376 and 424–700
  assert.equal(columnLeft(110, 100, 600, 2, 48), 100);
  assert.equal(columnLeft(380, 100, 600, 2, 48), 100);
  assert.equal(columnLeft(430, 100, 600, 2, 48), 424);
  assert.equal(columnLeft(900, 100, 600, 2, 48), 424, 'never past the last');
  assert.equal(columnLeft(400, 100, 600, 3, 48), 316, 'three columns of 168: 100, 316, 532');
});

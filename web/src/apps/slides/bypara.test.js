import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSteps, stepCount, byParagraph, stepPresent } from './slidemath.js';

test('by paragraph: each line with words is a click of its own; the next box follows', () => {
  const list = { id: 'l', type: 'text', text: 'One\n\nTwo\nThree', anim: 'fade', animAt: 1, animBy: 'para' };
  const slide = { items: [list, { id: 'n', type: 'text', text: 'Next', anim: 'fly', animAt: 2 }, { id: 'w', type: 'text', text: 'With', anim: 'fade', animAt: 3, animStart: 'with' }] };
  const s = buildSteps(slide);
  assert.deepEqual(s.get('l'), { step: 1, delay: 0, paras: [1, 1, 2, 3] }, 'the blank line goes with the line before it');
  assert.deepEqual(s.get('n'), { step: 4, delay: 0 });
  assert.deepEqual(s.get('w'), { step: 4, delay: 0 }, '"with previous" goes with the last line before it, or the box after');
  assert.equal(stepCount(slide), 4);
  assert.deepEqual(stepPresent({ slides: [slide] }, { i: 0, b: 3 }, 1), { i: 0, b: 4 });
  // Only text boxes coming in, with more than one line.
  assert.equal(byParagraph({ ...list, text: 'Only one' }), false);
  assert.equal(byParagraph({ ...list, anim: 'fadeout' }), false);
  assert.equal(byParagraph({ ...list, animBy: undefined }), false);
  assert.equal(stepCount({ items: [{ ...list, animBy: undefined }] }), 1);
});

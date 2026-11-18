import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSteps, stepCount, stepPresent, animChange } from './slidemath.js';

const it = (id, animAt, animStart) => ({ id, type: 'text', anim: 'fade', animAt, ...(animStart && { animStart }) });
test('with previous / after previous: boxes share a click; each "after" waits for the one before', () => {
  const slide = { items: [it('a', 1, 'with'), it('b', 2, 'with'), it('c', 3, 'after'), it('d', 4, 'with'), it('e', 5), it('f', 6, 'after'), { id: 'plain', type: 'text' }] };
  const s = buildSteps(slide);
  // The first can't go with anything before it: it is on the first click.
  assert.deepEqual(Object.fromEntries(s), { a: { step: 1, delay: 0 }, b: { step: 1, delay: 0 }, c: { step: 1, delay: 0.5 }, d: { step: 1, delay: 0.5 }, e: { step: 2, delay: 0 }, f: { step: 2, delay: 0.5 } });
  assert.equal(stepCount(slide), 2);
  assert.equal(stepCount({ items: [] }), 0);
  // Presenting goes click by click.
  const deck = { slides: [slide, { items: [] }] };
  assert.deepEqual(stepPresent(deck, { i: 0, b: 1 }, 1), { i: 0, b: 2 });
  assert.deepEqual(stepPresent(deck, { i: 0, b: 2 }, 1), { i: 1, b: 0 });
  assert.deepEqual(stepPresent(deck, { i: 1, b: 0 }, -1), { i: 0, b: 2 });
  // No animation clears when it starts too.
  assert.deepEqual(animChange(slide, slide.items[2], ''), { anim: undefined, animAt: undefined, animStart: undefined, animBy: undefined });
});

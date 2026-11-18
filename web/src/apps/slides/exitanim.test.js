import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildState, isExit, ANIMATIONS } from './slidemath.js';

test('exit animations: a box shows until its click, then goes', () => {
  assert.ok(ANIMATIONS.some(([v]) => v === 'fadeout') && isExit('disappear') && !isExit('fade'));
  // Not presenting: everything shows.
  assert.deepEqual(buildState('fadeout', 2, undefined), { shown: true, moving: '' });
  // Entrance: in from its click on, moving on it.
  assert.deepEqual([0, 1, 2, 3].map((b) => buildState('fade', 2, b)), [{ shown: false, moving: '' }, { shown: false, moving: '' }, { shown: true, moving: 'anim-fade' }, { shown: true, moving: '' }]);
  // Disappear: there until its click, then gone at once.
  assert.deepEqual([1, 2, 3].map((b) => buildState('disappear', 2, b).shown), [true, false, false]);
  // Fade out: fading on its click, gone after.
  assert.deepEqual([1, 2, 3].map((b) => buildState('fadeout', 2, b)), [{ shown: true, moving: '' }, { shown: true, moving: 'anim-fadeout' }, { shown: false, moving: '' }]);
});

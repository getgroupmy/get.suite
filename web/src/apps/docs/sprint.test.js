import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sprintText } from './sprint.js';

test('a sprint shows the words added and the time left', () => {
  assert.equal(sprintText(25 * 60e3, 0), '+0 words · 25:00');
  assert.equal(sprintText(65_400, 1), '+1 word · 1:06', 'rounded up to the second');
  assert.equal(sprintText(-5, 240), '+240 words · 0:00');
  assert.equal(sprintText(9e3, -3), '−3 words · 0:09', 'fewer words than at the start');
});

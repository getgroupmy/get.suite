import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moved } from './moved.js';

test('a mouse event counts as moving only with some movement', () => {
  assert.equal(moved({ movementX: 0, movementY: 0 }), false, 'a list opening under a resting pointer');
  assert.equal(moved({ movementX: 3, movementY: 0 }), true);
  assert.equal(moved({ movementX: 0, movementY: -1 }), true);
  assert.equal(moved(undefined), false);
});

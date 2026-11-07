import { test } from 'node:test';
import assert from 'node:assert/strict';
import { greeting } from './greeting.js';

test('greeting by time of day', () => {
  assert.equal(greeting(new Date(2026, 0, 1, 8)), 'Good morning');
  assert.equal(greeting(new Date(2026, 0, 1, 13)), 'Good afternoon');
  assert.equal(greeting(new Date(2026, 0, 1, 20)), 'Good evening');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newEventMinutes, lengthLabel } from './calprefs.js';

test('new event length: speedy meetings end 5 or 10 minutes early', () => {
  assert.equal(newEventMinutes(), 60);
  assert.equal(newEventMinutes({ length: 30, speedy: true }), 25);
  assert.equal(newEventMinutes({ length: 60, speedy: true }), 50);
  assert.equal(newEventMinutes({ length: 120, speedy: true }), 110);
  assert.equal(newEventMinutes({ length: 15, speedy: true }), 15);
  assert.deepEqual([lengthLabel(45), lengthLabel(60), lengthLabel(90)], ['45 minutes', '1 hour', '1.5 hours']);
});

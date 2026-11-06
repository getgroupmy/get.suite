import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dueLabel, between } from './taskmath.js';

test('due dates in words, with a tone', () => {
  const now = new Date(2026, 10, 6, 15, 0); // Fri 6 Nov 2026, afternoon
  assert.deepEqual(dueLabel('2026-11-06', now), { text: 'Today', tone: 'soon' });
  assert.deepEqual(dueLabel('2026-11-07', now), { text: 'Tomorrow', tone: 'soon' });
  assert.deepEqual(dueLabel('2026-11-05', now), { text: 'Yesterday', tone: 'late' });
  assert.equal(dueLabel('2026-11-01', now).tone, 'late');
  assert.equal(dueLabel('2026-11-20', now).tone, '');
  assert.match(dueLabel('2027-01-02', now).text, /2027/, 'another year says which');
  assert.doesNotMatch(dueLabel('2026-12-02', now).text, /2026/);
});

test('a dragged task lands between its neighbours', () => {
  assert.equal(between(undefined, undefined), 0);
  assert.equal(between(undefined, 3), 2);
  assert.equal(between(3, undefined), 4);
  assert.equal(between(1, 2), 1.5);
});

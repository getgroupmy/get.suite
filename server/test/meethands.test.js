import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextState, handQueue } from '../src/meethands.js';

test('a raised hand is stamped when it goes up, kept while it stays up, cleared when lowered', () => {
  const s0 = nextState({}, { mic: false }, 100);
  assert.deepEqual(s0, { mic: false, cam: true, hand: false, screen: false, rec: false, hand_at: null });
  const s1 = nextState(s0, { hand: true }, 200);
  assert.equal(s1.hand_at, 200);
  const s2 = nextState(s1, { mic: true, hand: true }, 300);
  assert.equal(s2.hand_at, 200, 'turning the mic on keeps your place');
  const s3 = nextState(s2, { hand: false }, 400);
  assert.deepEqual([s3.hand, s3.hand_at], [false, null]);
  assert.equal(nextState(s3, { hand: true }, 500).hand_at, 500, 'raised again: back of the queue');
  assert.equal(nextState({}, { hand: 1, junk: 'x' }, 9).junk, undefined);
});

test('the queue: hands up, first raised first', () => {
  const people = [
    { id: 'a', state: { hand: true, hand_at: 30 } }, { id: 'b', state: { hand: false, hand_at: null } },
    { id: 'c', state: { hand: true, hand_at: 10 } }, { id: 'd', state: { hand: true, hand_at: 20 } }, { id: 'e' },
  ];
  assert.deepEqual(handQueue(people), ['c', 'd', 'a']);
  assert.deepEqual(handQueue([]), []);
});

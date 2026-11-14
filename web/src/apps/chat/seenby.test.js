import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seenBy } from './seenby.js';

const r = (name, read_at) => ({ id: name, name, read_at });
test('seen by: nobody, one, a few, many, everyone', () => {
  assert.equal(seenBy([r('Ana', null), r('Ben', 5)], 10, 2).text, null, 'read before it was sent');
  assert.equal(seenBy([r('Ana', 12), r('Ben', 5)], 10, 2).text, 'Seen by Ana');
  assert.equal(seenBy([r('Ben', 14), r('Ana', 12), r('Cy', 1)], 10, 3).text, 'Seen by Ana and Ben', 'in the order they read it');
  assert.equal(seenBy([r('A', 11), r('B', 12), r('C', 13)], 10, 5).text, 'Seen by A, B and C');
  assert.equal(seenBy([r('A', 11), r('B', 12), r('C', 13), r('D', 14), r('E', 15)], 10, 9).text, 'Seen by A, B and 3 others');
  assert.equal(seenBy([r('A', 11), r('B', 12)], 10, 2).text, 'Seen by everyone');
  assert.equal(seenBy([r('A', 11)], 10, 1).text, 'Seen by A', 'one other person: by name');
});

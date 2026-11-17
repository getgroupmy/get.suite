import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toggleReaction } from './chatreact.js';

const me = { id: 'u1', name: 'Olivia' }, kim = { id: 'u2', name: 'Kim' };
test('tapping a reaction adds yours, tapping again takes it off', () => {
  assert.deepEqual(toggleReaction([], '👍', me), [{ emoji: '👍', users: [me] }]);
  assert.deepEqual(toggleReaction([{ emoji: '👍', users: [kim] }], '👍', me), [{ emoji: '👍', users: [kim, me] }]);
  assert.deepEqual(toggleReaction([{ emoji: '👍', users: [kim, me] }], '👍', me), [{ emoji: '👍', users: [kim] }]);
  assert.deepEqual(toggleReaction([{ emoji: '👍', users: [me] }, { emoji: '🎉', users: [kim] }], '👍', me), [{ emoji: '🎉', users: [kim] }], 'nobody left: gone');
  assert.deepEqual(toggleReaction(undefined, '🎉', me), [{ emoji: '🎉', users: [me] }]);
});

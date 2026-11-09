import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noteTyping, typingIn, typingText, TYPING_FOR } from './typing.js';

test('who is typing where, for a few seconds', () => {
  let s = {};
  s = noteTyping(s, { channel_id: 'c', user_id: 'k', name: 'Kim' }, 1000);
  s = noteTyping(s, { channel_id: 'c', parent_id: 'm', user_id: 'a', name: 'Ann' }, 1000);
  assert.deepEqual(typingIn(s, 'c', null, 2000), ['Kim']);
  assert.deepEqual(typingIn(s, 'c', 'm', 2000), ['Ann'], 'a thread is its own place');
  assert.deepEqual(typingIn(s, 'c', null, 1000 + TYPING_FOR + 1), [], 'gone after a while');
  s = noteTyping(s, { channel_id: 'c', user_id: 'k', stop: true }, 2000);
  assert.deepEqual(typingIn(s, 'c', null, 2000), []);
  assert.deepEqual(typingIn({}, 'x', null), []);
});

test('the line', () => {
  assert.equal(typingText([]), '');
  assert.equal(typingText(['Kim']), 'Kim is typing…');
  assert.equal(typingText(['Kim', 'Ann']), 'Kim and Ann are typing…');
  assert.equal(typingText(['Kim', 'Ann', 'Bo']), 'Kim, Ann and Bo are typing…');
  assert.equal(typingText(['Kim', 'Ann', 'Bo', 'Cy']), 'Several people are typing…');
});

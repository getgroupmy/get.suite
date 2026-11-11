import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextConversation, lastEditable } from './keys.js';

const ids = ['a', 'b', 'c', 'd'];

test('the conversation above or below, stopping at the ends', () => {
  assert.equal(nextConversation(ids, 'b', 1), 'c');
  assert.equal(nextConversation(ids, 'b', -1), 'a');
  assert.equal(nextConversation(ids, 'd', 1), null);
  assert.equal(nextConversation(ids, 'a', -1), null);
  assert.equal(nextConversation(ids, 'x', 1), 'a', 'none open: the first');
  assert.equal(nextConversation(ids, null, -1), 'd');
  assert.equal(nextConversation([], 'a', 1), null);
  assert.equal(nextConversation(['a', 'b', 'a'], 'a', 1), 'b', 'a starred one listed twice counts once');
});

test('the next unread one, going round', () => {
  const unread = (id) => id === 'a' || id === 'c';
  assert.equal(nextConversation(ids, 'b', 1, unread), 'c');
  assert.equal(nextConversation(ids, 'c', 1, unread), 'a', 'round past the end');
  assert.equal(nextConversation(ids, 'c', -1, unread), 'a');
  assert.equal(nextConversation(ids, 'a', -1, unread), 'c', 'round past the top');
  assert.equal(nextConversation(ids, 'a', 1, (id) => id === 'a'), null, 'only this one is unread');
  assert.equal(nextConversation(ids, null, 1, unread), 'a');
  assert.equal(nextConversation(ids, null, -1, unread), 'c');
});

test('your latest message that can be changed', () => {
  const list = [
    { id: 1, user_id: 'me', body: 'old' },
    { id: 2, user_id: 'me', body: 'latest' },
    { id: 3, user_id: 'kim', body: 'theirs' },
    { id: 4, user_id: 'me', poll: { question: 'Lunch?' } },
  ];
  assert.equal(lastEditable(list, 'me').id, 2);
  assert.equal(lastEditable(list, 'dan'), null);
  assert.equal(lastEditable([{ id: 5, user_id: 'me', deleted_at: 1 }], 'me'), null);
});

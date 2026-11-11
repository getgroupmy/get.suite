import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newFromId, newCount } from './unread.js';

const list = [
  { id: 'a', user_id: 'kim', created_at: 100 },
  { id: 'b', user_id: 'me', created_at: 200 },
  { id: 'c', user_id: 'kim', created_at: 300 },
  { id: 'd', user_id: 'me', created_at: 400 },
  { id: 'e', user_id: 'kim', created_at: 500 },
];

test('the line goes before the first message someone else sent since you read', () => {
  assert.equal(newFromId(list, 250, 'me'), 'c');
  assert.equal(newCount(list, 'c', 'me'), 2, 'your own replies are not counted');
  assert.equal(newFromId(list, 150, 'me'), 'c', 'your own message is not new to you');
});

test('no line when nothing is new', () => {
  assert.equal(newFromId(list, 500, 'me'), null);
  assert.equal(newFromId([], 0, 'me'), null);
  assert.equal(newCount(list, null, 'me'), 0);
});

test('never opened: no line above the very first message, but one further down', () => {
  assert.equal(newFromId(list, null, 'me'), null);
  assert.equal(newFromId(list.slice(1), null, 'me'), 'c');
  assert.equal(newFromId(list, 0, 'me'), 'a', 'read before (time 0) still shows it');
});

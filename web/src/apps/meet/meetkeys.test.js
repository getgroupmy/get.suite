import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meetKey, typingIn } from './meetkeys.js';

const body = { tagName: 'BODY' }, input = { tagName: 'INPUT', type: 'text' }, box = { tagName: 'INPUT', type: 'checkbox' };
test('Meet keys', () => {
  assert.equal(meetKey({ key: 'd', ctrlKey: true, target: body }), 'mic');
  assert.equal(meetKey({ key: 'd', metaKey: true, target: input }), 'mic', 'also while typing (it’s a shortcut, not a letter)');
  assert.equal(meetKey({ key: 'e', ctrlKey: true, target: body }), 'cam');
  assert.equal(meetKey({ key: 'd', ctrlKey: true, shiftKey: true, target: body }), null);
  assert.equal(meetKey({ key: ' ', target: body }), 'talk');
  assert.equal(meetKey({ key: ' ', target: body, repeat: true }), null, 'held: once');
  assert.equal(meetKey({ key: ' ', target: input }), null, 'a space in the chat');
  assert.equal(meetKey({ key: ' ', target: box }), null, 'Space ticks a tick box');
  assert.equal(meetKey({ key: ' ', target: { tagName: 'BUTTON' } }), null, 'and presses a button');
  assert.equal(meetKey({ key: ' ', target: { tagName: 'DIV', getAttribute: () => 'button' } }), null);
  assert.equal(meetKey({ key: ' ', target: { tagName: 'DIV', getAttribute: () => null } }), 'talk');
  assert.equal(meetKey({ key: 'd', target: body }), null);
  assert.equal(typingIn({ isContentEditable: true }), true);
  assert.equal(typingIn(null), false);
});

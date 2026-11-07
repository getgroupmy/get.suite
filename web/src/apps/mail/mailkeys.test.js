import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mailKey, stepMessage } from './mailkeys.js';

const ev = (key, extra = {}) => ({ key, target: { tagName: 'BODY' }, ...extra });

test('keys map to actions, but not while typing or with Ctrl', () => {
  assert.equal(mailKey(ev('c')), 'compose');
  assert.equal(mailKey(ev('#')), 'delete');
  assert.equal(mailKey(ev('U')), 'unread');
  assert.equal(mailKey(ev('u')), 'list');
  assert.equal(mailKey(ev('x')), null);
  assert.equal(mailKey(ev('c', { ctrlKey: true })), null);
  assert.equal(mailKey(ev('r', { target: { tagName: 'INPUT' } })), null);
  assert.equal(mailKey(ev('r', { target: { tagName: 'DIV', isContentEditable: true } })), null);
});

test('j and k move through the list', () => {
  const list = [{ uid: 9 }, { uid: 7 }, { uid: 3 }];
  assert.equal(stepMessage(list, 9, 'next'), 7);
  assert.equal(stepMessage(list, 7, 'prev'), 9);
  assert.equal(stepMessage(list, 3, 'next'), null);
  assert.equal(stepMessage(list, null, 'next'), 9);
  assert.equal(stepMessage([], null, 'next'), null);
});

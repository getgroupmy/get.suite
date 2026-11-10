import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mailKey, stepMessage, pickMatches } from './mailkeys.js';

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

test('v and l pick a folder or a label, typing narrows the choices', () => {
  assert.equal(mailKey(ev('v')), 'moveTo');
  assert.equal(mailKey(ev('l')), 'labelAs');
  const items = [{ name: 'Archive' }, { name: 'Clients/Acme' }, { name: 'Café receipts' }, { name: 'Accounts' }];
  assert.deepEqual(pickMatches(items, 'ac').map((x) => x.name), ['Accounts', 'Clients/Acme']);
  assert.deepEqual(pickMatches(items, 'CAFE').map((x) => x.name), ['Café receipts']);
  assert.equal(pickMatches(items, '  ').length, 4);
  assert.deepEqual(pickMatches(items, 'zzz'), []);
});

test('after archiving the open message: the newer or older one, or none', async () => {
  const { afterRemoval } = await import('./mailkeys.js');
  const list = [{ uid: 9 }, { uid: 7 }, { uid: 4 }]; // newest first
  assert.equal(afterRemoval(list, 7, 'older'), 4);
  assert.equal(afterRemoval(list, 7, 'newer'), 9);
  assert.equal(afterRemoval(list, 4, 'older'), null, 'none older: back to the list');
  assert.equal(afterRemoval(list, 9, 'newer'), null);
  assert.equal(afterRemoval(list, 7, 'list'), null);
  assert.equal(afterRemoval(list, 5, 'older'), null, 'not in the list');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contactKey } from './contactkeys.js';

const ev = (key, extra = {}) => ({ key, target: { tagName: 'TR', closest: () => null }, ...extra });
test('contact keys', () => {
  assert.equal(contactKey(ev('j')), 'next');
  assert.equal(contactKey(ev('K')), 'prev');
  assert.equal(contactKey(ev('Enter'), true), 'open');
  assert.equal(contactKey(ev('Enter'), false), null);
  assert.equal(contactKey(ev('o')), 'open');
  assert.equal(contactKey(ev('s')), 'star');
  assert.equal(contactKey(ev('#', { shiftKey: true })), 'delete');
  assert.equal(contactKey(ev('c')), 'new');
  assert.equal(contactKey(ev('c', { ctrlKey: true })), null);
  assert.equal(contactKey(ev('j', { target: { tagName: 'INPUT', closest: () => null } })), null);
});

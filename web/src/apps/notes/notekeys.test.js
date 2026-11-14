import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noteKey } from './notekeys.js';

const ev = (key, extra = {}) => ({ key, target: { tagName: 'DIV', closest: () => null }, ...extra });
test('note keys: letters, # for delete; not while typing or with modifiers', () => {
  assert.equal(noteKey(ev('j')), 'next');
  assert.equal(noteKey(ev('K')), 'prev');
  assert.equal(noteKey(ev('f')), 'pin');
  assert.equal(noteKey(ev('e')), 'archive');
  assert.equal(noteKey(ev('#', { shiftKey: true })), 'delete');
  assert.equal(noteKey(ev('c')), 'new');
  assert.equal(noteKey(ev('c', { shiftKey: true })), null);
  assert.equal(noteKey(ev('j', { metaKey: true })), null);
  assert.equal(noteKey(ev('j', { target: { tagName: 'TEXTAREA', closest: () => null } })), null);
  assert.equal(noteKey(ev('j', { target: { isContentEditable: true, tagName: 'DIV', closest: () => null } })), null);
});

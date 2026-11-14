import { test } from 'node:test';
import assert from 'node:assert/strict';
import { driveKey, stepIndex } from './drivekeys.js';

const on = (key, extra = {}) => ({ key, target: { tagName: 'TR', closest: () => null }, ...extra });
test('keys on a file: arrows, F2, Delete always; letters marked as such', () => {
  assert.deepEqual(driveKey(on('ArrowDown'), true), { action: 'next', letter: false });
  assert.deepEqual(driveKey(on('F2'), true), { action: 'rename', letter: false });
  assert.deepEqual(driveKey(on('Delete'), true), { action: 'trash', letter: false });
  assert.deepEqual(driveKey(on('j'), true), { action: 'next', letter: true });
  assert.deepEqual(driveKey(on('#', { shiftKey: true }), true), { action: 'trash', letter: true });
  assert.deepEqual(driveKey(on('S'), true), { action: 'star', letter: true });
  assert.equal(driveKey(on('j', { shiftKey: true }), true), null);
});
test('elsewhere: arrows only from nothing focused; never while typing', () => {
  assert.equal(driveKey(on('ArrowDown', { target: { tagName: 'BUTTON', closest: () => null } }), false), null, 'in a menu, say');
  assert.deepEqual(driveKey(on('ArrowDown', { target: { tagName: 'BODY', closest: () => null } }), false), { action: 'next', letter: false });
  assert.equal(driveKey(on('F2', { target: { tagName: 'BODY', closest: () => null } }), false), null);
  assert.equal(driveKey(on('j', { target: { tagName: 'INPUT', closest: () => null } }), false), null);
  assert.equal(driveKey(on('j', { ctrlKey: true }), true), null);
});
test('stepping', () => {
  assert.equal(stepIndex(3, -1, 'next'), 0);
  assert.equal(stepIndex(3, -1, 'prev'), 2);
  assert.equal(stepIndex(3, 2, 'next'), 2);
  assert.equal(stepIndex(3, 1, 'prev'), 0);
  assert.equal(stepIndex(3, 1, 'last'), 2);
  assert.equal(stepIndex(0, -1, 'next'), -1);
});

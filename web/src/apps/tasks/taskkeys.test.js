import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskKey, stepTask, afterLeaving } from './taskkeys.js';

const ev = (key, extra = {}) => ({ key, target: { tagName: 'BUTTON', closest: () => null }, ...extra });
test('keys: letters (either case), # for delete; not while typing or with Ctrl', () => {
  assert.equal(taskKey(ev('j')), 'next');
  assert.equal(taskKey(ev('K')), 'prev');
  assert.equal(taskKey(ev('x')), 'done');
  assert.equal(taskKey(ev('#', { shiftKey: true })), 'delete');
  assert.equal(taskKey(ev('n')), 'new');
  assert.equal(taskKey(ev('j', { shiftKey: true })), null);
  assert.equal(taskKey(ev('j', { ctrlKey: true })), null);
  assert.equal(taskKey(ev('j', { target: { tagName: 'INPUT', closest: () => null } })), null);
  assert.equal(taskKey(ev('q')), null);
});

test('stepping: from nothing, the first (or last going up); stops at the ends', () => {
  const ids = ['a', 'b', 'c'];
  assert.equal(stepTask(ids, null, 'next'), 'a');
  assert.equal(stepTask(ids, null, 'prev'), 'c');
  assert.equal(stepTask(ids, 'a', 'next'), 'b');
  assert.equal(stepTask(ids, 'c', 'next'), 'c');
  assert.equal(stepTask(ids, 'a', 'prev'), 'a');
  assert.equal(stepTask([], null, 'next'), null);
});

test('after a task leaves: the one below, else above', () => {
  assert.equal(afterLeaving(['a', 'b', 'c'], 'b'), 'c');
  assert.equal(afterLeaving(['a', 'b', 'c'], 'c'), 'b');
  assert.equal(afterLeaving(['a'], 'a'), null);
});

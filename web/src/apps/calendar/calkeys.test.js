import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calKey } from './calkeys.js';

const ev = (key, extra = {}) => ({ key, target: { tagName: 'BODY', closest: () => null }, ...extra });
test('calendar keys', () => {
  assert.deepEqual(calKey(ev('t')), { today: true });
  assert.deepEqual(calKey(ev('W')), { view: 'week' });
  assert.deepEqual(calKey(ev('a')), { view: 'schedule' });
  assert.deepEqual(calKey(ev('j')), { step: 1 });
  assert.deepEqual(calKey(ev('p')), { step: -1 });
  assert.deepEqual(calKey(ev('c')), { create: true });
  assert.equal(calKey(ev('c', { shiftKey: true })), null);
  assert.equal(calKey(ev('t', { ctrlKey: true })), null);
  assert.equal(calKey(ev('t', { target: { tagName: 'INPUT', closest: () => null } })), null);
  assert.equal(calKey(ev('x')), null);
});

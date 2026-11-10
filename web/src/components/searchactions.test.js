import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchActions } from './searchactions.js';

const keys = (l) => l.map((a) => a.key);

test('quick actions: every word typed starts one of theirs; mail and admin only when they apply', () => {
  assert.deepEqual(keys(matchActions('new doc')), ['doc']);
  assert.deepEqual(keys(matchActions('compose')), ['mail']);
  assert.deepEqual(keys(matchActions('compose', { mail: false })), []);
  assert.deepEqual(keys(matchActions('meeting')), ['event', 'meet']);
  assert.deepEqual(keys(matchActions('sheet')), ['sheet']);
  assert.deepEqual(keys(matchActions('admin')), []);
  assert.deepEqual(keys(matchActions('admin', { admin: true })), ['admin']);
  assert.deepEqual(keys(matchActions('n')), [], 'too short');
  assert.deepEqual(keys(matchActions('budget review')), [], 'a plain search finds no action');
  assert.equal(matchActions('new').length, 3, 'at most three');
});

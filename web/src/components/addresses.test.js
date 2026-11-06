import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentToken, insertAddress } from './addresses.js';

test('the address being typed, and putting a chosen one in its place', () => {
  const v = 'Ann <ann@acme.com>, bo';
  const t = currentToken(v, v.length);
  assert.deepEqual(t, { start: 19, end: 22, text: 'bo' });
  assert.deepEqual(insertAddress(v, t, { name: 'Bob Stone', email: 'bob@acme.com' }), { text: 'Ann <ann@acme.com>, Bob Stone <bob@acme.com>, ', caret: 46 });
  assert.equal(insertAddress('ki', currentToken('ki', 2), { name: '', email: 'kim@acme.com' }).text, 'kim@acme.com, ');
  // In the middle of a line, the rest stays.
  const mid = 'x@y.com, ca; z@w.com';
  const t2 = currentToken(mid, 11);
  assert.equal(t2.text, 'ca');
  assert.equal(insertAddress(mid, t2, { name: 'Cat, "the" Boss', email: 'cat@acme.com' }).text, 'x@y.com, Cat the Boss <cat@acme.com>, z@w.com');
});

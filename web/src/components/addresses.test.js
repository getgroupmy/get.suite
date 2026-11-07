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

test('a group puts in everyone in it', () => {
  const v = 'boa';
  const r = insertAddress(v, currentToken(v, 3), { kind: 'group', name: 'Board', members: [{ name: 'Ann Board', email: 'ann@example.org' }, { name: '', email: 'ben@example.org' }] });
  assert.equal(r.text, 'Ann Board <ann@example.org>, ben@example.org, ');
});

test('reading a list of addresses', async () => {
  const { parseAddresses } = await import('./addresses.js');
  assert.deepEqual(parseAddresses('Ann Board <Ann@Example.org>, ben@example.org;\n"Cat C" <cat@example.org>, nope, '), {
    list: [{ name: 'Ann Board', email: 'ann@example.org' }, { name: '', email: 'ben@example.org' }, { name: 'Cat C', email: 'cat@example.org' }], bad: ['nope'],
  });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toBytes, toB64url, creationOptions, requestOptions, credentialJson, passkeyError } from './passkey.js';

test('base64url both ways, any length', () => {
  for (const n of [0, 1, 2, 3, 31, 32, 33]) {
    const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 250) % 256);
    assert.deepEqual(toBytes(toB64url(bytes)), bytes);
    assert.doesNotMatch(toB64url(bytes), /[+/=]/);
  }
});
test('options and answers', () => {
  const c = creationOptions({ challenge: 'AQID', user: { id: 'BAU', name: 'a' }, excludeCredentials: [{ type: 'public-key', id: 'Bg' }], rp: { id: 'x' } });
  assert.deepEqual([...c.challenge], [1, 2, 3]);
  assert.deepEqual([...c.user.id], [4, 5]);
  assert.deepEqual([...c.excludeCredentials[0].id], [6]);
  assert.equal(c.rp.id, 'x');
  assert.deepEqual([...requestOptions({ challenge: 'AQID' }).challenge], [1, 2, 3]);
  const j = credentialJson({ id: 'abc', type: 'public-key', response: { clientDataJSON: new Uint8Array([1]).buffer, authenticatorData: new Uint8Array([2]).buffer, signature: new Uint8Array([3]).buffer, userHandle: null } });
  assert.deepEqual(j, { id: 'abc', type: 'public-key', response: { clientDataJSON: 'AQ', authenticatorData: 'Ag', signature: 'Aw' } });
  assert.match(passkeyError({ name: 'NotAllowedError' }), /cancelled/);
});

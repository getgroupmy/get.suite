import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cborDecode, verifyRegistration, verifyAssertion, b64url } from '../src/webauthn.js';
import { enc, authenticator } from './fixtures/fakeauthn.js';

const ORIGIN = 'https://ws.example.com', RP = 'ws.example.com';

test('CBOR: numbers, strings, bytes, arrays, maps; refuses what it doesn’t take', () => {
  const v = cborDecode(enc(new Map([[1, 2], [-7, 'x'], ['a', [Buffer.from([1, 2]), true, 300, 70000]]]))).value;
  assert.equal(v.get(1), 2);
  assert.equal(v.get(-7), 'x');
  assert.deepEqual(v.get('a'), [Buffer.from([1, 2]), true, 300, 70000]);
  assert.throws(() => cborDecode(Buffer.from([0x5f])), /unknown size/);
  assert.throws(() => cborDecode(Buffer.from([0x45, 1])), /too soon/);
  assert.throws(() => cborDecode(Buffer.from([0xc0, 0])), /tags/);
});

for (const kind of ['ec', 'ed']) {
  test(`passkey (${kind === 'ec' ? 'P-256' : 'Ed25519'}): made, then signs in; a counter that goes back is refused`, () => {
    const a = authenticator(kind);
    const made = verifyRegistration(a.create('chal-1'), { challenge: 'chal-1', origin: ORIGIN, rpId: RP });
    assert.equal(made.id, b64url(a.credId));
    assert.equal(made.alg, kind === 'ec' ? -7 : -8);
    const stored = { publicKey: made.publicKey, alg: made.alg, signCount: made.signCount };
    const r1 = verifyAssertion(a.get('chal-2'), stored, { challenge: 'chal-2', origin: ORIGIN, rpId: RP });
    assert.equal(r1.signCount, 1);
    assert.equal(r1.uv, true);
    stored.signCount = r1.signCount;
    assert.equal(verifyAssertion(a.get('chal-3'), stored, { challenge: 'chal-3', origin: ORIGIN, rpId: RP }).signCount, 2);
    stored.signCount = 2;
    assert.throws(() => verifyAssertion(a.get('chal-4', { counter: 2 }), stored, { challenge: 'chal-4', origin: ORIGIN, rpId: RP }), /copied/);
  });
}

test('passkey answers refused: wrong challenge, origin, site, type, signature, no presence or verification', () => {
  const a = authenticator();
  const ctx = { challenge: 'c1', origin: ORIGIN, rpId: RP };
  assert.throws(() => verifyRegistration(a.create('other'), ctx), /out of date/);
  assert.throws(() => verifyRegistration(a.create('c1', { origin: 'https://evil.example' }), ctx), /another site/);
  assert.throws(() => verifyRegistration(a.create('c1', { rp: 'evil.example' }), ctx), /another site/);
  assert.throws(() => verifyRegistration(a.create('c1', { flags: 0x04 }), ctx), /confirmed/);
  const made = verifyRegistration(a.create('c1'), ctx);
  const stored = { publicKey: made.publicKey, alg: made.alg, signCount: 0 };
  assert.throws(() => verifyAssertion(a.get('c1', { badSig: true }), stored, ctx), /signature/);
  assert.throws(() => verifyAssertion(a.get('c1', { flags: 0x01 }), stored, ctx), /fingerprint, face or PIN/);
  assert.throws(() => verifyAssertion(a.get('c2'), stored, ctx), /out of date/);
  assert.throws(() => verifyAssertion(a.get('c1', { rp: 'evil.example' }), stored, ctx), /another site/);
  // A registration answer isn't a sign-in.
  const reg = a.create('c1');
  assert.throws(() => verifyAssertion({ clientDataJSON: reg.clientDataJSON, authenticatorData: '', signature: '' }, stored, ctx), /isn’t the answer/);
  // Another authenticator's signature with this one's id: refused.
  const b = authenticator();
  assert.throws(() => verifyAssertion(b.get('c1'), stored, ctx), /signature/);
});

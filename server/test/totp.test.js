import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base32Encode, base32Decode, codeAt, verifyCode, otpauthUrl, newRecoveryCodes, hashRecovery, newSecret } from '../src/totp.js';

// RFC 6238 appendix B: the SHA1 key is the ASCII string "12345678901234567890".
const RFC_KEY = base32Encode(Buffer.from('12345678901234567890'));

test('codes match the RFC 6238 test vectors (last 6 digits)', () => {
  const vectors = [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037'], [20000000000, '353130']];
  for (const [t, code] of vectors) assert.equal(codeAt(RFC_KEY, Math.floor(t / 30)), code, `t=${t}`);
});

test('base32 round trip', () => {
  const buf = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255, 77]);
  assert.deepEqual(base32Decode(base32Encode(buf)), buf);
  assert.equal(base32Decode('gezd gnbv-gy').toString(), '123456', 'spaces, dashes and lower case are fine');
  assert.equal(newSecret().length, 32);
});

test('verification allows one step of clock drift and never the same step twice', () => {
  const now = 1_800_000_000_000;
  const step = Math.floor(now / 30000);
  assert.equal(verifyCode(RFC_KEY, codeAt(RFC_KEY, step), { now }), step);
  assert.equal(verifyCode(RFC_KEY, codeAt(RFC_KEY, step - 1), { now }), step - 1, 'phone clock slightly behind');
  assert.equal(verifyCode(RFC_KEY, codeAt(RFC_KEY, step + 1), { now }), step + 1, 'slightly ahead');
  assert.equal(verifyCode(RFC_KEY, codeAt(RFC_KEY, step - 2), { now }), null, 'too old');
  assert.equal(verifyCode(RFC_KEY, codeAt(RFC_KEY, step), { now, lastStep: step }), null, 'already used');
  assert.equal(verifyCode(RFC_KEY, ` ${codeAt(RFC_KEY, step).replace(/(\d{3})/, '$1 ')} `, { now }), step, 'spaces are fine');
  for (const bad of ['', '12345', '1234567', 'abcdef', null]) assert.equal(verifyCode(RFC_KEY, bad, { now }), null);
});

test('otpauth link and recovery codes', () => {
  const url = otpauthUrl('ABC', 'anna@acme.com', 'Acme Workspace');
  assert.equal(url, 'otpauth://totp/Acme%20Workspace%3Aanna%40acme.com?secret=ABC&issuer=Acme%20Workspace&algorithm=SHA1&digits=6&period=30');
  const codes = newRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  for (const c of codes) assert.match(c, /^[a-z2-9]{4}-[a-z2-9]{4}$/);
  assert.equal(hashRecovery('ABCD-EFGH'), hashRecovery(' abcd efgh '), 'case and separators do not matter');
});

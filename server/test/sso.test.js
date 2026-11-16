import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-sso-'));
const { verifyIdToken, emailOf, cleanIssuer, newAttempt, takeAttempt } = await import('../src/sso.js');

const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = (k, kid) => ({ ...k.publicKey.export({ format: 'jwk' }), kid, use: 'sig' });
const jwks = { keys: [jwk(rsa, 'r1'), jwk(ec, 'e1')] };
const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function sign(claims, { alg = 'RS256', kid = 'r1', key = rsa.privateKey } = {}) {
  const head = enc({ alg, kid, typ: 'JWT' }), body = enc(claims);
  const data = Buffer.from(`${head}.${body}`);
  const sig = alg === 'ES256' ? crypto.sign('SHA256', data, { key, dsaEncoding: 'ieee-p1363' }) : alg === 'none' ? Buffer.alloc(0) : crypto.sign('RSA-SHA256', data, key);
  return `${head}.${body}.${sig.toString('base64url')}`;
}
const now = Math.floor(Date.now() / 1000);
const good = { iss: 'https://login.example.com/t1', aud: 'ws-client', exp: now + 600, iat: now, nonce: 'n-123', email: 'kim@acme.com' };
const opts = { issuer: 'https://login.example.com/t1', clientId: 'ws-client', nonce: 'n-123', jwks };

test('a good ID token (RS256 or ES256) gives its claims', () => {
  assert.equal(verifyIdToken(sign(good), opts).email, 'kim@acme.com');
  assert.equal(verifyIdToken(sign(good, { alg: 'ES256', kid: 'e1', key: ec.privateKey }), opts).email, 'kim@acme.com');
});

test('refused: a forged signature, another key, "none", a shared-secret algorithm', () => {
  const t = sign(good);
  const forged = `${t.split('.')[0]}.${enc({ ...good, email: 'boss@acme.com' })}.${t.split('.')[2]}`;
  assert.throws(() => verifyIdToken(forged, opts), /signature/);
  assert.throws(() => verifyIdToken(sign(good, { key: other.privateKey }), opts), /signature/);
  assert.throws(() => verifyIdToken(sign(good, { alg: 'none' }), opts), /aren’t accepted/);
  assert.throws(() => verifyIdToken(sign(good, { alg: 'HS256' }), opts), /aren’t accepted/);
  assert.throws(() => verifyIdToken(sign(good, { kid: 'unknown' }), opts), /no key/);
  assert.throws(() => verifyIdToken('not.a', opts), /Not an ID token/);
});

test('refused: another issuer, another app, expired, from the future, another sign-in', () => {
  assert.throws(() => verifyIdToken(sign({ ...good, iss: 'https://evil.example.com' }), opts), /another issuer/);
  assert.throws(() => verifyIdToken(sign({ ...good, aud: 'other-app' }), opts), /another app/);
  assert.throws(() => verifyIdToken(sign({ ...good, aud: ['ws-client', 'x'], azp: 'x' }), opts), /another app/);
  assert.throws(() => verifyIdToken(sign({ ...good, exp: now - 3600 }), opts), /expired/);
  assert.throws(() => verifyIdToken(sign({ ...good, iat: now + 3600 }), opts), /future/);
  assert.throws(() => verifyIdToken(sign({ ...good, nonce: 'other' }), opts), /isn’t for this sign-in/);
  assert.ok(verifyIdToken(sign({ ...good, aud: ['ws-client', 'x'], azp: 'ws-client' }), opts), 'several audiences, this app the authorised one');
});

test('the email: email (unless unverified), else Microsoft’s preferred_username or upn', () => {
  assert.equal(emailOf({ email: 'Kim@Acme.com' }), 'kim@acme.com');
  assert.equal(emailOf({ email: 'kim@acme.com', email_verified: false }), null);
  assert.equal(emailOf({ preferred_username: 'kim@acme.com' }), 'kim@acme.com');
  assert.equal(emailOf({ upn: 'kim@acme.com' }), 'kim@acme.com');
  assert.equal(emailOf({ preferred_username: 'kim' }), null);
});

test('issuer addresses: https (http only for this machine); attempts used once and within ten minutes', () => {
  assert.equal(cleanIssuer('https://login.example.com/t1/'), 'https://login.example.com/t1');
  assert.equal(cleanIssuer('http://127.0.0.1:9999'), 'http://127.0.0.1:9999');
  assert.throws(() => cleanIssuer('http://login.example.com'), /must start with https/);
  assert.throws(() => cleanIssuer('nonsense'), /isn’t a web address/);
  assert.equal(cleanIssuer(''), null);
  const a = newAttempt('org1');
  assert.equal(crypto.createHash('sha256').update(a.verifier).digest('base64url'), a.challenge, 'PKCE S256');
  assert.equal(takeAttempt(a.state).nonce, a.nonce);
  assert.equal(takeAttempt(a.state), null, 'only once');
  const old = newAttempt('org1', Date.now() - 11 * 60e3);
  assert.equal(takeAttempt(old.state), null, 'too old');
});

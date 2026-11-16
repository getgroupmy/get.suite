// Single sign-on end to end: a real Workspace server and a stand-in identity provider (OpenID Connect).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-ssoflow-'));
process.env.DATA_DIR = dir;
let server, base, idp, issuer;

// The stand-in provider: its configuration and keys, and a token endpoint that swaps the codes the test
// hands out (each with the claims to put in its ID token) for signed ID tokens.
const key = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const codes = new Map(); // code → { claims, verifierHash, redirect }
const seen = []; // what the token endpoint was sent
const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = (claims) => { const h = enc({ alg: 'RS256', kid: 'k1' }), b = enc(claims); return `${h}.${b}.${crypto.sign('RSA-SHA256', Buffer.from(`${h}.${b}`), key.privateKey).toString('base64url')}`; };
function provider(req, res) {
  const u = new URL(req.url, issuer);
  const json = (o, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (u.pathname === '/.well-known/openid-configuration') return json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` });
  if (u.pathname === '/jwks') return json({ keys: [{ ...key.publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig' }] });
  if (u.pathname === '/token') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const p = new URLSearchParams(body);
      seen.push(Object.fromEntries(p));
      const c = codes.get(p.get('code'));
      codes.delete(p.get('code'));
      if (!c || p.get('client_secret') !== 'shh' || crypto.createHash('sha256').update(p.get('code_verifier') || '').digest('base64url') !== c.challenge) return json({ error: 'invalid_grant' }, 400);
      json({ id_token: sign(c.claims), access_token: 'x', token_type: 'Bearer' });
    });
    return undefined;
  }
  res.writeHead(404); res.end();
}

before(async () => {
  idp = http.createServer(provider);
  await new Promise((r) => idp.listen(0, '127.0.0.1', r));
  issuer = `http://127.0.0.1:${idp.address().port}`;
  const { createApp } = await import('../src/app.js');
  server = http.createServer(createApp());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); idp.close(); fs.rmSync(dir, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  return async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json', ...(cookie && { cookie }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const c = res.headers.get('set-cookie'); if (c) cookie = c.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}
const owner = client();

/** Start signing in as `email`; the provider "says yes" with these claims (nonce filled in unless given). */
async function signIn(email, claims) {
  const start = await fetch(`${base}/api/auth/sso/start?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  const to = new URL(start.headers.get('location'), base);
  if (!to.href.startsWith(issuer)) return { to };
  const code = crypto.randomBytes(12).toString('hex');
  codes.set(code, { claims: { iss: issuer, aud: 'ws-app', exp: Math.floor(Date.now() / 1000) + 300, nonce: to.searchParams.get('nonce'), ...claims }, challenge: to.searchParams.get('code_challenge') });
  const back = await fetch(`${base}/api/auth/sso/callback?code=${code}&state=${to.searchParams.get('state')}`, { redirect: 'manual' });
  return { to, back, location: back.headers.get('location'), cookie: (back.headers.get('set-cookie') || '').split(';')[0] };
}

test('set up: a company with single sign-on (the secret is never sent back)', async () => {
  assert.equal((await owner('POST', '/api/auth/setup', { org_name: 'Acme', domain: 'acme.com', name: 'Olivia Owner', local: 'olivia', password: 'password123' })).status, 200);
  assert.equal((await owner('POST', '/api/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).status, 201);
  assert.equal((await owner('PATCH', '/api/orgs/current', { sso_issuer: 'http://login.example.com' })).status, 400, 'https only (but this machine)');
  const r = await owner('PATCH', '/api/orgs/current', { sso_issuer: `${issuer}/`, sso_client_id: 'ws-app', sso_secret: 'shh', sso_label: 'Microsoft' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const org = (await owner('GET', '/api/orgs/current')).body;
  assert.deepEqual([org.sso_issuer, org.sso_client_id, org.sso_label, org.sso_has_secret], [issuer, 'ws-app', 'Microsoft', true]);
  assert.ok(!JSON.stringify(org).includes('shh'), 'the secret isn’t sent back');
  assert.deepEqual((await (await fetch(`${base}/api/auth/sso/check?email=kim@ACME.com`)).json()), { sso: 'Microsoft' });
  assert.deepEqual((await (await fetch(`${base}/api/auth/sso/check?email=kim@elsewhere.com`)).json()), { sso: null });
});

test('the provider is asked properly, and its yes signs Kim in', async () => {
  const r = await signIn('kim@acme.com', { email: 'Kim@Acme.com' });
  const p = r.to.searchParams;
  assert.deepEqual([r.to.pathname, p.get('response_type'), p.get('client_id'), p.get('scope'), p.get('code_challenge_method'), p.get('login_hint')], ['/authorize', 'code', 'ws-app', 'openid email profile', 'S256', 'kim@acme.com']);
  assert.match(p.get('redirect_uri'), /\/api\/auth\/sso\/callback$/);
  assert.ok(p.get('state') && p.get('nonce'));
  assert.equal(r.location, '/');
  const me = await fetch(`${base}/api/auth/me`, { headers: { cookie: r.cookie } });
  assert.equal((await me.json()).user.username, 'kim@acme.com');
  assert.equal(seen.at(-1).client_secret, 'shh');
  const devices = await fetch(`${base}/api/auth/sessions`, { headers: { cookie: r.cookie } });
  if (devices.ok) assert.ok(JSON.stringify(await devices.json()).includes('"sso"'), 'the device list says how');
  const log = (await owner('GET', '/api/audit?action=sign-in')).body;
  assert.match(JSON.stringify(log), /kim@acme\.com[\s\S]*Microsoft/);
});

test('refused, saying why: a used state, no such account, a disabled one, an ID token for another sign-in', async () => {
  const r = await signIn('kim@acme.com', { email: 'kim@acme.com' });
  const again = await fetch(`${base}/api/auth/sso/callback?code=x&state=${r.to.searchParams.get('state')}`, { redirect: 'manual' });
  assert.match(decodeURIComponent(again.headers.get('location')), /took too long or was used already/);
  assert.match(decodeURIComponent((await signIn('kim@acme.com', { email: 'nobody@acme.com' })).location), /nobody@acme\.com has no Workspace account here/);
  const kimId = (await owner('GET', '/api/users')).body.find((u) => u.username === 'kim@acme.com').id;
  await owner('PATCH', `/api/users/${kimId}`, { disabled: true });
  assert.match(decodeURIComponent((await signIn('kim@acme.com', { email: 'kim@acme.com' })).location), /has no Workspace account here/);
  await owner('PATCH', `/api/users/${kimId}`, { disabled: false });
  const forged = await signIn('kim@acme.com', { email: 'kim@acme.com', nonce: 'someone-elses' });
  assert.match(decodeURIComponent(forged.location), /didn’t work: The ID token isn’t for this sign-in/);
  assert.equal(forged.cookie, '', 'no session');
  const other = await signIn('kim@acme.com', { email: 'kim@acme.com', aud: 'another-app' });
  assert.match(decodeURIComponent(other.location), /for another app/);
  const failed = (await owner('GET', '/api/audit?action=sign-in.failed')).body;
  assert.match(JSON.stringify(failed), /sso/);
});

test('someone with Workspace two-step verification still gives their code', async () => {
  // Olivia turns two-step verification on (the authenticator app), then signs in through the provider.
  const setup = (await owner('POST', '/api/auth/2fa/setup', { password: 'password123' })).body;
  assert.ok(setup?.secret, JSON.stringify(setup));
  const { codeAt } = await import('../src/totp.js');
  const totp = (secret) => codeAt(secret, Math.floor(Date.now() / 30000));
  const on = await owner('POST', '/api/auth/2fa/confirm', { code: totp(setup.secret) });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  const r = await signIn('olivia@acme.com', { email: 'olivia@acme.com' });
  assert.match(r.location, /^\/login\?sso_ticket=/);
  assert.equal(r.cookie, '', 'not signed in yet');
  const ticket = decodeURIComponent(r.location.split('sso_ticket=')[1]);
  const done = await fetch(`${base}/api/auth/login/code`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ ticket, code: codeAt(setup.secret, Math.floor(Date.now() / 30000) + 1) }) }); // the next code: one is never accepted twice
  assert.equal(done.status, 200);
  assert.equal((await done.json()).user.username, 'olivia@acme.com');
});

test('a company without it: sent back to the password', async () => {
  await owner('PATCH', '/api/orgs/current', { sso_issuer: '' });
  const start = await fetch(`${base}/api/auth/sso/start?email=kim@acme.com`, { redirect: 'manual' });
  assert.match(decodeURIComponent(start.headers.get('location')), /doesn’t sign in that way/);
});

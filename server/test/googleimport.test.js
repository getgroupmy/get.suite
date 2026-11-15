import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-gimport-'));
const { createOrg } = await import('../src/tenancy.js');
const { q } = await import('../src/db.js');
const { googleSignInUrl, finishGoogleSignIn, cleanGoogleApp, googleAppOf, GOOGLE_SCOPE } = await import('../src/mail/googleimport.js');

let g; const posted = [];
const jwt = (p) => `x.${Buffer.from(JSON.stringify(p)).toString('base64url')}.y`;
before(async () => {
  g = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const f = Object.fromEntries(new URLSearchParams(body));
      posted.push(f);
      res.setHeader('content-type', 'application/json');
      if (f.code === 'bad') { res.statusCode = 400; return res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'Bad Request' })); }
      res.end(JSON.stringify({ access_token: 'ya29.fake', scope: f.code === 'nomail' ? 'openid email' : GOOGLE_SCOPE, id_token: jwt({ email: 'Ana@Gmail.com', email_verified: true }) }));
    });
  });
  await new Promise((r) => g.listen(0, '127.0.0.1', r));
  process.env.GOOGLE_TOKEN_URL = `http://127.0.0.1:${g.address().port}/token`;
});
after(() => g.close());

test('the company’s Google client, checked; the secret is kept unless replaced', () => {
  assert.deepEqual(cleanGoogleApp({ client_id: ' 123-abc.apps.googleusercontent.com ', client_secret: 'GOCSPX-abcdefghijkl' }), { clientId: '123-abc.apps.googleusercontent.com', secret: 'GOCSPX-abcdefghijkl' });
  assert.equal(cleanGoogleApp({ client_id: '123-abc.apps.googleusercontent.com' }).secret, undefined, 'left out: kept');
  assert.throws(() => cleanGoogleApp({ client_id: 'my-client' }), /apps\.googleusercontent\.com/);
  assert.throws(() => cleanGoogleApp({ client_id: '1.apps.googleusercontent.com', client_secret: 'a b' }), /secret/);
});

test('sign in at Google (PKCE and a one-time state), then the import starts with the access Google gives', async () => {
  const { id: orgId, userId } = createOrg({ name: 'Acme', domain: 'acme.com', adminName: 'Ana', adminLocal: 'ana', adminPassword: 'password123' });
  const user = q('SELECT * FROM users WHERE id = ?').get(userId);
  assert.throws(() => googleSignInUrl(user, { base: 'https://work.acme.com' }), /hasn’t set up importing from Google/);
  q('UPDATE orgs SET g_client_id = ?, g_client_secret = ? WHERE id = ?').run('123-abc.apps.googleusercontent.com', 'GOCSPX-secret-value', orgId);
  assert.equal(googleAppOf(orgId).clientId, '123-abc.apps.googleusercontent.com');
  const url = new URL(googleSignInUrl(user, { email: 'ana@gmail.com', base: 'https://work.acme.com/' }));
  const p = Object.fromEntries(url.searchParams);
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.deepEqual([p.client_id, p.redirect_uri, p.response_type, p.scope, p.code_challenge_method, p.login_hint], ['123-abc.apps.googleusercontent.com', 'https://work.acme.com/api/mail/import/google/callback', 'code', GOOGLE_SCOPE, 'S256', 'ana@gmail.com']);
  const started = [];
  const start = async (u, o) => { started.push(o); return { status: 'running' }; };
  await assert.rejects(finishGoogleSignIn(user, { code: 'c', state: 'forged', base: 'https://work.acme.com' }, { start }), /expired or isn’t yours/);
  const out = await finishGoogleSignIn(user, { code: 'good', state: p.state, base: 'https://work.acme.com' }, { start });
  assert.equal(out.status, 'running');
  assert.deepEqual(started[0], { host: 'imap.gmail.com', port: 993, username: 'ana@gmail.com', accessToken: 'ya29.fake' });
  const sent = posted.at(-1);
  assert.equal(sent.client_secret, 'GOCSPX-secret-value');
  assert.equal(crypto.createHash('sha256').update(sent.code_verifier).digest('base64url'), p.code_challenge, 'the PKCE verifier matches');
  await assert.rejects(finishGoogleSignIn(user, { code: 'good', state: p.state, base: 'https://work.acme.com' }, { start }), /expired/, 'a state works once');
  // Someone else's state can't be used.
  const other = createOrg({ name: 'Globex', domain: 'globex.com', adminName: 'Gil', adminLocal: 'gil', adminPassword: 'password123' });
  const st = new URL(googleSignInUrl(user, { base: 'https://work.acme.com' })).searchParams.get('state');
  await assert.rejects(finishGoogleSignIn(q('SELECT * FROM users WHERE id = ?').get(other.userId), { code: 'good', state: st, base: 'x' }, { start }), /isn’t yours/);
});

test('said no at Google, no mail access ticked, or a bad code: said so, nothing started', async () => {
  const user = q("SELECT * FROM users WHERE username = 'ana@acme.com'").get();
  const started = [];
  const start = async (u, o) => { started.push(o); };
  const st = () => new URL(googleSignInUrl(user, { base: 'https://w' })).searchParams.get('state');
  await assert.rejects(finishGoogleSignIn(user, { error: 'access_denied', state: st(), base: 'https://w' }, { start }), /didn’t let Workspace read/);
  await assert.rejects(finishGoogleSignIn(user, { code: 'nomail', state: st(), base: 'https://w' }, { start }), /tick the box for Gmail/);
  await assert.rejects(finishGoogleSignIn(user, { code: 'bad', state: st(), base: 'https://w' }, { start }), /didn’t complete the sign-in: Bad Request/);
  assert.equal(started.length, 0);
});

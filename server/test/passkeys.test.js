import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-passkeys-'));
const { createApp } = await import('../src/app.js');
const { authenticator } = await import('./fixtures/fakeauthn.js');
const { b64url } = await import('../src/webauthn.js');
const { q } = await import('../src/db.js');

let server, base;
test.before(async () => { server = createApp().listen(0); await new Promise((r) => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
function client() {
  let cookie = '';
  return async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json', ...(cookie && { cookie }) }, body: body ? JSON.stringify(body) : undefined });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}

test('passkeys: added with your password, sign in with one (no password, no code), removed', async () => {
  delete process.env.PUBLIC_URL;
  const ana = client();
  const me = (await ana('POST', '/api/auth/setup', { org_name: 'Acme', domain: 'acme.com', name: 'Ana Silva', local: 'ana', password: 'password123' })).body.user;
  const site = { origin: base, rp: '127.0.0.1', userHandle: b64url(Buffer.from(me.id)) };
  const key = authenticator('ec', site);

  // Adding one needs the password.
  assert.equal((await ana('POST', '/api/auth/passkeys/options', { password: 'nope' })).status, 400);
  const opts = (await ana('POST', '/api/auth/passkeys/options', { password: 'password123' })).body;
  assert.equal(opts.rp.id, '127.0.0.1');
  assert.equal(opts.user.id, site.userHandle);
  assert.equal(opts.authenticatorSelection.userVerification, 'required');
  // A made-up answer to someone else's challenge is refused (and the challenge is used up).
  assert.equal((await ana('POST', '/api/auth/passkeys', { credential: { id: key.id, response: key.create('not-it') } })).status, 400);
  assert.equal((await ana('POST', '/api/auth/passkeys', { credential: { id: key.id, response: key.create(opts.challenge) } })).status, 400, 'used up');
  const opts2 = (await ana('POST', '/api/auth/passkeys/options', { password: 'password123' })).body;
  const added = await ana('POST', '/api/auth/passkeys', { credential: { id: key.id, response: key.create(opts2.challenge) }, name: 'Work laptop' });
  assert.equal(added.status, 201);
  assert.deepEqual(added.body.map((p) => [p.id, p.name]), [[key.id, 'Work laptop']]);
  const opts3 = (await ana('POST', '/api/auth/passkeys/options', { password: 'password123' })).body;
  assert.deepEqual(opts3.excludeCredentials.map((x) => x.id), [key.id], 'the browser is told not to make a second one on the same device');

  // Signing in with it on another browser: no password, no code.
  const signIn = async (who, k = key, change = (x) => x) => {
    const o = (await who('POST', '/api/auth/login/passkey/options')).body;
    return who('POST', '/api/auth/login/passkey', { ticket: o.ticket, credential: change({ id: k.id, response: k.get(o.options.challenge) }) });
  };
  const other = client();
  const r = await signIn(other);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.user.username, 'ana@acme.com');
  assert.equal((await other('GET', '/api/auth/me')).status, 200);
  assert.ok((await ana('GET', '/api/auth/passkeys')).body[0].last_used_at > 0);
  const log = q("SELECT details FROM audit_log WHERE action = 'sign-in' ORDER BY rowid DESC LIMIT 1").get();
  assert.match(log?.details || '', /passkey/);

  // A ticket works once; an unknown passkey, or one whose account doesn't match, is refused.
  const o = (await client()('POST', '/api/auth/login/passkey/options')).body;
  const c2 = client();
  assert.equal((await c2('POST', '/api/auth/login/passkey', { ticket: o.ticket, credential: { id: key.id, response: key.get(o.options.challenge) } })).status, 200);
  assert.equal((await c2('POST', '/api/auth/login/passkey', { ticket: o.ticket, credential: { id: key.id, response: key.get(o.options.challenge) } })).status, 401, 'used up');
  const stranger = authenticator('ec', site);
  assert.equal((await signIn(client(), stranger)).status, 401);
  assert.equal((await signIn(client(), key, (x) => ({ ...x, response: { ...x.response, userHandle: b64url(Buffer.from('someone-else')) } }))).status, 401);

  // With an authenticator app on, a passkey is still enough (it's two steps in one).
  q('INSERT OR REPLACE INTO two_factor (user_id, secret, enabled) VALUES (?, ?, 1)').run(me.id, 'JBSWY3DPEHPK3PXP');
  const r2 = await signIn(client());
  assert.equal(r2.status, 200);
  assert.ok(r2.body.user, 'signed in, no code asked');
  q('DELETE FROM two_factor WHERE user_id = ?').run(me.id);

  // Suspended: refused.
  q('UPDATE users SET disabled = 1 WHERE id = ?').run(me.id);
  assert.equal((await signIn(client())).status, 401);
  q('UPDATE users SET disabled = 0 WHERE id = ?').run(me.id);

  // Someone else can't remove it; Ana can, and then it signs nobody in.
  const bob = client();
  await ana('POST', '/api/users', { local: 'bob', domain: 'acme.com', name: 'Bob', password: 'password123' });
  await bob('POST', '/api/auth/login', { username: 'bob@acme.com', password: 'password123' });
  assert.equal((await bob('DELETE', `/api/auth/passkeys/${key.id}`)).status, 404);
  assert.deepEqual((await ana('DELETE', `/api/auth/passkeys/${key.id}`)).body, []);
  assert.equal((await signIn(client())).status, 401);
});

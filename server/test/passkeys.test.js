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

test('passkeys and a company that requires two steps: a passkey counts, and then it is the second step after a password', async () => {
  const ana = client();
  await ana('POST', '/api/auth/login', { username: 'ana@acme.com', password: 'password123' });
  const anaId = (await ana('GET', '/api/auth/me')).body.user.id;
  const cat = client();
  const catId = (await ana('POST', '/api/users', { local: 'cat', domain: 'acme.com', name: 'Cat Lee', password: 'password123' })).body.id;
  await cat('POST', '/api/auth/login', { username: 'cat@acme.com', password: 'password123' });
  const site = (id) => ({ origin: base, rp: '127.0.0.1', userHandle: b64url(Buffer.from(id)) });
  const addKey = async (who, id) => {
    const k = authenticator('ec', site(id));
    const o = (await who('POST', '/api/auth/passkeys/options', { password: 'password123' })).body;
    assert.equal((await who('POST', '/api/auth/passkeys', { credential: { id: k.id, response: k.create(o.challenge) }, name: 'Key' })).status, 201);
    return k;
  };
  // Requiring it needs it yourself: a passkey is enough.
  assert.equal((await ana('PATCH', '/api/orgs/current', { require_2fa: true })).status, 400);
  const anaKey = await addKey(ana, anaId);
  assert.equal((await ana('PATCH', '/api/orgs/current', { require_2fa: true })).status, 200);
  assert.equal((await ana('GET', '/api/auth/me')).body.user.needs_two_factor, false, 'Ana has a passkey');
  const left = (await ana('GET', '/api/orgs/current')).body.without_2fa;
  // Cat has neither: must set something up; a passkey will do.
  assert.equal((await cat('GET', '/api/auth/me')).body.user.needs_two_factor, true);
  const catKey = await addKey(cat, catId);
  assert.equal((await cat('GET', '/api/auth/me')).body.user.needs_two_factor, false);
  assert.equal((await ana('GET', '/api/orgs/current')).body.without_2fa, left - 1);

  // Cat's password now leads to the passkey step, for Cat's passkeys only.
  const fresh = client();
  const step = (await fresh('POST', '/api/auth/login', { username: 'cat@acme.com', password: 'password123' })).body;
  assert.equal(step.passkeyStep, true);
  assert.equal(step.user, undefined, 'not signed in yet');
  assert.deepEqual(step.options.allowCredentials.map((c) => c.id), [catKey.id]);
  assert.equal((await fresh('GET', '/api/auth/me')).status, 401);
  // Someone else's passkey can't finish Cat's sign-in.
  assert.equal((await fresh('POST', '/api/auth/login/passkey', { ticket: step.ticket, credential: { id: anaKey.id, response: anaKey.get(step.options.challenge) } })).status, 401);
  const step2 = (await fresh('POST', '/api/auth/login', { username: 'cat@acme.com', password: 'password123' })).body;
  const done = await fresh('POST', '/api/auth/login/passkey', { ticket: step2.ticket, credential: { id: catKey.id, response: catKey.get(step2.options.challenge) } });
  assert.equal(done.status, 200);
  assert.equal(done.body.user.username, 'cat@acme.com');

  // The users list shows who has passkeys; an admin's reset (lost phone) takes them away and signs Cat out.
  assert.equal((await ana('GET', '/api/users')).body.find((u) => u.id === catId).passkeys, 1);
  assert.equal((await ana('PATCH', `/api/users/${catId}`, { reset_two_factor: true })).status, 200);
  assert.deepEqual(q('SELECT id FROM passkeys WHERE user_id = ?').all(catId), []);
  assert.equal((await cat('GET', '/api/auth/me')).status, 401);
  // …and Cat's password alone then signs in, to set something up again.
  const after = await client()('POST', '/api/auth/login', { username: 'cat@acme.com', password: 'password123' });
  assert.equal(after.body.user?.needs_two_factor, true);
  await ana('PATCH', '/api/orgs/current', { require_2fa: false });
});

test('passkeys: you are told when one is added or removed; renamed (yours only)', async () => {
  const dan = client();
  const ana = client();
  await ana('POST', '/api/auth/login', { username: 'ana@acme.com', password: 'password123' });
  const danId = (await ana('POST', '/api/users', { local: 'dan', domain: 'acme.com', name: 'Dan Ode', password: 'password123' })).body.id;
  await dan('POST', '/api/auth/login', { username: 'dan@acme.com', password: 'password123' });
  const k = authenticator('ec', { origin: base, rp: '127.0.0.1', userHandle: b64url(Buffer.from(danId)) });
  const o = (await dan('POST', '/api/auth/passkeys/options', { password: 'password123' })).body;
  await dan('POST', '/api/auth/passkeys', { credential: { id: k.id, response: k.create(o.challenge) }, name: 'Phone' });
  const titles = () => q("SELECT title FROM notifications WHERE user_id = ? AND kind = 'signin' ORDER BY rowid").all(danId).map((n) => n.title);
  assert.deepEqual(titles(), ['A passkey was added to your account: “Phone”']);
  // Renamed: Dan's own only.
  assert.deepEqual((await dan('PATCH', `/api/auth/passkeys/${k.id}`, { name: 'Pixel 9' })).body.map((p) => p.name), ['Pixel 9']);
  assert.equal((await ana('PATCH', `/api/auth/passkeys/${k.id}`, { name: 'Mine now' })).status, 404);
  assert.equal((await dan('PATCH', `/api/auth/passkeys/${k.id}`, { name: '' })).status, 400);
  await dan('DELETE', `/api/auth/passkeys/${k.id}`);
  assert.deepEqual(titles(), ['A passkey was added to your account: “Phone”', 'A passkey was removed from your account: “Pixel 9”']);
});

test('signed-in devices say how each signed in: password, code, passkey', async () => {
  const ana = client();
  await ana('POST', '/api/auth/login', { username: 'ana@acme.com', password: 'password123' });
  const me = (await ana('GET', '/api/auth/me')).body.user;
  const current = async (who) => (await who('GET', '/api/auth/sessions')).body.find((s) => s.current).method;
  assert.equal(await current(ana), 'password');
  const k = authenticator('ec', { origin: base, rp: '127.0.0.1', userHandle: b64url(Buffer.from(me.id)) });
  const o = (await ana('POST', '/api/auth/passkeys/options', { password: 'password123' })).body;
  await ana('POST', '/api/auth/passkeys', { credential: { id: k.id, response: k.create(o.challenge) }, name: 'Key' });
  const viaKey = client();
  const lo = (await viaKey('POST', '/api/auth/login/passkey/options')).body;
  assert.equal((await viaKey('POST', '/api/auth/login/passkey', { ticket: lo.ticket, credential: { id: k.id, response: k.get(lo.options.challenge) } })).status, 200);
  assert.equal(await current(viaKey), 'passkey');
  // With an authenticator app: the code step.
  const { codeAt } = await import('../src/totp.js');
  const secret = 'JBSWY3DPEHPK3PXP';
  q('INSERT OR REPLACE INTO two_factor (user_id, secret, enabled) VALUES (?, ?, 1)').run(me.id, secret);
  const viaCode = client();
  const step = (await viaCode('POST', '/api/auth/login', { username: 'ana@acme.com', password: 'password123' })).body;
  assert.equal((await viaCode('POST', '/api/auth/login/code', { ticket: step.ticket, code: codeAt(secret, Math.floor(Date.now() / 30000)) })).status, 200);
  assert.equal(await current(viaCode), 'code');
  q('DELETE FROM two_factor WHERE user_id = ?').run(me.id);
  // Everyone's list shows all three.
  const methods = (await ana('GET', '/api/auth/sessions')).body.map((s) => s.method);
  for (const m of ['password', 'passkey', 'code']) assert.ok(methods.includes(m), m);
});

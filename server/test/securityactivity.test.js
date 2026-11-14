import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-secact-'));
const { createApp } = await import('../src/app.js');
const { securityActivity } = await import('../src/securityactivity.js');
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

test('recent security activity: your sign-ins, attempts and changes, in words for you, and only yours', async () => {
  const ana = client(), kim = client(), stranger = client();
  await ana('POST', '/api/auth/setup', { org_name: 'Acme', domain: 'acme.com', name: 'Ana Admin', local: 'ana', password: 'password123' });
  const kimId = (await ana('POST', '/api/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  await ana('POST', '/api/users', { local: 'lee', domain: 'acme.com', name: 'Lee Chan', password: 'password123' });
  assert.equal((await stranger('POST', '/api/auth/login', { username: 'kim@acme.com', password: 'guess-guess' })).status, 401);
  assert.equal((await kim('POST', '/api/auth/login', { username: 'kim@acme.com', password: 'password123' })).status, 200);
  assert.equal((await kim('PUT', '/api/auth/recovery-email', { password: 'password123', email: 'kim.home@example.net' })).status, 200);
  // Ana (an admin) signs out Kim's devices, and her own sign-ins are hers.
  assert.equal((await ana('DELETE', `/api/users/${kimId}/sessions/all`)).status, 200);
  assert.equal((await kim('GET', '/api/auth/security-activity')).status, 401, 'signed out');
  await kim('POST', '/api/auth/login', { username: 'kim@acme.com', password: 'password123' });
  const r = await kim('GET', '/api/auth/security-activity');
  assert.equal(r.status, 200);
  const texts = r.body.entries.map((e) => e.text);
  assert.deepEqual(texts, [
    'You signed in',
    '1 device was signed out',
    'Your recovery email was set',
    'You signed in',
    'Someone tried to sign in as you: wrong password',
  ]);
  assert.equal(r.body.failed, 1);
  assert.equal(r.body.days, 30);
  const out = r.body.entries[1];
  assert.equal(out.by, 'Ana Admin', 'done by someone else: says who');
  assert.equal(r.body.entries[0].by, null);
  assert.equal(r.body.entries.at(-1).warn, true);
  assert.equal(r.body.entries[0].warn, false);
  assert.ok(r.body.entries.every((e) => 'ip' in e && !('details' in e)));
  // Ana's list: her own setup sign-in, not her signing Kim out, nor Kim's anything.
  const a = (await ana('GET', '/api/auth/security-activity')).body.entries.map((e) => e.text);
  assert.ok(!a.some((t) => /signed out|tried|recovery/.test(t)), a.join(' | '));
  // Lee has nothing yet.
  const lee = client();
  await lee('POST', '/api/auth/login', { username: 'lee@acme.com', password: 'password123' });
  assert.deepEqual((await lee('GET', '/api/auth/security-activity')).body.entries.map((e) => e.text), ['You signed in']);
});

test('older than 30 days is left out; a passkey or two-step sign-in says how', () => {
  const u = q("SELECT id, username FROM users WHERE username = 'lee@acme.com'").get();
  const add = q('INSERT INTO audit_log (org_id, at, actor_id, actor_name, action, target, details, ip) VALUES (NULL, ?, ?, ?, ?, ?, ?, ?)');
  const now = Date.now();
  add.run(now - 40 * 86400000, u.id, 'Lee Chan', 'password.change', u.username, null, '10.0.0.1');
  add.run(now - 1000, u.id, 'Lee Chan', 'sign-in', u.username, JSON.stringify({ how: 'passkey' }), '10.0.0.2');
  add.run(now - 500, u.id, 'Lee Chan', 'sign-in', u.username, JSON.stringify({ twoStep: 'code' }), '10.0.0.3');
  add.run(now - 400, null, null, 'sign-in.failed', u.username, JSON.stringify({ reason: 'code' }), '10.0.0.4');
  add.run(now - 300, u.id, 'Lee Chan', 'drive.create', 'Team', null, null); // not a security thing
  const r = securityActivity(u);
  assert.deepEqual(r.entries.slice(0, 3).map((e) => [e.text, e.ip]), [
    ['Someone tried to sign in as you: wrong code', '10.0.0.4'],
    ['You signed in with a code', '10.0.0.3'],
    ['You signed in with a passkey', '10.0.0.2'],
  ]);
  assert.ok(!r.entries.some((e) => e.text === 'Your password was changed'), 'too old');
  assert.equal(securityActivity(u, { limit: 2 }).more, true);
});

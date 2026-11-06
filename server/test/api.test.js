import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-test-'));
process.env.DATA_DIR = dir;
const { createApp } = await import('../src/app.js');
const { attachHub } = await import('../src/hub.js');

let server, base;
before(async () => {
  server = http.createServer(createApp({ maxUploadBytes: 1024 * 1024 }));
  attachHub(server);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  return async function call(method, url, body, { raw, headers = {} } = {}) {
    const res = await fetch(base + url, {
      method,
      headers: {
        'x-requested-with': 'nas-workspace',
        ...(cookie && { cookie }),
        ...(body !== undefined && !raw && { 'content-type': 'application/json' }),
        ...headers,
      },
      body: raw ? body : body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : await res.text() };
  };
}
const login = async (c, username, password = 'password123') => {
  const r = await c('POST', '/api/auth/login', { username, password });
  assert.equal(r.status, 200, `login ${username}: ${JSON.stringify(r.body)}`);
  return r.body.user;
};

// Acme (owner = platform owner) and Globex (separate company).
const owner = client();   // owner@acme.com, platform owner + Acme admin
const bob = client();     // bob@acme.com
const gina = client();    // gina@globex.com, Globex admin
let bobId, ginaId, globexId;

test('first-run setup creates the first company and platform owner', async () => {
  assert.equal((await owner('GET', '/api/auth/status')).body.needsSetup, true);
  const bad = await owner('POST', '/api/auth/setup', { org_name: 'Acme', domain: 'not a domain', name: 'O', local: 'owner', password: 'password123' });
  assert.equal(bad.status, 400);
  const r = await owner('POST', '/api/auth/setup', { org_name: 'Acme', domain: 'Acme.com', name: 'Olivia Owner', local: 'Owner', password: 'password123' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.user.username, 'owner@acme.com');
  assert.equal(r.body.user.is_super, true);
  assert.equal(r.body.user.org_name, 'Acme');
  assert.equal((await owner('POST', '/api/auth/setup', { org_name: 'x', domain: 'x.com', name: 'x', local: 'x', password: '12345678' })).status, 409);
});

test('CSRF header is required for writes', async () => {
  const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 403);
});

test('company admin adds users only on their own domains', async () => {
  assert.equal((await owner('POST', '/api/users', { local: 'bob', domain: 'globex.com', name: 'Bob', password: 'password123' })).status, 400);
  const r = await owner('POST', '/api/users', { local: 'bob', domain: 'acme.com', name: 'Bob B', password: 'password123' });
  assert.equal(r.status, 201);
  bobId = r.body.id;
  assert.equal((await owner('POST', '/api/users', { local: 'bob', domain: 'acme.com', name: 'Bob 2', password: 'password123' })).status, 400, 'duplicate address');
  assert.equal((await bob('POST', '/api/auth/login', { username: 'bob@acme.com', password: 'wrong-pass' })).status, 401);
  await login(bob, 'BOB@acme.com');
  assert.equal((await bob('GET', '/api/users')).status, 403, 'members cannot manage users');
  assert.equal((await bob('GET', '/api/orgs')).status, 403, 'members cannot list companies');
});

test('platform owner creates a second company', async () => {
  const r = await owner('POST', '/api/orgs', { name: 'Globex', domain: 'globex.com', admin_name: 'Gina G', admin_local: 'gina', admin_password: 'password123' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  globexId = r.body.id;
  ginaId = r.body.userId;
  assert.equal((await owner('POST', '/api/orgs', { name: 'Dup', domain: 'globex.com', admin_name: 'x', admin_local: 'x', admin_password: 'password123' })).status, 400, 'domain taken');
  const me = await login(gina, 'gina@globex.com');
  assert.equal(me.is_admin, true);
  assert.equal(me.is_super, false);
  assert.equal((await gina('GET', '/api/orgs')).status, 403, 'company admins cannot see other companies');
});

test('companies are isolated: directory, user admin, channels', async () => {
  const dirG = (await gina('GET', '/api/users/directory')).body.map((u) => u.username);
  assert.deepEqual(dirG, ['gina@globex.com']);
  assert.equal((await gina('GET', `/api/users?org_id=${(await owner('GET', '/api/auth/me')).body.user.org_id}`)).status, 403);
  assert.equal((await gina('PATCH', `/api/users/${bobId}`, { disabled: true })).status, 404, 'cannot manage other company users');
  assert.equal((await gina('POST', '/api/users', { local: 'z', domain: 'acme.com', name: 'Z', password: 'password123' })).status, 400);

  const acmeGeneral = (await bob('GET', '/api/chat/channels')).body.channels.find((c) => c.name === 'general');
  const globexGeneral = (await gina('GET', '/api/chat/channels')).body.channels.find((c) => c.name === 'general');
  assert.notEqual(acmeGeneral.id, globexGeneral.id);
  await bob('POST', `/api/chat/channels/${acmeGeneral.id}/messages`, { body: 'acme only' });
  assert.equal((await gina('GET', `/api/chat/channels/${acmeGeneral.id}/messages`)).status, 404);
  assert.equal((await gina('POST', `/api/chat/channels/${acmeGeneral.id}/messages`, { body: 'hi' })).status, 404);
});

test('platform owner can manage another company', async () => {
  const list = (await owner('GET', `/api/users?org_id=${globexId}`)).body;
  assert.deepEqual(list.map((u) => u.username), ['gina@globex.com']);
  const r = await owner('POST', '/api/users', { org_id: globexId, local: 'hank', domain: 'globex.com', name: 'Hank', password: 'password123' });
  assert.equal(r.status, 201);
});

let sharedFolder, sharedFile, dmId;
test('cross-company collaboration by exact email address', async () => {
  const found = await bob('GET', '/api/users/lookup?email=gina@globex.com');
  assert.equal(found.status, 200);
  assert.equal(found.body.org_name, 'Globex');
  assert.equal((await bob('GET', '/api/users/lookup?email=nobody@globex.com')).status, 404);

  sharedFolder = (await bob('POST', '/api/files/folder', { name: 'Joint project' })).body;
  sharedFile = (await bob('POST', `/api/files/upload?parent=${sharedFolder.id}&name=spec.txt`, 'joint spec', { raw: true })).body;
  const s = await bob('PUT', `/api/files/${sharedFolder.id}/shares`, { shares: [{ user_id: ginaId, role: 'editor' }] });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal((await bob('GET', `/api/files/${sharedFolder.id}/shares`)).body[0].external, true);
  assert.deepEqual((await gina('GET', '/api/files?view=shared')).body.map((f) => f.name), ['Joint project']);
  assert.equal((await gina('GET', `/api/files/${sharedFile.id}/raw`)).body, 'joint spec');

  dmId = (await gina('POST', '/api/chat/dm', { user_id: bobId })).body.id;
  assert.equal((await gina('POST', `/api/chat/channels/${dmId}/messages`, { body: 'hello from Globex' })).status, 201);
  assert.equal((await bob('GET', `/api/chat/channels/${dmId}/messages`)).body[0].body, 'hello from Globex');
});

test('turning off external collaboration revokes access immediately', async () => {
  const r = await gina('PATCH', '/api/orgs/current', { allow_external: false });
  assert.equal(r.status, 200);
  assert.equal(r.body.allow_external, false);
  assert.equal((await gina('GET', `/api/files/${sharedFile.id}/raw`)).status, 404, 'existing share revoked');
  assert.deepEqual((await gina('GET', '/api/files?view=shared')).body, []);
  assert.equal((await bob('GET', '/api/users/lookup?email=gina@globex.com')).status, 404);
  assert.equal((await bob('PUT', `/api/files/${sharedFolder.id}/shares`, { shares: [{ user_id: ginaId, role: 'viewer' }] })).status, 400);
  assert.equal((await bob('POST', `/api/chat/channels/${dmId}/messages`, { body: 'still there?' })).status, 400);
  assert.equal((await bob('POST', '/api/chat/dm', { user_id: ginaId })).status, 400);
  // Re-enable restores it.
  await gina('PATCH', '/api/orgs/current', { allow_external: true });
  assert.equal((await gina('GET', `/api/files/${sharedFile.id}/raw`)).body, 'joint spec');
});

test('storage quota is enforced per company', async () => {
  assert.equal((await gina('PATCH', '/api/orgs/current', { quota_mb: 1 })).status, 400, 'company admins cannot set quotas');
  await owner('PATCH', `/api/orgs/${globexId}`, { quota_mb: 1 });
  const chunk = Buffer.alloc(600 * 1024);
  assert.equal((await gina('POST', '/api/files/upload?name=a.bin', chunk, { raw: true })).status, 201);
  assert.equal((await gina('POST', '/api/files/upload?name=b.bin', chunk, { raw: true })).status, 413);
  const orgs = (await owner('GET', '/api/orgs')).body;
  assert.equal(orgs.find((o) => o.id === globexId).storage_used, 600 * 1024);
});

test('domains: add, refuse removing last or in-use domain', async () => {
  assert.equal((await owner('POST', `/api/orgs/${globexId}/domains`, { name: 'acme.com' })).status, 400, 'belongs to Acme');
  const r = await owner('POST', `/api/orgs/${globexId}/domains`, { name: 'globex.net' });
  assert.deepEqual(r.body.domains, ['globex.com', 'globex.net']);
  assert.equal((await owner('DELETE', `/api/orgs/${globexId}/domains/globex.com`)).status, 400, 'in use');
  assert.equal((await owner('DELETE', `/api/orgs/${globexId}/domains/globex.net`)).status, 200);
  assert.equal((await owner('DELETE', `/api/orgs/${globexId}/domains/globex.com`)).status, 400, 'last domain');
});

test('drive: uploads, inherited access, viewer limits, size limit', async () => {
  const folder = (await owner('POST', '/api/files/folder', { name: 'Projects' })).body;
  const up = await owner('POST', `/api/files/upload?parent=${folder.id}&name=${encodeURIComponent('notes é.txt')}`, 'hello world', { raw: true });
  assert.equal(up.body.name, 'notes é.txt');
  const dup = await owner('POST', `/api/files/upload?parent=${folder.id}&name=notes%20%C3%A9.txt`, 'again', { raw: true });
  assert.equal(dup.body.name, 'notes é (1).txt');
  assert.equal((await bob('GET', `/api/files/${up.body.id}/raw`)).status, 404, 'not shared yet');
  await owner('PUT', `/api/files/${folder.id}/shares`, { shares: [{ user_id: bobId, role: 'viewer' }] });
  assert.equal((await bob('GET', `/api/files/${up.body.id}/raw`)).body, 'hello world', 'inherited access');
  assert.equal((await bob('PATCH', `/api/files/${up.body.id}`, { name: 'x.txt' })).status, 403, 'viewer cannot rename');
  assert.equal((await owner('POST', '/api/files/upload?name=big.bin', Buffer.alloc(2 * 1024 * 1024), { raw: true })).status, 413);
});

test('drive: html uploads are never served inline', async () => {
  const up = await owner('POST', '/api/files/upload?name=evil.html', '<script>alert(1)</script>', { raw: true });
  const res = await owner('GET', `/api/files/${up.body.id}/raw`);
  assert.equal(res.headers.get('content-type'), 'application/octet-stream');
  assert.match(res.headers.get('content-disposition'), /^attachment/);
  assert.equal((await fetch(`${base}/api/files/${up.body.id}/raw`)).status, 401);
});

test('docs: optimistic concurrency', async () => {
  const doc = (await owner('POST', '/api/files/new', { kind: 'doc', name: 'Plan' })).body;
  const c = (await owner('GET', `/api/files/${doc.id}/content`)).body;
  assert.equal((await owner('PUT', `/api/files/${doc.id}/content`, { version: c.file.version, content: { type: 'doc', content: [] } })).status, 200);
  assert.equal((await owner('PUT', `/api/files/${doc.id}/content`, { version: c.file.version, content: {} })).status, 409);
});

test('trash, permanent delete, and no folder cycles', async () => {
  const f = (await owner('POST', '/api/files/folder', { name: 'Old' })).body;
  await owner('POST', `/api/files/upload?parent=${f.id}&name=a.txt`, 'a', { raw: true });
  await owner('PATCH', `/api/files/${f.id}`, { trashed: true });
  assert.ok((await owner('GET', '/api/files?view=trash')).body.some((x) => x.id === f.id));
  assert.equal((await owner('POST', '/api/files/empty-trash')).body.deleted, 1);
  assert.equal((await owner('GET', `/api/files/${f.id}`)).status, 404);
  const a = (await owner('POST', '/api/files/folder', { name: 'A' })).body;
  const b = (await owner('POST', '/api/files/folder', { name: 'B', parent_id: a.id })).body;
  assert.equal((await owner('PATCH', `/api/files/${a.id}`, { parent_id: b.id })).status, 400);
});

test('calendar and contacts are private per user', async () => {
  const ev = await owner('POST', '/api/events', { title: 'Standup', start: 1000, end: 2000 });
  assert.equal(ev.status, 201);
  assert.equal((await bob('GET', '/api/events?from=0&to=5000')).body.length, 0);
  assert.equal((await bob('DELETE', `/api/events/${ev.body.id}`)).status, 404);
  assert.equal((await owner('POST', '/api/events', { title: 'Bad', start: 2000, end: 1000 })).status, 400);
  assert.equal((await owner('POST', '/api/contacts', { name: 'Carol' })).status, 201);
  assert.equal((await bob('GET', '/api/contacts')).body.length, 0);
});

test('session cookie is Secure only behind HTTPS (auto mode)', async () => {
  const post = (headers) => fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ username: 'owner@acme.com', password: 'password123' }),
  });
  assert.doesNotMatch((await post({})).headers.get('set-cookie'), /Secure/);
  assert.match((await post({ 'x-forwarded-proto': 'https' })).headers.get('set-cookie'), /Secure/);
});

test('database backup snapshot is readable and rotated', async () => {
  const { backupDatabase, BACKUP_DIR } = await import('../src/backup.js');
  const { DatabaseSync } = await import('node:sqlite');
  for (let d = 1; d <= 9; d++) backupDatabase({ keep: 7, date: new Date(Date.UTC(2026, 0, d)) });
  const files = fs.readdirSync(BACKUP_DIR).sort();
  assert.equal(files.length, 7);
  assert.equal(files[0], 'workspace-2026-01-03.db');
  const snap = new DatabaseSync(path.join(BACKUP_DIR, files.at(-1)), { readOnly: true });
  assert.ok(snap.prepare('SELECT COUNT(*) AS n FROM users').get().n >= 3);
  snap.close();
});

test('disabling a user signs them out', async () => {
  await owner('PATCH', `/api/users/${bobId}`, { disabled: true });
  assert.equal((await bob('GET', '/api/auth/me')).status, 401);
});

test('deleting a company removes its users and files', async () => {
  assert.equal((await owner('DELETE', `/api/orgs/${(await owner('GET', '/api/auth/me')).body.user.org_id}`)).status, 400, 'not your own');
  const files = fs.readdirSync(path.join(dir, 'files')).length;
  assert.equal((await owner('DELETE', `/api/orgs/${globexId}`)).status, 200);
  assert.equal((await gina('GET', '/api/auth/me')).status, 401);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(fs.readdirSync(path.join(dir, 'files')).length, files - 1, "Globex's upload was removed from disk");
});

test('two-step verification: setup, sign-in with a code or a recovery code, admin reset', async () => {
  const { codeAt, stepAt } = await import('../src/totp.js');
  const anna = client();
  const created = await owner('POST', '/api/users', { local: 'anna', domain: 'acme.com', name: 'Anna Two', password: 'password123' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  await login(anna, 'anna@acme.com');
  assert.deepEqual((await anna('GET', '/api/auth/2fa')).body, { enabled: false });

  assert.equal((await anna('POST', '/api/auth/2fa/setup', { password: 'wrong' })).status, 400, 'needs the password');
  const setup = (await anna('POST', '/api/auth/2fa/setup', { password: 'password123' })).body;
  assert.match(setup.secret, /^[A-Z2-7]{32}$/);
  assert.match(setup.otpauth, /^otpauth:\/\/totp\/Acme%3Aanna%40acme\.com\?secret=/);
  assert.equal((await anna('POST', '/api/auth/2fa/confirm', { code: '000000' })).status, 400, 'wrong first code');
  const on = (await anna('POST', '/api/auth/2fa/confirm', { code: codeAt(setup.secret, stepAt()) })).body;
  assert.equal(on.enabled, true);
  assert.equal(on.recoveryCodes.length, 10);
  assert.equal(on.recoveryLeft, 10);

  // Signing in now takes two steps; the password alone gives no session.
  const fresh = client();
  const step1 = await fresh('POST', '/api/auth/login', { username: 'anna@acme.com', password: 'password123' });
  assert.equal(step1.body.twoFactor, true);
  assert.equal(step1.body.user, undefined);
  assert.equal((await fresh('GET', '/api/auth/me')).status, 401, 'no session after the password alone');
  assert.equal((await fresh('POST', '/api/auth/login/code', { ticket: step1.body.ticket, code: '123456' })).status, 401);
  // The code that confirmed setup was used up; the next step's code works (allowed one step of drift).
  const ok = await fresh('POST', '/api/auth/login/code', { ticket: step1.body.ticket, code: codeAt(setup.secret, stepAt() + 1) });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.user.username, 'anna@acme.com');
  assert.equal((await fresh('GET', '/api/auth/me')).status, 200);
  assert.equal((await fresh('POST', '/api/auth/login/code', { ticket: step1.body.ticket, code: codeAt(setup.secret, stepAt()) })).status, 401, 'a ticket works once');

  // A recovery code works once.
  const viaRecovery = client();
  const t2 = (await viaRecovery('POST', '/api/auth/login', { username: 'anna@acme.com', password: 'password123' })).body.ticket;
  const r2 = await viaRecovery('POST', '/api/auth/login/code', { ticket: t2, code: on.recoveryCodes[0].toUpperCase() });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.recoveryLeft, 9);
  const t3 = (await client()('POST', '/api/auth/login', { username: 'anna@acme.com', password: 'password123' })).body.ticket;
  assert.equal((await client()('POST', '/api/auth/login/code', { ticket: t3, code: on.recoveryCodes[0] })).status, 401, 'used up');

  // Five wrong codes end the attempt.
  const guesser = client();
  const t4 = (await guesser('POST', '/api/auth/login', { username: 'anna@acme.com', password: 'password123' })).body.ticket;
  for (let i = 0; i < 4; i++) assert.equal((await guesser('POST', '/api/auth/login/code', { ticket: t4, code: '00000' + i })).status, 401);
  const fifth = await guesser('POST', '/api/auth/login/code', { ticket: t4, code: '000009' });
  assert.match(fifth.body.error, /Too many wrong codes/);
  assert.equal((await guesser('POST', '/api/auth/login/code', { ticket: t4, code: codeAt(setup.secret, stepAt()) })).status, 401);

  // The admin sees it, and can reset it for a lost phone; the user then signs in with the password only.
  const list = (await owner('GET', '/api/users')).body;
  assert.equal(list.find((u) => u.username === 'anna@acme.com').two_factor, 1);
  assert.equal((await anna('PATCH', `/api/users/${created.body.id}`, { reset_two_factor: true })).status, 403, 'admins only');
  assert.equal((await owner('PATCH', `/api/users/${created.body.id}`, { reset_two_factor: true })).status, 200);
  assert.equal((await fresh('GET', '/api/auth/me')).status, 401, 'sessions ended');
  const after = await client()('POST', '/api/auth/login', { username: 'anna@acme.com', password: 'password123' });
  assert.equal(after.body.user.username, 'anna@acme.com');

  // Turning it off yourself needs the password and a current code.
  const again = (await anna('POST', '/api/auth/2fa/setup', { password: 'password123' }));
  assert.equal(again.status, 401, 'old session was ended by the reset');
});

test('signed-in devices: listed per session, sign out one or all others', async () => {
  const created = await owner('POST', '/api/users', { local: 'dev', domain: 'acme.com', name: 'Dev Ices', password: 'password123' });
  assert.equal(created.status, 201);
  const laptop = client(), phone = client(), tablet = client();
  const ua = (s) => ({ headers: { 'user-agent': s } });
  for (const [c, agent] of [[laptop, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'],
    [phone, 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'],
    [tablet, 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0']]) {
    assert.equal((await c('POST', '/api/auth/login', { username: 'dev@acme.com', password: 'password123' }, ua(agent))).status, 200);
  }
  const list = (await laptop('GET', '/api/auth/sessions')).body;
  assert.equal(list.length, 3);
  assert.deepEqual(list.map((s) => s.device).sort(), ['Chrome on Windows', 'Firefox on Linux', 'Safari on iPhone']);
  assert.equal(list.filter((s) => s.current).length, 1);
  assert.equal(list.find((s) => s.current).device, 'Chrome on Windows');
  assert.ok(list.every((s) => s.ip && s.created_at && s.last_seen && /^[0-9a-f]{20}$/.test(s.id)));
  assert.ok(list.every((s) => !('token' in s)), 'no tokens in the list');
  const { q: dbq } = await import('../src/db.js');
  const tokens = dbq("SELECT token FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = 'dev@acme.com')").all().map((r) => r.token);
  assert.ok(tokens.length === 3 && tokens.every((t) => !JSON.stringify(list).includes(t)), 'session tokens never appear');

  // Sign out the phone from the laptop.
  const phoneId = list.find((s) => s.device === 'Safari on iPhone').id;
  assert.equal((await laptop('DELETE', `/api/auth/sessions/${phoneId}`)).status, 200);
  assert.equal((await phone('GET', '/api/auth/me')).status, 401);
  assert.equal((await laptop('DELETE', `/api/auth/sessions/${phoneId}`)).status, 404);
  // Someone else's session can't be touched.
  const ownerList = (await owner('GET', '/api/auth/sessions')).body;
  assert.equal((await laptop('DELETE', `/api/auth/sessions/${ownerList[0].id}`)).status, 404);
  assert.equal((await owner('GET', '/api/auth/me')).status, 200);
  // Everywhere else.
  assert.deepEqual((await laptop('POST', '/api/auth/sessions/sign-out-others')).body, { signedOut: 1 });
  assert.equal((await tablet('GET', '/api/auth/me')).status, 401);
  assert.equal((await laptop('GET', '/api/auth/me')).status, 200);
  assert.equal((await laptop('GET', '/api/auth/sessions')).body.length, 1);
});

test('a company can require two-step verification', async () => {
  const { codeAt, stepAt } = await import('../src/totp.js');
  // A separate company, so the rest of the tests aren't affected.
  const made = await owner('POST', '/api/orgs', { name: 'Initech', domain: 'initech.com', admin_name: 'Ivy Admin', admin_local: 'ivy', admin_password: 'password123' });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const ivy = client(), pete = client();
  await login(ivy, 'ivy@initech.com');
  assert.equal((await ivy('POST', '/api/users', { local: 'pete', domain: 'initech.com', name: 'Pete', password: 'password123' })).status, 201);
  await login(pete, 'pete@initech.com');

  // The admin must have it first, or they'd be locked out of the setting.
  const tooEarly = await ivy('PATCH', '/api/orgs/current', { require_2fa: true });
  assert.equal(tooEarly.status, 400);
  assert.match(tooEarly.body.error, /your own account first/);
  const s = (await ivy('POST', '/api/auth/2fa/setup', { password: 'password123' })).body;
  assert.equal((await ivy('POST', '/api/auth/2fa/confirm', { code: codeAt(s.secret, stepAt()) })).status, 200);
  const on = await ivy('PATCH', '/api/orgs/current', { require_2fa: true });
  assert.equal(on.status, 200);
  assert.equal(on.body.require_2fa, true);
  assert.equal(on.body.without_2fa, 1, 'Pete still has to set it up');

  // Pete is signed in but can only reach his own account settings until he sets it up.
  assert.equal((await pete('GET', '/api/auth/me')).body.user.needs_two_factor, true);
  const blocked = await pete('GET', '/api/files');
  assert.equal(blocked.status, 403);
  assert.match(blocked.body.error, /requires two-step verification/);
  const ps = (await pete('POST', '/api/auth/2fa/setup', { password: 'password123' })).body;
  assert.equal((await pete('POST', '/api/auth/2fa/confirm', { code: codeAt(ps.secret, stepAt()) })).status, 200);
  assert.equal((await pete('GET', '/api/auth/me')).body.user.needs_two_factor, false);
  assert.equal((await pete('GET', '/api/files')).status, 200);
  // ... and can't turn it off while it's required.
  const off = await pete('POST', '/api/auth/2fa/disable', { password: 'password123', code: codeAt(ps.secret, stepAt() + 1) });
  assert.equal(off.status, 400);
  assert.match(off.body.error, /requires two-step verification/);
  assert.equal((await ivy('GET', '/api/orgs/current')).body.without_2fa, 0);
});

test('repeating events: rules are checked, and series that started earlier are returned', async () => {
  const cal = client();
  assert.equal((await owner('POST', '/api/users', { local: 'cal', domain: 'acme.com', name: 'Cal Endar', password: 'password123' })).status, 201);
  await login(cal, 'cal@acme.com');
  const day = 864e5, jan1 = Date.UTC(2026, 0, 1, 9);
  const weekly = await cal('POST', '/api/events', { title: 'Weekly sync', start: jan1, end: jan1 + 36e5, rrule: { freq: 'weekly', byday: [4, 1, 4] } });
  assert.equal(weekly.status, 201, JSON.stringify(weekly.body));
  assert.deepEqual(weekly.body.rrule, { freq: 'weekly', byday: [1, 4] }, 'weekdays sorted, duplicates dropped');
  assert.deepEqual(weekly.body.exdates, []);
  assert.equal('repeat_until' in weekly.body, false);
  const ended = await cal('POST', '/api/events', { title: 'Old daily', start: jan1, end: jan1 + 36e5, rrule: { freq: 'daily', until: jan1 + 10 * day } });
  await cal('POST', '/api/events', { title: 'One-off', start: jan1, end: jan1 + 36e5 });
  await cal('POST', '/api/events', { title: 'Five times', start: jan1, end: jan1 + 36e5, rrule: { freq: 'monthly', interval: 2, count: 5 } });

  // A range in June: the weekly and the counted series come back (to be expanded), the ended one and the one-off don't.
  const june = (await cal('GET', `/api/events?from=${Date.UTC(2026, 5, 1)}&to=${Date.UTC(2026, 6, 1)}`)).body.map((e) => e.title).sort();
  assert.deepEqual(june, ['Five times', 'Weekly sync']);

  // Skipping one occurrence, and ending the series.
  const p = await cal('PATCH', `/api/events/${weekly.body.id}`, { exdates: [jan1 + 7 * day], rrule: { freq: 'weekly', byday: [4], until: Date.UTC(2026, 2, 1) } });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.deepEqual(p.body.exdates, [jan1 + 7 * day]);
  assert.equal((await cal('GET', `/api/events?from=${Date.UTC(2026, 5, 1)}&to=${Date.UTC(2026, 6, 1)}`)).body.length, 1, 'ended in March');
  assert.equal((await cal('PATCH', `/api/events/${weekly.body.id}`, { rrule: null })).body.rrule, null, 'no longer repeats');

  for (const bad of [{ freq: 'hourly' }, { freq: 'daily', interval: 0 }, { freq: 'daily', byday: [1] }, { freq: 'weekly', byday: [] },
    { freq: 'weekly', byday: [7] }, { freq: 'daily', count: 0 }, { freq: 'daily', count: 3, until: jan1 + day }, { freq: 'daily', until: jan1 - day }]) {
    assert.equal((await cal('POST', '/api/events', { title: 'x', start: jan1, end: jan1 + 1, rrule: bad })).status, 400, JSON.stringify(bad));
  }
  assert.equal(ended.status, 201);
});

test('calendar invitations: guests see the event, answer it, and only the organizer can change it', async () => {
  const org = client(), guest = client();
  for (const [c, local] of [[org, 'meet'], [guest, 'gues']]) {
    assert.equal((await owner('POST', '/api/users', { local, domain: 'acme.com', name: `${local} person`, password: 'password123' })).status, 201);
    await login(c, `${local}@acme.com`);
  }
  const t = Date.UTC(2026, 10, 10, 14);
  const bad = await org('POST', '/api/events', { title: 'x', start: t, end: t + 36e5, guests: ['nobody@nowhere.example'] });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /can't be invited/);
  // Someone at another company without collaboration can't be invited.
  assert.equal((await org('POST', '/api/events', { title: 'x', start: t, end: t + 36e5, guests: ['gina@globex.com'] })).status, 400);

  const ev = await org('POST', '/api/events', { title: 'Planning', start: t, end: t + 36e5, guests: ['GUES@acme.com', 'meet@acme.com'], tz: 'Europe/London' });
  assert.equal(ev.status, 201, JSON.stringify(ev.body));
  assert.deepEqual(ev.body.guests.map((g) => [g.email, g.status]), [['gues@acme.com', 'needs']], 'the organizer is not their own guest');

  const seen = (await guest('GET', `/api/events?from=${t - 864e5}&to=${t + 864e5}`)).body;
  assert.equal(seen.length, 1);
  assert.equal(seen[0].role, 'guest');
  assert.equal(seen[0].my_status, 'needs');
  assert.deepEqual(seen[0].organizer, { name: 'meet person', email: 'meet@acme.com' });
  assert.equal((await guest('PATCH', `/api/events/${ev.body.id}`, { title: 'Mine now' })).status, 404, 'guests cannot edit');
  assert.equal((await guest('DELETE', `/api/events/${ev.body.id}`)).status, 404);
  assert.equal((await guest('POST', `/api/events/${ev.body.id}/rsvp`, { status: 'perhaps' })).status, 400);
  assert.equal((await guest('POST', `/api/events/${ev.body.id}/rsvp`, { status: 'yes' })).status, 200);
  assert.equal((await bob('POST', `/api/events/${ev.body.id}/rsvp`, { status: 'yes' })).status, 401, 'bob is disabled; and he is not invited anyway');
  const mineAll = (await org('GET', `/api/events?from=${t - 864e5}&to=${t + 864e5}`)).body;
  assert.equal(mineAll.length, 1, 'refused invitations left no events behind');
  const mine = mineAll[0];
  assert.equal(mine.role, 'organizer');
  assert.deepEqual(mine.guests.map((g) => g.status), ['yes']);

  // Editing keeps answers; removing a guest takes the event out of their calendar.
  await org('PATCH', `/api/events/${ev.body.id}`, { title: 'Planning (room 2)', guests: ['gues@acme.com'] });
  assert.equal((await guest('GET', `/api/events?from=${t - 864e5}&to=${t + 864e5}`)).body[0].my_status, 'yes');
  await org('PATCH', `/api/events/${ev.body.id}`, { guests: [] });
  assert.equal((await guest('GET', `/api/events?from=${t - 864e5}&to=${t + 864e5}`)).body.length, 0);
  assert.equal((await guest('POST', `/api/events/${ev.body.id}/rsvp`, { status: 'no' })).status, 404);
});

test('public share links: no account needed; expiry, password, folders, revoking, company switch', async () => {
  const pub = client(); // nobody signed in
  const sharer = client();
  assert.equal((await owner('POST', '/api/users', { local: 'linker', domain: 'acme.com', name: 'Link Er', password: 'password123' })).status, 201);
  await login(sharer, 'linker@acme.com');
  const file = (await sharer('POST', '/api/files/upload?name=quote.pdf', '%PDF-1.4 hi', { raw: true })).body;
  const doc = (await sharer('POST', '/api/files/new', { kind: 'doc', name: 'Plan' })).body;
  assert.equal((await sharer('POST', '/api/links', { file_id: doc.id })).status, 400, 'docs cannot have links (yet)');
  assert.equal((await owner('POST', '/api/links', { file_id: file.id })).status, 404, 'only people with access, and only the owner');

  const link = (await sharer('POST', '/api/links', { file_id: file.id })).body;
  assert.match(link.token, /^[A-Za-z0-9_-]{24}$/);
  const info = (await pub('GET', `/api/public/links/${link.token}`)).body;
  assert.deepEqual([info.name, info.kind, info.locked, info.owner_name, info.org_name], ['quote.pdf', 'file', false, 'Link Er', 'Acme']);
  const raw = await pub('GET', `/api/public/links/${link.token}/raw`);
  assert.equal(raw.body, '%PDF-1.4 hi');
  assert.equal(raw.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.match((await pub('GET', `/api/public/links/${link.token}/raw?download`)).headers.get('content-disposition'), /^attachment/);
  assert.equal((await pub('GET', `/api/public/links/nope${link.token}`)).status, 404);
  assert.equal((await sharer('GET', `/api/links?file=${file.id}`)).body[0].opens, 1);

  // Password: locked until typed; wrong ones are refused; the key opens the file.
  const locked = (await sharer('POST', '/api/links', { file_id: file.id, password: 'sesame123', expires_at: Date.now() + 864e5 })).body;
  assert.equal(locked.has_password, true);
  assert.equal((await sharer('POST', '/api/links', { file_id: file.id, password: 'abc' })).status, 400);
  assert.equal((await sharer('POST', '/api/links', { file_id: file.id, expires_at: Date.now() - 1 })).status, 400);
  const li = (await pub('GET', `/api/public/links/${locked.token}`)).body;
  assert.equal(li.locked, true);
  assert.equal(li.size, undefined, 'nothing about the file before the password');
  assert.equal((await pub('GET', `/api/public/links/${locked.token}/raw`)).status, 401);
  assert.equal((await pub('POST', `/api/public/links/${locked.token}/unlock`, { password: 'wrong-one' })).status, 401);
  const { key } = (await pub('POST', `/api/public/links/${locked.token}/unlock`, { password: 'sesame123' })).body;
  assert.equal((await pub('GET', `/api/public/links/${locked.token}`, undefined, { headers: { 'x-link-key': key } })).body.locked, false);
  assert.equal((await pub('GET', `/api/public/links/${locked.token}/raw?key=${key}`)).body, '%PDF-1.4 hi');
  assert.equal((await pub('GET', `/api/public/links/${link.token}/raw?key=${key}`)).status, 200, 'no password: key not needed');

  // Expired links say so.
  const { q } = await import('../src/db.js');
  q('UPDATE share_links SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, locked.id);
  assert.equal((await pub('GET', `/api/public/links/${locked.token}`)).status, 410);
  assert.equal((await sharer('GET', `/api/links?file=${file.id}`)).body.find((l) => l.id === locked.id).expired, true);

  // Folders: browse inside, open files inside, nothing outside or in the trash.
  const folder = (await sharer('POST', '/api/files/folder', { name: 'Deliverables' })).body;
  const sub = (await sharer('POST', '/api/files/folder', { name: 'Drafts', parent_id: folder.id })).body;
  const inside = (await sharer('POST', `/api/files/upload?parent=${sub.id}&name=a.txt`, 'inside', { raw: true })).body;
  const binned = (await sharer('POST', `/api/files/upload?parent=${folder.id}&name=old.txt`, 'old', { raw: true })).body;
  await sharer('POST', '/api/files/new', { kind: 'doc', name: 'Notes', parent_id: folder.id });
  await sharer('PATCH', `/api/files/${binned.id}`, { trashed: true });
  const fl = (await sharer('POST', '/api/links', { file_id: folder.id })).body;
  const top = (await pub('GET', `/api/public/links/${fl.token}`)).body;
  assert.deepEqual(top.items.map((i) => i.name), ['Drafts'], 'trashed files and docs are left out');
  const down = (await pub('GET', `/api/public/links/${fl.token}?folder=${sub.id}`)).body;
  assert.deepEqual(down.path.map((p) => p.name), ['Deliverables', 'Drafts']);
  assert.deepEqual(down.items.map((i) => i.name), ['a.txt']);
  assert.equal((await pub('GET', `/api/public/links/${fl.token}/raw?item=${inside.id}`)).body, 'inside');
  assert.equal((await pub('GET', `/api/public/links/${fl.token}/raw?item=${binned.id}`)).status, 404);
  assert.equal((await pub('GET', `/api/public/links/${fl.token}/raw?item=${file.id}`)).status, 404, 'files outside the folder');
  assert.equal((await pub('GET', `/api/public/links/${fl.token}?folder=${doc.id}`)).status, 404);
  assert.equal((await pub('GET', `/api/public/links/${link.token}/raw?item=${inside.id}`)).status, 404, 'a file link opens only that file');

  // The company can switch links off (and back on); trashing or revoking ends a link.
  assert.equal((await owner('PATCH', '/api/orgs/current', { allow_links: false })).body.allow_links, false);
  assert.equal((await pub('GET', `/api/public/links/${link.token}`)).status, 404);
  assert.equal((await sharer('POST', '/api/links', { file_id: file.id })).status, 403);
  await owner('PATCH', '/api/orgs/current', { allow_links: true });
  assert.equal((await pub('GET', `/api/public/links/${link.token}`)).status, 200);
  await sharer('PATCH', `/api/files/${folder.id}`, { trashed: true });
  assert.equal((await pub('GET', `/api/public/links/${fl.token}/raw?item=${inside.id}`)).status, 404);
  assert.equal((await owner('DELETE', `/api/links/${link.id}`)).status, 404, 'only the owner revokes');
  assert.equal((await sharer('DELETE', `/api/links/${link.id}`)).status, 200);
  assert.equal((await pub('GET', `/api/public/links/${link.token}`)).status, 404);
});

test('version history: new uploads, editing sessions, restore, delete, quota', async () => {
  const me = client(), other = client();
  for (const [c, local] of [[me, 'verna'], [other, 'otto']]) {
    assert.equal((await owner('POST', '/api/users', { local, domain: 'acme.com', name: `${local} v`, password: 'password123' })).status, 201);
    await login(c, `${local}@acme.com`);
  }
  const otherId = (await other('GET', '/api/auth/me')).body.user.id;
  const up = (await me('POST', '/api/files/upload?name=price-list.txt', 'v1 prices', { raw: true })).body;
  const v2 = await me('POST', `/api/files/${up.id}/versions`, 'v2 prices, updated', { raw: true });
  assert.equal(v2.status, 200, JSON.stringify(v2.body));
  assert.equal(v2.body.version, 2);
  assert.equal((await me('GET', `/api/files/${up.id}/raw`)).body, 'v2 prices, updated');
  let list = (await me('GET', `/api/files/${up.id}/versions`)).body;
  assert.deepEqual(list.map((v) => [v.version, v.size, v.saved_by_name]), [[1, 9, 'verna v']]);
  assert.equal((await me('GET', `/api/files/${up.id}/versions/${list[0].id}/raw`)).body, 'v1 prices');

  // Viewers see the history but can't change it.
  await me('PUT', `/api/files/${up.id}/shares`, { shares: [{ user_id: otherId, role: 'viewer' }] });
  assert.equal((await other('GET', `/api/files/${up.id}/versions`)).body.length, 1);
  assert.equal((await other('POST', `/api/files/${up.id}/versions/${list[0].id}/restore`)).status, 403);
  assert.equal((await other('POST', `/api/files/${up.id}/versions`, 'x', { raw: true })).status, 403);

  // Restoring keeps what was there as a version too.
  const restored = (await me('POST', `/api/files/${up.id}/versions/${list[0].id}/restore`)).body;
  assert.equal(restored.version, 3);
  assert.equal((await me('GET', `/api/files/${up.id}/raw`)).body, 'v1 prices');
  list = (await me('GET', `/api/files/${up.id}/versions`)).body;
  assert.deepEqual(list.map((v) => v.version), [2, 1]);
  assert.equal((await me('DELETE', `/api/files/${up.id}/versions/${list[1].id}`)).status, 200);
  assert.equal((await me('GET', `/api/files/${up.id}/versions`)).body.length, 1);
  assert.equal((await me('POST', `/api/files/${up.id}/versions/nope/restore`)).status, 404);

  // Docs: saves in one sitting are one version; another editor, or a pause, starts a new one.
  const doc = (await me('POST', '/api/files/new', { kind: 'doc', name: 'Proposal' })).body;
  const save = async (c, version, text) => (await c('PUT', `/api/files/${doc.id}/content`, { version, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } })).body.version;
  let v = await save(me, 1, 'Draft');
  v = await save(me, v, 'Draft two');
  v = await save(me, v, 'Draft three');
  assert.equal((await me('GET', `/api/files/${doc.id}/versions`)).body.length, 0, 'one sitting');
  await me('PUT', `/api/files/${doc.id}/shares`, { shares: [{ user_id: otherId, role: 'editor' }] });
  v = await save(other, v, 'Otto edits');
  list = (await me('GET', `/api/files/${doc.id}/versions`)).body;
  assert.equal(list.length, 1);
  assert.equal(list[0].saved_by_name, 'verna v');
  const old = (await me('GET', `/api/files/${doc.id}/versions/${list[0].id}/content`)).body.content;
  assert.equal(old.content[0].content[0].text, 'Draft three');
  const { q } = await import('../src/db.js');
  q('UPDATE files SET updated_at = updated_at - 11 * 60000 WHERE id = ?').run(doc.id);
  v = await save(other, v, 'Otto, later');
  assert.equal((await me('GET', `/api/files/${doc.id}/versions`)).body.length, 2, 'after a pause');
  await me('POST', `/api/files/${doc.id}/versions/${list[0].id}/restore`);
  assert.equal((await me('GET', `/api/files/${doc.id}/content`)).body.content.content[0].content[0].text, 'Draft three');

  // Earlier versions count towards the company's storage.
  const { orgStorageUsed } = await import('../src/tenancy.js');
  const org = (await me('GET', '/api/auth/me')).body.user.org_id;
  const before = orgStorageUsed(org);
  await me('POST', `/api/files/${up.id}/versions`, 'x'.repeat(1000), { raw: true });
  assert.equal(orgStorageUsed(org) - before, 1000, 'the new bytes plus the kept old ones (already counted)');
});

test('renaming an address: account and data stay, the old address can stay as an alias, mail folders are never reused', async () => {
  const sam = client();
  const id = (await owner('POST', '/api/users', { local: 'sam', domain: 'acme.com', name: 'Sam Lee', password: 'password123' })).body.id;
  await login(sam, 'sam@acme.com');
  const f = (await sam('POST', '/api/files/folder', { name: 'Sam stuff' })).body;
  const { q } = await import('../src/db.js');
  q("INSERT INTO aliases (id, org_id, address, targets, created_at) VALUES ('al1', (SELECT org_id FROM users WHERE id = ?), 'team@acme.com', 'sam@acme.com, owner@acme.com', 0)").run(id);

  assert.equal((await owner('PATCH', `/api/users/${id}`, { local: 'Sam.Lee' })).status, 200);
  const u = { ...q('SELECT username, mail_home FROM users WHERE id = ?').get(id) };
  assert.deepEqual(u, { username: 'sam.lee@acme.com', mail_home: '/var/vmail/acme.com/sam' }, 'the mailbox stays where it was');
  assert.equal(q("SELECT targets FROM aliases WHERE address = 'team@acme.com'").get().targets, 'sam.lee@acme.com, owner@acme.com');
  assert.equal(q("SELECT targets FROM aliases WHERE address = 'sam@acme.com'").get().targets, 'sam.lee@acme.com', 'old address kept as an alias');
  assert.equal((await sam('GET', '/api/auth/me')).body.user.email, 'sam.lee@acme.com', 'still signed in');
  assert.ok((await sam('GET', '/api/files')).body.some((x) => x.id === f.id), 'files stay');
  assert.equal((await client()('POST', '/api/auth/login', { username: 'sam@acme.com', password: 'password123' })).status, 401);
  await login(client(), 'sam.lee@acme.com');

  // Taken addresses and other companies' domains are refused.
  assert.equal((await owner('PATCH', `/api/users/${id}`, { local: 'team' })).status, 400);
  assert.equal((await owner('PATCH', `/api/users/${id}`, { domain: 'globex.com' })).status, 400);

  // Without keeping the old address, it's free again; whoever gets it gets a new, empty mailbox.
  assert.equal((await owner('PATCH', `/api/users/${id}`, { local: 'slee', keep_old_address: false })).status, 200);
  assert.equal(q("SELECT 1 FROM aliases WHERE address = 'sam.lee@acme.com'").get(), undefined);
  assert.equal(q('SELECT mail_home FROM users WHERE id = ?').get(id).mail_home, '/var/vmail/acme.com/sam', 'still the original mailbox');
  q("DELETE FROM aliases WHERE address = 'sam@acme.com'").run();
  const newSam = (await owner('POST', '/api/users', { local: 'sam', domain: 'acme.com', name: 'Another Sam', password: 'password123' })).body.id;
  assert.match(q('SELECT mail_home FROM users WHERE id = ?').get(newSam).mail_home, /^\/var\/vmail\/acme\.com\/sam\.[0-9a-f]{8}$/, 'a fresh folder, not Sam Lee\'s');
  // Deleting someone retires their folder too.
  const tmp = (await owner('POST', '/api/users', { local: 'temp', domain: 'acme.com', name: 'Temp', password: 'password123' })).body.id;
  assert.equal(q('SELECT mail_home FROM users WHERE id = ?').get(tmp).mail_home, null, 'the usual folder');
  await owner('DELETE', `/api/users/${tmp}`);
  const again = (await owner('POST', '/api/users', { local: 'temp', domain: 'acme.com', name: 'Temp 2', password: 'password123' })).body.id;
  assert.match(q('SELECT mail_home FROM users WHERE id = ?').get(again).mail_home, /^\/var\/vmail\/acme\.com\/temp\./);
});

test('presentations: created with a title slide, saved like documents', async () => {
  const deck = await owner('POST', '/api/files/new', { kind: 'slides' });
  assert.equal(deck.status, 201);
  assert.equal(deck.body.name, 'Untitled presentation');
  const c = (await owner('GET', `/api/files/${deck.body.id}/content`)).body;
  assert.equal(c.content.slides.length, 1);
  assert.deepEqual(c.content.slides[0].items.map((i) => i.role), ['title', 'subtitle']);
  const next = { ...c.content, slides: [...c.content.slides, { id: 'two', items: [] }] };
  assert.equal((await owner('PUT', `/api/files/${deck.body.id}/content`, { version: c.file.version, content: next })).status, 200);
  assert.equal((await owner('GET', `/api/files/${deck.body.id}/content`)).body.content.slides.length, 2);

  // Pictures: viewers of the deck see the ones it uses, nothing else.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const pic = (await owner('POST', '/api/files/upload?name=logo.png', png, { raw: true })).body;
  const secret = (await owner('POST', '/api/files/upload?name=secret.png', png, { raw: true })).body;
  const viewer = client();
  assert.equal((await owner('POST', '/api/users', { local: 'deckview', domain: 'acme.com', name: 'Deck Viewer', password: 'password123' })).status, 201);
  const vid = (await login(viewer, 'deckview@acme.com')).id;
  await owner('PUT', `/api/files/${deck.body.id}/shares`, { shares: [{ user_id: vid, role: 'viewer' }] });
  const cur = (await owner('GET', `/api/files/${deck.body.id}/content`)).body;
  const withPic = { ...cur.content, slides: [{ ...cur.content.slides[0], items: [...cur.content.slides[0].items, { id: 'p', type: 'image', fileId: pic.id, x: 0, y: 0, w: 10, h: 10 }] }, ...cur.content.slides.slice(1)] };
  await owner('PUT', `/api/files/${deck.body.id}/content`, { version: cur.file.version, content: withPic });
  const shown = await viewer('GET', `/api/files/${deck.body.id}/pictures/${pic.id}`);
  assert.equal(shown.status, 200);
  assert.equal(shown.headers.get('content-type'), 'image/png');
  assert.equal((await viewer('GET', `/api/files/${pic.id}/raw`)).status, 404, 'the picture file itself is not shared');
  assert.equal((await viewer('GET', `/api/files/${deck.body.id}/pictures/${secret.id}`)).status, 404, 'only pictures the deck uses');
});

test('documents: pictures show for everyone who can open the document', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const pic = (await owner('POST', '/api/files/upload?name=photo.png', png, { raw: true })).body;
  const other = (await owner('POST', '/api/files/upload?name=other.png', png, { raw: true })).body;
  const doc = (await owner('POST', '/api/files/new', { kind: 'doc', name: 'With a picture' })).body;
  const viewer = client();
  assert.equal((await owner('POST', '/api/users', { local: 'docview', domain: 'acme.com', name: 'Doc Viewer', password: 'password123' })).status, 201);
  const vid = (await login(viewer, 'docview@acme.com')).id;
  await owner('PUT', `/api/files/${doc.id}/shares`, { shares: [{ user_id: vid, role: 'viewer' }] });
  const at = `/api/files/${doc.id}/pictures/${pic.id}`;
  assert.equal((await owner('GET', at)).status, 200, 'the person who put it in sees it straight away');
  assert.equal((await viewer('GET', at)).status, 404, 'others once the document uses it');
  const cur = (await owner('GET', `/api/files/${doc.id}/content`)).body;
  const content = { type: 'doc', content: [{ type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'image', attrs: { fileId: pic.id } }] }] }] }] };
  assert.equal((await owner('PUT', `/api/files/${doc.id}/content`, { version: cur.file.version, content })).status, 200);
  assert.equal((await viewer('GET', at)).status, 200, 'a picture inside a table counts too');
  assert.equal((await viewer('GET', `/api/files/${doc.id}/pictures/${other.id}`)).status, 404, 'only pictures the document uses');
  assert.equal((await viewer('GET', `/api/files/${pic.id}/raw`)).status, 404, 'the picture file itself is not shared');
});

test('Office files: open Word, Excel and PowerPoint as Docs, Sheets and Slides, and download them back', async () => {
  const { Document, Packer, Paragraph, HeadingLevel } = await import('docx');
  const ExcelJS = (await import('exceljs')).default;
  const PptxGenJS = (await import('pptxgenjs')).default;
  const folder = (await owner('POST', '/api/files/folder', { name: 'From the client' })).body;
  const up = async (name, buf) => (await owner('POST', `/api/files/upload?parent=${folder.id}&name=${encodeURIComponent(name)}`, buf, { raw: true })).body;

  const docx = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph({ text: 'Contract', heading: HeadingLevel.HEADING_1 }), new Paragraph('Terms apply.')] }] }));
  const wordFile = await up('Contract v2.docx', docx);
  const doc = await owner('POST', `/api/files/${wordFile.id}/open-as`);
  assert.equal(doc.status, 201, JSON.stringify(doc.body));
  assert.deepEqual([doc.body.kind, doc.body.name, doc.body.parent_id], ['doc', 'Contract v2', folder.id], 'a copy next to the original');
  assert.match(JSON.stringify((await owner('GET', `/api/files/${doc.body.id}/content`)).body.content), /Contract.*Terms apply\./);

  const wb = new ExcelJS.Workbook(); wb.addWorksheet('Prices').getCell('A1').value = 42;
  const sheet = (await owner('POST', `/api/files/${(await up('Prices.xlsx', Buffer.from(await wb.xlsx.writeBuffer()))).id}/open-as`)).body;
  assert.equal(sheet.kind, 'sheet');
  assert.equal((await owner('GET', `/api/files/${sheet.id}/content`)).body.content.sheets[0].cells.A1, '42');

  const p = new PptxGenJS(); p.layout = 'LAYOUT_WIDE';
  p.addSlide().addImage({ data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', x: 1, y: 1, w: 2, h: 2 });
  const deck = (await owner('POST', `/api/files/${(await up('Pitch.pptx', await p.write({ outputType: 'nodebuffer' }))).id}/open-as`)).body;
  assert.equal(deck.kind, 'slides');
  const picId = (await owner('GET', `/api/files/${deck.id}/content`)).body.content.slides[0].items[0].fileId;
  assert.equal((await owner('GET', `/api/files/${deck.id}/pictures/${picId}`)).status, 200, 'its pictures show in the deck');
  assert.ok((await owner('GET', `/api/files?parent=${folder.id}`)).body.some((f) => f.name === 'Pitch pictures' && f.kind === 'folder'));

  // Downloading as Office files.
  for (const [f, ext, type] of [[doc.body, 'docx', 'wordprocessingml'], [sheet, 'xlsx', 'spreadsheetml'], [deck, 'pptx', 'presentationml']]) {
    const res = await owner('GET', `/api/files/${f.id}/export`);
    assert.equal(res.status, 200, ext);
    assert.match(res.headers.get('content-type'), new RegExp(type));
    assert.match(res.headers.get('content-disposition'), new RegExp(`\\.${ext}$`));
  }
  assert.equal((await owner('POST', `/api/files/${folder.id}/open-as`)).status, 400, 'folders and other files can\'t');
});

test('comments: threads on text or cells, replies, resolving, mentions by chat, who may do what', async () => {
  const cami = client(), vera = client(), out = client();
  for (const [c, local] of [[cami, 'cami'], [vera, 'vera'], [out, 'oscar']]) {
    assert.equal((await owner('POST', '/api/users', { local, domain: 'acme.com', name: `${local} c`, password: 'password123' })).status, 201);
    await login(c, `${local}@acme.com`);
  }
  const ids = Object.fromEntries((await owner('GET', '/api/users/directory')).body.map((u) => [u.username, u.id]));
  const doc = (await owner('POST', '/api/files/new', { kind: 'doc', name: 'Proposal' })).body;
  await owner('PUT', `/api/files/${doc.id}/shares`, { shares: [{ user_id: ids['cami@acme.com'], role: 'editor' }, { user_id: ids['vera@acme.com'], role: 'viewer' }] });

  const made = await owner('POST', `/api/comments/${doc.id}`, { body: 'Can @cami@acme.com check this? @oscar@acme.com too', anchor: { quote: 'the price' }, id: 'thread-one-1' });
  assert.equal(made.status, 201);
  assert.equal(made.body.comment.id, 'thread-one-1', 'the editor picks the id (it marks the text with it)');
  assert.deepEqual(made.body.notified, ['cami@acme.com']);
  assert.deepEqual(made.body.noAccess, ['oscar@acme.com'], 'Oscar can\'t open the file, so he isn\'t told about it');
  // Cami got a chat message with a link to the comment.
  const dms = (await cami('GET', '/api/chat/channels')).body.channels.filter((c) => c.dm_key);
  const msgs = (await cami('GET', `/api/chat/channels/${dms[0].id}/messages`)).body;
  assert.match(msgs.at(-1).body, /Mentioned you in a comment on “Proposal”[\s\S]*\/docs\/.+\?comment=thread-one-1/);

  assert.equal((await cami('POST', `/api/comments/${doc.id}`, { body: 'Looks fine', thread_id: 'thread-one-1' })).status, 201);
  assert.equal((await vera('GET', `/api/comments/${doc.id}`)).body.length, 2, 'viewers read');
  assert.equal((await vera('POST', `/api/comments/${doc.id}`, { body: 'x', anchor: { quote: 'y' } })).status, 403, 'but do not write');
  assert.equal((await out('GET', `/api/comments/${doc.id}`)).status, 404);
  assert.equal((await cami('PATCH', `/api/comments/${doc.id}/thread-one-1`, { body: 'changed' })).status, 403, 'only the author edits');
  assert.equal((await cami('PATCH', `/api/comments/${doc.id}/thread-one-1`, { resolved: true })).body.resolved, true);
  await owner('POST', `/api/comments/${doc.id}`, { body: 'One more thing', thread_id: 'thread-one-1' });
  assert.equal((await owner('GET', `/api/comments/${doc.id}`)).body[0].resolved, false, 'a reply reopens the thread');

  // Sheets: on a cell.
  const sheet = (await owner('POST', '/api/files/new', { kind: 'sheet', name: 'Budget' })).body;
  const onCell = (await owner('POST', `/api/comments/${sheet.id}`, { body: 'Source?', anchor: { sheet: 0, cell: 'b2' } })).body.comment;
  assert.equal(onCell.anchor.cell, 'B2');
  // A row inserted above: the thread moves with its cell; a deleted cell marks it gone.
  assert.equal((await owner('PATCH', `/api/comments/${sheet.id}/${onCell.id}`, { anchor: { sheet: 0, cell: 'B3' } })).body.anchor.cell, 'B3');
  assert.deepEqual((await owner('PATCH', `/api/comments/${sheet.id}/${onCell.id}`, { anchor: { sheet: 0, cell: 'B3', gone: true } })).body.anchor, { sheet: 0, cell: 'B3', gone: true });
  assert.equal((await owner('POST', `/api/comments/${sheet.id}`, { body: 'x', anchor: { cell: 'nope' } })).status, 400);

  // Deleting: the author or the owner; the first comment takes its replies with it.
  const reply = (await owner('GET', `/api/comments/${doc.id}`)).body.find((c) => c.author_email === 'cami@acme.com');
  assert.equal((await cami('DELETE', `/api/comments/${doc.id}/${reply.id}`)).status, 200);
  assert.equal((await owner('DELETE', `/api/comments/${doc.id}/thread-one-1`)).status, 200);
  assert.equal((await owner('GET', `/api/comments/${doc.id}`)).body.length, 0);
});

test('search finds files by the words inside them, and only files you can open', async () => {
  const { indexPending } = await import('../src/search.js');
  const { Document, Packer, Paragraph } = await import('docx');
  const doc = (await owner('POST', '/api/files/new', { kind: 'doc', name: 'Minutes', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'We agreed the Penang warehouse lease.' }] }] } })).body;
  const sheet = (await owner('POST', '/api/files/new', { kind: 'sheet', name: 'Stock', content: { sheets: [{ name: 'Sheet1', cells: { A1: 'Zanzibar cloves', B1: '=SUM(1,2)' } }] } })).body;
  await owner('POST', '/api/files/upload?name=notes.txt', Buffer.from('Remember the café déjà vu meeting'), { raw: true });
  const word = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('Quarterly kumquat forecast')] }] }));
  await owner('POST', '/api/files/upload?name=forecast.docx', word, { raw: true });
  while (await indexPending()) { /* until everything is indexed */ }
  const find = async (who, words) => (await who('GET', `/api/files?view=search&q=${encodeURIComponent(words)}`)).body;
  const hit = (await find(owner, 'penang lease'))[0];
  assert.equal(hit.id, doc.id);
  assert.match(hit.match, /\u0001Penang\u0002 warehouse \u0001lease\u0002/, 'with where it matched');
  assert.equal((await find(owner, 'zanzib'))[0].id, sheet.id, 'the start of a word is enough');
  assert.equal((await find(owner, 'SUM')).filter((f) => f.id === sheet.id).length, 0, 'formulas are not searched');
  assert.equal((await find(owner, 'cafe deja'))[0].name, 'notes.txt', 'accents do not matter');
  assert.equal((await find(owner, 'kumquat'))[0].name, 'forecast.docx');
  assert.equal((await find(owner, 'minutes'))[0].id, doc.id, 'names still match');
  assert.equal((await find(owner, 'minutes'))[0].match, undefined);
  // Someone else finds nothing until it's shared with them; edits are picked up.
  const other = client();
  assert.equal((await owner('POST', '/api/users', { local: 'searcher', domain: 'acme.com', name: 'Sam Searcher', password: 'password123' })).status, 201);
  const sid = (await login(other, 'searcher@acme.com')).id;
  assert.equal((await find(other, 'penang')).length, 0);
  await owner('PUT', `/api/files/${doc.id}/shares`, { shares: [{ user_id: sid, role: 'viewer' }] });
  assert.equal((await find(other, 'penang')).length, 1);
  const cur = (await owner('GET', `/api/files/${doc.id}/content`)).body;
  await owner('PUT', `/api/files/${doc.id}/content`, { version: cur.file.version, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Moved to Ipoh instead.' }] }] } });
  while (await indexPending()) { /* again */ }
  assert.equal((await find(owner, 'penang')).length, 0);
  assert.equal((await find(owner, 'ipoh'))[0].id, doc.id);
  await owner('PATCH', `/api/files/${doc.id}`, { trashed: true });
  assert.equal((await find(owner, 'ipoh')).length, 0, 'not from the bin');
  assert.deepEqual(await find(owner, '"*)('), [], 'odd input is harmless');
});

test('calendar reminders are each person\'s own', async () => {
  const start = Date.UTC(2026, 11, 1, 9), end = start + 36e5;
  const guest = client();
  assert.equal((await owner('POST', '/api/users', { local: 'remy', domain: 'acme.com', name: 'Remy Reminder', password: 'password123' })).status, 201);
  await login(guest, 'remy@acme.com');
  const made = await owner('POST', '/api/events', { title: 'Board meeting', start, end, reminders: [10, 1440, 10, -5, 99999999], guests: ['remy@acme.com'] });
  assert.equal(made.status, 201);
  assert.deepEqual(made.body.reminders, [10, 1440], 'cleaned: whole minutes, at most four weeks, once each');
  const mine = async (who) => (await who('GET', `/api/events?from=${start - 864e5}&to=${end + 864e5}`)).body.find((e) => e.id === made.body.id).reminders;
  assert.deepEqual(await mine(guest), [], "the organiser's reminders aren't the guest's");
  assert.deepEqual((await guest('PUT', `/api/events/${made.body.id}/reminders`, { reminders: [60] })).body.reminders, [60]);
  assert.deepEqual(await mine(guest), [60]);
  assert.deepEqual(await mine(owner), [10, 1440]);
  assert.deepEqual((await owner('PATCH', `/api/events/${made.body.id}`, { reminders: [] })).body.reminders, []);
  const stranger = client();
  assert.equal((await owner('POST', '/api/users', { local: 'stranger', domain: 'acme.com', name: 'Stan Stranger', password: 'password123' })).status, 201);
  await login(stranger, 'stranger@acme.com');
  assert.equal((await stranger('PUT', `/api/events/${made.body.id}/reminders`, { reminders: [5] })).status, 404);
});

test('scheduled mail gets the time it is actually sent as its date', async () => {
  const { redate } = await import('../src/routes/webmail.js');
  const raw = Buffer.from('From: a@acme.com\r\nDate: Mon, 01 Jan 2024 00:00:00 +0000\r\nSubject: Hi\r\n\r\nDate: in the body stays\r\n');
  const out = redate(raw, new Date(Date.UTC(2026, 10, 9, 8, 0))).toString();
  assert.match(out, /^From: a@acme.com\r\nDate: Mon, 09 Nov 2026 08:00:00 \+0000\r\nSubject: Hi/);
  assert.match(out, /\r\n\r\nDate: in the body stays/);
  assert.match(redate(Buffer.from('Subject: x\r\n\r\nbody')).toString(), /^Date: .+\r\nSubject: x\r\n\r\nbody$/, 'added when missing');
});

test('contacts: import vCard and CSV files (duplicates skipped), export, and address suggestions', async () => {
  const c = client();
  assert.equal((await owner('POST', '/api/users', { local: 'impo', domain: 'acme.com', name: 'Ivy Importer', password: 'password123' })).status, 201);
  await login(c, 'impo@acme.com');
  const up = (text) => c('POST', '/api/contacts/import', text, { raw: true, headers: { 'content-type': 'text/plain' } });
  const google = 'Name,Given Name,Family Name,E-mail 1 - Type,E-mail 1 - Value,Phone 1 - Value,Organization 1 - Name,Notes\r\n'
    + '"Tan, Mei Ling",Mei Ling,Tan,* Work,meiling@example.com ::: mei@home.example,+60 12-345 6789,Globex,"Met at ""Expo""\nKL"\r\n'
    + ',Raj,Kumar,,RAJ@example.com,,,\r\n';
  assert.deepEqual((await up(google)).body, { added: 2, skipped: 0 });
  const outlook = 'First Name;Last Name;E-mail Address;Mobile Phone;Company\nRaj;Kumar;raj@example.com;;\nSiti;Aminah;siti@example.com;+60 3-1111 2222;Acme\n';
  assert.deepEqual((await up(outlook)).body, { added: 1, skipped: 1 }, 'Raj is already there (same address)');
  const vcf = 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:card-1\r\nFN:Lee Wong\r\nEMAIL;TYPE=INTERNET:lee@example.com\r\nBDAY:1990-04-01\r\nEND:VCARD\r\nBEGIN:VCARD\r\nVERSION:3.0\r\nFN:Mei Ling Tan\r\nEMAIL:meiling@example.com\r\nEND:VCARD\r\n';
  assert.deepEqual((await up(vcf)).body, { added: 1, skipped: 1 });
  assert.equal((await up('just some text')).status, 400);
  const list = (await c('GET', '/api/contacts')).body;
  const mei = list.find((x) => x.email === 'meiling@example.com');
  assert.deepEqual([mei.name, mei.phone, mei.company, mei.notes], ['Tan, Mei Ling', '+60 12-345 6789', 'Globex', 'Met at "Expo"\nKL']);
  assert.equal(list.find((x) => x.email === 'raj@example.com').name, 'Raj Kumar');
  assert.match(list.find((x) => x.email === 'lee@example.com').vcard_extra, /BDAY:1990-04-01/, 'the rest of the card is kept');

  const csv = await c('GET', '/api/contacts/export?format=csv');
  assert.match(csv.headers.get('content-disposition'), /contacts\.csv/);
  const text = csv.body;
  assert.match(text, /^\uFEFF?Name,E-mail Address,Phone,Company,Notes\r\n/); // (the reader drops the byte-order mark)
  assert.match(text, /"Tan, Mei Ling",meiling@example.com,\+60 12-345 6789,Globex,"Met at ""Expo""\nKL"/);
  const back = (await c('GET', '/api/contacts/export?format=vcf')).body;
  assert.equal((back.match(/BEGIN:VCARD/g) || []).length, 4);

  const sug = async (q) => (await c('GET', `/api/contacts/suggest?q=${encodeURIComponent(q)}`)).body;
  assert.deepEqual((await sug('mei')).map((s) => [s.email, s.kind]), [['meiling@example.com', 'contact']]);
  const colleague = await sug('owner');
  assert.ok(colleague.some((s) => s.email === 'owner@acme.com' && s.kind === 'colleague'), 'colleagues too');
  assert.deepEqual(await sug(''), []);
  assert.deepEqual((await sug('globex')).length, 0, 'only names and addresses are matched');
});

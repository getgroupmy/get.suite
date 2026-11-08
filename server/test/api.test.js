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
  return async function call(method, url, body, { raw, headers = {}, binary } = {}) {
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
    return { status: res.status, headers: res.headers, body: binary ? Buffer.from(await res.arrayBuffer()) : type.includes('json') ? await res.json() : await res.text() };
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
  assert.equal(list.find((x) => x.email === 'lee@example.com').birthday, '1990-04-01', 'the birthday comes with the card');

  const csv = await c('GET', '/api/contacts/export?format=csv');
  assert.match(csv.headers.get('content-disposition'), /contacts\.csv/);
  const text = csv.body;
  assert.match(text, /^\uFEFF?Name,E-mail Address,Phone,Company,Notes,Birthday,Job Title,Address,Web Page\r\n/); // (the reader drops the byte-order mark)
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

test('chat: unread counts, editing, reactions and attached files', async () => {
  const a = client(), b = client(), x = client();
  for (const [local, name] of [['chata', 'Chat Ann'], ['chatb', 'Chat Ben'], ['chatx', 'Chat Xavi']]) assert.equal((await owner('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).status, 201);
  const aid = (await login(a, 'chata@acme.com')).id;
  const bid = (await login(b, 'chatb@acme.com')).id;
  await login(x, 'chatx@acme.com');
  const dm = (await a('POST', '/api/chat/dm', { user_id: bid })).body.id;
  const unread = async (who) => (await who('GET', '/api/chat/channels')).body.channels.find((c) => c.id === dm)?.unread;
  const m1 = (await a('POST', `/api/chat/channels/${dm}/messages`, { body: 'Hello Ben' })).body;
  await a('POST', `/api/chat/channels/${dm}/messages`, { body: 'Are you there?' });
  assert.equal(await unread(b), 2);
  assert.equal(await unread(a), 0, 'your own messages are read');
  await b('POST', `/api/chat/channels/${dm}/read`);
  assert.equal(await unread(b), 0);

  const edited = await a('PATCH', `/api/chat/messages/${m1.id}`, { body: 'Hello Ben!' });
  assert.equal(edited.body.body, 'Hello Ben!');
  assert.ok(edited.body.edited_at);
  assert.equal((await b('PATCH', `/api/chat/messages/${m1.id}`, { body: 'hijack' })).status, 404, 'only your own');

  const r1 = (await b('POST', `/api/chat/messages/${m1.id}/reactions`, { emoji: '👍' })).body;
  assert.deepEqual(r1.reactions, [{ emoji: '👍', users: [{ id: bid, name: 'Chat Ben' }] }]);
  await a('POST', `/api/chat/messages/${m1.id}/reactions`, { emoji: '👍' });
  const r2 = (await b('POST', `/api/chat/messages/${m1.id}/reactions`, { emoji: '👍' })).body;
  assert.deepEqual(r2.reactions, [{ emoji: '👍', users: [{ id: aid, name: 'Chat Ann' }] }], 'a second time takes it back');
  assert.equal((await x('POST', `/api/chat/messages/${m1.id}/reactions`, { emoji: '👍' })).status, 404, 'not for people outside the conversation');

  const folder = (await a('POST', '/api/chat/files-folder')).body.id;
  assert.equal((await a('POST', '/api/chat/files-folder')).body.id, folder, 'the same folder each time');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const pic = (await a('POST', `/api/files/upload?name=photo.png&parent=${folder}`, png, { raw: true })).body;
  const withFile = (await a('POST', `/api/chat/channels/${dm}/messages`, { body: '', files: [pic.id] })).body;
  assert.deepEqual(withFile.files.map((f) => [f.name, f.mime]), [['photo.png', 'image/png']]);
  const got = await b('GET', `/api/chat/messages/${withFile.id}/files/${pic.id}`);
  assert.equal(got.status, 200, 'the other person can open it');
  assert.match(got.headers.get('content-disposition'), /^inline/);
  assert.equal((await x('GET', `/api/chat/messages/${withFile.id}/files/${pic.id}`)).status, 404);
  assert.equal((await b('POST', `/api/chat/channels/${dm}/messages`, { body: 'x', files: [pic.id] })).status, 400, 'only files you can open yourself');
  assert.equal((await a('POST', `/api/chat/channels/${dm}/messages`, { body: '' })).status, 400, 'a message needs text or a file');
});

test('drive: stars, copies, and downloading several files as a zip', async () => {
  const JSZip = (await import('jszip')).default;
  const folder = (await owner('POST', '/api/files/folder', { name: 'Quarter' })).body;
  const txt = (await owner('POST', `/api/files/upload?name=notes.txt&parent=${folder.id}`, 'hello zip', { raw: true })).body;
  const sub = (await owner('POST', '/api/files/folder', { name: 'Inner', parent_id: folder.id })).body;
  await owner('POST', `/api/files/upload?name=deep.txt&parent=${sub.id}`, 'deep', { raw: true });
  const doc = (await owner('POST', '/api/files/new', { kind: 'doc', name: 'Zip plan', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'In the zip' }] }] } })).body;

  assert.deepEqual((await owner('PUT', `/api/files/${doc.id}/star`, { starred: true })).body, { starred: true });
  const starred = (await owner('GET', '/api/files?view=starred')).body;
  assert.deepEqual(starred.map((f) => [f.name, f.starred]), [['Zip plan', true]]);
  assert.equal((await owner('GET', '/api/files?view=mine')).body.find((f) => f.id === doc.id).starred, true, 'shown in other lists too');
  const someone = client();
  assert.equal((await owner('POST', '/api/users', { local: 'zipper', domain: 'acme.com', name: 'Zed Zipper', password: 'password123' })).status, 201);
  await login(someone, 'zipper@acme.com');
  assert.equal((await someone('PUT', `/api/files/${doc.id}/star`, { starred: true })).status, 404, 'only files you can open');

  const copy = (await owner('POST', `/api/files/${txt.id}/copy`)).body;
  assert.equal(copy.name, 'Copy of notes.txt');
  assert.equal(copy.parent_id, folder.id, 'next to the original');
  assert.equal((await owner('GET', `/api/files/${copy.id}/raw`)).body, 'hello zip');
  const docCopy = (await owner('POST', `/api/files/${doc.id}/copy`)).body;
  assert.equal(JSON.stringify((await owner('GET', `/api/files/${docCopy.id}/content`)).body.content).includes('In the zip'), true);

  const z = await owner('GET', `/api/files/zip?ids=${folder.id},${doc.id}`, undefined, { binary: true });
  assert.equal(z.status, 200);
  assert.match(z.headers.get('content-disposition'), /Workspace%20files\.zip/);
  const zip = await JSZip.loadAsync(z.body);
  const names = Object.keys(zip.files).filter((n) => !n.endsWith('/')).sort();
  assert.deepEqual(names, ['Quarter/Copy of notes.txt', 'Quarter/Inner/deep.txt', 'Quarter/notes.txt', 'Zip plan.docx']);
  assert.equal(await zip.file('Quarter/Inner/deep.txt').async('string'), 'deep');
  assert.equal((await zip.file('Zip plan.docx').async('nodebuffer')).subarray(0, 2).toString(), 'PK');
  assert.equal((await someone('GET', `/api/files/zip?ids=${folder.id}`)).status, 404, "not someone else's files");
});

test('activity log: sign-ins, account changes and sharing, for each company\'s admins only', async () => {
  const p = client();
  assert.equal((await owner('POST', '/api/users', { local: 'auditee', domain: 'acme.com', name: 'Audi Tee', password: 'password123' })).status, 201);
  assert.equal((await p('POST', '/api/auth/login', { username: 'auditee@acme.com', password: 'wrong-one' })).status, 401);
  const pid = (await login(p, 'auditee@acme.com')).id;
  await owner('PATCH', `/api/users/${pid}`, { is_admin: false, name: 'Audi Tee Jr' });
  const f = (await owner('POST', '/api/files/folder', { name: 'Audited folder' })).body;
  await owner('PUT', `/api/files/${f.id}/shares`, { shares: [{ user_id: pid, role: 'viewer' }] });
  const log = (await owner('GET', '/api/audit')).body;
  const seen = log.entries.map((e) => `${e.action} ${e.target}`);
  for (const want of ['user.create auditee@acme.com', 'sign-in.failed auditee@acme.com', 'sign-in auditee@acme.com', 'user.update auditee@acme.com', 'file.share Audited folder']) {
    assert.ok(seen.includes(want), `${want} in ${seen.slice(0, 12).join(' | ')}`);
  }
  const share = log.entries.find((e) => e.action === 'file.share' && e.target === 'Audited folder');
  assert.deepEqual(share.details, { with: ['auditee@acme.com (viewer)'] });
  assert.equal(share.actor_name, 'Olivia Owner');
  assert.equal(share.label, 'Changed sharing');
  assert.equal(log.entries.find((e) => e.action === 'sign-in.failed').actor_id, null);
  // Filters and export.
  const only = (await owner('GET', '/api/audit?action=sign-in')).body.entries;
  assert.ok(only.length && only.every((e) => e.action.startsWith('sign-in')));
  assert.ok((await owner('GET', '/api/audit?q=audited')).body.entries.every((e) => /audited/i.test(e.target || '')));
  const csv = await owner('GET', '/api/audit/export?action=file');
  assert.match(csv.body, /^﻿?Time \(UTC\),Who,What,Target,Details,IP address\r\n/);
  assert.match(csv.body, /Changed sharing,Audited folder/);
  // Not for people who aren't admins, nor for another company's admin.
  assert.equal((await p('GET', '/api/audit')).status, 403);
  const ni = await owner('POST', '/api/orgs', { name: 'Audit Co', domain: 'auditco.com', admin_name: 'Ian I', admin_local: 'ian', admin_password: 'password123' });
  assert.equal(ni.status, 201, JSON.stringify(ni.body));
  const g = client();
  await login(g, 'ian@auditco.com');
  const gr = await g('GET', '/api/audit');
  assert.equal(gr.status, 200, JSON.stringify(gr.body));
  const theirs = gr.body.entries;
  assert.ok(!theirs.some((e) => e.target === 'auditee@acme.com'), "Globex doesn't see Acme's activity");
  assert.ok((await g('GET', `/api/audit?org_id=${(await owner('GET', '/api/orgs/current')).body.id}`)).body.entries.every((e) => e.target !== 'auditee@acme.com'), 'and cannot ask for it');
});

test('chat threads: replies beside a message, counted on it; unread only for people in the thread', async () => {
  const a = client(), b = client(), c = client();
  for (const [local, name] of [['thra', 'Thread Ann'], ['thrb', 'Thread Ben'], ['thrc', 'Thread Cat']]) assert.equal((await owner('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).status, 201);
  await login(a, 'thra@acme.com'); await login(b, 'thrb@acme.com'); await login(c, 'thrc@acme.com');
  const ch = (await a('POST', '/api/chat/channels', { name: 'threads-test' })).body.id;
  const unread = async (who) => (await who('GET', '/api/chat/channels')).body.channels.find((x) => x.id === ch).unread;
  const top = (await a('POST', `/api/chat/channels/${ch}/messages`, { body: 'Lunch on Friday?' })).body;
  for (const who of [b, c]) await who('POST', `/api/chat/channels/${ch}/read`);
  const r1 = await b('POST', `/api/chat/channels/${ch}/messages`, { body: 'Yes!', parent_id: top.id });
  assert.equal(r1.status, 201);
  assert.equal(r1.body.parent_id, top.id);
  // A reply to a reply goes in the same thread.
  const r2 = (await a('POST', `/api/chat/channels/${ch}/messages`, { body: 'Great, 12:30', parent_id: r1.body.id })).body;
  assert.equal(r2.parent_id, top.id, "threads don't nest");
  const list = (await c('GET', `/api/chat/channels/${ch}/messages`)).body;
  assert.deepEqual(list.map((m) => m.body), ['Lunch on Friday?'], 'replies are not in the conversation itself');
  assert.equal(list[0].reply_count, 2);
  assert.equal(list[0].last_reply_at, r2.created_at);
  assert.deepEqual(list[0].repliers, ['Thread Ben', 'Thread Ann']);
  const t = (await c('GET', `/api/chat/messages/${top.id}/replies`)).body;
  assert.equal(t.message.body, 'Lunch on Friday?');
  assert.deepEqual(t.replies.map((m) => [m.user_name, m.body]), [['Thread Ben', 'Yes!'], ['Thread Ann', 'Great, 12:30']]);
  assert.equal(await unread(c), 0, "Cat isn't in the thread, so its replies aren't unread for her");
  assert.equal(await unread(b), 1, "Ben replied, so Ann's reply is unread for him");
  // Another conversation's message can't be replied to here; outsiders can't read the thread.
  const other = (await a('POST', '/api/chat/channels', { name: 'threads-other' })).body.id;
  assert.equal((await a('POST', `/api/chat/channels/${other}/messages`, { body: 'x', parent_id: top.id })).status, 400);
  const g = client();
  const made = await owner('POST', '/api/orgs', { name: 'Thread Co', domain: 'threadco.com', admin_name: 'Tia', admin_local: 'tia', admin_password: 'password123' });
  assert.equal(made.status, 201);
  await login(g, 'tia@threadco.com');
  assert.equal((await g('GET', `/api/chat/messages/${top.id}/replies`)).status, 404);
  // Deleting a reply updates the count; deleting the message takes its thread with it.
  await a('DELETE', `/api/chat/messages/${r2.id}`);
  assert.equal((await c('GET', `/api/chat/channels/${ch}/messages`)).body[0].reply_count, 1);
  await a('DELETE', `/api/chat/messages/${top.id}`);
  assert.equal((await c('GET', `/api/chat/messages/${top.id}/replies`)).status, 404);
  assert.equal(await unread(b), 0);
});

test('chat mentions: counted per conversation until read', async () => {
  const a = client(), b = client();
  for (const [local, name] of [['menta', 'Ment Ann'], ['mentb', 'Ment Ben']]) assert.equal((await owner('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).status, 201);
  await login(a, 'menta@acme.com'); await login(b, 'mentb@acme.com');
  const ch = (await a('POST', '/api/chat/channels', { name: 'mentions-test' })).body.id;
  const of = async (who) => (await who('GET', '/api/chat/channels')).body.channels.find((x) => x.id === ch);
  await a('POST', `/api/chat/channels/${ch}/messages`, { body: 'Hi all' });
  await a('POST', `/api/chat/channels/${ch}/messages`, { body: '@MentB@acme.com can you check the numbers?' });
  await a('POST', `/api/chat/channels/${ch}/messages`, { body: 'and @menta@acme.com too' });
  assert.deepEqual([(await of(b)).unread, (await of(b)).mentions], [3, 1], 'mentions match whatever the case');
  assert.equal((await of(a)).mentions, 0, 'mentioning yourself does not count');
  await b('POST', `/api/chat/channels/${ch}/read`);
  assert.equal((await of(b)).mentions, 0);
});

test('tasks: lists, ordering, due dates, done, sharing and assigning', async () => {
  const a = client(), b = client(), c = client();
  for (const [local, name] of [['taska', 'Task Ann'], ['taskb', 'Task Ben'], ['taskc', 'Task Cat']]) assert.equal((await owner('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).status, 201);
  await login(a, 'taska@acme.com');
  const bid = (await login(b, 'taskb@acme.com')).id;
  const cid = (await login(c, 'taskc@acme.com')).id;
  const first = (await a('GET', '/api/tasks/lists')).body;
  assert.deepEqual(first.lists.map((l) => [l.name, l.mine, l.open]), [['My tasks', true, 0]], 'everyone starts with a list');
  assert.equal((await a('GET', '/api/tasks/lists')).body.lists.length, 1, 'only one');
  const list = (await a('POST', '/api/tasks/lists', { name: 'Launch' })).body.id;
  const add = async (title, extra = {}) => (await a('POST', `/api/tasks/lists/${list}/tasks`, { title, ...extra })).body;
  const t1 = await add('Write press release');
  const t2 = await add('Book venue', { due: '2026-12-01' });
  const t3 = await add('Order cake', { at: 'end' });
  const titles = async (who = a) => (await who('GET', `/api/tasks/lists/${list}/tasks`)).body.map((t) => `${t.title}${t.done ? ' ✓' : ''}`);
  assert.deepEqual(await titles(), ['Book venue', 'Write press release', 'Order cake'], 'new on top, or at the end');
  assert.equal((await a('POST', `/api/tasks/lists/${list}/tasks`, { title: 'x', due: '1 Dec' })).status, 400);
  // Drag: between two others.
  await a('PATCH', `/api/tasks/tasks/${t3.id}`, { position: (t2.position + t1.position) / 2 });
  assert.deepEqual(await titles(), ['Book venue', 'Order cake', 'Write press release']);
  // Done goes to the bottom; undone comes back on top.
  await a('PATCH', `/api/tasks/tasks/${t2.id}`, { done: true });
  assert.deepEqual(await titles(), ['Order cake', 'Write press release', 'Book venue ✓']);
  assert.equal((await a('GET', '/api/tasks/lists')).body.lists.find((l) => l.id === list).open, 2);
  await a('PATCH', `/api/tasks/tasks/${t2.id}`, { done: false });
  assert.deepEqual(await titles(), ['Book venue', 'Order cake', 'Write press release']);
  // Not shared yet: Ben can't see it, or be given a task on it.
  assert.equal((await b('GET', `/api/tasks/lists/${list}/tasks`)).status, 404);
  assert.equal((await a('PATCH', `/api/tasks/tasks/${t1.id}`, { assignee_id: bid })).status, 400);
  // Shared with Ben: he sees it, can change it and be given tasks.
  assert.equal((await b('PUT', `/api/tasks/lists/${list}/members`, { user_ids: [cid] })).status, 404, "only the owner shares");
  await a('PUT', `/api/tasks/lists/${list}/members`, { user_ids: [bid] });
  const forBen = (await b('GET', '/api/tasks/lists')).body.lists.find((l) => l.id === list);
  assert.deepEqual([forBen.mine, forBen.owner_name], [false, 'Task Ann']);
  const given = (await a('PATCH', `/api/tasks/tasks/${t1.id}`, { assignee_id: bid, notes: 'Draft by Friday' })).body;
  assert.deepEqual([given.assignee_name, given.notes], ['Task Ben', 'Draft by Friday']);
  await a('PATCH', `/api/tasks/tasks/${t2.id}`, { assignee_id: bid });
  assert.deepEqual((await b('GET', '/api/tasks/assigned')).body.map((t) => [t.title, t.list_name]), [['Book venue', 'Launch'], ['Write press release', 'Launch']], 'with a date first');
  assert.equal((await b('GET', '/api/tasks/lists')).body.assigned, 2);
  // The calendar: Ben's tasks with dates; Ann sees unassigned ones on her lists, not Ben's.
  await a('POST', `/api/tasks/lists/${list}/tasks`, { title: 'Send invites', due: '2026-12-03' });
  const due = async (who, from = '2026-12-01', to = '2026-12-31') => (await who('GET', `/api/tasks/due?from=${from}&to=${to}`)).body.map((t) => t.title);
  assert.deepEqual(await due(b), ['Book venue']);
  assert.deepEqual(await due(a), ['Send invites']);
  assert.deepEqual(await due(a, '2026-12-04', '2026-12-31'), []);
  assert.equal((await a('GET', '/api/tasks/due?from=x&to=y')).status, 400);
  await b('PATCH', `/api/tasks/tasks/${t1.id}`, { done: true });
  assert.ok((await titles()).includes('Write press release ✓'), 'Ben ticked it off');
  // Clear completed; Ben leaves: his tasks are nobody's.
  assert.equal((await a('DELETE', `/api/tasks/lists/${list}/done`)).body.deleted, 1);
  await b('DELETE', `/api/tasks/lists/${list}`);
  assert.equal((await b('GET', `/api/tasks/lists/${list}/tasks`)).status, 404);
  assert.equal((await a('GET', `/api/tasks/lists/${list}/tasks`)).body.find((t) => t.id === t2.id).assignee_id, null);
  // Move a task to another list; delete a list with its tasks.
  const mine = first.lists[0].id;
  await a('PATCH', `/api/tasks/tasks/${t3.id}`, { list_id: mine });
  assert.deepEqual((await a('GET', `/api/tasks/lists/${mine}/tasks`)).body.map((t) => t.title), ['Order cake']);
  assert.equal((await c('PATCH', `/api/tasks/tasks/${t3.id}`, { title: 'hijack' })).status, 404);
  await a('DELETE', `/api/tasks/lists/${list}`);
  assert.equal((await a('GET', `/api/tasks/lists/${list}/tasks`)).status, 404);
});

test('tasks: repeating tasks come back when ticked off, and Undo takes the next one away', async () => {
  const a = client();
  assert.equal((await owner('POST', '/api/users', { local: 'taskr', domain: 'acme.com', name: 'Task Rep', password: 'password123' })).status, 201);
  await login(a, 'taskr@acme.com');
  const list = (await a('POST', '/api/tasks/lists', { name: 'Chores' })).body.id;
  const tasks = async () => (await a('GET', `/api/tasks/lists/${list}/tasks`)).body;
  assert.equal((await a('POST', `/api/tasks/lists/${list}/tasks`, { title: 'Bins', repeat: 'weekly' })).status, 400, 'needs a date');
  assert.equal((await a('POST', `/api/tasks/lists/${list}/tasks`, { title: 'Bins', due: '2026-11-02', repeat: 'hourly' })).status, 400);
  const bins = (await a('POST', `/api/tasks/lists/${list}/tasks`, { title: 'Bins', notes: 'Green one', due: '2026-11-02', repeat: 'weekly' })).body;
  assert.equal(bins.repeat, 'weekly');
  // Ticked off late: the next is the first Monday from today on, with the same notes.
  const done = (await a('PATCH', `/api/tasks/tasks/${bins.id}`, { done: true, today: '2026-11-07' })).body;
  assert.ok(done.done && done.next_id);
  let all = await tasks();
  const next = all.find((t) => !t.done);
  assert.deepEqual([next.title, next.notes, next.due, next.repeat, next.id], ['Bins', 'Green one', '2026-11-09', 'weekly', done.next_id]);
  // Ticking it again (already done) makes no second copy.
  await a('PATCH', `/api/tasks/tasks/${bins.id}`, { done: true, today: '2026-11-07' });
  assert.equal((await tasks()).length, 2);
  // Undo: the next one goes away.
  await a('PATCH', `/api/tasks/tasks/${bins.id}`, { done: false });
  all = await tasks();
  assert.deepEqual(all.map((t) => [t.title, t.done, t.due]), [['Bins', false, '2026-11-02']]);
  // …but not once someone has changed it.
  await a('PATCH', `/api/tasks/tasks/${bins.id}`, { done: true, today: '2026-11-07' });
  const n2 = (await tasks()).find((t) => !t.done);
  await a('PATCH', `/api/tasks/tasks/${n2.id}`, { notes: 'Green and blue' });
  await a('PATCH', `/api/tasks/tasks/${bins.id}`, { done: false });
  assert.equal((await tasks()).length, 2);
  // Clearing the date stops it repeating; a repeat can't be set without one.
  const cleared = (await a('PATCH', `/api/tasks/tasks/${n2.id}`, { due: null })).body;
  assert.equal(cleared.repeat, null);
  assert.equal((await a('PATCH', `/api/tasks/tasks/${n2.id}`, { repeat: 'daily' })).status, 400);
  // A task that doesn't repeat just gets done.
  const once = (await a('POST', `/api/tasks/lists/${list}/tasks`, { title: 'Once', due: '2026-11-07' })).body;
  await a('PATCH', `/api/tasks/tasks/${once.id}`, { done: true });
  assert.equal((await tasks()).filter((t) => t.title === 'Once').length, 1);
});

test('search filters: kind of file, whose it is, and when it changed', async () => {
  const { q } = await import('../src/db.js');
  const tag = `flt${Date.now() % 100000}`;
  const mk = async (who, name, extra = {}) => (await who('POST', '/api/files/new', { kind: 'doc', name, ...extra })).body;
  const d = await mk(owner, `${tag} notes`);
  const s = await mk(owner, `${tag} budget`, { kind: 'sheet' });
  const folder = (await owner('POST', '/api/files/folder', { name: `${tag} folder` })).body;
  const pdf = (await owner('POST', `/api/files/upload?name=${tag}-report.pdf`, Buffer.from('%PDF-1.4'), { raw: true, headers: { 'content-type': 'application/pdf' } })).body;
  const old = await mk(owner, `${tag} old plan`);
  q('UPDATE files SET updated_at = ? WHERE id = ?').run(Date.now() - 40 * 864e5, old.id);
  // A colleague shares one of theirs with the owner.
  const pal = client();
  assert.equal((await owner('POST', '/api/users', { local: 'filterpal', domain: 'acme.com', name: 'Filter Pal', password: 'password123' })).status, 201);
  await login(pal, 'filterpal@acme.com');
  const bobs = await mk(pal, `${tag} from bob`);
  await pal('PUT', `/api/files/${bobs.id}/shares`, { shares: [{ user_id: (await owner('GET', '/api/auth/me')).body.user.id, role: 'viewer' }] });
  const find = async (params) => (await owner('GET', `/api/files?view=search&q=${tag}&${params}`)).body.map((f) => f.name).sort();
  assert.deepEqual(await find('type=doc'), [`${tag} from bob`, `${tag} notes`, `${tag} old plan`]);
  assert.deepEqual(await find('type=sheet'), [`${tag} budget`]);
  assert.deepEqual(await find('type=folder'), [`${tag} folder`]);
  assert.deepEqual(await find('type=pdf'), [`${tag}-report.pdf`]);
  assert.deepEqual(await find('owner=others'), [`${tag} from bob`]);
  assert.deepEqual(await find('type=doc&owner=me&modified=30'), [`${tag} notes`]);
  assert.equal((await find('modified=30')).includes(`${tag} old plan`), false);
  assert.equal((await owner('GET', '/api/files?view=search&q=&type=pdf')).body.some((f) => f.id === pdf.id), true, 'filters work without words');
  assert.equal((await owner('GET', `/api/files?view=search&q=${tag}&type=nope`)).status, 400);
  void d; void s; void folder;
});

test('booking pages: free times around busy ones; booking puts it on the calendar; taken times refused', async () => {
  const a = client(), outsider = client();
  assert.equal((await owner('POST', '/api/users', { local: 'booker', domain: 'acme.com', name: 'Bea Booker', password: 'password123' })).status, 201);
  await login(a, 'booker@acme.com');
  assert.equal((await a('POST', '/api/bookings', { title: 'Chat', duration: 7 })).status, 400);
  const page = (await a('POST', '/api/bookings', { title: 'Intro call', duration: 30, days: [0, 1, 2, 3, 4, 5, 6], from_min: 0, to_min: 1440, tz: 'UTC', notice_hours: 0, days_ahead: 2 })).body;
  assert.match(page.url, /\/b\/[\w-]+$/);
  const token = page.url.split('/b/')[1];
  const pub = (await outsider('GET', `/api/public/book/${token}`)).body;
  assert.equal(pub.title, 'Intro call');
  assert.equal(pub.owner.name, 'Bea Booker');
  const all = pub.days.flatMap((d) => d.slots);
  assert.ok(all.length > 40);
  // A busy event takes its times away.
  const busyAt = all[5];
  await a('POST', '/api/events', { title: 'Dentist', start: busyAt, end: busyAt + 36e5 });
  const after = (await outsider('GET', `/api/public/book/${token}`)).body.days.flatMap((d) => d.slots);
  assert.ok(!after.includes(busyAt) && !after.includes(busyAt + 18e5), 'busy times are not offered');
  // Book one.
  const slot = after[0];
  assert.equal((await outsider('POST', `/api/public/book/${token}`, { start: slot, name: 'Oscar Out', email: 'not-an-email' })).status, 400);
  const b = await outsider('POST', `/api/public/book/${token}`, { start: slot, name: 'Oscar Out', email: 'oscar@example.org', note: 'About the quote' });
  assert.equal(b.status, 201, JSON.stringify(b.body));
  const ev = (await a('GET', `/api/events?from=${slot - 1}&to=${slot + 36e5}`)).body.find((e) => e.title === 'Intro call: Oscar Out');
  assert.ok(ev, 'on the calendar');
  assert.equal(ev.end - ev.start, 30 * 6e4);
  assert.match(ev.description, /oscar@example.org/);
  assert.match(ev.description, /About the quote/);
  assert.deepEqual(ev.guests.map((g) => [g.email, g.status]), [['oscar@example.org', 'yes']]);
  assert.equal((await outsider('POST', `/api/public/book/${token}`, { start: slot, name: 'Second', email: 'two@example.org' })).status, 409, 'now taken');
  assert.equal((await a('GET', '/api/bookings')).body[0].bookings, 1);
  // Turned off, or someone else's: not available / not changeable.
  assert.equal((await owner('PATCH', `/api/bookings/${page.id}`, { enabled: false })).status, 404);
  await a('PATCH', `/api/bookings/${page.id}`, { enabled: false });
  assert.equal((await outsider('GET', `/api/public/book/${token}`)).status, 404);
  await a('DELETE', `/api/bookings/${page.id}`);
  assert.deepEqual((await a('GET', '/api/bookings')).body, []);
});

test('page setup: kept with a document, checked, and only for documents', async () => {
  const d = (await owner('POST', '/api/files/new', { kind: 'doc', name: 'Letterhead' })).body;
  assert.equal(d.page_setup, null);
  const set = await owner('PATCH', `/api/files/${d.id}`, { page_setup: { size: 'letter', orientation: 'landscape', margin: 'wide', header: 'Acme\nTrading', numbers: true } });
  assert.deepEqual(set.body.page_setup, { size: 'letter', orientation: 'landscape', margin: 'wide', header: 'Acme Trading', footer: '', numbers: true });
  assert.deepEqual((await owner('GET', `/api/files/${d.id}`)).body.page_setup.size, 'letter');
  assert.equal((await owner('PATCH', `/api/files/${d.id}`, { page_setup: { size: 'a3' } })).status, 400);
  assert.equal((await owner('PATCH', `/api/files/${d.id}`, { page_setup: { header: 'x'.repeat(201) } })).status, 400);
  const s = (await owner('POST', '/api/files/new', { kind: 'sheet', name: 'Not a doc' })).body;
  assert.equal((await owner('PATCH', `/api/files/${s.id}`, { page_setup: {} })).status, 400);
  assert.equal((await owner('PATCH', `/api/files/${d.id}`, { page_setup: null })).body.page_setup, null, 'back to the default');
});

test('contact groups: made, changed, suggested in Mail with everyone in them, only your own', async () => {
  const g = await owner('POST', '/api/contacts/groups', { name: 'Board', members: [{ name: 'Ann Board', email: 'Ann@Example.org' }, { email: 'ben@example.org' }, { email: 'ann@example.org' }] });
  assert.equal(g.status, 201);
  assert.deepEqual(g.body.members, [{ name: 'Ann Board', email: 'ann@example.org' }, { name: '', email: 'ben@example.org' }], 'addresses kept once, in small letters');
  assert.equal((await owner('POST', '/api/contacts/groups', { name: 'board' })).status, 400, 'names are unique');
  assert.equal((await owner('POST', '/api/contacts/groups', { name: 'Bad', members: [{ email: 'nope' }] })).status, 400);
  const s = (await owner('GET', '/api/contacts/suggest?q=boa')).body;
  assert.equal(s[0].kind, 'group');
  assert.equal(s[0].name, 'Board');
  assert.equal(s[0].members.length, 2);
  await owner('PATCH', `/api/contacts/groups/${g.body.id}`, { name: 'Board members', members: [{ email: 'cat@example.org' }] });
  assert.deepEqual((await owner('GET', '/api/contacts/groups')).body.find((x) => x.id === g.body.id).members, [{ name: '', email: 'cat@example.org' }]);
  const other = client();
  assert.equal((await owner('POST', '/api/users', { local: 'grouper', domain: 'acme.com', name: 'Gus Grouper', password: 'password123' })).status, 201);
  await login(other, 'grouper@acme.com');
  assert.equal((await other('PATCH', `/api/contacts/groups/${g.body.id}`, { name: 'x' })).status, 404);
  assert.ok(!(await other('GET', '/api/contacts/suggest?q=board')).body.some((x) => x.kind === 'group'));
  await owner('DELETE', `/api/contacts/groups/${g.body.id}`);
  assert.ok(!(await owner('GET', '/api/contacts/groups')).body.some((x) => x.id === g.body.id));
});

test('chat channels: private ones only for members, topics, archiving, and who may change them', async () => {
  const a = client(), b = client(), c = client();
  for (const [local, name] of [['chana', 'Chan Ann'], ['chanb', 'Chan Ben'], ['chanc', 'Chan Cat']]) assert.equal((await owner('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).status, 201);
  await login(a, 'chana@acme.com');
  const bid = (await login(b, 'chanb@acme.com')).id;
  const cid = (await login(c, 'chanc@acme.com')).id;
  const listOf = async (who) => (await who('GET', '/api/chat/channels')).body.channels;
  const priv = (await a('POST', '/api/chat/channels', { name: 'board-only', private: true, members: [bid], topic: 'Board business' })).body.id;
  assert.ok((await listOf(b)).some((x) => x.id === priv && x.private && x.topic === 'Board business'));
  assert.ok(!(await listOf(c)).some((x) => x.id === priv), 'not for people outside it');
  assert.equal((await c('GET', `/api/chat/channels/${priv}/messages`)).status, 404);
  assert.equal((await c('POST', `/api/chat/channels/${priv}/messages`, { body: 'hi' })).status, 404);
  assert.deepEqual((await a('GET', `/api/chat/channels/${priv}/members`)).body.map((m) => m.name), ['Chan Ann', 'Chan Ben']);
  // Ben adds Cat; Ben can't take Ann off; Cat leaves.
  await b('POST', `/api/chat/channels/${priv}/members`, { user_ids: [cid] });
  assert.ok((await listOf(c)).some((x) => x.id === priv));
  assert.equal((await b('DELETE', `/api/chat/channels/${priv}/members/${(await a('GET', '/api/auth/me')).body.user.id}`)).status, 403);
  await c('DELETE', `/api/chat/channels/${priv}/members/me`);
  assert.ok(!(await listOf(c)).some((x) => x.id === priv));
  assert.equal((await a('POST', '/api/chat/channels', { name: 'x', private: true, members: [ginaId] })).status, 400, 'only colleagues');
  // Topic by anyone in it; rename and archive by the maker.
  await b('PATCH', `/api/chat/channels/${priv}`, { topic: 'Board meetings and papers' });
  assert.equal((await listOf(a)).find((x) => x.id === priv).topic, 'Board meetings and papers');
  assert.equal((await b('PATCH', `/api/chat/channels/${priv}`, { archived: true })).status, 403);
  await a('PATCH', `/api/chat/channels/${priv}`, { archived: true, name: 'board-2026' });
  const arch = (await listOf(b)).find((x) => x.id === priv);
  assert.ok(arch.archived_at && arch.name === 'board-2026');
  assert.equal((await b('POST', `/api/chat/channels/${priv}/messages`, { body: 'late' })).status, 400, 'read-only when archived');
  await a('PATCH', `/api/chat/channels/${priv}`, { archived: false });
  assert.equal((await b('POST', `/api/chat/channels/${priv}/messages`, { body: 'back' })).status, 201);
  // The company-wide channel stays open.
  const general = (await listOf(a)).find((x) => x.name === 'general');
  assert.equal((await owner('PATCH', `/api/chat/channels/${general.id}`, { private: true })).status, 400);
  // A public channel made private keeps those who wrote in it.
  const pub = (await a('POST', '/api/chat/channels', { name: 'was-public' })).body.id;
  await c('POST', `/api/chat/channels/${pub}/messages`, { body: 'hello' });
  await a('PATCH', `/api/chat/channels/${pub}`, { private: true });
  assert.ok((await listOf(c)).some((x) => x.id === pub), 'Cat wrote there');
  assert.ok(!(await listOf(b)).some((x) => x.id === pub), 'Ben never did');
});

test('notifications: mentions, tasks, invitations and shares land in the bell; read one or all', async () => {
  const a = client(), b = client();
  for (const [local, name] of [['bella', 'Bell Ann'], ['bellb', 'Bell Ben']]) assert.equal((await owner('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).status, 201);
  await login(a, 'bella@acme.com');
  const bid = (await login(b, 'bellb@acme.com')).id;
  const bell = async () => (await b('GET', '/api/notifications')).body;
  assert.equal((await bell()).unread, 0);
  // A chat mention.
  const ch = (await a('POST', '/api/chat/channels', { name: 'bell-test' })).body.id;
  await a('POST', `/api/chat/channels/${ch}/messages`, { body: 'Ping @bellb@acme.com please' });
  // A task given to Ben.
  const list = (await a('POST', '/api/tasks/lists', { name: 'Bell list' })).body.id;
  await a('PUT', `/api/tasks/lists/${list}/members`, { user_ids: [bid] });
  await a('POST', `/api/tasks/lists/${list}/tasks`, { title: 'Ring it', assignee_id: bid });
  // An invitation.
  await a('POST', '/api/events', { title: 'Bell meeting', start: Date.now() + 864e5, end: Date.now() + 864e5 + 36e5, guests: ['bellb@acme.com'] });
  // A shared document.
  const doc = (await a('POST', '/api/files/new', { kind: 'doc', name: 'Bell notes' })).body;
  await a('PUT', `/api/files/${doc.id}/shares`, { shares: [{ user_id: bid, role: 'editor' }] });
  await a('PUT', `/api/files/${doc.id}/shares`, { shares: [{ user_id: bid, role: 'viewer' }] }); // a change, not a new share
  const n = await bell();
  assert.deepEqual(n.items.map((x) => x.kind), ['share', 'invite', 'task', 'mention']);
  assert.equal(n.unread, 4);
  assert.equal(n.items[0].title, 'Bell Ann shared “Bell notes” with you');
  assert.equal(n.items[0].link, `/docs/${doc.id}`);
  assert.equal(n.items[2].link.startsWith(`/tasks/${list}?task=`), true);
  assert.equal(n.items[3].link, `/chat/${ch}`);
  assert.equal((await a('GET', '/api/notifications')).body.unread, 0, 'nothing for the one who did it');
  assert.equal((await b('POST', '/api/notifications/read', { ids: [n.items[0].id] })).body.unread, 3);
  assert.equal((await b('POST', '/api/notifications/read', { all: true })).body.unread, 0);
  assert.equal((await b('POST', '/api/notifications/read', {})).status, 400);
});

test('named versions: name the current state, name or un-name an earlier one, see its content', async () => {
  const d = (await owner('POST', '/api/files/new', { kind: 'sheet', name: 'Forecast', content: { sheets: [{ name: 'Sheet1', cells: { A1: 'v1' } }] } })).body;
  const named = await owner('POST', `/api/files/${d.id}/versions/name`, { label: 'Sent to the bank' });
  assert.equal(named.status, 201);
  assert.equal((await owner('POST', `/api/files/${d.id}/versions/name`, { label: '' })).status, 400);
  const list = (await owner('GET', `/api/files/${d.id}/versions`)).body;
  assert.equal(list[0].label, 'Sent to the bank');
  const content = (await owner('GET', `/api/files/${d.id}/versions/${named.body.id}/content`)).body.content;
  assert.equal(content.sheets[0].cells.A1, 'v1');
  assert.equal((await owner('PATCH', `/api/files/${d.id}/versions/${named.body.id}`, { label: 'Final' })).body.label, 'Final');
  assert.equal((await owner('PATCH', `/api/files/${d.id}/versions/${named.body.id}`, { label: '' })).body.label, null);
  const other = client();
  assert.equal((await owner('POST', '/api/users', { local: 'verpal', domain: 'acme.com', name: 'Ver Pal', password: 'password123' })).status, 201);
  await login(other, 'verpal@acme.com');
  assert.equal((await other('PATCH', `/api/files/${d.id}/versions/${named.body.id}`, { label: 'x' })).status, 404, 'not for people without access');
});

test('storage report: per person (files, versions, trash), largest files, admins only', async () => {
  const p = client();
  assert.equal((await owner('POST', '/api/users', { local: 'hoarder', domain: 'acme.com', name: 'Hal Hoarder', password: 'password123' })).status, 201);
  await login(p, 'hoarder@acme.com');
  const big = Buffer.alloc(300_000, 7);
  const f = (await p('POST', '/api/files/upload?name=huge-scan.bin', big, { raw: true })).body;
  await p('POST', `/api/files/${f.id}/versions?name=huge-scan.bin`, Buffer.alloc(100_000, 1), { raw: true }); // the 300 KB becomes a version
  const t = (await p('POST', '/api/files/upload?name=old.bin', Buffer.alloc(50_000, 2), { raw: true })).body;
  await p('PATCH', `/api/files/${t.id}`, { trashed: true });
  const r = (await owner('GET', '/api/orgs/current/storage')).body;
  const hal = r.people.find((x) => x.username === 'hoarder@acme.com');
  assert.deepEqual([hal.files, hal.versions, hal.trash, hal.count, hal.total], [100_000, 300_000, 50_000, 2, 450_000]);
  assert.ok(r.used >= 450_000);
  const top = r.largest.find((x) => x.id === f.id);
  assert.equal(top.versions_size, 300_000);
  assert.equal(top.owner_name, 'Hal Hoarder');
  assert.ok(r.largest.find((x) => x.id === t.id).trashed);
  assert.equal((await p('GET', '/api/orgs/current/storage')).status, 403);
});

test('branding: colour and logo for the company, shown on its sign-in page by domain', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  assert.equal((await owner('PATCH', '/api/orgs/current', { accent: 'red' })).status, 400);
  await owner('PATCH', '/api/orgs/current', { accent: '#0B8043' });
  assert.equal((await owner('PUT', '/api/orgs/current/logo', Buffer.from('<svg onload="alert(1)"/>'), { raw: true, headers: { 'content-type': 'image/svg+xml' } })).status, 400, 'no SVG');
  const up = await owner('PUT', '/api/orgs/current/logo', png, { raw: true, headers: { 'content-type': 'image/png' } });
  assert.equal(up.status, 200);
  const me = (await owner('GET', '/api/auth/me')).body.user;
  assert.equal(me.org_accent, '#0b8043');
  assert.match(me.org_logo, /^\/api\/public\/brand\/logo\//);
  const anyone = client();
  const logo = await anyone('GET', me.org_logo, undefined, { binary: true });
  assert.equal(logo.status, 200);
  assert.equal(logo.headers?.get?.('content-type') ?? 'image/png', 'image/png');
  // The sign-in page at workspace.acme.com shows Acme.
  const { brandForHost } = await import('../src/routes/brand.js');
  assert.equal(brandForHost('workspace.acme.com:8080').accent, '#0b8043');
  assert.equal(brandForHost('acme.com').name, (await owner('GET', '/api/orgs/current')).body.name);
  assert.equal(brandForHost('example.net'), null);
  assert.equal(brandForHost('notacme.com'), null, 'whole domain names only');
  assert.ok('brand' in (await anyone('GET', '/api/public/brand')).body);
  // Not for people who aren't admins.
  const p = client();
  assert.equal((await owner('POST', '/api/users', { local: 'brandpal', domain: 'acme.com', name: 'Brand Pal', password: 'password123' })).status, 201);
  await login(p, 'brandpal@acme.com');
  assert.equal((await p('PUT', '/api/orgs/current/logo', png, { raw: true, headers: { 'content-type': 'image/png' } })).status, 403);
  await owner('DELETE', '/api/orgs/current/logo');
  await owner('PATCH', '/api/orgs/current', { accent: null });
  assert.equal((await owner('GET', '/api/auth/me')).body.user.org_logo, null);
});

test('drive: folder colours and descriptions (found by search)', async () => {
  const folder = (await owner('POST', '/api/files/folder', { name: 'Colourful' })).body;
  const doc = (await owner('POST', '/api/files/new', { kind: 'doc', name: 'Plain name' })).body;
  assert.equal((await owner('PATCH', `/api/files/${folder.id}`, { color: '#D93025' })).body.color, '#d93025');
  assert.equal((await owner('PATCH', `/api/files/${folder.id}`, { color: 'red' })).status, 400);
  assert.equal((await owner('PATCH', `/api/files/${doc.id}`, { color: '#d93025' })).status, 400, 'only folders');
  const d = (await owner('PATCH', `/api/files/${doc.id}`, { description: 'Quarterly zebra figures for the board' })).body;
  assert.equal(d.description, 'Quarterly zebra figures for the board');
  assert.ok((await owner('GET', '/api/files?view=search&q=zebra')).body.some((f) => f.id === doc.id), 'found by its description');
  assert.equal((await owner('PATCH', `/api/files/${doc.id}`, { description: '' })).body.description, null);
  assert.equal((await owner('GET', '/api/files')).body.find((f) => f.id === folder.id).color, '#d93025');
});

test('out of office: invitations then are declined for you, the organizer is told; shown as away in free/busy', async () => {
  const a = client(), b = client();
  for (const [local, name] of [['oooa', 'Away Ann'], ['ooob', 'Ooo Ben']]) assert.equal((await owner('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).status, 201);
  const aid = (await login(a, 'oooa@acme.com')).id;
  await login(b, 'ooob@acme.com');
  const day = Date.now() + 10 * 864e5 - (Date.now() % 864e5); // a midnight (UTC) ten days on
  const away = (await a('POST', '/api/events', { title: 'Out of office', description: 'On holiday, back on the 4th', kind: 'ooo', all_day: 1, start: day, end: day + 3 * 864e5 - 1, guests: ['ooob@acme.com'] })).body;
  assert.equal(away.kind, 'ooo');
  assert.deepEqual(away.guests, [], 'no guests on time off');
  assert.equal((await a('POST', '/api/events', { title: 'x', kind: 'party', start: day, end: day + 1 })).status, 400);
  const during = (await b('POST', '/api/events', { title: 'Budget review', start: day + 864e5 + 10 * 36e5, end: day + 864e5 + 11 * 36e5, guests: ['oooa@acme.com'] })).body;
  assert.equal(during.guests.find((g) => g.email === 'oooa@acme.com').status, 'no');
  const bell = (await b('GET', '/api/notifications')).body.items;
  assert.ok(bell.some((n) => n.title === 'Away Ann is out of office and declined “Budget review”' && n.body === 'On holiday, back on the 4th'), JSON.stringify(bell.map((n) => n.title)));
  const after = (await b('POST', '/api/events', { title: 'Catch-up', start: day + 4 * 864e5, end: day + 4 * 864e5 + 36e5, guests: ['oooa@acme.com'] })).body;
  assert.equal(after.guests.find((g) => g.email === 'oooa@acme.com').status, 'needs', 'after the time off');
  // Added later to an event during it: declined too.
  const later = (await b('POST', '/api/events', { title: 'Planning', start: day + 2 * 36e5, end: day + 3 * 36e5 })).body;
  const patched = (await b('PATCH', `/api/events/${later.id}`, { guests: ['oooa@acme.com'] })).body;
  assert.equal(patched.guests[0].status, 'no');
  // They can still say yes themselves.
  assert.equal((await a('POST', `/api/events/${later.id}/rsvp`, { status: 'yes' })).status, 200);
  // Free/busy: the whole time off, marked as away, all-day or not.
  const fb = (await b('GET', `/api/freebusy?users=${aid}&from=${day}&to=${day + 5 * 864e5}`)).body;
  assert.ok(fb[aid].busy.some((x) => x.ooo && x.start === day && x.end === day + 3 * 864e5 - 1), JSON.stringify(fb[aid].busy));
  assert.ok(!JSON.stringify(fb).includes('holiday'), 'no details');
  // Turning it into an ordinary event.
  assert.equal((await a('PATCH', `/api/events/${away.id}`, { kind: null })).body.kind, null);
});

test('find a time: the first slots in working hours when everyone is free', async () => {
  const a = client(), b = client();
  for (const [local, name] of [['fta', 'Find Ann'], ['ftb', 'Find Ben']]) assert.equal((await owner('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).status, 201);
  await login(a, 'fta@acme.com');
  const bid = (await login(b, 'ftb@acme.com')).id;
  // A Monday at least a week ahead, midnight UTC.
  const d = new Date(Date.now() + 8 * 864e5); d.setUTCHours(0, 0, 0, 0);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  const mon = d.getTime(), h = 36e5;
  await a('POST', '/api/events', { title: 'Ann busy', start: mon + 9 * h, end: mon + 10 * h });
  await b('POST', '/api/events', { title: 'Ben busy', start: mon + 10 * h, end: mon + 11.5 * h });
  await b('POST', '/api/events', { title: 'Ben all day', all_day: 1, start: mon, end: mon + 864e5 - 1 }); // all-day events don't block
  const r = (await a('GET', `/api/freebusy/suggest?users=${bid}&duration=60&tz=UTC&from=${mon}`)).body;
  assert.equal(r.people, 2);
  assert.deepEqual(r.slots.slice(0, 3).map((x) => (x.start - mon) / h), [11.5, 12, 12.5]);
  assert.equal(r.slots[0].end - r.slots[0].start, h);
  assert.equal(r.slots.length, 8);
  // Alone: 10:00 is free for Ann.
  assert.equal(((await a('GET', `/api/freebusy/suggest?duration=60&tz=UTC&from=${mon}`)).body.slots[0].start - mon) / h, 10);
  // Late in the day it moves on to the next working day; a Friday afternoon skips the weekend.
  const fri = mon + 4 * 864e5;
  const late = (await a('GET', `/api/freebusy/suggest?duration=120&tz=UTC&from=${fri + 16 * h}`)).body.slots[0].start;
  assert.equal(late, mon + 7 * 864e5 + 9 * h);
  assert.equal((await a('GET', '/api/freebusy/suggest?duration=5')).status, 400);
});

test('free/busy: colleagues’ busy times without details; not other companies', async () => {
  const a = client();
  assert.equal((await owner('POST', '/api/users', { local: 'busybee', domain: 'acme.com', name: 'Busy Bee', password: 'password123' })).status, 201);
  const aid = (await login(a, 'busybee@acme.com')).id;
  const t = Date.now() + 2 * 864e5;
  await a('POST', '/api/events', { title: 'Secret interview', location: 'Room 4', start: t, end: t + 36e5 });
  await a('POST', '/api/events', { title: 'Every morning', start: t + 864e5, end: t + 864e5 + 18e5, rrule: { freq: 'daily', count: 3 } });
  const r = (await owner('GET', `/api/freebusy?users=${aid},${ginaId}&from=${t - 36e5}&to=${t + 5 * 864e5}`)).body;
  assert.equal(r[aid].name, 'Busy Bee');
  assert.deepEqual(r[aid].busy[0], { start: t, end: t + 36e5 });
  assert.equal(r[aid].busy.length, 4, 'repeating ones too');
  assert.ok(!JSON.stringify(r).includes('Secret'), 'no titles');
  assert.equal(r[ginaId], undefined, 'not other companies');
  assert.equal((await owner('GET', `/api/freebusy?users=${aid}&from=0&to=${100 * 864e5}`)).status, 400);
});

test('chat search: all the words, in conversations you can see (threads too); jump to a message', async () => {
  const a = client(), b = client();
  for (const [local, name] of [['seeka', 'Seek Ann'], ['seekb', 'Seek Ben']]) assert.equal((await owner('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).status, 201);
  await login(a, 'seeka@acme.com'); await login(b, 'seekb@acme.com');
  const open = (await a('POST', '/api/chat/channels', { name: 'seek-open' })).body.id;
  const priv = (await a('POST', '/api/chat/channels', { name: 'seek-private', private: true })).body.id;
  const m1 = (await a('POST', `/api/chat/channels/${open}/messages`, { body: 'The flamingo invoice is late' })).body;
  for (let i = 0; i < 120; i++) await a('POST', `/api/chat/channels/${open}/messages`, { body: `filler ${i}` });
  await a('POST', `/api/chat/channels/${open}/messages`, { body: 'Flamingo reply in thread', parent_id: m1.id });
  await a('POST', `/api/chat/channels/${priv}/messages`, { body: 'secret flamingo plans' });
  const found = (await b('GET', '/api/chat/search?q=FLAMINGO')).body;
  assert.deepEqual(found.map((x) => x.body), ['Flamingo reply in thread', 'The flamingo invoice is late'], 'not the private channel Ben is not in');
  assert.equal(found[0].parent_id, m1.id);
  assert.equal(found[1].where, '#seek-open');
  assert.equal((await a('GET', '/api/chat/search?q=flamingo plans')).body.length, 1, 'all the words');
  assert.deepEqual((await b('GET', '/api/chat/search?q=')).body, []);
  // Jump: the message and those around it (it's older than the latest 100).
  const around = (await b('GET', `/api/chat/channels/${open}/messages?around=${m1.id}`)).body;
  assert.equal(around[0].id, m1.id);
  assert.equal(around.length, 50);
});

test('chat pins: anyone in the conversation pins and unpins; replies cannot be; outsiders see nothing', async () => {
  const a = client(), b = client(), c = client();
  for (const [local, name] of [['pina', 'Pin Ann'], ['pinb', 'Pin Ben'], ['pinc', 'Pin Cat']]) assert.equal((await owner('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).status, 201);
  await login(a, 'pina@acme.com');
  const bid = (await login(b, 'pinb@acme.com')).id;
  await login(c, 'pinc@acme.com');
  const ch = (await a('POST', '/api/chat/channels', { name: 'pin-private', private: true, members: [bid] })).body.id;
  const m1 = (await a('POST', `/api/chat/channels/${ch}/messages`, { body: 'Wifi password is on the fridge' })).body;
  const m2 = (await a('POST', `/api/chat/channels/${ch}/messages`, { body: 'Standup moved to 10:00' })).body;
  const reply = (await b('POST', `/api/chat/channels/${ch}/messages`, { body: 'thanks', parent_id: m1.id })).body;
  const pinned = (await b('POST', `/api/chat/messages/${m1.id}/pin`, {})).body;
  assert.ok(pinned.pinned_at);
  assert.equal(pinned.pinned_by_name, 'Pin Ben');
  await new Promise((r) => setTimeout(r, 5));
  await a('POST', `/api/chat/messages/${m2.id}/pin`, {});
  assert.deepEqual((await a('GET', `/api/chat/channels/${ch}/pins`)).body.map((m) => m.body), ['Standup moved to 10:00', 'Wifi password is on the fridge'], 'latest pinned first');
  assert.ok((await a('GET', `/api/chat/channels/${ch}/messages`)).body.find((m) => m.id === m1.id).pinned_at, 'shown on the message');
  assert.equal((await a('POST', `/api/chat/messages/${reply.id}/pin`, {})).status, 400);
  assert.equal((await c('POST', `/api/chat/messages/${m1.id}/pin`, {})).status, 404, 'not in the private channel');
  assert.equal((await c('GET', `/api/chat/channels/${ch}/pins`)).status, 404);
  await a('POST', `/api/chat/messages/${m1.id}/pin`, { pinned: false });
  assert.deepEqual((await b('GET', `/api/chat/channels/${ch}/pins`)).body.map((m) => m.body), ['Standup moved to 10:00']);
  // Archived channels are read-only, pins included.
  await a('PATCH', `/api/chat/channels/${ch}`, { archived: true });
  assert.equal((await a('POST', `/api/chat/messages/${m2.id}/pin`, { pinned: false })).status, 400);
});

test('drive activity: who made, edited, renamed, moved, shared, trashed and restored a file', async () => {
  const a = client(), b = client(), c = client();
  for (const [local, name] of [['acta', 'Act Ann'], ['actb', 'Act Ben'], ['actc', 'Act Cat']]) assert.equal((await owner('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).status, 201);
  await login(a, 'acta@acme.com');
  const bid = (await login(b, 'actb@acme.com')).id;
  await login(c, 'actc@acme.com');
  const doc = (await a('POST', '/api/files/new', { kind: 'doc', name: 'Plan' })).body;
  const folder = (await a('POST', '/api/files/folder', { name: 'Projects' })).body;
  const v1 = (await a('PUT', `/api/files/${doc.id}/content`, { version: doc.version, content: { type: 'doc', content: [] } })).body.version;
  await a('PUT', `/api/files/${doc.id}/content`, { version: v1, content: { type: 'doc', content: [{ type: 'paragraph' }] } }); // same person, same hour: one entry
  await a('PATCH', `/api/files/${doc.id}`, { name: 'Plan 2027' });
  await a('PATCH', `/api/files/${doc.id}`, { parent_id: folder.id });
  await a('PUT', `/api/files/${doc.id}/shares`, { shares: [{ user_id: bid, role: 'editor' }] });
  const cur = (await b('GET', `/api/files/${doc.id}`)).body;
  await b('PUT', `/api/files/${doc.id}/content`, { version: cur.version, content: { type: 'doc', content: [] } });
  await a('PATCH', `/api/files/${doc.id}`, { trashed: true });
  await a('PATCH', `/api/files/${doc.id}`, { trashed: true }); // already there: nothing new
  await a('PATCH', `/api/files/${doc.id}`, { trashed: false });
  const list = (await b('GET', `/api/files/${doc.id}/activity`)).body;
  assert.deepEqual(list.map((x) => `${x.user_name}:${x.action}`).reverse(),
    ['Act Ann:create', 'Act Ann:edit', 'Act Ann:rename', 'Act Ann:move', 'Act Ann:share', 'Act Ben:edit', 'Act Ann:trash', 'Act Ann:restore']);
  const find = (action) => list.find((x) => x.action === action).details;
  assert.deepEqual(find('rename'), { from: 'Plan', to: 'Plan 2027' });
  assert.deepEqual(find('move'), { to: 'Projects' });
  assert.deepEqual(find('share'), { added: ['Act Ben (can edit)'], removed: [] });
  assert.ok(list.every((x) => x.at > 0));
  assert.equal((await c('GET', `/api/files/${doc.id}/activity`)).status, 404, 'not shared with them');
  // A copy and an upload say so.
  const copy = (await b('POST', `/api/files/${doc.id}/copy`, {})).body;
  assert.deepEqual((await b('GET', `/api/files/${copy.id}/activity`)).body.map((x) => [x.action, x.details]), [['copy', { from: 'Plan 2027' }]]);
  // Unsharing is noted too.
  await a('PUT', `/api/files/${doc.id}/shares`, { shares: [] });
  assert.deepEqual((await a('GET', `/api/files/${doc.id}/activity`)).body[0].details, { added: [], removed: ['Act Ben'] });
});

test('contacts: duplicates found by email, phone or name; merging keeps one with everything', async () => {
  const a = client(), b = client();
  for (const [local, name] of [['dupa', 'Dup Ann'], ['dupb', 'Dup Ben']]) assert.equal((await owner('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).status, 201);
  await login(a, 'dupa@acme.com');
  await login(b, 'dupb@acme.com');
  const add = async (c) => (await a('POST', '/api/contacts', c)).body;
  const k1 = await add({ name: 'Kim Park', email: 'kim@park.example', company: 'Acme', notes: 'Met at expo' });
  const k2 = await add({ name: 'K. Park', email: 'KIM@park.example', phone: '+44 7700 900123', birthday: '1990-05-01' });
  const k3 = await add({ name: 'Kimberly Park', email: 'kim.park@gmail.example', phone: '07700 900 123' });
  await add({ name: 'Somebody Else', email: 'else@x.example' });
  const groups = (await a('GET', '/api/contacts/duplicates')).body;
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].map((c) => c.id).sort(), [k1.id, k2.id, k3.id].sort());
  assert.deepEqual((await b('GET', '/api/contacts/duplicates')).body, [], 'only your own');
  assert.equal((await b('POST', '/api/contacts/merge', { keep: k1.id, ids: [k2.id] })).status, 404, 'not theirs');
  assert.equal((await a('POST', '/api/contacts/merge', { keep: k1.id, ids: [] })).status, 400);
  const m = (await a('POST', '/api/contacts/merge', { keep: k1.id, ids: [k2.id, k3.id] })).body;
  assert.equal(m.id, k1.id);
  assert.equal(m.name, 'Kim Park');
  assert.equal(m.phone, '+44 7700 900123');
  assert.equal(m.birthday, '1990-05-01');
  assert.equal(m.notes, 'Met at expo\nAlso email: kim.park@gmail.example');
  const left = (await a('GET', '/api/contacts')).body.map((c) => c.name).sort();
  assert.deepEqual(left, ['Kim Park', 'Somebody Else']);
  assert.deepEqual((await a('GET', '/api/contacts/duplicates')).body, []);
});

test('chat: scheduled messages wait, can be changed or cancelled, send at their time or now; checked again when due', async () => {
  const { sendDueChat } = await import('../src/routes/chat.js');
  const a = client(), b = client();
  for (const [local, name] of [['scha', 'Sched Ann'], ['schb', 'Sched Ben']]) assert.equal((await owner('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).status, 201);
  await login(a, 'scha@acme.com');
  const bid = (await login(b, 'schb@acme.com')).id;
  const ch = (await a('POST', '/api/chat/channels', { name: 'sched-private', private: true, members: [bid] })).body.id;
  const hour = Date.now() + 36e5;
  assert.equal((await a('POST', `/api/chat/channels/${ch}/scheduled`, { body: 'too soon', send_at: Date.now() + 1000 })).status, 400);
  assert.equal((await a('POST', `/api/chat/channels/${ch}/scheduled`, { body: 'too late', send_at: Date.now() + 400 * 864e5 })).status, 400);
  assert.equal((await a('POST', `/api/chat/channels/${ch}/scheduled`, { poll: { question: 'Q', options: ['a', 'b'] }, send_at: hour })).status, 400);
  const s1 = (await a('POST', `/api/chat/channels/${ch}/scheduled`, { body: 'Morning all, standup at 10', send_at: hour })).body;
  const s2 = (await a('POST', `/api/chat/channels/${ch}/scheduled`, { body: 'Reminder: timesheets', send_at: hour + 36e5 })).body;
  const s3 = (await a('POST', `/api/chat/channels/${ch}/scheduled`, { body: 'Never mind', send_at: hour })).body;
  assert.deepEqual((await a('GET', `/api/chat/scheduled?channel=${ch}`)).body.map((x) => x.body), ['Morning all, standup at 10', 'Never mind', 'Reminder: timesheets']);
  assert.deepEqual((await b('GET', `/api/chat/scheduled?channel=${ch}`)).body, [], 'only yours');
  assert.equal((await b('DELETE', `/api/chat/scheduled/${s1.id}`)).status, 404);
  const msgs = async () => (await b('GET', `/api/chat/channels/${ch}/messages`)).body.map((m) => m.body);
  assert.deepEqual(await msgs(), [], 'nothing seen yet');
  await a('DELETE', `/api/chat/scheduled/${s3.id}`);
  assert.equal((await a('PATCH', `/api/chat/scheduled/${s2.id}`, { body: 'Reminder: timesheets by 5pm' })).body.body, 'Reminder: timesheets by 5pm');
  // Due: sent as from them; the later one waits.
  assert.equal(sendDueChat(hour + 1000), 1);
  assert.deepEqual(await msgs(), ['Morning all, standup at 10']);
  assert.equal((await b('GET', `/api/chat/channels/${ch}/messages`)).body[0].user_name, 'Sched Ann');
  // Send now.
  const now = (await a('POST', `/api/chat/scheduled/${s2.id}/send`, {})).body;
  assert.equal(now.body, 'Reminder: timesheets by 5pm');
  assert.deepEqual((await a('GET', `/api/chat/scheduled`)).body, []);
  // Archived by the time it's due: kept with the reason, and the sender is told.
  const s4 = (await a('POST', `/api/chat/channels/${ch}/scheduled`, { body: 'After the archive', send_at: hour })).body;
  await a('PATCH', `/api/chat/channels/${ch}`, { archived: true });
  assert.equal(sendDueChat(hour + 1000), 1);
  const kept = (await a('GET', '/api/chat/scheduled')).body;
  assert.equal(kept[0].id, s4.id);
  assert.match(kept[0].error, /archived/);
  assert.equal(sendDueChat(hour + 2000), 0, 'not tried again');
  assert.ok((await a('GET', '/api/notifications')).body.items.some((n) => n.title === 'A scheduled message couldn’t be sent'));
  assert.equal((await a('POST', `/api/chat/scheduled/${s4.id}/send`, {})).status, 400, 'still can’t');
});

test('admin: import people from a CSV — checked first, good rows created, passwords made up when missing', async () => {
  const csv = 'First name,Last name,Email,Password,Admin\n'
    + 'Imp,One,imp1,,\n'
    + 'Imp,Two,imp2@acme.com,secretpass1,yes\n'
    + 'Imp,Three,imp3@other.example,,\n'
    + 'Imp,Four,imp1,,\n'
    + ',,imp5,,\n'
    + 'Imp,Six,imp6,short,\n';
  const dry = await owner('POST', '/api/users/import', { csv, domain: 'acme.com', dry_run: true });
  assert.equal(dry.status, 200);
  assert.deepEqual(dry.body.rows.map((r) => [r.line, r.email, r.error || 'ok']), [
    [2, 'imp1@acme.com', 'ok'], [3, 'imp2@acme.com', 'ok'], [4, 'imp3@other.example', 'other.example is not a domain of this company'],
    [5, 'imp1@acme.com', 'imp1@acme.com is in the file twice'], [6, 'imp5@acme.com', 'No name'], [7, 'imp6@acme.com', 'The password must be at least 8 characters']]);
  assert.equal(dry.body.rows[1].admin, true);
  assert.equal(JSON.stringify(dry.body).includes('secretpass1'), false, 'passwords not sent back');
  assert.equal((await owner('GET', '/api/users')).body.some((u) => u.username === 'imp1@acme.com'), false, 'a dry run creates nobody');
  const done = (await owner('POST', '/api/users/import', { csv, domain: 'acme.com' })).body;
  assert.equal(done.created, 2);
  const made = done.rows.find((r) => r.email === 'imp1@acme.com');
  assert.match(made.password, /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
  assert.equal(done.rows.find((r) => r.email === 'imp2@acme.com').password, undefined, 'their own password isn’t shown');
  const c = client();
  assert.equal((await c('POST', '/api/auth/login', { username: 'imp1@acme.com', password: made.password })).status, 200);
  const two = client();
  assert.equal((await two('POST', '/api/auth/login', { username: 'imp2@acme.com', password: 'secretpass1' })).status, 200);
  assert.equal(!!(await two('GET', '/api/auth/me')).body.user.is_admin, true);
  // Again: now they're taken.
  assert.equal((await owner('POST', '/api/users/import', { csv: 'Name,Email\nX Y,imp1', domain: 'acme.com', dry_run: true })).body.rows[0].update, true, 'someone already here is updated, not added again');
  assert.equal((await owner('POST', '/api/users/import', { csv: 'Who,Where\na,b', domain: 'acme.com' })).status, 400, 'columns named');
  assert.equal((await c('POST', '/api/users/import', { csv, domain: 'acme.com' })).status, 403, 'admins only');
});

test('drive: asking for access — the owner is told, approves (as asked or otherwise) or declines; nothing leaks', async () => {
  const a = client(), b = client(), c = client();
  for (const [local, name] of [['reqa', 'Req Ann'], ['reqb', 'Req Ben'], ['reqc', 'Req Cat']]) assert.equal((await owner('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).status, 201);
  await login(a, 'reqa@acme.com');
  await login(b, 'reqb@acme.com');
  await login(c, 'reqc@acme.com');
  const doc = (await a('POST', '/api/files/new', { kind: 'doc', name: 'Budget 2027' })).body;
  assert.equal((await b('GET', `/api/files/${doc.id}`)).status, 404);
  assert.deepEqual((await b('POST', `/api/files/${doc.id}/request-access`, { role: 'editor', message: 'For the board pack' })).body, { ok: true });
  assert.deepEqual((await b('POST', '/api/files/nonexistent/request-access', {})).body, { ok: true }, 'the same answer for a file that isn’t there');
  assert.equal((await a('POST', `/api/files/${doc.id}/request-access`, {})).status, 400, 'the owner has it');
  const bell = (await a('GET', '/api/notifications')).body.items;
  assert.ok(bell.some((n) => n.title === 'Req Ben asks to edit “Budget 2027”' && n.body === 'For the board pack'));
  await c('POST', `/api/files/${doc.id}/request-access`, {});
  let reqs = (await a('GET', '/api/files/access-requests')).body;
  assert.deepEqual(reqs.map((r) => [r.user_name, r.role, r.file_name]), [['Req Cat', 'viewer', 'Budget 2027'], ['Req Ben', 'editor', 'Budget 2027']]);
  assert.deepEqual((await b('GET', '/api/files/access-requests')).body, [], 'only the owner sees them');
  const ben = reqs.find((r) => r.user_name === 'Req Ben');
  assert.equal((await b('POST', `/api/files/access-requests/${ben.id}`, { approve: true })).status, 404, 'only the owner answers');
  // Ben gets to view (not edit, as asked); Cat is declined.
  await a('POST', `/api/files/access-requests/${ben.id}`, { approve: true, role: 'viewer' });
  assert.equal((await b('GET', `/api/files/${doc.id}`)).body.role, 'viewer');
  assert.ok((await b('GET', '/api/notifications')).body.items.some((n) => n.title === 'Req Ann shared “Budget 2027” with you'));
  const cat = (await a('GET', '/api/files/access-requests')).body[0];
  await a('POST', `/api/files/access-requests/${cat.id}`, { approve: false });
  assert.equal((await c('GET', `/api/files/${doc.id}`)).status, 404);
  assert.ok((await c('GET', '/api/notifications')).body.items.some((n) => n.title === 'Req Ann didn’t give you access to “Budget 2027”'));
  assert.deepEqual((await a('GET', '/api/files/access-requests')).body, []);
  assert.equal((await b('POST', `/api/files/${doc.id}/request-access`, {})).status, 400, 'Ben can open it now');
});

test('profile photos: set, seen by colleagues and people you can work with, removed', async () => {
  const a = client(), b = client();
  for (const [local, name] of [['pha', 'Photo Ann'], ['phb', 'Photo Ben']]) assert.equal((await owner('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).status, 201);
  const aid = (await login(a, 'pha@acme.com')).id;
  await login(b, 'phb@acme.com');
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const put = (who, body) => who('PUT', '/api/users/me/photo', body, { raw: true, headers: { 'content-type': 'image/png' } });
  assert.equal((await put(a, Buffer.from('<svg></svg>'))).status, 400, 'pictures only');
  assert.equal((await put(a, PNG)).status, 200);
  const list = (await b('GET', '/api/users/photos')).body;
  const mine = list.find((p) => p.id === aid);
  assert.equal(mine.email, 'pha@acme.com');
  const got = await b('GET', `/api/users/${aid}/photo?v=${mine.v}`, undefined, { binary: true });
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'image/png');
  assert.deepEqual(got.body, PNG);
  assert.equal((await owner('POST', '/api/orgs', { name: 'Photo Co', domain: 'photoco.example', admin_name: 'Photo X', admin_local: 'phx', admin_password: 'password123' })).status, 201);
  const x = client();
  await login(x, 'phx@photoco.example');
  assert.equal((await x('GET', `/api/users/${aid}/photo`)).status, 200, 'another company you can work with (external collaboration on)');
  assert.deepEqual((await x('GET', '/api/users/photos')).body, [], 'the list is your own company');
  assert.equal((await b('GET', '/api/users/nobody/photo')).status, 404);
  assert.equal((await a('DELETE', '/api/users/me/photo')).status, 200);
  assert.equal((await b('GET', '/api/users/photos')).body.some((p) => p.id === aid), false);
  assert.equal((await b('GET', `/api/users/${aid}/photo`)).status, 404);
});

test('drive: a folder path for uploading a folder — found when there, made when not, inside folders you can edit', async () => {
  const a = client(), b = client();
  for (const [local, name] of [['fpa', 'Path Ann'], ['fpb', 'Path Ben']]) assert.equal((await owner('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).status, 201);
  await login(a, 'fpa@acme.com');
  const bid = (await login(b, 'fpb@acme.com')).id;
  const one = (await a('POST', '/api/files/folder-path', { path: ['Holiday', '2026', 'Beach'] })).body;
  assert.equal(one.created, 3);
  const again = (await a('POST', '/api/files/folder-path', { path: ['Holiday', '2026', 'Hills'] })).body;
  assert.equal(again.created, 1, 'Holiday and 2026 are reused');
  const top = (await a('GET', '/api/files')).body.filter((f) => f.name === 'Holiday');
  assert.equal(top.length, 1);
  const y2026 = (await a('GET', `/api/files?parent=${top[0].id}`)).body;
  assert.deepEqual(y2026.map((f) => f.name), ['2026']);
  assert.deepEqual((await a('GET', `/api/files?parent=${y2026[0].id}`)).body.map((f) => f.name).sort(), ['Beach', 'Hills']);
  // Inside a folder shared for viewing only: refused; for editing: allowed.
  await a('PUT', `/api/files/${top[0].id}/shares`, { shares: [{ user_id: bid, role: 'viewer' }] });
  assert.equal((await b('POST', '/api/files/folder-path', { parent_id: top[0].id, path: ['Ben'] })).status, 403);
  await a('PUT', `/api/files/${top[0].id}/shares`, { shares: [{ user_id: bid, role: 'editor' }] });
  const ben = (await b('POST', '/api/files/folder-path', { parent_id: top[0].id, path: ['2026', 'Ben'] })).body;
  assert.equal(ben.created, 1, '2026 there already');
  assert.equal((await a('POST', '/api/files/folder-path', { path: [] })).status, 400);
});

test('company templates: an admin marks one; anyone in the company starts from it, shared or not', async () => {
  const a = client(), b = client();
  for (const [local, name] of [['tpla', 'Tpl Ann'], ['tplb', 'Tpl Ben']]) assert.equal((await owner('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).status, 201);
  await login(a, 'tpla@acme.com');
  await login(b, 'tplb@acme.com');
  const doc = (await a('POST', '/api/files/new', { kind: 'doc', name: 'Proposal', content: { type: 'doc', content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Proposal for …' }] }] } })).body;
  assert.equal((await a('PUT', `/api/files/${doc.id}/template`, { template: true })).status, 403, 'not an admin');
  await a('PUT', `/api/files/${doc.id}/shares`, { shares: [] });
  assert.equal((await owner('PUT', `/api/files/${doc.id}/template`, { template: true })).status, 404, 'the admin must be able to open it');
  const ownerMe = (await owner('GET', '/api/auth/me')).body.user;
  await a('PUT', `/api/files/${doc.id}/shares`, { shares: [{ user_id: ownerMe.id, role: 'viewer' }] });
  assert.equal((await owner('PUT', `/api/files/${doc.id}/template`, { template: true })).body.template, 1);
  const list = (await b('GET', '/api/files/templates')).body;
  assert.ok(list.some((t) => t.id === doc.id && t.name === 'Proposal' && t.kind === 'doc'));
  assert.equal((await b('GET', `/api/files/${doc.id}`)).status, 404, 'Ben can’t open the template itself');
  const mine = (await b('POST', `/api/files/templates/${doc.id}/use`, { name: 'Proposal for Globex' })).body;
  assert.equal(mine.name, 'Proposal for Globex');
  assert.equal(mine.role, 'owner');
  assert.match(JSON.stringify((await b('GET', `/api/files/${mine.id}/content`)).body.content), /Proposal for …/);
  assert.equal((await b('POST', `/api/files/templates/${mine.id}/use`, {})).status, 404, 'not a template');
  await owner('PUT', `/api/files/${doc.id}/template`, { template: false });
  assert.equal((await b('GET', '/api/files/templates')).body.some((t) => t.id === doc.id), false);
});

test('chat: remind me about a message — a notification at the time, linking back; changed, cancelled, private', async () => {
  const { sendDueChat } = await import('../src/routes/chat.js');
  const a = client(), b = client();
  for (const [local, name] of [['rema', 'Rem Ann'], ['remb', 'Rem Ben']]) assert.equal((await owner('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).status, 201);
  await login(a, 'rema@acme.com');
  const bid = (await login(b, 'remb@acme.com')).id;
  const ch = (await a('POST', '/api/chat/channels', { name: 'remind-me', private: true, members: [bid] })).body.id;
  const m = (await b('POST', `/api/chat/channels/${ch}/messages`, { body: 'Can you send the contract by Friday?' })).body;
  const hour = Date.now() + 36e5;
  assert.equal((await a('POST', `/api/chat/messages/${m.id}/remind`, { at: Date.now() })).status, 400);
  assert.equal((await a('POST', `/api/chat/messages/${m.id}/remind`, { at: hour })).status, 200);
  await a('POST', `/api/chat/messages/${m.id}/remind`, { at: hour + 60e3 }); // changed, not doubled
  const mine = (await a('GET', '/api/chat/reminders')).body;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].at, hour + 60e3);
  assert.equal(mine[0].author, 'Rem Ben');
  assert.deepEqual((await b('GET', '/api/chat/reminders')).body, [], 'private');
  sendDueChat(hour); // not yet
  assert.equal((await a('GET', '/api/chat/reminders')).body.length, 1);
  sendDueChat(hour + 61e3);
  assert.deepEqual((await a('GET', '/api/chat/reminders')).body, []);
  const n = (await a('GET', '/api/notifications')).body.items.find((x) => x.title === 'Reminder: Rem Ben in #remind-me');
  assert.ok(n);
  assert.equal(n.body, 'Can you send the contract by Friday?');
  assert.equal(n.link, `/chat/${ch}?msg=${m.id}`);
  // Cancelled ones don't come.
  await a('POST', `/api/chat/messages/${m.id}/remind`, { at: hour });
  await a('POST', `/api/chat/messages/${m.id}/remind`, { at: null });
  assert.deepEqual((await a('GET', '/api/chat/reminders')).body, []);
});

test('drive: sharing with everyone in the company — view or edit, folders included, newcomers too, not other companies', async () => {
  const a = client(), b = client(), c = client();
  for (const [local, name] of [['coa', 'Co Ann'], ['cob', 'Co Ben']]) assert.equal((await owner('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).status, 201);
  await login(a, 'coa@acme.com');
  await login(b, 'cob@acme.com');
  const folder = (await a('POST', '/api/files/folder', { name: 'Company handbook' })).body;
  const doc = (await a('POST', '/api/files/new', { kind: 'doc', name: 'Holidays policy', parent_id: folder.id })).body;
  assert.equal((await b('GET', `/api/files/${doc.id}`)).status, 404);
  assert.equal((await b('PUT', `/api/files/${folder.id}/company`, { role: 'viewer' })).status, 404, 'only the owner');
  assert.equal((await a('PUT', `/api/files/${folder.id}/company`, { role: 'viewer' })).body.org_role, 'viewer');
  assert.equal((await b('GET', `/api/files/${doc.id}`)).body.role, 'viewer', 'inside the folder too');
  assert.ok((await b('GET', '/api/files?view=shared')).body.some((f) => f.id === folder.id && f.role === 'viewer'));
  assert.ok((await b('GET', `/api/files?view=search&q=${encodeURIComponent('handbook')}`)).body.some((f) => f.id === folder.id), 'found by search');
  const inside = (await b('GET', `/api/files?view=search&q=${encodeURIComponent('Holidays')}`)).body.find((f) => f.id === doc.id);
  assert.equal(inside?.role, 'viewer', 'and what is inside it');
  assert.equal((await b('PUT', `/api/files/${doc.id}/content`, { version: 1, content: { type: 'doc', content: [] } })).status, 403, 'view only');
  // Someone who joins later has it too.
  assert.equal((await owner('POST', '/api/users', { local: 'coc', domain: 'acme.com', name: 'Co Cat', password: 'password123' })).status, 201);
  await login(c, 'coc@acme.com');
  assert.equal((await c('GET', `/api/files/${folder.id}`)).body.role, 'viewer');
  // Edit for everyone.
  await a('PUT', `/api/files/${folder.id}/company`, { role: 'editor' });
  assert.equal((await b('GET', `/api/files/${doc.id}`)).body.role, 'editor');
  // Other companies don't.
  const x = client();
  assert.equal((await owner('POST', '/api/orgs', { name: 'Co Other', domain: 'coother.example', admin_name: 'Other X', admin_local: 'x', admin_password: 'password123' })).status, 201);
  await login(x, 'x@coother.example');
  assert.equal((await x('GET', `/api/files/${folder.id}`)).status, 404);
  assert.equal((await x('GET', '/api/files?view=shared')).body.some((f) => f.id === folder.id), false);
  // Stop.
  await a('PUT', `/api/files/${folder.id}/company`, { role: null });
  assert.equal((await b('GET', `/api/files/${doc.id}`)).status, 404);
  assert.equal((await b('GET', '/api/files?view=shared')).body.some((f) => f.id === folder.id), false);
});

test('drive search: files inside folders shared with you are found; not once the folder is in the trash', async () => {
  const a = client(), b = client();
  for (const [local, name] of [['sra', 'Srch Ann'], ['srb', 'Srch Ben']]) assert.equal((await owner('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).status, 201);
  await login(a, 'sra@acme.com');
  const bid = (await login(b, 'srb@acme.com')).id;
  const top = (await a('POST', '/api/files/folder', { name: 'Projects zz' })).body;
  const sub = (await a('POST', '/api/files/folder', { name: 'Kiwi', parent_id: top.id })).body;
  const deep = (await a('POST', '/api/files/new', { kind: 'doc', name: 'Kiwi launch plan', parent_id: sub.id })).body;
  await a('POST', '/api/files/new', { kind: 'doc', name: 'Kiwi private notes' }); // not shared
  const find = async () => (await b('GET', `/api/files?view=search&q=kiwi`)).body.map((f) => f.name).sort();
  assert.deepEqual(await find(), []);
  await a('PUT', `/api/files/${top.id}/shares`, { shares: [{ user_id: bid, role: 'editor' }] });
  assert.deepEqual(await find(), ['Kiwi', 'Kiwi launch plan']);
  assert.equal((await b('GET', `/api/files?view=search&q=launch`)).body[0].role, 'editor');
  await a('PATCH', `/api/files/${top.id}`, { trashed: true });
  assert.deepEqual(await find(), []);
  assert.equal(deep.name, 'Kiwi launch plan');
});

test('rooms: admins list them; an event books a free room, a clashing one is declined; repeats and moves are checked', async () => {
  const a = client(), b = client();
  for (const [local, name] of [['rma', 'Room Ann'], ['rmb', 'Room Ben']]) assert.equal((await owner('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).status, 201);
  await login(a, 'rma@acme.com');
  await login(b, 'rmb@acme.com');
  assert.equal((await a('POST', '/api/rooms', { name: 'Boardroom' })).status, 403, 'admins only');
  const board = (await owner('POST', '/api/rooms', { name: 'Boardroom', capacity: 12 })).body;
  const small = (await owner('POST', '/api/rooms', { name: 'Small room', capacity: 4 })).body;
  assert.deepEqual((await a('GET', '/api/rooms')).body.map((r) => r.name).filter((n) => ['Boardroom', 'Small room'].includes(n)), ['Boardroom', 'Small room']);
  const d = new Date(Date.now() + 9 * 864e5); d.setUTCHours(0, 0, 0, 0);
  const day = d.getTime(), h = 36e5;
  const e1 = (await a('POST', '/api/events', { title: 'Board meeting', start: day + 10 * h, end: day + 12 * h, rooms: [board.id] })).body;
  assert.deepEqual(e1.rooms.map((r) => [r.name, r.status]), [['Boardroom', 'yes']]);
  // Ben wants it at 11: taken; the small room is free.
  const free = (await b('GET', `/api/rooms?start=${day + 11 * h}&end=${day + 12 * h}`)).body;
  assert.equal(free.find((r) => r.id === board.id).free, false);
  assert.equal(free.find((r) => r.id === small.id).free, true);
  const e2 = (await b('POST', '/api/events', { title: 'Interview', start: day + 11 * h, end: day + 12 * h, rooms: [board.id, small.id] })).body;
  assert.deepEqual(e2.rooms.map((r) => [r.name, r.status]), [['Boardroom', 'no'], ['Small room', 'yes']]);
  // A weekly event that would meet the board meeting a week on: declined.
  const weekly = (await b('POST', '/api/events', { title: 'Weekly sync', start: day - 7 * 864e5 + 10.5 * h, end: day - 7 * 864e5 + 11 * h, rrule: { freq: 'weekly' }, rooms: [board.id] })).body;
  assert.equal(weekly.rooms[0].status, 'no');
  // Ann moves the board meeting to the afternoon: Ben's interview could now have the boardroom, his own still says no until he asks again,
  // and the moved meeting is still booked.
  const moved = (await a('PATCH', `/api/events/${e1.id}`, { start: day + 14 * h, end: day + 15 * h })).body;
  assert.equal(moved.rooms[0].status, 'yes');
  const again = (await b('PATCH', `/api/events/${e2.id}`, { rooms: [board.id] })).body;
  assert.deepEqual(again.rooms.map((r) => [r.name, r.status]), [['Boardroom', 'yes']]);
  assert.ok((await b('GET', `/api/events?from=${day}&to=${day + 864e5}`)).body.find((e) => e.id === e2.id).rooms.length === 1);
  const bookings = (await b('GET', `/api/rooms/${board.id}/busy?from=${day}&to=${day + 864e5}`)).body;
  assert.deepEqual(bookings.map((x) => [x.title, x.organizer, (x.start - day) / h]), [['Interview', 'Room Ben', 11], ['Board meeting', 'Room Ann', 14]]);
  assert.equal((await b('GET', `/api/rooms/${board.id}/busy?from=0&to=${100 * 864e5}`)).status, 400);
  await owner('DELETE', `/api/rooms/${small.id}`);
  assert.equal((await a('POST', '/api/events', { title: 'x', start: day, end: day + h, rooms: [small.id] })).status, 400);
});

test('company contacts: shared by their owner, seen and suggested to colleagues, changed by the owner or an admin', async () => {
  const a = client(), b = client();
  for (const [local, name] of [['cca', 'Cc Ann'], ['ccb', 'Cc Ben']]) assert.equal((await owner('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).status, 201);
  await login(a, 'cca@acme.com');
  await login(b, 'ccb@acme.com');
  const supplier = (await a('POST', '/api/contacts', { name: 'Zed Supplies', email: 'orders@zedsupplies.example', phone: '0123', shared: true })).body;
  await a('POST', '/api/contacts', { name: 'Zed Private Friend', email: 'friend@zed.example' });
  const company = (await b('GET', '/api/contacts?scope=company')).body;
  const z = company.find((c) => c.name === 'Zed Supplies');
  assert.ok(z);
  assert.equal(z.owner_name, 'Cc Ann');
  assert.equal(z.can_edit, false);
  assert.equal(company.some((c) => c.name === 'Zed Private Friend'), false);
  assert.ok((await b('GET', '/api/contacts/suggest?q=zed')).body.some((x) => x.email === 'orders@zedsupplies.example'), 'suggested when writing mail');
  assert.equal((await b('GET', '/api/contacts/suggest?q=zed')).body.some((x) => x.email === 'friend@zed.example'), false);
  assert.equal((await b('PATCH', `/api/contacts/${supplier.id}`, { phone: '999' })).status, 404, 'not Ben’s');
  assert.equal((await owner('PATCH', `/api/contacts/${supplier.id}`, { phone: '0456' })).body.phone, '0456', 'an admin may');
  assert.equal((await owner('GET', '/api/contacts?scope=company')).body.find((c) => c.id === supplier.id).can_edit, true);
  await a('PATCH', `/api/contacts/${supplier.id}`, { shared: false });
  assert.equal((await b('GET', '/api/contacts?scope=company')).body.some((c) => c.id === supplier.id), false);
  assert.equal((await owner('DELETE', `/api/contacts/${supplier.id}`)).status, 404, 'no longer shared: Ann’s alone');
});

test('chat polls: ask, vote (one or several), change your vote, close; checked options', async () => {
  const a = client(), b = client(), c = client();
  for (const [local, name] of [['polla', 'Poll Ann'], ['pollb', 'Poll Ben'], ['pollc', 'Poll Cat']]) assert.equal((await owner('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).status, 201);
  await login(a, 'polla@acme.com');
  const bid = (await login(b, 'pollb@acme.com')).id;
  await login(c, 'pollc@acme.com');
  const ch = (await a('POST', '/api/chat/channels', { name: 'poll-private', private: true, members: [bid] })).body.id;
  const send = (poll) => a('POST', `/api/chat/channels/${ch}/messages`, { poll });
  assert.equal((await send({ question: 'Lunch?', options: ['Pizza'] })).status, 400, 'two options at least');
  assert.equal((await send({ question: 'Lunch?', options: ['Pizza', 'pizza'] })).status, 400, 'no repeats');
  assert.equal((await send({ question: '', options: ['A', 'B'] })).status, 400);
  assert.equal((await send({ question: 'Q', options: Array.from({ length: 11 }, (_, i) => `o${i}`) })).status, 400);
  const p = (await send({ question: 'Lunch on Friday?', options: ['Pizza', ' Sushi ', '', 'Salad'] })).body;
  assert.equal(p.body, 'Lunch on Friday?');
  assert.deepEqual(p.poll.options.map((o) => [o.id, o.text, o.votes.length]), [['o1', 'Pizza', 0], ['o2', 'Sushi', 0], ['o3', 'Salad', 0]]);
  assert.equal(p.poll.multi, false);
  const vote = (who, options) => who('POST', `/api/chat/messages/${p.id}/vote`, { options });
  assert.equal((await vote(b, ['o1', 'o2'])).status, 400, 'one only');
  assert.equal((await vote(b, ['o9'])).status, 400);
  await vote(b, ['o2']);
  let got = (await vote(a, ['o2'])).body;
  assert.deepEqual(got.poll.options[1].votes.map((v) => v.name), ['Poll Ben', 'Poll Ann']);
  assert.equal(got.poll.voters, 2);
  got = (await vote(b, ['o3'])).body; // changed their mind
  assert.deepEqual(got.poll.options.map((o) => o.votes.length), [0, 1, 1]);
  got = (await vote(b, [])).body; // took it back
  assert.equal(got.poll.voters, 1);
  assert.equal((await vote(c, ['o1'])).status, 404, 'not in the channel');
  assert.equal((await b('POST', `/api/chat/messages/${p.id}/poll/close`, {})).status, 400, 'only who asked');
  assert.equal((await a('PATCH', `/api/chat/messages/${p.id}`, { body: 'x' })).status, 400, 'no editing');
  assert.ok((await a('POST', `/api/chat/messages/${p.id}/poll/close`, {})).body.poll.closed_at);
  assert.equal((await vote(b, ['o1'])).status, 400, 'closed');
  assert.equal((await a('POST', `/api/chat/messages/${p.id}/poll/close`, { closed: false })).body.poll.closed_at, null);
  // Several choices.
  const m = (await send({ question: 'Which days?', options: ['Mon', 'Tue', 'Wed'], multi: true })).body;
  got = (await b('POST', `/api/chat/messages/${m.id}/vote`, { options: ['o1', 'o3'] })).body;
  assert.deepEqual(got.poll.options.map((o) => o.votes.length), [1, 0, 1]);
  assert.equal(got.poll.voters, 1);
  const listed = (await b('GET', `/api/chat/channels/${ch}/messages`)).body.find((x) => x.id === m.id);
  assert.equal(listed.poll.question, 'Which days?');
  assert.equal((await b('POST', `/api/chat/messages/${(await a('POST', `/api/chat/channels/${ch}/messages`, { body: 'plain' })).body.id}/vote`, { options: [] })).status, 404, 'not a poll');
});

test('tasks: important ones, starred on the task, gathered from every list; carried to the next repeat', async () => {
  const a = client(), b = client(), c = client();
  for (const [local, name] of [['impa', 'Imp Ann'], ['impb', 'Imp Ben'], ['impc', 'Imp Cat']]) assert.equal((await owner('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).status, 201);
  await login(a, 'impa@acme.com');
  const bid = (await login(b, 'impb@acme.com')).id;
  await login(c, 'impc@acme.com');
  const mine = (await a('POST', '/api/tasks/lists', { name: 'Mine' })).body.id;
  const shared = (await a('POST', '/api/tasks/lists', { name: 'Team' })).body.id;
  await a('PUT', `/api/tasks/lists/${shared}/members`, { user_ids: [bid] });
  const t1 = (await a('POST', `/api/tasks/lists/${mine}/tasks`, { title: 'Pay rent', important: true, due: '2026-12-01' })).body;
  assert.equal(t1.important, true);
  const t2 = (await a('POST', `/api/tasks/lists/${shared}/tasks`, { title: 'Book venue' })).body;
  await a('POST', `/api/tasks/lists/${shared}/tasks`, { title: 'Not important' });
  assert.equal((await b('PATCH', `/api/tasks/tasks/${t2.id}`, { important: true })).body.important, true, 'anyone on the list can star it');
  assert.deepEqual((await a('GET', '/api/tasks/important')).body.map((t) => t.title), ['Pay rent', 'Book venue'], 'dated first');
  assert.deepEqual((await b('GET', '/api/tasks/important')).body.map((t) => t.title), ['Book venue'], 'only lists you are on');
  assert.deepEqual((await c('GET', '/api/tasks/important')).body, []);
  assert.equal((await a('GET', '/api/tasks/lists')).body.important, 2);
  await a('PATCH', `/api/tasks/tasks/${t2.id}`, { done: true });
  assert.deepEqual((await a('GET', '/api/tasks/important')).body.map((t) => t.title), ['Pay rent'], 'done ones leave');
  // Repeating: the next one is important too.
  await a('PATCH', `/api/tasks/tasks/${t1.id}`, { repeat: 'monthly' });
  await a('PATCH', `/api/tasks/tasks/${t1.id}`, { done: true, today: '2026-11-07' });
  const next = (await a('GET', '/api/tasks/important')).body;
  assert.equal(next.length, 1);
  assert.equal(next[0].due, '2027-01-01');
  assert.equal((await a('PATCH', `/api/tasks/tasks/${next[0].id}`, { important: false })).body.important, false);
});

test('tasks: a checklist of steps, shared with the list, fresh on each repeat', async () => {
  const a = client(), b = client(), c = client();
  for (const [local, name] of [['stepa', 'Step Ann'], ['stepb', 'Step Ben'], ['stepc', 'Step Cat']]) assert.equal((await owner('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).status, 201);
  await login(a, 'stepa@acme.com');
  const bid = (await login(b, 'stepb@acme.com')).id;
  await login(c, 'stepc@acme.com');
  const list = (await a('POST', '/api/tasks/lists', { name: 'Office' })).body.id;
  await a('PUT', `/api/tasks/lists/${list}/members`, { user_ids: [bid] });
  const t = (await a('POST', `/api/tasks/lists/${list}/tasks`, { title: 'Monthly close', due: '2026-11-30', repeat: 'monthly' })).body;
  assert.deepEqual(t.steps, []);
  for (const title of ['Bank statements', 'Invoices', 'Payroll']) assert.equal((await a('POST', `/api/tasks/tasks/${t.id}/steps`, { title })).status, 201);
  let steps = (await b('GET', `/api/tasks/lists/${list}/tasks`)).body[0].steps;
  assert.deepEqual(steps.map((x) => x.title), ['Bank statements', 'Invoices', 'Payroll'], 'Ben sees them');
  // Ben ticks one, renames one, moves the last to the top, removes one.
  await b('PATCH', `/api/tasks/tasks/${t.id}/steps/${steps[0].id}`, { done: true });
  await b('PATCH', `/api/tasks/tasks/${t.id}/steps/${steps[1].id}`, { title: 'Supplier invoices' });
  const moved = (await b('PATCH', `/api/tasks/tasks/${t.id}/steps/${steps[2].id}`, { index: 0 })).body.steps;
  assert.deepEqual(moved.map((x) => [x.title, x.done]), [['Payroll', false], ['Bank statements', true], ['Supplier invoices', false]]);
  assert.equal((await b('PATCH', `/api/tasks/tasks/${t.id}/steps/nope`, { done: true })).status, 404);
  assert.equal((await c('POST', `/api/tasks/tasks/${t.id}/steps`, { title: 'x' })).status, 404, 'not on the list');
  assert.equal((await a('POST', `/api/tasks/tasks/${t.id}/steps`, { title: '' })).status, 400);
  // Done: the next month's task has the same steps, none ticked.
  await a('PATCH', `/api/tasks/tasks/${t.id}`, { done: true, today: '2026-11-30' });
  const next = (await a('GET', `/api/tasks/lists/${list}/tasks`)).body.find((x) => !x.done);
  assert.equal(next.due, '2026-12-30');
  assert.deepEqual(next.steps.map((x) => [x.title, x.done]), [['Payroll', false], ['Bank statements', false], ['Supplier invoices', false]]);
  assert.ok(next.steps.every((x) => !steps.some((y) => y.id === x.id)), 'new ids');
  steps = (await a('DELETE', `/api/tasks/tasks/${next.id}/steps/${next.steps[0].id}`)).body.steps;
  assert.equal(steps.length, 2);
});

test('contacts: birthdays saved, checked, exported, and listed for a date range', async () => {
  const a = client();
  assert.equal((await owner('POST', '/api/users', { local: 'bday', domain: 'acme.com', name: 'Bday Ann', password: 'password123' })).status, 201);
  await login(a, 'bday@acme.com');
  const ann = (await a('POST', '/api/contacts', { name: 'Ann Lee', birthday: '1990-05-17' })).body;
  assert.equal(ann.birthday, '1990-05-17');
  const bo = (await a('POST', '/api/contacts', { name: 'Bo Chan', birthday: '--05-02' })).body;
  assert.equal(bo.birthday, '--05-02');
  await a('POST', '/api/contacts', { name: 'No Date' });
  assert.equal((await a('POST', '/api/contacts', { name: 'Bad', birthday: '1990-02-30' })).status, 400);
  const may = (await a('GET', '/api/contacts/birthdays?from=2026-05-01&to=2026-05-31')).body;
  assert.deepEqual(may.map((b) => [b.name, b.date, b.age]), [['Bo Chan', '2026-05-02', null], ['Ann Lee', '2026-05-17', 36]]);
  assert.equal((await a('GET', '/api/contacts/birthdays?from=2026-01-01&to=2028-01-01')).status, 400, 'a year at most');
  assert.equal((await a('PATCH', `/api/contacts/${ann.id}`, { birthday: null })).body.birthday, null);
  assert.equal((await a('PATCH', `/api/contacts/${bo.id}`, { phone: '123' })).body.birthday, '--05-02', 'kept when not sent');
  assert.deepEqual((await a('GET', '/api/contacts/birthdays?from=2026-05-01&to=2026-05-31')).body.map((b) => b.name), ['Bo Chan']);
  const vcf = await a('GET', '/api/contacts/export');
  assert.match(String(vcf.body ?? vcf.text ?? ''), /BDAY;X-APPLE-OMIT-YEAR=1604:1604-05-02/);
});

test('drive trash: emptied for good after the company’s number of days; the setting is checked', async () => {
  const { emptyOldTrash } = await import('../src/routes/files.js');
  const { q } = await import('../src/db.js');
  const a = client();
  assert.equal((await owner('POST', '/api/users', { local: 'trashy', domain: 'acme.com', name: 'Trash Ann', password: 'password123' })).status, 201);
  await login(a, 'trashy@acme.com');
  const mk = async (name) => (await a('POST', '/api/files/new', { kind: 'doc', name })).body.id;
  const oldOne = await mk('Old notes'), newOne = await mk('New notes'), kept = await mk('Kept');
  for (const id of [oldOne, newOne]) assert.equal((await a('PATCH', `/api/files/${id}`, { trashed: true })).status, 200);
  const trash = (await a('GET', '/api/files?view=trash')).body;
  const listed = (trash.files || trash).find((f) => f.id === oldOne);
  assert.ok(listed.deletes_at > Date.now() + 29 * 864e5 && listed.deletes_at < Date.now() + 31 * 864e5, 'goes in 30 days');
  // 31 days pass for one of them.
  q('UPDATE files SET trashed_at = ? WHERE id = ?').run(Date.now() - 31 * 864e5, oldOne);
  assert.ok(emptyOldTrash() >= 1);
  assert.equal(q('SELECT 1 FROM files WHERE id = ?').get(oldOne), undefined, 'gone for good');
  assert.ok(q('SELECT 1 FROM files WHERE id = ?').get(newOne), 'the newer one stays');
  assert.ok(q('SELECT 1 FROM files WHERE id = ? AND trashed = 0').get(kept), 'not in the trash: untouched');
  // Restoring clears the time; the setting can be changed by an admin (0 = never).
  await a('PATCH', `/api/files/${newOne}`, { trashed: false });
  assert.equal(q('SELECT trashed_at FROM files WHERE id = ?').get(newOne).trashed_at, null);
  assert.equal((await owner('PATCH', '/api/orgs/current', { trash_days: -1 })).status, 400);
  assert.equal((await owner('PATCH', '/api/orgs/current', { trash_days: 0 })).status, 200);
  await a('PATCH', `/api/files/${newOne}`, { trashed: true });
  q('UPDATE files SET trashed_at = ? WHERE id = ?').run(Date.now() - 400 * 864e5, newOne);
  emptyOldTrash();
  assert.ok(q('SELECT 1 FROM files WHERE id = ?').get(newOne), 'never emptied with 0');
  const t2 = (await a('GET', '/api/files?view=trash')).body;
  assert.equal((t2.files || t2).find((f) => f.id === newOne).deletes_at, undefined);
  assert.equal((await owner('PATCH', '/api/orgs/current', { trash_days: 30 })).status, 200);
});

test('calendar search: words in title, place or notes; your events and invitations; next time for repeating ones', async () => {
  const a = client(), b = client(), c = client();
  for (const [local, name] of [['cfa', 'Cal Ann'], ['cfb', 'Cal Ben'], ['cfc', 'Cal Cat']]) assert.equal((await owner('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).status, 201);
  await login(a, 'cfa@acme.com');
  await login(b, 'cfb@acme.com');
  await login(c, 'cfc@acme.com');
  const day = 864e5, now = Date.now();
  await a('POST', '/api/events', { title: 'Budget review', location: 'Room 4', start: now + 2 * day, end: now + 2 * day + 36e5, guests: ['cfb@acme.com'] });
  await a('POST', '/api/events', { title: 'Old budget talk', start: now - 40 * day, end: now - 40 * day + 36e5 });
  await a('POST', '/api/events', { title: 'Standup', description: 'Daily budget check', start: now - 100 * day, end: now - 100 * day + 9e5, rrule: { freq: 'daily' } });
  await c('POST', '/api/events', { title: 'Budget secret', start: now + day, end: now + day + 36e5 });
  const found = (await a('GET', '/api/events/search?q=BUDGET')).body;
  assert.deepEqual(found.map((e) => e.title), ['Standup', 'Budget review', 'Old budget talk'], 'coming (soonest first), then past; not other people’s');
  const standup = found[0];
  assert.ok(standup.repeats && standup.start >= now - day && standup.start < now + 2 * day, 'its next time, not its first');
  assert.equal(found[1].location, 'Room 4');
  assert.deepEqual((await a('GET', '/api/events/search?q=budget room')).body.map((e) => e.title), ['Budget review'], 'all the words');
  const asGuest = (await b('GET', '/api/events/search?q=review')).body;
  assert.deepEqual(asGuest.map((e) => [e.title, e.role]), [['Budget review', 'guest']]);
  assert.deepEqual((await a('GET', '/api/events/search?q=')).body, []);
  assert.deepEqual((await a('GET', '/api/events/search?q=100%25')).body, []);
});

test('file requests: people send files into a folder without seeing it; the owner is told', async () => {
  const pub = client(), owner2 = client();
  assert.equal((await owner('POST', '/api/users', { local: 'requester', domain: 'acme.com', name: 'Req Ann', password: 'password123' })).status, 201);
  await login(owner2, 'requester@acme.com');
  const folder = (await owner2('POST', '/api/files/folder', { name: 'Receipts' })).body;
  const secret = (await owner2('POST', `/api/files/upload?name=private.txt&parent=${folder.id}`, 'nope', { raw: true })).body;
  const file = (await owner2('POST', '/api/files/upload?name=x.txt', 'x', { raw: true })).body;
  assert.equal((await owner2('POST', '/api/links', { file_id: file.id, mode: 'upload' })).status, 400, 'folders only');
  const link = (await owner2('POST', '/api/links', { file_id: folder.id, mode: 'upload' })).body;
  assert.equal(link.mode, 'upload');
  const info = (await pub('GET', `/api/public/links/${link.token}`)).body;
  assert.deepEqual([info.mode, info.name, info.items], ['upload', 'Receipts', undefined], 'nothing inside is shown');
  assert.equal((await pub('GET', `/api/public/links/${link.token}/raw?item=${secret.id}`)).status, 404);
  const sent = await pub('POST', `/api/public/links/${link.token}/upload?name=${encodeURIComponent('taxi.pdf')}&from=${encodeURIComponent('Bob Client')}`, '%PDF-1.4 taxi', { raw: true, headers: { 'content-type': 'application/octet-stream' } });
  assert.equal(sent.status, 201);
  await pub('POST', `/api/public/links/${link.token}/upload?name=taxi.pdf`, '%PDF-1.4 again', { raw: true, headers: { 'content-type': 'application/octet-stream' } });
  const inside = (await owner2('GET', `/api/files?parent=${folder.id}`)).body;
  const list = inside.files || inside;
  const names = list.map((f) => f.name).sort();
  assert.equal(names.length, 3);
  assert.ok(names.includes('taxi.pdf') && names.some((n) => n !== 'taxi.pdf' && n.startsWith('taxi')), 'same name kept apart');
  assert.equal(list.find((f) => f.name === 'taxi.pdf').description, 'Sent by Bob Client through a file request');
  const bell = (await owner2('GET', '/api/notifications')).body;
  assert.ok((bell.items || bell).some((n) => /Bob Client sent “taxi.pdf”/.test(n.title)));
  // A view link can't take uploads; bad names are refused; a removed request stops working.
  const view = (await owner2('POST', '/api/links', { file_id: folder.id })).body;
  assert.equal((await pub('POST', `/api/public/links/${view.token}/upload?name=a.txt`, 'a', { raw: true })).status, 404);
  assert.equal((await pub('POST', `/api/public/links/${link.token}/upload?name=..%2Fa`, 'a', { raw: true })).status, 400);
  await owner2('DELETE', `/api/links/${link.id}`);
  assert.equal((await pub('POST', `/api/public/links/${link.token}/upload?name=late.txt`, 'a', { raw: true })).status, 404);
});

test('status: set, seen by colleagues in the directory, checked, and cleared by itself', async () => {
  const a = client(), b = client();
  for (const [local, name] of [['sta', 'Stat Ann'], ['stb', 'Stat Ben']]) assert.equal((await owner('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).status, 201);
  const aid = (await login(a, 'sta@acme.com')).id;
  await login(b, 'stb@acme.com');
  assert.deepEqual((await a('GET', '/api/users/me/status')).body, { status: null });
  assert.equal((await a('PUT', '/api/users/me/status', {})).status, 400);
  assert.equal((await a('PUT', '/api/users/me/status', { text: 'x', until: Date.now() - 1000 })).status, 400);
  assert.equal((await a('PUT', '/api/users/me/status', { emoji: '<b>', text: 'x' })).status, 400);
  const until = Date.now() + 36e5;
  const set = (await a('PUT', '/api/users/me/status', { emoji: '🌴', text: 'On leave until Monday', until })).body.status;
  assert.deepEqual(set, { emoji: '🌴', text: 'On leave until Monday', until });
  const seen = (await b('GET', '/api/users/directory')).body.find((u) => u.id === aid);
  assert.deepEqual(seen.status, set);
  assert.equal(seen.status_text, undefined, 'only the shaped status');
  // Past its time it's gone.
  const { q } = await import('../src/db.js');
  q('UPDATE users SET status_until = ? WHERE id = ?').run(Date.now() - 1, aid);
  assert.equal((await b('GET', '/api/users/directory')).body.find((u) => u.id === aid).status, null);
  await a('PUT', '/api/users/me/status', { text: 'Working from home' });
  assert.deepEqual((await a('GET', '/api/users/me/status')).body.status, { emoji: null, text: 'Working from home', until: null });
  await a('DELETE', '/api/users/me/status');
  assert.equal((await b('GET', '/api/users/directory')).body.find((u) => u.id === aid).status, null);
  // Direct messages say who the other person is, for showing their status.
  const dm = (await b('POST', '/api/chat/dm', { user_id: aid })).body;
  const ch = (await b('GET', '/api/chat/channels')).body.channels.find((c) => c.id === (dm.id || dm.channel_id));
  assert.equal(ch.dm_user_id, aid);
});

test('chat mute: per person; counts still kept; unmuting', async () => {
  const a = client(), b = client();
  for (const [local, name] of [['mua', 'Mute Ann'], ['mub', 'Mute Ben']]) assert.equal((await owner('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).status, 201);
  await login(a, 'mua@acme.com'); await login(b, 'mub@acme.com');
  const ch = (await a('POST', '/api/chat/channels', { name: 'mute-noisy' })).body.id;
  const find = async (who) => (await who('GET', '/api/chat/channels')).body.channels.find((c) => c.id === ch);
  assert.equal((await find(b)).muted, false);
  assert.deepEqual((await b('POST', `/api/chat/channels/${ch}/mute`, {})).body, { muted: true });
  await a('POST', `/api/chat/channels/${ch}/messages`, { body: 'chatter' });
  const muted = await find(b);
  assert.equal(muted.muted, true);
  assert.equal(muted.unread, 1, 'still counted (the app bar leaves it out)');
  assert.equal((await find(a)).muted, false, 'only for Ben');
  await b('POST', `/api/chat/channels/${ch}/mute`, { muted: false });
  assert.equal((await find(b)).muted, false);
});

test('tasks search: all the words in title, notes or steps; your lists and shared ones only', async () => {
  const a = client(), b = client(), c = client();
  for (const [local, name] of [['tsa', 'TS Ann'], ['tsb', 'TS Ben'], ['tsc', 'TS Cat']]) assert.equal((await owner('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).status, 201);
  await login(a, 'tsa@acme.com');
  const bid = (await login(b, 'tsb@acme.com')).id;
  await login(c, 'tsc@acme.com');
  const mine = (await a('POST', '/api/tasks/lists', { name: 'Ann list' })).body.id;
  const shared = (await b('POST', '/api/tasks/lists', { name: 'Ben shared' })).body.id;
  await b('PUT', `/api/tasks/lists/${shared}/members`, { user_ids: [(await a('GET', '/api/tasks/lists')).body.lists[0].owner_id] });
  const other = (await c('POST', '/api/tasks/lists', { name: 'Cat private' })).body.id;
  await a('POST', `/api/tasks/lists/${mine}/tasks`, { title: 'Renew insurance', notes: 'car policy', due: '2026-12-01' });
  const t2 = (await a('POST', `/api/tasks/lists/${mine}/tasks`, { title: 'Garage' })).body;
  await a('POST', `/api/tasks/tasks/${t2.id}/steps`, { title: 'Call insurance broker' });
  await b('POST', `/api/tasks/lists/${shared}/tasks`, { title: 'Office insurance quote', due: '2026-11-20' });
  await c('POST', `/api/tasks/lists/${other}/tasks`, { title: 'Secret insurance thing' });
  const found = (await a('GET', '/api/tasks/search?q=INSURANCE')).body;
  assert.deepEqual(found.map((t) => [t.title, t.list_name]), [['Office insurance quote', 'Ben shared'], ['Renew insurance', 'Ann list'], ['Garage', 'Ann list']]);
  assert.deepEqual((await a('GET', '/api/tasks/search?q=car insurance')).body.map((t) => t.title), ['Renew insurance'], 'all the words, notes too');
  assert.deepEqual((await a('GET', '/api/tasks/search?q=')).body, []);
  void bid;
});

test('contacts: job title, address and web page saved; web page checked and completed', async () => {
  const a = client();
  assert.equal((await owner('POST', '/api/users', { local: 'fields', domain: 'acme.com', name: 'Field Ann', password: 'password123' })).status, 201);
  await login(a, 'fields@acme.com');
  const c = (await a('POST', '/api/contacts', { name: 'Raj', title: 'Buyer', address: '1 Main St\nIpoh', website: 'raj.example.com' })).body;
  assert.deepEqual([c.title, c.address, c.website], ['Buyer', '1 Main St\nIpoh', 'https://raj.example.com']);
  assert.equal((await a('POST', '/api/contacts', { name: 'Bad', website: 'not a site' })).status, 400);
  const e = (await a('PATCH', `/api/contacts/${c.id}`, { title: 'Head buyer' })).body;
  assert.deepEqual([e.title, e.address], ['Head buyer', '1 Main St\nIpoh'], 'other fields kept');
  const vcf = (await a('GET', '/api/contacts/export')).body;
  assert.match(vcf, /TITLE:Head buyer/);
  assert.match(vcf, /URL:https:\/\/raj\.example\.com/);
});

test('contacts lookup: is this address a contact or a colleague', async () => {
  const a = client();
  assert.equal((await owner('POST', '/api/users', { local: 'looker', domain: 'acme.com', name: 'Look Ann', password: 'password123' })).status, 201);
  await login(a, 'looker@acme.com');
  assert.deepEqual((await a('GET', '/api/contacts/lookup?email=Sam@Client.example')).body, { contact: null, colleague: false });
  const c = (await a('POST', '/api/contacts', { name: 'Sam Client', email: 'sam@client.example' })).body;
  assert.deepEqual((await a('GET', '/api/contacts/lookup?email=SAM@client.example')).body, { contact: { id: c.id, name: 'Sam Client' }, colleague: false });
  assert.equal((await a('GET', '/api/contacts/lookup?email=owner@acme.com')).body.colleague, true);
  assert.equal((await a('GET', '/api/contacts/lookup?email=nope')).status, 400);
});

test('tasks: made from an email or chat message, linking back inside Workspace only', async () => {
  const a = client();
  assert.equal((await owner('POST', '/api/users', { local: 'lnka', domain: 'acme.com', name: 'Link Ann', password: 'password123' })).status, 201);
  await login(a, 'lnka@acme.com');
  const list = (await a('GET', '/api/tasks/lists')).body.lists.find((l) => l.mine).id;
  const t = (await a('POST', `/api/tasks/lists/${list}/tasks`, { title: 'Reply to Raj', link: { url: '/mail?open=%3Cx%40y.com%3E', label: 'Email from Raj' } })).body;
  assert.equal(t.link_url, '/mail?open=%3Cx%40y.com%3E');
  assert.equal(t.link_label, 'Email from Raj');
  for (const url of ['https://evil.example.com', '//evil.example.com', 'javascript:alert(1)', '/files/x', '/mail\\..', '/chat x']) {
    assert.equal((await a('POST', `/api/tasks/lists/${list}/tasks`, { title: 'x', link: { url } })).status, 400, url);
  }
  const c = (await a('POST', `/api/tasks/lists/${list}/tasks`, { title: 'From chat', link: { url: '/chat/abc?msg=1', label: 'x' }, due: '2026-12-01', repeat: 'daily' })).body;
  const next = (await a('PATCH', `/api/tasks/tasks/${c.id}`, { done: true })).body;
  const again = (await a('GET', `/api/tasks/lists/${list}/tasks`)).body.find((x) => x.title === 'From chat' && !x.done);
  assert.ok(next.done && again && again.link_url === '/chat/abc?msg=1', 'the next repeat keeps the link');
  const off = (await a('PATCH', `/api/tasks/tasks/${t.id}`, { link: null })).body;
  assert.equal(off.link_url, null);
});

test('chat: forward a message to another conversation, with its files and a note', async () => {
  const a = client(), b = client(), c = client();
  for (const [local, name] of [['fwda', 'Fwd Ann'], ['fwdb', 'Fwd Ben'], ['fwdc', 'Fwd Cat']]) assert.equal((await owner('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).status, 201);
  await login(a, 'fwda@acme.com');
  const bid = (await login(b, 'fwdb@acme.com')).id;
  const cid = (await login(c, 'fwdc@acme.com')).id;
  const dm = (await a('POST', '/api/chat/dm', { user_id: bid })).body.id;
  const folder = (await a('POST', '/api/chat/files-folder')).body.id;
  const pic = (await a('POST', `/api/files/upload?name=plan.txt&parent=${folder}`, Buffer.from('the plan'), { raw: true })).body;
  const src = (await a('POST', `/api/chat/channels/${dm}/messages`, { body: 'The plan is attached', files: [pic.id] })).body;
  // Ben forwards it to his DM with Cat: Cat sees who wrote it (not where: a direct message) and can open the file.
  const bc = (await b('POST', '/api/chat/dm', { user_id: cid })).body.id;
  const f = await b('POST', `/api/chat/messages/${src.id}/forward`, { channel_id: bc, body: 'FYI' });
  assert.equal(f.status, 201);
  assert.equal(f.body.body, 'FYI');
  assert.deepEqual({ ...f.body.forwarded, at: 0 }, { name: 'Fwd Ann', where: null, at: 0, body: 'The plan is attached' });
  assert.equal(f.body.files[0].id, pic.id);
  assert.equal((await c('GET', `/api/chat/messages/${f.body.id}/files/${pic.id}`)).status, 200);
  const seen = (await c('GET', `/api/chat/channels/${bc}/messages`)).body;
  assert.ok((seen.messages || seen).some((m) => m.forwarded?.name === 'Fwd Ann'));
  // Forwarding the forward passes on the original; a channel's name is kept.
  const office = (await c('POST', '/api/chat/channels', { name: 'fwd-office' })).body.id;
  const g = (await c('POST', `/api/chat/messages/${f.body.id}/forward`, { channel_id: office })).body;
  assert.deepEqual([g.forwarded.name, g.forwarded.body], ['Fwd Ben', 'FYI'], 'Ben wrote a note, so this forwards his message');
  const h = (await c('POST', `/api/chat/messages/${g.id}/forward`, { channel_id: office })).body;
  assert.deepEqual(h.forwarded, g.forwarded, 'an empty forward passes on the original');
  const pub = (await c('POST', `/api/chat/channels/${office}/messages`, { body: 'In the office' })).body;
  assert.equal((await b('POST', `/api/chat/messages/${pub.id}/forward`, { channel_id: bc })).body.forwarded.where, 'fwd-office');
  // Only messages you can see, only to conversations you can write in; not polls.
  assert.equal((await c('POST', `/api/chat/messages/${src.id}/forward`, { channel_id: office })).status, 404);
  assert.equal((await a('POST', `/api/chat/messages/${src.id}/forward`, { channel_id: bc })).status, 404);
  const poll = (await a('POST', `/api/chat/channels/${dm}/messages`, { poll: { question: 'Lunch?', options: ['Yes', 'No'] } })).body;
  assert.equal((await a('POST', `/api/chat/messages/${poll.id}/forward`, { channel_id: dm })).status, 400);
});

test('calendar: files from Drive attached to an event; guests can view the organizer’s', async () => {
  const a = client(), b = client(), c = client();
  for (const [local, name] of [['atta', 'Att Ann'], ['attb', 'Att Ben'], ['attc', 'Att Cat']]) assert.equal((await owner('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).status, 201);
  await login(a, 'atta@acme.com');
  const bid = (await login(b, 'attb@acme.com')).id;
  await login(c, 'attc@acme.com');
  const agenda = (await a('POST', '/api/files/new', { kind: 'doc', name: 'Agenda' })).body;
  const catsDoc = (await c('POST', '/api/files/new', { kind: 'doc', name: 'Cat private' })).body;
  const folder = (await a('POST', '/api/files/folder', { name: 'F' })).body;
  assert.equal((await a('POST', '/api/events', { title: 'x', start: 1, end: 2, attachments: [catsDoc.id] })).status, 400, 'only files you can open');
  if (folder?.id) assert.equal((await a('POST', '/api/events', { title: 'x', start: 1, end: 2, attachments: [folder.id] })).status, 400, 'not folders');
  assert.equal((await b('GET', `/api/files/${agenda.id}`)).status, 404);
  const ev = (await a('POST', '/api/events', { title: 'Planning', start: 1000, end: 2000, guests: ['attb@acme.com'], attachments: [agenda.id] })).body;
  assert.deepEqual(ev.attachments.map((x) => [x.name, x.kind, x.can_open]), [['Agenda', 'doc', true]]);
  assert.equal((await b('GET', `/api/files/${agenda.id}`)).status, 200, 'the guest can now view it');
  const seen = (await b('GET', '/api/events?from=0&to=5000')).body.find((x) => x.id === ev.id);
  assert.deepEqual(seen.attachments.map((x) => [x.name, x.can_open]), [['Agenda', true]]);
  // Cat shares her doc with Ann, who attaches it: Ben can't open it (Ann doesn't own it), and sees that.
  const cid = (await c('GET', '/api/auth/me')).body.user.id;
  const aid = (await a('GET', '/api/auth/me')).body.user.id;
  await c('PUT', `/api/files/${catsDoc.id}/shares`, { shares: [{ user_id: aid, role: 'viewer' }] });
  const both = (await a('PATCH', `/api/events/${ev.id}`, { attachments: [agenda.id, catsDoc.id] })).body;
  assert.equal(both.attachments.length, 2);
  const forBen = (await b('GET', '/api/events?from=0&to=5000')).body.find((x) => x.id === ev.id).attachments;
  assert.deepEqual(forBen.map((x) => [x.name, x.can_open]), [['Agenda', true], ['Cat private', false]]);
  // Cat stops sharing; Ann can still keep it on the event (but not add it anew elsewhere).
  await c('PUT', `/api/files/${catsDoc.id}/shares`, { shares: [] });
  assert.equal((await a('PATCH', `/api/events/${ev.id}`, { attachments: [catsDoc.id, agenda.id] })).status, 200);
  assert.equal((await a('PATCH', `/api/events/${ev.id}`, { attachments: [] })).body.attachments.length, 0);
  void bid; void cid;
});

test('working hours: set your own; Find a time keeps to everyone’s, each in their time zone', async () => {
  const a = client(), b = client();
  for (const [local, name] of [['wha', 'Hours Ann'], ['whb', 'Hours Ben']]) assert.equal((await owner('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).status, 201);
  await login(a, 'wha@acme.com');
  const bid = (await login(b, 'whb@acme.com')).id;
  const usual = (await a('GET', '/api/users/me/work-hours?tz=UTC')).body;
  assert.deepEqual([usual.own, usual.text, usual.tz], [false, 'Mon–Fri 9:00–17:00', 'UTC']);
  assert.equal((await b('PUT', '/api/users/me/work-hours', { hours: { days: [], start: 0, end: 60 } })).status, 400);
  // Ben works Tuesday and Thursday, 13:00–18:00 in Berlin (UTC+1 in winter).
  const set = (await b('PUT', '/api/users/me/work-hours', { hours: { days: [2, 4], start: 13 * 60, end: 18 * 60, tz: 'Europe/Berlin' } })).body;
  assert.deepEqual([set.own, set.text, set.tz], [true, 'Tue, Thu 13:00–18:00', 'Europe/Berlin']);
  const d = new Date(Date.UTC(2026, 11, 7)); // a Monday in December (no clock change nearby)
  while (d.getTime() < Date.now() + 864e5) d.setUTCDate(d.getUTCDate() + 7);
  const mon = d.getTime(), h = 36e5;
  const r = (await a('GET', `/api/freebusy/suggest?users=${bid}&duration=60&tz=UTC&from=${mon}`)).body;
  // Tuesday, from 12:00 UTC (13:00 Berlin) to 16:00 UTC (Ann's 9–5 in UTC ends at 17:00, Ben's at 17:00 UTC).
  assert.equal((r.slots[0].start - mon) / h, 24 + 12);
  assert.ok(r.slots.every((x) => [2, 4].includes(new Date(x.start).getUTCDay())), 'only Tuesdays and Thursdays');
  assert.ok(r.slots.every((x) => new Date(x.start).getUTCHours() >= 12 && new Date(x.end).getUTCHours() <= 17));
  assert.deepEqual(r.hours.map((x) => [x.name, x.hours, x.tz]), [['Hours Ben', 'Tue, Thu 13:00–18:00', 'Europe/Berlin']]);
  // Back to the usual.
  assert.equal((await b('PUT', '/api/users/me/work-hours', { hours: null })).body.own, false);
  assert.equal(((await a('GET', `/api/freebusy/suggest?users=${bid}&duration=60&tz=UTC&from=${mon}`)).body.slots[0].start - mon) / h, 9);
});

test('other contacts: people you email are remembered and suggested; not colleagues or contacts', async () => {
  const { recordSent } = await import('../src/othercontacts.js');
  const a = client();
  assert.equal((await owner('POST', '/api/users', { local: 'otha', domain: 'acme.com', name: 'Other Ann', password: 'password123' })).status, 201);
  const me = (await login(a, 'otha@acme.com'));
  const user = { id: me.id, username: 'otha@acme.com', org_id: (await a('GET', '/api/auth/me')).body.user.org_id };
  const colleague = (await owner('GET', '/api/auth/me')).body.user.username;
  recordSent(user, [{ name: 'Raj Kumar', address: 'Raj@Globex.example.com' }, { address: colleague.toUpperCase() }, { address: 'otha@acme.com' }]);
  recordSent(user, [{ address: 'raj@globex.example.com' }, { name: 'Sue Ng', address: 'sue@initech.example.com' }]);
  const list = (await a('GET', '/api/contacts/other')).body;
  assert.deepEqual(list.map((x) => [x.email, x.name, x.times]), [['raj@globex.example.com', 'Raj Kumar', 2], ['sue@initech.example.com', 'Sue Ng', 1]], 'not colleagues or yourself; the name is kept');
  const s = (await a('GET', '/api/contacts/suggest?q=raj')).body;
  assert.deepEqual(s.map((x) => [x.email, x.kind]), [['raj@globex.example.com', 'other']]);
  // Added to your contacts: it leaves Other contacts (and is suggested as a contact).
  await a('POST', '/api/contacts', { name: 'Raj Kumar', email: 'raj@globex.example.com' });
  assert.deepEqual((await a('GET', '/api/contacts/other')).body.map((x) => x.email), ['sue@initech.example.com']);
  assert.equal((await a('GET', '/api/contacts/suggest?q=raj')).body[0].kind, 'contact');
  assert.equal((await a('DELETE', `/api/contacts/other/${encodeURIComponent('sue@initech.example.com')}`)).status, 200);
  assert.deepEqual((await a('GET', '/api/contacts/other')).body, []);
  assert.equal((await a('DELETE', '/api/contacts/other/nobody%40x.com')).status, 404);
});

test('tasks: a due time on the due date; cleared with the date; kept on the next repeat', async () => {
  const a = client();
  assert.equal((await owner('POST', '/api/users', { local: 'dta', domain: 'acme.com', name: 'Time Ann', password: 'password123' })).status, 201);
  await login(a, 'dta@acme.com');
  const list = (await a('GET', '/api/tasks/lists')).body.lists.find((l) => l.mine).id;
  const t = (await a('POST', `/api/tasks/lists/${list}/tasks`, { title: 'Call Raj', due: '2026-12-01', due_time: '15:30' })).body;
  assert.equal(t.due_time, '15:30');
  assert.equal((await a('POST', `/api/tasks/lists/${list}/tasks`, { title: 'x', due: '2026-12-01', due_time: '25:00' })).status, 400);
  assert.equal((await a('POST', `/api/tasks/lists/${list}/tasks`, { title: 'No date', due_time: '10:00' })).body.due_time, null, 'no date, no time');
  const early = (await a('POST', `/api/tasks/lists/${list}/tasks`, { title: 'Early', due: '2026-12-01', due_time: '09:00' })).body;
  const allDay = (await a('POST', `/api/tasks/lists/${list}/tasks`, { title: 'Any time', due: '2026-12-01' })).body;
  assert.deepEqual((await a('GET', '/api/tasks/due?from=2026-12-01&to=2026-12-01')).body.map((x) => x.title), ['Early', 'Call Raj', 'Any time'], 'timed ones first, in order');
  assert.equal((await a('PATCH', `/api/tasks/tasks/${allDay.id}`, { due_time: '08:00' })).body.due_time, '08:00');
  assert.equal((await a('PATCH', `/api/tasks/tasks/${t.id}`, { due: null })).body.due_time, null, 'clearing the date clears the time');
  assert.equal((await a('PATCH', `/api/tasks/tasks/${t.id}`, { due_time: '10:00' })).status, 400, 'a time needs a date');
  await a('PATCH', `/api/tasks/tasks/${early.id}`, { repeat: 'daily' });
  await a('PATCH', `/api/tasks/tasks/${early.id}`, { done: true, today: '2026-12-01' });
  const next = (await a('GET', `/api/tasks/lists/${list}/tasks`)).body.find((x) => x.title === 'Early' && !x.done);
  assert.deepEqual([next.due, next.due_time], ['2026-12-02', '09:00']);
});

test('transfer ownership: give a folder to a colleague; give a leaving person’s files to someone', async () => {
  const a = client(), b = client(), c = client();
  for (const [local, name] of [['tra', 'Give Ann'], ['trb', 'Give Ben'], ['trc', 'Give Cat']]) assert.equal((await owner('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).status, 201);
  const aid = (await login(a, 'tra@acme.com')).id;
  const bid = (await login(b, 'trb@acme.com')).id;
  const cid = (await login(c, 'trc@acme.com')).id;
  const folder = (await a('POST', '/api/files/folder', { name: 'Projects' })).body;
  const doc = (await a('POST', '/api/files/new', { kind: 'doc', name: 'Plan', parent_id: folder.id })).body;
  await a('PUT', `/api/files/${folder.id}/shares`, { shares: [{ user_id: bid, role: 'viewer' }] });
  assert.equal((await b('POST', `/api/files/${folder.id}/transfer`, { user_id: bid })).status, 403, 'only the owner');
  assert.equal((await a('POST', `/api/files/${folder.id}/transfer`, { user_id: aid })).status, 400);
  const t = await a('POST', `/api/files/${folder.id}/transfer`, { user_id: bid });
  assert.equal(t.status, 200);
  assert.equal(t.body.items, 2);
  assert.equal(t.body.role, 'editor', 'the giver keeps edit access');
  assert.equal((await b('GET', `/api/files/${doc.id}`)).body.role, 'owner');
  assert.deepEqual((await b('GET', `/api/files/${folder.id}/shares`)).body.map((s) => [s.name, s.role]), [['Give Ann', 'editor']], 'Ben’s own share is gone');
  // Deleting Cat, her files go to Ben in "Files from Give Cat".
  const notes = (await c('POST', '/api/files/new', { kind: 'doc', name: 'Notes' })).body;
  const del = await owner('DELETE', `/api/users/${cid}?transfer_to=${bid}`);
  assert.equal(del.status, 200);
  assert.equal(del.body.files_moved, 1);
  const got = (await b('GET', `/api/files/${notes.id}`)).body;
  assert.equal(got.role, 'owner');
  const parent = (await b('GET', `/api/files/${got.parent_id}`)).body;
  assert.equal(parent.name, 'Files from Give Cat');
  assert.equal((await owner('DELETE', `/api/users/${aid}?transfer_to=${aid}`)).status, 400);
});

test('pause notifications: until a time; colleagues see it; stopping early', async () => {
  const a = client(), b = client();
  for (const [local, name] of [['pza', 'Pause Ann'], ['pzb', 'Pause Ben']]) assert.equal((await owner('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).status, 201);
  const aid = (await login(a, 'pza@acme.com')).id;
  await login(b, 'pzb@acme.com');
  assert.equal((await a('GET', '/api/users/me/pause')).body.paused_until, null);
  assert.equal((await a('PUT', '/api/users/me/pause', { until: Date.now() - 1000 })).status, 400);
  assert.equal((await a('PUT', '/api/users/me/pause', { until: Date.now() + 40 * 864e5 })).status, 400, 'up to a month');
  const until = Date.now() + 36e5;
  assert.equal((await a('PUT', '/api/users/me/pause', { until })).body.paused_until, until);
  assert.equal((await a('GET', '/api/users/me/pause')).body.paused_until, until);
  assert.equal((await b('GET', '/api/users/directory')).body.find((u) => u.id === aid).paused_until, until);
  await a('PUT', '/api/users/me/pause', { until: null });
  assert.equal((await b('GET', '/api/users/directory')).body.find((u) => u.id === aid).paused_until, null);
});

test('chat: mark unread from a message', async () => {
  const a = client(), b = client(), x = client();
  for (const [local, name] of [['mku', 'Unread Ann'], ['mkv', 'Unread Ben'], ['mkw', 'Unread Xavi']]) assert.equal((await owner('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).status, 201);
  await login(a, 'mku@acme.com');
  const bid = (await login(b, 'mkv@acme.com')).id;
  await login(x, 'mkw@acme.com');
  const dm = (await a('POST', '/api/chat/dm', { user_id: bid })).body.id;
  const ids = [];
  for (const t of ['one', 'two', 'three']) { ids.push((await a('POST', `/api/chat/channels/${dm}/messages`, { body: t })).body.id); await new Promise((r) => setTimeout(r, 5)); }
  const unread = async () => (await b('GET', '/api/chat/channels')).body.channels.find((c) => c.id === dm).unread;
  await b('POST', `/api/chat/channels/${dm}/read`);
  assert.equal(await unread(), 0);
  assert.equal((await b('POST', `/api/chat/messages/${ids[1]}/unread`)).status, 200);
  assert.equal(await unread(), 2, 'from "two" on');
  await b('POST', `/api/chat/channels/${dm}/read`);
  assert.equal(await unread(), 0);
  assert.equal((await x('POST', `/api/chat/messages/${ids[0]}/unread`)).status, 404, 'not for people outside it');
});

test('docs: download as Markdown; open a .md file as a document', async () => {
  const md = '# Minutes\n\nWe agreed on **three** things:\n\n- [x] budget\n- [ ] hiring\n\n| Who | What |\n| --- | --- |\n| Kim | slides |\n';
  const up = (await owner('POST', '/api/files/upload?name=minutes.md', Buffer.from(md), { raw: true })).body;
  const doc = await owner('POST', `/api/files/${up.id}/open-as`);
  assert.equal(doc.status, 201);
  assert.equal(doc.body.kind, 'doc');
  assert.equal(doc.body.name, 'minutes');
  const content = (await owner('GET', `/api/files/${doc.body.id}/content`)).body;
  const json = JSON.stringify(content);
  assert.ok(json.includes('"taskList"') && json.includes('"table"') && json.includes('"bold"'), json.slice(0, 300));
  const out = await owner('GET', `/api/files/${doc.body.id}/export?format=md`);
  assert.equal(out.status, 200);
  assert.match(out.headers.get('content-disposition'), /minutes\.md/);
  assert.equal(out.body.toString(), md, 'back as it was');
  const word = await owner('GET', `/api/files/${doc.body.id}/export`);
  assert.match(word.headers.get('content-disposition'), /minutes\.docx/, 'Word is still the default');
});

test('calendar: import an .ics from another app (repeats, exceptions, reminders); export yours', async () => {
  const a = client(), b = client();
  for (const [local, name] of [['icsa', 'Ics Ann'], ['icsb', 'Ics Ben']]) assert.equal((await owner('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).status, 201);
  await login(a, 'icsa@acme.com');
  await login(b, 'icsb@acme.com');
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Google Inc//Google Calendar 70.9054//EN',
    'BEGIN:VTIMEZONE', 'TZID:Europe/Berlin', 'BEGIN:STANDARD', 'DTSTART:19701025T030000', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD', 'END:VTIMEZONE',
    'BEGIN:VEVENT', 'UID:one@google.com', 'DTSTART;TZID=Europe/Berlin:20261203T100000', 'DTEND;TZID=Europe/Berlin:20261203T110000', 'SUMMARY:Supplier call', 'LOCATION:Room 2',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'END:VALARM', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:two@google.com', 'DTSTART;VALUE=DATE:20261224', 'DTEND;VALUE=DATE:20261227', 'SUMMARY:Holiday', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:three@google.com', 'DTSTART:20261201T090000Z', 'DTEND:20261201T093000Z', 'RRULE:FREQ=WEEKLY;COUNT=4', 'SUMMARY:Stand-up', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:three@google.com', 'RECURRENCE-ID:20261208T090000Z', 'DTSTART:20261208T130000Z', 'DTEND:20261208T133000Z', 'SUMMARY:Stand-up (moved)', 'END:VEVENT',
    'END:VCALENDAR', '',
  ].join('\r\n');
  const r = await a('POST', '/api/events/import?tz=Europe/Berlin', ics, { raw: true, headers: { 'content-type': 'text/calendar' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { added: 3, skipped: 0, failed: 0 });
  const list = (await a('GET', `/api/events?from=${Date.UTC(2026, 11, 1)}&to=${Date.UTC(2026, 11, 31)}`)).body;
  const call = list.find((e) => e.title === 'Supplier call');
  assert.equal(call.start, Date.UTC(2026, 11, 3, 9), '10:00 in Berlin');
  assert.equal(call.location, 'Room 2');
  assert.deepEqual(call.reminders, [15]);
  const holiday = list.find((e) => e.title === 'Holiday');
  assert.equal(holiday.all_day, 1);
  const standup = list.find((e) => e.title === 'Stand-up');
  assert.deepEqual(standup.rrule, { freq: 'weekly', count: 4 });
  assert.ok(list.some((e) => e.title === 'Stand-up (moved)' && e.start === Date.UTC(2026, 11, 8, 13)), 'the moved occurrence');
  assert.deepEqual((await a('POST', '/api/events/import', ics, { raw: true, headers: { 'content-type': 'text/calendar' } })).body, { added: 0, skipped: 3, failed: 0 }, 'the same file twice adds nothing');
  assert.equal((await a('POST', '/api/events/import', 'hello', { raw: true, headers: { 'content-type': 'text/plain' } })).status, 400);
  // Exported, and imported by someone else: the same events.
  const out = await a('GET', '/api/events/export');
  assert.match(out.headers.get('content-type'), /text\/calendar/);
  assert.equal((out.body.match(/BEGIN:VEVENT/g) || []).length, 4, 'three events and the moved occurrence');
  assert.equal((out.body.match(/BEGIN:VTIMEZONE/g) || []).length, new Set(out.body.match(/TZID:[^\r\n]*/g)).size, 'each time zone once');
  assert.deepEqual((await b('POST', '/api/events/import', out.body, { raw: true, headers: { 'content-type': 'text/calendar' } })).body, { added: 3, skipped: 0, failed: 0 });
  const theirs = (await b('GET', `/api/events?from=${Date.UTC(2026, 11, 1)}&to=${Date.UTC(2026, 11, 31)}`)).body;
  assert.equal(theirs.find((e) => e.title === 'Supplier call').start, Date.UTC(2026, 11, 3, 9));
});

test('chat: save messages for later; only yours; gone when you leave the conversation', async () => {
  const a = client(), b = client();
  for (const [local, name] of [['sva', 'Save Ann'], ['svb', 'Save Ben']]) assert.equal((await owner('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).status, 201);
  await login(a, 'sva@acme.com');
  const bid = (await login(b, 'svb@acme.com')).id;
  const priv = (await a('POST', '/api/chat/channels', { name: 'save-team', private: true, members: [bid] })).body.id;
  const m1 = (await a('POST', `/api/chat/channels/${priv}/messages`, { body: 'Quote is RM 4,500' })).body;
  const m2 = (await a('POST', `/api/chat/channels/${priv}/messages`, { body: 'Delivery on Friday' })).body;
  assert.equal((await b('PUT', `/api/chat/messages/${m1.id}/saved`, { saved: true })).body.saved, true);
  await new Promise((r) => setTimeout(r, 5));
  await b('PUT', `/api/chat/messages/${m2.id}/saved`, { saved: true });
  const list = (await b('GET', '/api/chat/saved')).body;
  assert.deepEqual(list.map((x) => [x.body, x.author, x.channel]), [['Delivery on Friday', 'Save Ann', 'save-team'], ['Quote is RM 4,500', 'Save Ann', 'save-team']], 'last saved first');
  assert.deepEqual((await a('GET', '/api/chat/saved')).body, [], 'yours only');
  await b('PUT', `/api/chat/messages/${m2.id}/saved`, { saved: false });
  assert.deepEqual((await b('GET', '/api/chat/saved')).body.map((x) => x.body), ['Quote is RM 4,500']);
  // Leaving the private channel: it drops out of the list, and can't be saved again.
  await b('DELETE', `/api/chat/channels/${priv}/members/me`);
  assert.deepEqual((await b('GET', '/api/chat/saved')).body, []);
  assert.equal((await b('PUT', `/api/chat/messages/${m2.id}/saved`, { saved: true })).status, 404);
});

test('drive storage: files, older versions, trash and the biggest items; clearing old versions', async () => {
  const a = client();
  assert.equal((await owner('POST', '/api/users', { local: 'stra', domain: 'acme.com', name: 'Store Ann', password: 'password123' })).status, 201);
  await login(a, 'stra@acme.com');
  const big = (await a('POST', '/api/files/upload?name=video.bin', Buffer.alloc(5000, 1), { raw: true })).body;
  assert.equal((await a('POST', `/api/files/${big.id}/versions`, Buffer.alloc(6000, 2), { raw: true })).status < 300, true);
  const small = (await a('POST', '/api/files/upload?name=note.txt', Buffer.from('hello'), { raw: true })).body;
  const old = (await a('POST', '/api/files/upload?name=old.zip', Buffer.alloc(2000, 3), { raw: true })).body;
  await a('PATCH', `/api/files/${old.id}`, { trashed: true });
  const s = (await a('GET', '/api/files/storage')).body;
  assert.equal(s.files, 6000 + 5);
  assert.equal(s.versions, 5000);
  assert.equal(s.trash, 2000);
  assert.ok(s.company.used >= 13005);
  assert.deepEqual(s.largest.map((f) => [f.name, f.size, f.versions, f.versions_size, f.trashed]), [['video.bin', 6000, 1, 5000, false], ['old.zip', 2000, 0, 0, true], ['note.txt', 5, 0, 0, false]]);
  void small;
  const cleared = (await a('DELETE', `/api/files/${big.id}/versions`)).body;
  assert.deepEqual(cleared, { deleted: 1, freed: 5000 });
  assert.equal((await a('GET', '/api/files/storage')).body.versions, 0);
  assert.equal((await a('GET', `/api/files/${big.id}/raw`)).body.length, 6000, 'the file itself stays');
  assert.equal((await owner('DELETE', `/api/files/${big.id}/versions`)).status, 404, 'only the owner');
});

test('admin: export the people as CSV (formula-like names kept as text); admins only', async () => {
  const a = client();
  assert.equal((await owner('POST', '/api/users', { local: 'expa', domain: 'acme.com', name: '=HYPERLINK("x")', password: 'password123' })).status, 201);
  await login(a, 'expa@acme.com');
  const r = await owner('GET', '/api/users/export');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/csv/);
  assert.match(r.headers.get('content-disposition'), /people\.csv/);
  const lines = r.body.replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(lines[0], 'Name,Email,Administrator,Status,Two-step verification,Drive storage (MB),Created,Last active,Job title,Department,Work phone,Manager');
  const row = lines.find((l) => l.includes('expa@acme.com'));
  assert.ok(row.startsWith(`"'=HYPERLINK(""x"")",expa@acme.com,no,active,off,0.0,`), row);
  assert.match(row, /,\d{4}-\d{2}-\d{2},,,,$/, 'last active, from the sign-in (then no job details)');
  assert.equal((await a('GET', '/api/users/export')).status, 403);
});

test('admin: when each person last used their account (signing in counts; signing out keeps it)', async () => {
  const a = client();
  assert.equal((await owner('POST', '/api/users', { local: 'lasta', domain: 'acme.com', name: 'Last Ann', password: 'password123' })).status, 201);
  const before = (await owner('GET', '/api/users')).body.find((u) => u.username === 'lasta@acme.com');
  assert.equal(before.last_active, null, 'never signed in');
  const t0 = Date.now();
  await login(a, 'lasta@acme.com');
  await a('POST', '/api/auth/logout');
  const after = (await owner('GET', '/api/users')).body.find((u) => u.username === 'lasta@acme.com');
  assert.ok(after.last_active >= t0 - 1000, 'kept after signing out');
  const csv = (await owner('GET', '/api/users/export')).body;
  assert.match(csv.split('\r\n').find((l) => l.includes('lasta@acme.com')), new RegExp(`,${new Date(after.last_active).toISOString().slice(0, 10)},,,,$`));
});

test('tasks: each person sorts a list their own way', async () => {
  const a = client(), b = client();
  for (const [local, name] of [['srta', 'Sort Ann'], ['srtb', 'Sort Ben']]) assert.equal((await owner('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).status, 201);
  await login(a, 'srta@acme.com');
  const bid = (await login(b, 'srtb@acme.com')).id;
  const list = (await a('POST', '/api/tasks/lists', { name: 'Shared sort' })).body.id;
  await a('PUT', `/api/tasks/lists/${list}/members`, { user_ids: [bid] });
  const sortOf = async (who) => (await who('GET', '/api/tasks/lists')).body.lists.find((l) => l.id === list).sort;
  assert.equal(await sortOf(a), 'mine');
  assert.equal((await a('PUT', `/api/tasks/lists/${list}/sort`, { sort: 'due' })).body.sort, 'due');
  assert.equal(await sortOf(a), 'due');
  assert.equal(await sortOf(b), 'mine', 'Ben keeps his own');
  assert.equal((await a('PUT', `/api/tasks/lists/${list}/sort`, { sort: 'colour' })).status, 400);
  await a('PUT', `/api/tasks/lists/${list}/sort`, { sort: 'mine' });
  assert.equal(await sortOf(a), 'mine');
});

test('comments on presentations: anchored to a slide; mentions link to the presentation', async () => {
  const a = client(), b = client();
  for (const [local, name] of [['cma', 'Slide Ann'], ['cmb', 'Slide Ben']]) assert.equal((await owner('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).status, 201);
  await login(a, 'cma@acme.com');
  const bid = (await login(b, 'cmb@acme.com')).id;
  const deck = (await a('POST', '/api/files/new', { kind: 'slides', name: 'Pitch' })).body;
  await a('PUT', `/api/files/${deck.id}/shares`, { shares: [{ user_id: bid, role: 'editor' }] });
  const c = await a('POST', `/api/comments/${deck.id}`, { body: 'Shorter title here, @cmb@acme.com?', anchor: { slide: 's_1' } });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  assert.deepEqual(c.body.comment.anchor, { slide: 's_1' });
  assert.deepEqual(c.body.notified, ['cmb@acme.com']);
  assert.equal((await a('POST', `/api/comments/${deck.id}`, { body: 'x', anchor: { slide: 'bad id!' } })).status, 400);
  const list = (await b('GET', `/api/comments/${deck.id}`)).body;
  assert.equal(list.length, 1);
  const reply = await b('POST', `/api/comments/${deck.id}`, { body: 'Done', thread_id: c.body.comment.id });
  assert.equal(reply.status, 201);
  const dms = (await b('GET', '/api/chat/channels')).body.channels.filter((x) => x.dm_key);
  const msgs = (await b('GET', `/api/chat/channels/${dms[0].id}/messages`)).body;
  assert.ok(msgs.some((m) => m.body.includes(`/slides/${deck.id}?comment=`)), 'the mention links to the slide');
});

test('tasks: comments on a task, seen by everyone on the list; the people involved are told', async () => {
  const a = client(), b = client(), c = client();
  for (const [local, name] of [['tca', 'Talk Ann'], ['tcb', 'Talk Ben'], ['tcc', 'Talk Cat']]) assert.equal((await owner('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).status, 201);
  await login(a, 'tca@acme.com');
  const bid = (await login(b, 'tcb@acme.com')).id;
  await login(c, 'tcc@acme.com');
  const list = (await a('POST', '/api/tasks/lists', { name: 'Launch' })).body.id;
  await a('PUT', `/api/tasks/lists/${list}/members`, { user_ids: [bid] });
  const t = (await a('POST', `/api/tasks/lists/${list}/tasks`, { title: 'Book venue', assignee_id: bid })).body;
  const c1 = await a('POST', `/api/tasks/tasks/${t.id}/comments`, { body: 'Hotel or hall?' });
  assert.equal(c1.status, 201);
  const bell = async (who) => (await who('GET', '/api/notifications')).body;
  const benBell = await bell(b);
  assert.ok(JSON.stringify(benBell).includes('Talk Ann commented on “Book venue”'), 'the assignee is told');
  await b('POST', `/api/tasks/tasks/${t.id}/comments`, { body: 'Hall, cheaper' });
  assert.ok(JSON.stringify(await bell(a)).includes('Talk Ben commented'), 'the creator (and earlier commenter) is told');
  const list2 = (await b('GET', `/api/tasks/tasks/${t.id}/comments`)).body;
  assert.deepEqual(list2.map((x) => [x.author_name, x.body]), [['Talk Ann', 'Hotel or hall?'], ['Talk Ben', 'Hall, cheaper']]);
  assert.equal((await a('GET', `/api/tasks/lists/${list}/tasks`)).body.find((x) => x.id === t.id).comments, 2);
  assert.equal((await c('GET', `/api/tasks/tasks/${t.id}/comments`)).status, 404, 'not for people off the list');
  assert.equal((await a('DELETE', `/api/tasks/tasks/${t.id}/comments/${list2[1].id}`)).status, 404, 'only your own');
  assert.equal((await b('DELETE', `/api/tasks/tasks/${t.id}/comments/${list2[1].id}`)).status, 200);
  assert.equal((await a('POST', `/api/tasks/tasks/${t.id}/comments`, { body: '  ' })).status, 400);
});

test('drive: who can open a document but not a file it links to', async () => {
  const a = client(), b = client(), c = client();
  for (const [local, name] of [['gapa', 'Gap Ann'], ['gapb', 'Gap Ben'], ['gapc', 'Gap Cat']]) assert.equal((await owner('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).status, 201);
  await login(a, 'gapa@acme.com');
  const bid = (await login(b, 'gapb@acme.com')).id;
  const cid = (await login(c, 'gapc@acme.com')).id;
  const doc = (await a('POST', '/api/files/new', { kind: 'doc', name: 'Report' })).body;
  const sheet = (await a('POST', '/api/files/new', { kind: 'sheet', name: 'Figures' })).body;
  await a('PUT', `/api/files/${doc.id}/shares`, { shares: [{ user_id: bid, role: 'viewer' }, { user_id: cid, role: 'editor' }] });
  await a('PUT', `/api/files/${sheet.id}/shares`, { shares: [{ user_id: cid, role: 'viewer' }] });
  const gap = (await a('GET', `/api/files/${sheet.id}/missing-access?for=${doc.id}`)).body;
  assert.deepEqual(gap.people.map((p) => p.name), ['Gap Ben']);
  assert.equal(gap.can_share, true);
  assert.equal((await c('GET', `/api/files/${sheet.id}/missing-access?for=${doc.id}`)).body.can_share, false, 'Cat can open both but owns neither');
  assert.equal((await b('GET', `/api/files/${sheet.id}/missing-access?for=${doc.id}`)).status, 404, 'Ben can’t open the sheet');
});

test('chat: who in a conversation can’t open a linked Drive file', async () => {
  const a = client(), b = client(), c = client();
  for (const [local, name] of [['clka', 'Link Ann'], ['clkb', 'Link Ben'], ['clkc', 'Link Cat']]) assert.equal((await owner('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).status, 201);
  await login(a, 'clka@acme.com');
  const bid = (await login(b, 'clkb@acme.com')).id;
  const cid = (await login(c, 'clkc@acme.com')).id;
  const sheet = (await a('POST', '/api/files/new', { kind: 'sheet', name: 'Budget' })).body;
  const priv = (await a('POST', '/api/chat/channels', { name: 'clk-team', private: true, members: [bid, cid] })).body.id;
  await a('PUT', `/api/files/${sheet.id}/shares`, { shares: [{ user_id: cid, role: 'viewer' }] });
  const gap = (await a('GET', `/api/chat/channels/${priv}/missing-access?file=${sheet.id}`)).body;
  assert.deepEqual([gap.people.map((p) => p.name), gap.total, gap.everyone, gap.can_share], [['Link Ben'], 1, false, true]);
  assert.equal((await c('GET', `/api/chat/channels/${priv}/missing-access?file=${sheet.id}`)).body.can_share, false);
  assert.equal((await b('GET', `/api/chat/channels/${priv}/missing-access?file=${sheet.id}`)).status, 404, 'Ben can’t open it');
  const general = (await a('GET', '/api/chat/channels')).body.channels.find((x) => !x.dm_key && !x.private);
  const pub = (await a('GET', `/api/chat/channels/${general.id}/missing-access?file=${sheet.id}`)).body;
  assert.equal(pub.everyone, true);
  assert.ok(pub.total >= 1);
});

test('drive: before emailing links, which recipients can’t open which files', async () => {
  const a = client(), b = client();
  for (const [local, name] of [['mla', 'Mail Ann'], ['mlb', 'Mail Ben']]) assert.equal((await owner('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).status, 201);
  await login(a, 'mla@acme.com');
  await login(b, 'mlb@acme.com');
  const mine = (await a('POST', '/api/files/new', { kind: 'doc', name: 'Plan' })).body;
  const theirs = (await b('POST', '/api/files/new', { kind: 'doc', name: 'Ben notes' })).body;
  const open = (await a('POST', '/api/files/new', { kind: 'sheet', name: 'Shared sheet' })).body;
  const bid = (await b('GET', '/api/auth/me')).body.user.id;
  await a('PUT', `/api/files/${open.id}/shares`, { shares: [{ user_id: bid, role: 'viewer' }] });
  const r = (await a('POST', '/api/files/missing-access', { files: [mine.id, theirs.id, open.id], emails: ['MLB@acme.com', 'someone@outside.example'] })).body;
  assert.deepEqual(r.map((f) => [f.name, f.can_share, f.people.map((p) => p.username)]), [['Plan', true, ['mlb@acme.com']]], 'Ben’s own file and the shared one are fine; outsiders aren’t counted');
  assert.deepEqual((await a('POST', '/api/files/missing-access', { files: [mine.id], emails: [] })).body, []);
});

test('calendar: a guest proposes a new time; the organizer is told and moving the event clears it', async () => {
  const a = client(), b = client();
  for (const [local, name] of [['ppa', 'Prop Ann'], ['ppb', 'Prop Ben']]) assert.equal((await owner('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).status, 201);
  await login(a, 'ppa@acme.com');
  await login(b, 'ppb@acme.com');
  const h = 36e5, day = Date.UTC(2026, 11, 7);
  const ev = (await a('POST', '/api/events', { title: 'Review', start: day + 9 * h, end: day + 10 * h, guests: ['ppb@acme.com'] })).body;
  assert.equal((await b('POST', `/api/events/${ev.id}/propose`, { start: day + 14 * h, end: day + 13 * h })).status, 400);
  const p = await b('POST', `/api/events/${ev.id}/propose`, { start: day + 14 * h, end: day + 15 * h, note: 'Morning is full', tz: 'UTC' });
  assert.equal(p.status, 200);
  assert.equal(p.body.status, 'maybe');
  const seen = (await a('GET', `/api/events?from=${day}&to=${day + 864e5}`)).body.find((x) => x.id === ev.id);
  const ben = seen.guests.find((g) => g.email === 'ppb@acme.com');
  assert.deepEqual([ben.status, ben.proposed_start, ben.proposed_end, ben.proposal_note], ['maybe', day + 14 * h, day + 15 * h, 'Morning is full']);
  assert.ok(JSON.stringify((await a('GET', '/api/notifications')).body).includes('Prop Ben proposed a new time for “Review”'));
  assert.equal((await a('POST', `/api/events/${ev.id}/propose`, { start: day, end: day + h })).status, 404, 'only guests propose');
  // The organizer takes it: the proposal is gone.
  await a('PATCH', `/api/events/${ev.id}`, { start: day + 14 * h, end: day + 15 * h });
  const after = (await a('GET', `/api/events?from=${day}&to=${day + 864e5}`)).body.find((x) => x.id === ev.id).guests.find((g) => g.email === 'ppb@acme.com');
  assert.equal(after.proposed_start, null);
});

test('docs: @mentioning someone in the text notifies them, or says they can’t open it', async () => {
  const a = client(), b = client(), c = client();
  for (const [local, name] of [['dma', 'Doc Ann'], ['dmb', 'Doc Ben'], ['dmc', 'Doc Cat']]) assert.equal((await owner('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).status, 201);
  await login(a, 'dma@acme.com');
  const bid = (await login(b, 'dmb@acme.com')).id;
  const cid = (await login(c, 'dmc@acme.com')).id;
  const doc = (await a('POST', '/api/files/new', { kind: 'doc', name: 'Brief' })).body;
  await a('PUT', `/api/files/${doc.id}/shares`, { shares: [{ user_id: bid, role: 'viewer' }] });
  assert.deepEqual((await a('POST', `/api/files/${doc.id}/mention`, { user_id: bid })).body, { notified: true, name: 'Doc Ben' });
  assert.ok(JSON.stringify((await b('GET', '/api/notifications')).body).includes('Doc Ann mentioned you in “Brief”'));
  assert.equal((await a('POST', `/api/files/${doc.id}/mention`, { user_id: bid })).body.recently, true, 'not twice in a row');
  assert.deepEqual((await a('POST', `/api/files/${doc.id}/mention`, { user_id: cid })).body, { notified: false, no_access: true, can_share: true, name: 'Doc Cat' });
  assert.equal((await b('POST', `/api/files/${doc.id}/mention`, { user_id: cid })).status, 403, 'viewers don’t write mentions');
});

test('drive: follow a file and hear when someone else changes it (once an hour)', async () => {
  const a = client(), b = client();
  for (const [local, name] of [['wta', 'Watch Ann'], ['wtb', 'Watch Ben']]) assert.equal((await owner('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).status, 201);
  await login(a, 'wta@acme.com');
  const bid = (await login(b, 'wtb@acme.com')).id;
  const f = (await a('POST', '/api/files/upload?name=prices.csv', Buffer.from('a,b'), { raw: true })).body;
  await a('PUT', `/api/files/${f.id}/shares`, { shares: [{ user_id: bid, role: 'editor' }] });
  assert.equal((await a('GET', `/api/files/${f.id}/watch`)).body.watching, false);
  assert.equal((await a('PUT', `/api/files/${f.id}/watch`, { on: true })).body.watching, true);
  const told = async () => JSON.stringify((await a('GET', '/api/notifications')).body).split('Watch Ben changed “prices.csv”').length - 1;
  await a('POST', `/api/files/${f.id}/versions`, Buffer.from('a,b,c'), { raw: true });
  assert.equal(await told(), 0, 'your own changes don’t count');
  await b('POST', `/api/files/${f.id}/versions`, Buffer.from('a,b,c,d'), { raw: true });
  assert.equal(await told(), 1);
  await b('POST', `/api/files/${f.id}/versions`, Buffer.from('a,b,c,d,e'), { raw: true });
  assert.equal(await told(), 1, 'not again within the hour');
  await a('PUT', `/api/files/${f.id}/watch`, { on: false });
  assert.equal((await a('GET', `/api/files/${f.id}/watch`)).body.watching, false);
});

test('notifications: turn kinds off; those stop, others still come', async () => {
  const a = client(), b = client();
  for (const [local, name] of [['nsa', 'Set Ann'], ['nsb', 'Set Ben']]) assert.equal((await owner('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).status, 201);
  await login(a, 'nsa@acme.com');
  const bid = (await login(b, 'nsb@acme.com')).id;
  const s0 = (await b('GET', '/api/notifications/settings')).body;
  assert.ok(s0.kinds.every((k) => k.on) && s0.kinds.some((k) => k.kind === 'share'));
  const s1 = (await b('PUT', '/api/notifications/settings', { off: ['share', 'nonsense'] })).body;
  assert.deepEqual(s1.kinds.filter((k) => !k.on).map((k) => k.kind), ['share']);
  const doc = (await a('POST', '/api/files/new', { kind: 'doc', name: 'Quiet doc' })).body;
  await a('PUT', `/api/files/${doc.id}/shares`, { shares: [{ user_id: bid, role: 'viewer' }] });
  assert.ok(!JSON.stringify((await b('GET', '/api/notifications')).body).includes('Quiet doc'), 'no share notification');
  await a('POST', `/api/files/${doc.id}/mention`, { user_id: bid });
  assert.ok(JSON.stringify((await b('GET', '/api/notifications')).body).includes('mentioned you in “Quiet doc”'), 'mentions still come');
  assert.equal((await b('PUT', '/api/notifications/settings', { off: [] })).body.kinds.every((k) => k.on), true);
});

test('drive: follow a folder and hear when someone adds or changes something in it', async () => {
  const a = client(), b = client();
  for (const [local, name] of [['fwa', 'Folder Ann'], ['fwb', 'Folder Ben']]) assert.equal((await owner('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).status, 201);
  await login(a, 'fwa@acme.com');
  const bid = (await login(b, 'fwb@acme.com')).id;
  const folder = (await a('POST', '/api/files/folder', { name: 'Invoices' })).body;
  const sub = (await a('POST', '/api/files/folder', { name: '2026', parent_id: folder.id })).body;
  await a('PUT', `/api/files/${folder.id}/shares`, { shares: [{ user_id: bid, role: 'editor' }] });
  assert.equal((await a('PUT', `/api/files/${folder.id}/watch`, { on: true })).body.watching, true);
  const bell = async () => JSON.stringify((await a('GET', '/api/notifications')).body);
  await a('POST', `/api/files/upload?name=mine.pdf&parent=${folder.id}`, Buffer.from('x'), { raw: true });
  assert.ok(!(await bell()).includes('mine.pdf'), 'not your own');
  await b('POST', `/api/files/upload?name=march.pdf&parent=${sub.id}`, Buffer.from('x'), { raw: true });
  assert.ok((await bell()).includes('Folder Ben added “march.pdf” in “Invoices”'), 'in a subfolder too');
  await b('POST', `/api/files/upload?name=april.pdf&parent=${folder.id}`, Buffer.from('x'), { raw: true });
  assert.ok(!(await bell()).includes('april.pdf'), 'once an hour');
});

test('announcements: an admin posts one; everyone sees it until they dismiss it or it ends', async () => {
  const a = client();
  assert.equal((await owner('POST', '/api/users', { local: 'annc', domain: 'acme.com', name: 'Ann Nounce', password: 'password123' })).status, 201);
  await login(a, 'annc@acme.com');
  assert.equal((await a('POST', '/api/announcements', { text: 'Not allowed' })).status, 403, 'admins only');
  assert.equal((await owner('POST', '/api/announcements', { text: 'x', link: 'javascript:alert(1)' })).status, 400);
  const ann = (await owner('POST', '/api/announcements', { text: 'Office closed Friday', link: '/calendar', tone: 'warn' })).body;
  const old = (await owner('POST', '/api/announcements', { text: 'Ends soon', until: Date.now() + 300 })).body;
  let mine = (await a('GET', '/api/announcements')).body;
  assert.deepEqual(mine.map((x) => x.text), ['Ends soon', 'Office closed Friday']);
  assert.equal(mine.find((x) => x.id === ann.id).tone, 'warn');
  await new Promise((r) => setTimeout(r, 350));
  assert.deepEqual((await a('GET', '/api/announcements')).body.map((x) => x.text), ['Office closed Friday'], 'ended ones go');
  await a('POST', `/api/announcements/${ann.id}/dismiss`);
  assert.deepEqual((await a('GET', '/api/announcements')).body, [], 'dismissed');
  assert.equal((await owner('GET', '/api/announcements/all')).body.find((x) => x.id === ann.id).dismissed, 1);
  assert.equal((await owner('DELETE', `/api/announcements/${ann.id}`)).status, 200);
  assert.ok(!(await owner('GET', '/api/announcements/all')).body.some((x) => x.id === ann.id));
  void old;
});

test('forms: questions are tidied and answers checked', async () => {
  const { cleanQuestions, checkAnswers, responseTable } = await import('../src/routes/forms.js');
  const qs = cleanQuestions([
    { id: 'name', type: 'short', title: 'Your name', required: true },
    { id: 'lunch', type: 'choice', title: 'Lunch', options: ['Fish', ' Veg ', 'Veg', ''] },
    { id: 'days', type: 'checkbox', title: 'Days', options: ['Mon', 'Tue', 'Wed'] },
    { id: 'rate', type: 'scale', title: 'Rate', max: 7 },
    { id: 'when', type: 'date', title: 'When' },
    { type: 'nonsense', title: 'x', options: ['a'] },
  ]);
  assert.deepEqual(qs[1].options, ['Fish', 'Veg'], 'trimmed, no blanks or repeats');
  assert.equal(qs[3].max, 5, 'scales go to 5 or 10');
  assert.equal(qs[5].type, 'short');
  assert.equal(qs[5].options, undefined, 'only choice questions have options');
  assert.throws(() => checkAnswers(qs, {}), /Your name: this question needs an answer/);
  assert.throws(() => checkAnswers(qs, { name: 'A', lunch: 'Meat' }), /choose from the options/);
  assert.throws(() => checkAnswers(qs, { name: 'A', rate: 6 }), /1 to 5/);
  assert.throws(() => checkAnswers(qs, { name: 'A', when: 'tomorrow' }), /enter a date/);
  const a = checkAnswers(qs, { name: '  Ann ', lunch: 'Veg', days: ['Wed', 'Mon', 'Mon'], rate: '4', extra: 'ignored', when: '' });
  assert.deepEqual(a, { name: 'Ann', lunch: 'Veg', days: ['Mon', 'Wed'], rate: 4 });
  const table = responseTable({ questions: qs, audience: 'public' }, [{ created_at: 0, answers: a }]);
  assert.deepEqual(table[0].slice(0, 3), ['Submitted', 'Your name', 'Lunch']);
  assert.equal(table[1][3], 'Mon; Wed');
});

test('forms: build one, share the link, collect and read responses', async () => {
  const fa = client();
  const outsider = client();
  assert.equal((await owner('POST', '/api/users', { local: 'frma', domain: 'acme.com', name: 'Fran Former', password: 'password123' })).status, 201);
  assert.equal((await owner('POST', '/api/users', { local: 'frmb', domain: 'acme.com', name: 'Rex Responder', password: 'password123' })).status, 201);
  await login(fa, 'frma@acme.com');
  const rb = client();
  await login(rb, 'frmb@acme.com');
  const made = await fa('POST', '/api/forms', { title: 'Team lunch' });
  assert.equal(made.status, 201);
  const f = (await fa('PUT', `/api/forms/${made.body.id}`, { description: 'Pick one', confirmation: 'Thanks!', one_per_person: true, questions: [
    { id: 'food', type: 'choice', title: 'Food', options: ['Pizza', 'Sushi'], required: true },
    { id: 'note', type: 'paragraph', title: 'Anything else?' },
  ] })).body;
  assert.equal(f.questions.length, 2);
  assert.equal((await rb('GET', `/api/forms/${f.id}`)).status, 404, 'only the owner edits it');

  // A company form: sign-in needed, same company only, one each.
  assert.equal((await outsider('GET', `/api/public/forms/${f.token}`)).status, 401);
  const other = client();
  assert.equal((await owner('POST', '/api/orgs', { name: 'Formco', domain: 'formco.com', admin_name: 'Fo Admin', admin_local: 'fo', admin_password: 'password123' })).status, 201);
  await login(other, 'fo@formco.com');
  assert.equal((await other('GET', `/api/public/forms/${f.token}`)).status, 403, 'other companies');
  const seen = (await rb('GET', `/api/public/forms/${f.token}`)).body;
  assert.equal(seen.title, 'Team lunch');
  assert.equal(seen.answered, false);
  assert.equal((await rb('POST', `/api/public/forms/${f.token}`, { answers: {} })).status, 400, 'required');
  const sent = await rb('POST', `/api/public/forms/${f.token}`, { answers: { food: 'Sushi', note: '=cmd()' } });
  assert.equal(sent.status, 201);
  assert.equal(sent.body.confirmation, 'Thanks!');
  assert.equal((await rb('GET', `/api/public/forms/${f.token}`)).body.answered, true);
  assert.equal((await rb('POST', `/api/public/forms/${f.token}`, { answers: { food: 'Pizza' } })).status, 409, 'one each');
  const bell = (await fa('GET', '/api/notifications')).body.items.find((n) => n.kind === 'form');
  assert.match(bell.title, /Team lunch/);
  assert.equal(bell.body, 'From Rex Responder');

  const resp = (await fa('GET', `/api/forms/${f.id}/responses`)).body;
  assert.equal(resp.responses.length, 1);
  assert.deepEqual(resp.responses[0].user, { name: 'Rex Responder', email: 'frmb@acme.com' });
  const csv = await fa('GET', `/api/forms/${f.id}/responses.csv`);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.body, /Submitted,Name,Email,Food,Anything else\?/);
  assert.match(csv.body, /Rex Responder,frmb@acme\.com,Sushi,'=cmd\(\)/, 'formulas defused');
  const sheet = await fa('POST', `/api/forms/${f.id}/sheet`);
  assert.equal(sheet.status, 201);
  const file = (await fa('GET', `/api/files/${sheet.body.id}`)).body;
  assert.equal(file.name, 'Team lunch (responses)');
  const { content } = (await fa('GET', `/api/files/${sheet.body.id}/content`)).body;
  assert.equal(content.sheets[0].cells.D2, 'Sushi');
  assert.equal(content.sheets[0].frozen.rows, 1);
  assert.equal((await fa('GET', '/api/forms')).body.find((x) => x.id === f.id).responses, 1);

  // Anyone with the link: no sign-in, no names kept; closing stops it; a new link drops the old one.
  const pub = (await fa('PUT', `/api/forms/${f.id}`, { audience: 'public' })).body;
  assert.equal((await outsider('POST', `/api/public/forms/${pub.token}`, { answers: { food: 'Pizza' } })).status, 201);
  const all = (await fa('GET', `/api/forms/${f.id}/responses`)).body.responses;
  assert.equal(all.length, 2);
  assert.equal(all[1].user, null);
  await fa('PUT', `/api/forms/${f.id}`, { accepting: false });
  assert.equal((await outsider('POST', `/api/public/forms/${pub.token}`, { answers: { food: 'Pizza' } })).status, 409);
  assert.equal((await outsider('GET', `/api/public/forms/${pub.token}`)).body.accepting, false);
  const fresh = (await fa('POST', `/api/forms/${f.id}/new-link`)).body;
  assert.notEqual(fresh.token, pub.token);
  assert.equal((await outsider('GET', `/api/public/forms/${pub.token}`)).status, 404);
  // A company with links turned off closes public forms.
  await owner('PATCH', '/api/orgs/current', { allow_links: false });
  assert.equal((await outsider('GET', `/api/public/forms/${fresh.token}`)).status, 403);
  await owner('PATCH', '/api/orgs/current', { allow_links: true });

  const copy = (await fa('POST', `/api/forms/${f.id}/copy`)).body;
  assert.equal(copy.title, 'Copy of Team lunch');
  assert.equal(copy.questions.length, 2);
  assert.equal((await fa('DELETE', `/api/forms/${f.id}/responses/${all[0].id}`)).status, 200);
  assert.equal((await fa('DELETE', `/api/forms/${f.id}/responses`)).body.deleted, 1);
  assert.equal((await fa('DELETE', `/api/forms/${f.id}`)).status, 200);
  assert.equal((await outsider('GET', `/api/public/forms/${fresh.token}`)).status, 404);
});

test('forms: editors, closing date and response limit', async () => {
  const own = client(); const ed = client(); const visitor = client();
  for (const [local, name] of [['fea', 'Fay Owner'], ['feb', 'Eddie Editor']]) {
    assert.equal((await owner('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).status, 201);
  }
  await login(own, 'fea@acme.com');
  await login(ed, 'feb@acme.com');
  const f = (await own('POST', '/api/forms', { title: 'Offsite', questions: [{ id: 'q', type: 'short', title: 'Ideas' }] })).body;
  assert.equal((await ed('GET', `/api/forms/${f.id}`)).status, 404);
  assert.equal((await own('POST', `/api/forms/${f.id}/editors`, { email: 'nobody@acme.com' })).status, 400);
  const eds = (await own('POST', `/api/forms/${f.id}/editors`, { email: 'FEB@acme.com' })).body;
  assert.deepEqual(eds.map((u) => u.name), ['Eddie Editor']);
  assert.ok((await ed('GET', '/api/notifications')).body.items.some((n) => /added you to the form “Offsite”/.test(n.title)));
  const seen = (await ed('GET', '/api/forms')).body.find((x) => x.id === f.id);
  assert.equal(seen.owner_name, 'Fay Owner', 'shown as shared');
  const got = (await ed('GET', `/api/forms/${f.id}`)).body;
  assert.equal(got.role, 'editor');
  assert.equal((await ed('PUT', `/api/forms/${f.id}`, { title: 'Offsite 2027' })).body.title, 'Offsite 2027', 'editors can edit');
  assert.equal((await ed('POST', `/api/forms/${f.id}/editors`, { email: 'owner@acme.com' })).status, 403, 'only the owner adds people');
  assert.equal((await ed('DELETE', `/api/forms/${f.id}`)).status, 403, 'only the owner deletes');

  // Response limit, then a closing time.
  await own('PUT', `/api/forms/${f.id}`, { audience: 'public', max_responses: 1 });
  assert.equal((await own('PUT', `/api/forms/${f.id}`, { max_responses: 0 })).status, 400);
  assert.equal((await visitor('POST', `/api/public/forms/${f.token}`, { answers: { q: 'Beach' } })).status, 201);
  const full = await visitor('POST', `/api/public/forms/${f.token}`, { answers: { q: 'Hills' } });
  assert.equal(full.status, 409);
  assert.match(full.body.error, /all the responses it needs/);
  assert.equal((await visitor('GET', `/api/public/forms/${f.token}`)).body.closed, 'full');
  const bells = (await ed('GET', '/api/notifications')).body.items.filter((n) => n.kind === 'form');
  assert.equal(bells.length, 1, 'editors hear about responses too');
  assert.equal((await ed('GET', `/api/forms/${f.id}/responses`)).body.responses.length, 1, 'and read them');
  await own('PUT', `/api/forms/${f.id}`, { max_responses: null, close_at: Date.now() - 1000 });
  const g = await visitor('GET', `/api/public/forms/${f.token}`);
  assert.equal(g.body.accepting, false);
  assert.equal(g.body.closed_text, 'This form closed');
  assert.equal((await own('GET', `/api/forms/${f.id}`)).body.closed, 'ended');
  await own('PUT', `/api/forms/${f.id}`, { close_at: Date.now() + 864e5 });
  assert.equal((await visitor('POST', `/api/public/forms/${f.token}`, { answers: { q: 'Lake' } })).status, 201);

  // An editor can leave; then it's gone for them.
  assert.deepEqual((await ed('DELETE', `/api/forms/${f.id}/editors/${got.editors[0].id}`)).body, []);
  assert.equal((await ed('GET', `/api/forms/${f.id}`)).status, 404);
  assert.equal((await own('DELETE', `/api/forms/${f.id}`)).status, 200);
});

test('meet: start a meeting, join its room, signals pass between people', async () => {
  const { default: WS } = await import('ws');
  const { newCode, validCode, iceServers } = await import('../src/meet.js');
  assert.ok(validCode(newCode()));
  assert.equal(validCode('abc-defg-hi1'), false);
  assert.deepEqual(iceServers('[{"urls":"stun:stun.example.com:3478"},{"bad":1}]'), [{ urls: 'stun:stun.example.com:3478' }]);
  assert.deepEqual(iceServers('not json'), []);

  const cookieFor = async (local, name) => {
    assert.equal((await owner('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).status, 201);
    const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: `${local}@acme.com`, password: 'password123' }) });
    return r.headers.get('set-cookie').split(';')[0];
  };
  const ca = await cookieFor('mta', 'Mia Meet');
  const cb = await cookieFor('mtb', 'Max Meet');
  const call = (cookie, method, url, body) => fetch(base + url, { method, headers: { cookie, 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: body && JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const made = await call(ca, 'POST', '/api/meet', { title: 'Standup' });
  assert.equal(made.status, 201);
  const { code } = made.body;
  assert.equal((await call(cb, 'GET', '/api/meet/abc-defg-hij')).status, 404);
  assert.equal((await call(cb, 'GET', `/api/meet/${code}`)).body.title, 'Standup');

  const open = (cookie, q = '') => new Promise((resolve, reject) => {
    const ws = new WS(`${base.replace('http', 'ws')}/ws/meet/${code}${q}`, { headers: { cookie } });
    const inbox = [];
    ws.on('message', (d) => inbox.push(JSON.parse(String(d))));
    ws.on('open', () => resolve({ ws, inbox, next: async (type) => { for (let i = 0; i < 100; i++) { const k = inbox.findIndex((m) => m.type === type); if (k >= 0) return inbox.splice(k, 1)[0]; await new Promise((r) => setTimeout(r, 20)); } throw new Error(`no ${type}`); } }));
    ws.on('error', reject);
  });
  const a = await open(ca, '?cam=0');
  const wa = await a.next('welcome');
  assert.deepEqual(wa.peers, []);
  const b = await open(cb);
  const wb = await b.next('welcome');
  assert.equal(wb.peers.length, 1);
  assert.equal(wb.peers[0].user.name, 'Mia Meet');
  assert.equal(wb.peers[0].state.cam, false, 'came in with the camera off');
  const joined = await a.next('joined');
  assert.equal(joined.peer.user.name, 'Max Meet');
  assert.equal((await call(ca, 'GET', `/api/meet/${code}`)).body.people.length, 2);

  b.ws.send(JSON.stringify({ type: 'signal', to: wa.id, data: { sdp: 'offer' } }));
  const sig = await a.next('signal');
  assert.equal(sig.from, wb.id);
  assert.deepEqual(sig.data, { sdp: 'offer' });
  a.ws.send(JSON.stringify({ type: 'state', state: { mic: false, hand: true, bogus: 1 } }));
  const st = await b.next('state');
  assert.deepEqual(st.state, { mic: false, cam: false, hand: true, screen: false });
  b.ws.send(JSON.stringify({ type: 'chat', text: '  hello  ' }));
  assert.equal((await a.next('chat')).text, 'hello');
  b.ws.send(JSON.stringify({ type: 'react', emoji: '💣' }));
  b.ws.send(JSON.stringify({ type: 'react', emoji: '👍' }));
  assert.equal((await a.next('react')).emoji, '👍', 'only the offered reactions');

  // Another company can't get in.
  const outside = (await owner('POST', '/api/orgs', { name: 'Meetco', domain: 'meetco.com', admin_name: 'Mo', admin_local: 'mo', admin_password: 'password123' }));
  assert.equal(outside.status, 201);
  assert.equal((await owner('PATCH', `/api/orgs/${outside.body.id}`, { allow_external: false })).status, 200, 'and they keep to themselves');
  const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'mo@meetco.com', password: 'password123' }) });
  const co = r.headers.get('set-cookie').split(';')[0];
  assert.equal((await call(co, 'GET', `/api/meet/${code}`)).status, 403);
  await assert.rejects(open(co));

  b.ws.close();
  assert.equal((await a.next('left')).id, wb.id);
  a.ws.close();
  const mine = (await call(cb, 'GET', '/api/meet')).body;
  assert.equal(mine[0].code, code, 'recent meetings include ones you joined');
});

test('meet: a video meeting on a calendar event', async () => {
  const org = client(); const guest = client();
  for (const [local, name] of [['mca', 'Cal Organizer'], ['mcb', 'Gus Guest']]) {
    assert.equal((await owner('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).status, 201);
  }
  await login(org, 'mca@acme.com');
  await login(guest, 'mcb@acme.com');
  const { code } = (await org('POST', '/api/meet', { title: 'Planning' })).body;
  const t = Date.now() + 864e5;
  assert.equal((await org('POST', '/api/events', { title: 'Planning', start: t, end: t + 36e5, meet_code: 'abc-defg-hij' })).status, 400, 'must be a real meeting');
  const ev = (await org('POST', '/api/events', { title: 'Planning', start: t, end: t + 36e5, meet_code: code, guests: ['mcb@acme.com'] })).body;
  assert.equal(ev.meet_code, code);
  const seen = (await guest('GET', `/api/events?from=${t - 1}&to=${t + 864e5}`)).body;
  assert.equal(seen.find((e) => e.id === ev.id)?.meet_code, code, 'guests see the meeting');
  const { buildIcs } = await import('../src/ics.js');
  process.env.PUBLIC_URL = 'https://work.example.com/';
  assert.match(buildIcs({ ...ev, exdates: [] }, {}), new RegExp(`URL:https://work.example.com/meet/${code}`));
  delete process.env.PUBLIC_URL;
  assert.equal((await org('PATCH', `/api/events/${ev.id}`, { meet_code: null })).body.meet_code, null, 'removed');
  const ooo = (await org('POST', '/api/events', { title: 'Away', kind: 'ooo', start: t, end: t + 36e5, meet_code: code })).body;
  assert.equal(ooo.meet_code, null, 'time off has no meeting');
});

test('groups: share with a group; joining and leaving it gives and takes access', async () => {
  const own = client(); const a = client(); const b = client();
  const ids = {};
  for (const [local, name] of [['gro', 'Gil Owner'], ['gra', 'Gwen A'], ['grb', 'Gus B']]) {
    const r = await owner('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' });
    assert.equal(r.status, 201);
    ids[local] = r.body.id;
  }
  await login(own, 'gro@acme.com'); await login(a, 'gra@acme.com'); await login(b, 'grb@acme.com');
  assert.equal((await own('POST', '/api/groups', { name: 'Marketing' })).status, 403, 'admins make groups');
  const g = (await owner('POST', '/api/groups', { name: 'Marketing', description: 'The marketing team' })).body;
  assert.equal((await owner('POST', '/api/groups', { name: 'marketing' })).status, 400, 'names are unique');
  await owner('PUT', `/api/groups/${g.id}/members`, { user_ids: [ids.gra] });
  assert.ok((await own('GET', '/api/groups')).body.some((x) => x.name === 'Marketing' && x.members.length === 1), 'everyone sees groups');

  const folder = (await own('POST', '/api/files/folder', { name: 'Campaigns' })).body;
  const doc = (await own('POST', '/api/files/new', { kind: 'doc', name: 'Plan', parent_id: folder.id })).body;
  assert.equal((await a('GET', `/api/files/${doc.id}`)).status, 404);
  const set = await own('PUT', `/api/files/${folder.id}/groups`, { groups: [{ group_id: g.id, role: 'editor' }] });
  assert.equal(set.status, 200);
  assert.equal(set.body[0].name, 'Marketing');
  assert.equal((await a('GET', `/api/files/${doc.id}`)).body.role, 'editor', 'members get it, and what is inside');
  assert.ok((await a('GET', '/api/notifications')).body.items.some((n) => /shared “Campaigns” with the group Marketing/.test(n.title)));
  assert.equal((await b('GET', `/api/files/${doc.id}`)).status, 404);

  // Joining gives access; it shows in Shared with me.
  await owner('PUT', `/api/groups/${g.id}/members`, { user_ids: [ids.gra, ids.grb] });
  assert.equal((await b('GET', `/api/files/${doc.id}`)).body.role, 'editor');
  assert.ok((await b('GET', '/api/notifications')).body.items.some((n) => /added you to the group “Marketing”/.test(n.title)));
  // Direct shares sit alongside: the person list only shows people shared with one by one.
  await own('PUT', `/api/files/${folder.id}/shares`, { shares: [{ user_id: ids.grb, role: 'viewer' }] });
  const people = (await own('GET', `/api/files/${folder.id}/shares`)).body;
  assert.deepEqual(people.map((p) => [p.name, p.role]), [['Gus B', 'viewer']]);
  assert.equal((await b('GET', `/api/files/${doc.id}`)).body.role, 'editor', 'the better of the two');
  // Leaving the group: Gus keeps his own viewer share, Gwen loses access.
  await owner('PUT', `/api/groups/${g.id}/members`, { user_ids: [] });
  assert.equal((await b('GET', `/api/files/${doc.id}`)).body.role, 'viewer');
  assert.equal((await a('GET', `/api/files/${doc.id}`)).status, 404);
  // Clearing the person list doesn't drop group access.
  await owner('PUT', `/api/groups/${g.id}/members`, { user_ids: [ids.gra] });
  await own('PUT', `/api/files/${folder.id}/shares`, { shares: [] });
  assert.equal((await a('GET', `/api/files/${doc.id}`)).body.role, 'editor');
  assert.equal((await b('GET', `/api/files/${doc.id}`)).status, 404);
  // Deleting the group takes its access away.
  assert.equal((await owner('DELETE', `/api/groups/${g.id}`)).status, 200);
  assert.equal((await a('GET', `/api/files/${doc.id}`)).status, 404);
  assert.deepEqual((await own('GET', `/api/files/${folder.id}/groups`)).body, []);
  // Groups are per company.
  const other = (await owner('POST', '/api/groups', { name: 'Ops' })).body; // no description
  assert.equal(other.description, '');
  assert.equal((await owner('PATCH', `/api/groups/${other.id}`, { description: '' })).status, 200);
  const gina2 = client();
  assert.equal((await owner('POST', '/api/orgs', { name: 'Grpco', domain: 'grpco.com', admin_name: 'Gr', admin_local: 'gr', admin_password: 'password123' })).status, 201);
  await login(gina2, 'gr@grpco.com');
  const theirs = (await gina2('POST', '/api/files/folder', { name: 'X' })).body;
  assert.equal((await gina2('PUT', `/api/files/${theirs.id}/groups`, { groups: [{ group_id: other.id, role: 'viewer' }] })).status, 400);
});

test('tasks: in progress for the board', async () => {
  const a = client();
  assert.equal((await owner('POST', '/api/users', { local: 'tboard', domain: 'acme.com', name: 'Board Bea', password: 'password123' })).status, 201);
  await login(a, 'tboard@acme.com');
  const list = (await a('POST', '/api/tasks/lists', { name: 'Sprint' })).body.id;
  const t = (await a('POST', `/api/tasks/lists/${list}/tasks`, { title: 'Design' })).body;
  assert.equal(t.started, false);
  assert.equal((await a('PATCH', `/api/tasks/tasks/${t.id}`, { started: true })).body.started, true);
  const done = (await a('PATCH', `/api/tasks/tasks/${t.id}`, { done: true, today: '2026-11-07' })).body;
  assert.equal(done.started, false, 'done is done');
  const back = (await a('PATCH', `/api/tasks/tasks/${t.id}`, { done: false })).body;
  assert.equal(back.started, false, 'brought back to do');
  const inProgress = (await a('PATCH', `/api/tasks/tasks/${t.id}`, { done: false, started: true })).body;
  assert.equal(inProgress.started, true, 'or straight back to in progress');
  assert.equal((await a('GET', `/api/tasks/lists/${list}/tasks`)).body[0].started, true);
});

test('forms: quizzes score answers and keep the key secret', async () => {
  const { scoreOf, cleanQuestions } = await import('../src/routes/forms.js');
  const qs = cleanQuestions([
    { id: 'cap', type: 'short', title: 'Capital of France', answer: ' Paris ', points: 2 },
    { id: 'pr', type: 'checkbox', title: 'Primes', options: ['2', '3', '4'], answer: ['3', '2', 'nine'] },
    { id: 'c', type: 'choice', title: 'Colour', options: ['Red', 'Blue'], answer: 'Green' }, // not an option: no key
    { id: 'n', type: 'paragraph', title: 'Notes', answer: 'x' }, // paragraphs aren't marked
  ]);
  assert.deepEqual(qs[1].answer, ['2', '3']);
  assert.equal(qs[2].answer, undefined);
  assert.equal(qs[3].answer, undefined);
  assert.deepEqual(scoreOf(qs, { cap: 'paris', pr: ['3', '2'] }), { score: 3, max: 3, right: { cap: true, pr: true } });
  assert.equal(scoreOf(qs, { cap: 'Lyon', pr: ['2'] }).score, 0);

  const o = client(); const v = client();
  assert.equal((await owner('POST', '/api/users', { local: 'quizo', domain: 'acme.com', name: 'Quiz Owner', password: 'password123' })).status, 201);
  await login(o, 'quizo@acme.com');
  const f = (await o('POST', '/api/forms', { title: 'Safety quiz', questions: [
    { id: 'a', type: 'choice', title: 'Fire exit?', options: ['Left', 'Right'], answer: 'Right', points: 1 },
    { id: 'b', type: 'short', title: 'Emergency number', answer: '999', points: 1 },
  ] })).body;
  await o('PUT', `/api/forms/${f.id}`, { quiz: true, audience: 'public' });
  const seen = (await v('GET', `/api/public/forms/${f.token}`)).body;
  assert.equal(seen.quiz, true);
  assert.ok(seen.questions.every((x) => x.answer === undefined && x.points === undefined), 'the key never reaches people filling it in');
  const sent = (await v('POST', `/api/public/forms/${f.token}`, { answers: { a: 'Right', b: '112' } })).body;
  assert.deepEqual([sent.score, sent.max, sent.right], [1, 2, { a: true, b: false }]);
  const resp = (await o('GET', `/api/forms/${f.id}/responses`)).body;
  assert.equal(resp.responses[0].score, 1);
  assert.match((await o('GET', `/api/forms/${f.id}/responses.csv`)).body, /Submitted,Score,Fire exit\?,Emergency number[\s\S]*,1 \/ 2,Right,112/);
  await o('PUT', `/api/forms/${f.id}`, { show_score: false });
  assert.equal((await v('POST', `/api/public/forms/${f.token}`, { answers: { a: 'Left' } })).body.score, undefined, 'score hidden when asked');
  assert.equal((await o('POST', `/api/forms/${f.id}/copy`)).body.quiz, true);
});

test('notes: write, check off, pin, label, archive, search and share', async () => {
  const a = client(); const b = client();
  const ids = {};
  for (const [local, name] of [['nta', 'Nora Notes'], ['ntb', 'Ned Notes']]) ids[local] = (await owner('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).body.id;
  await login(a, 'nta@acme.com'); await login(b, 'ntb@acme.com');
  assert.equal((await a('POST', '/api/notes', { title: ' ', body: '' })).status, 400, 'empty');
  const n1 = (await a('POST', '/api/notes', { title: 'Shopping', items: [{ text: 'Milk' }, { text: 'Bread' }], labels: ['home', 'home', ' errands '] })).body;
  assert.deepEqual(n1.labels, ['home', 'errands']);
  assert.equal(n1.items.length, 2);
  const n2 = (await a('POST', '/api/notes', { body: 'Call the plumber on Monday', color: '#fff8b8' })).body;
  assert.equal((await a('POST', '/api/notes', { body: 'x', color: 'red' })).status, 400);
  let list = (await a('GET', '/api/notes')).body;
  assert.deepEqual(list.map((n) => n.id), [n2.id, n1.id], 'newest first');
  await a('PATCH', `/api/notes/${n1.id}`, { pinned: true, items: [{ ...n1.items[0], done: true }, n1.items[1]] });
  list = (await a('GET', '/api/notes')).body;
  assert.equal(list[0].id, n1.id, 'pinned on top');
  assert.equal(list[0].items[0].done, true);
  assert.deepEqual((await a('GET', '/api/notes?q=plumber')).body.map((n) => n.id), [n2.id]);
  assert.deepEqual((await a('GET', '/api/notes?q=bread')).body.map((n) => n.id), [n1.id], 'checklist text is searched');
  assert.deepEqual((await a('GET', '/api/notes?label=errands')).body.map((n) => n.id), [n1.id]);
  assert.deepEqual((await a('GET', '/api/notes/labels')).body, ['errands', 'home']);
  const arch = (await a('PATCH', `/api/notes/${n1.id}`, { archived: true })).body;
  assert.equal(arch.pinned, false, 'archiving unpins');
  assert.deepEqual((await a('GET', '/api/notes?archived=1')).body.map((n) => n.id), [n1.id]);
  assert.equal((await b('PATCH', `/api/notes/${n2.id}`, { body: 'hack' })).status, 404);
  // Sharing: the colleague can edit, not delete; leaving takes it off their list.
  const sh = (await a('PUT', `/api/notes/${n2.id}/shares`, { user_ids: [ids.ntb] })).body;
  assert.deepEqual(sh.shared.map((u) => u.name), ['Ned Notes']);
  assert.ok((await b('GET', '/api/notifications')).body.items.some((n) => n.title === 'Nora Notes shared a note with you'));
  const seen = (await b('GET', '/api/notes')).body;
  assert.equal(seen[0].mine, false);
  assert.equal((await b('PATCH', `/api/notes/${n2.id}`, { body: 'Plumber booked for Tuesday' })).status, 200);
  assert.equal((await a('GET', '/api/notes')).body.find((n) => n.id === n2.id).body, 'Plumber booked for Tuesday');
  assert.equal((await b('PUT', `/api/notes/${n2.id}/shares`, { user_ids: [] })).status, 403);
  const copy = (await b('POST', `/api/notes/${n2.id}/copy`)).body;
  assert.equal(copy.mine, true);
  assert.equal((await b('DELETE', `/api/notes/${n2.id}`)).body.deleted, false, 'they leave it');
  assert.equal((await a('GET', '/api/notes')).body.some((n) => n.id === n2.id), true, 'still there for the owner');
  assert.equal((await a('DELETE', `/api/notes/${n2.id}`)).body.deleted, true);
});

test('notes: reminders reach everyone on the note, then clear', async () => {
  const { remindNotesDue } = await import('../src/routes/notes.js');
  const a = client(); const b = client();
  const bid = (await owner('POST', '/api/users', { local: 'nrb', domain: 'acme.com', name: 'Rem B', password: 'password123' })).body.id;
  assert.equal((await owner('POST', '/api/users', { local: 'nra', domain: 'acme.com', name: 'Rem A', password: 'password123' })).status, 201);
  await login(a, 'nra@acme.com'); await login(b, 'nrb@acme.com');
  const n = (await a('POST', '/api/notes', { title: 'Renew parking permit', items: [{ text: 'Find form' }, { text: 'Pay', done: true }] })).body;
  assert.equal((await a('PATCH', `/api/notes/${n.id}`, { remind_at: Date.now() - 3600e3 })).status, 400, 'in the past');
  const at = Date.now() + 60e3;
  assert.equal((await a('PATCH', `/api/notes/${n.id}`, { remind_at: at })).body.remind_at, at);
  await a('PUT', `/api/notes/${n.id}/shares`, { user_ids: [bid] });
  assert.deepEqual((await b('GET', '/api/notes?reminders=1')).body.map((x) => x.id), [n.id], 'Reminders view');
  assert.equal(remindNotesDue(at - 1000), 0, 'not yet');
  assert.equal(remindNotesDue(at + 1000), 1);
  for (const c of [a, b]) {
    const bell = (await c('GET', '/api/notifications')).body.items.find((x) => x.kind === 'note');
    assert.equal(bell.title, 'Reminder: Renew parking permit');
    assert.equal(bell.body, '☐ Find form', 'what is still to do');
  }
  assert.equal((await a('GET', '/api/notes')).body.find((x) => x.id === n.id).remind_at, null, 'cleared once sent');
  assert.equal(remindNotesDue(at + 5000), 0, 'only once');
});

test('start page: Drive by default, Home if chosen', async () => {
  const a = client();
  assert.equal((await owner('POST', '/api/users', { local: 'spage', domain: 'acme.com', name: 'Start Page', password: 'password123' })).status, 201);
  assert.equal((await login(a, 'spage@acme.com')).start_page, 'drive');
  assert.equal((await a('PUT', '/api/users/me/start-page', { page: 'elsewhere' })).status, 400);
  assert.equal((await a('PUT', '/api/users/me/start-page', { page: 'home' })).body.start_page, 'home');
  assert.equal((await a('GET', '/api/auth/me')).body.user.start_page, 'home');
  await a('PUT', '/api/users/me/start-page', { page: 'drive' });
  assert.equal((await a('GET', '/api/auth/me')).body.user.start_page, 'drive');
});

test('approvals: ask, approve, reject, cancel; changes after approval are flagged', async () => {
  const own = client(); const r1 = client(); const r2 = client();
  const ids = {};
  for (const [local, name] of [['apo', 'Ava Author'], ['ap1', 'Rae Reviewer'], ['ap2', 'Rob Reviewer']]) ids[local] = (await owner('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).body.id;
  await login(own, 'apo@acme.com'); await login(r1, 'ap1@acme.com'); await login(r2, 'ap2@acme.com');
  const doc = (await own('POST', '/api/files/new', { kind: 'doc', name: 'Contract' })).body;
  assert.equal((await own('POST', '/api/approvals', { file_id: doc.id, reviewers: [ids.ap1] })).status, 400, 'reviewers must be able to open it');
  await own('PUT', `/api/files/${doc.id}/shares`, { shares: [{ user_id: ids.ap1, role: 'viewer' }, { user_id: ids.ap2, role: 'viewer' }] });
  assert.equal((await r1('POST', '/api/approvals', { file_id: doc.id, reviewers: [ids.ap2] })).status, 403, 'viewers cannot ask');
  const a = (await own('POST', '/api/approvals', { file_id: doc.id, reviewers: [ids.ap1, ids.ap2], message: 'Please check clause 4', due: '2026-12-01' })).body;
  assert.equal(a.status, 'pending');
  assert.equal(a.reviewers.length, 2);
  assert.ok((await r1('GET', '/api/notifications')).body.items.some((n) => n.title === 'Ava Author asked you to approve “Contract”'));
  assert.deepEqual((await r1('GET', '/api/approvals')).body.waiting.map((x) => x.id), [a.id]);
  assert.equal((await own('POST', `/api/approvals/${a.id}/decide`, { decision: 'approved' })).status, 403, 'not a reviewer');
  const half = (await r1('POST', `/api/approvals/${a.id}/decide`, { decision: 'approved', comment: 'Fine by me' })).body;
  assert.equal(half.status, 'pending', 'still waiting for Rob');
  assert.equal((await r1('POST', `/api/approvals/${a.id}/decide`, { decision: 'approved' })).status, 200, 'can change their mind while pending');
  const done = (await r2('POST', `/api/approvals/${a.id}/decide`, { decision: 'approved' })).body;
  assert.equal(done.status, 'approved');
  assert.ok((await own('GET', '/api/notifications')).body.items.some((n) => n.title === '“Contract” is approved'));
  assert.equal((await r2('POST', `/api/approvals/${a.id}/decide`, { decision: 'rejected' })).status, 400, 'finished');
  // An edit afterwards is flagged.
  await new Promise((r) => setTimeout(r, 5));
  const cur = (await own('GET', `/api/files/${doc.id}`)).body;
  await own('PUT', `/api/files/${doc.id}/content`, { version: cur.version, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'New clause' }] }] } });
  assert.equal((await own('GET', `/api/approvals/file/${doc.id}`)).body.current.changed_since, true);
  // A new request: rejected by anyone means rejected.
  const b = (await own('POST', '/api/approvals', { file_id: doc.id, reviewers: [ids.ap1, ids.ap2] })).body;
  const rej = (await r2('POST', `/api/approvals/${b.id}/decide`, { decision: 'rejected', comment: 'Clause 4 is wrong' })).body;
  assert.equal(rej.status, 'rejected');
  assert.equal(rej.reviewers.find((x) => x.name === 'Rob Reviewer').comment, 'Clause 4 is wrong');
  // Cancel.
  const c = (await own('POST', '/api/approvals', { file_id: doc.id, reviewers: [ids.ap1] })).body;
  assert.equal((await r1('POST', `/api/approvals/${c.id}/cancel`)).status, 403);
  assert.equal((await own('POST', `/api/approvals/${c.id}/cancel`)).status, 200);
  const hist = (await own('GET', `/api/approvals/file/${doc.id}`)).body;
  assert.equal(hist.current.id, b.id, 'cancelled ones are not current');
  assert.equal(hist.history.length, 3);
});

test('notes: copy to a document or to tasks', async () => {
  const a = client();
  assert.equal((await owner('POST', '/api/users', { local: 'ntd', domain: 'acme.com', name: 'Nat Doc', password: 'password123' })).status, 201);
  await login(a, 'ntd@acme.com');
  const list = (await a('POST', '/api/notes', { title: 'Trip', items: [{ text: 'Book hotel' }, { text: 'Passport', done: true }, { text: 'Taxi' }] })).body;
  const text = (await a('POST', '/api/notes', { title: 'Minutes', body: 'Line one\nLine two' })).body;
  const d1 = (await a('POST', `/api/notes/${list.id}/doc`)).body;
  const { content } = (await a('GET', `/api/files/${d1.id}/content`)).body;
  assert.equal((await a('GET', `/api/files/${d1.id}`)).body.name, 'Trip');
  assert.equal(content.content[0].type, 'heading');
  assert.deepEqual(content.content[1].content.map((i) => [i.attrs.checked, i.content[0].content[0].text]), [[false, 'Book hotel'], [true, 'Passport'], [false, 'Taxi']]);
  const d2 = (await a('POST', `/api/notes/${text.id}/doc`)).body;
  assert.deepEqual((await a('GET', `/api/files/${d2.id}/content`)).body.content.content.slice(1).map((p) => p.content[0].text), ['Line one', 'Line two']);
  const t = (await a('POST', `/api/notes/${list.id}/tasks`)).body;
  assert.equal(t.added, 2, 'only what is still to do');
  assert.equal(t.list.name, 'My tasks');
  const tasks = (await a('GET', `/api/tasks/lists/${t.list.id}/tasks`)).body.filter((x) => !x.done);
  assert.deepEqual(tasks.slice(0, 2).map((x) => x.title), ['Book hotel', 'Taxi'], 'in order, on top');
  assert.equal((await a('POST', `/api/notes/${text.id}/tasks`)).body.added, 1, 'a plain note becomes one task');
});

test('download your data: one zip with Drive, calendar, contacts, tasks and notes', async () => {
  const JSZip = (await import('jszip')).default;
  const a = client();
  assert.equal((await owner('POST', '/api/users', { local: 'takeo', domain: 'acme.com', name: 'Tak Eout', password: 'password123' })).status, 201);
  await login(a, 'takeo@acme.com');
  const folder = (await a('POST', '/api/files/folder', { name: 'Reports' })).body;
  await a('POST', '/api/files/new', { kind: 'doc', name: 'Q3', parent_id: folder.id });
  await a('POST', '/api/files/new', { kind: 'sheet', name: 'Budget' });
  const t = Date.now() + 864e5;
  await a('POST', '/api/events', { title: 'Review', start: t, end: t + 36e5 });
  await a('POST', '/api/contacts', { name: 'Zed Export', email: 'zed@example.com' });
  const list = (await a('POST', '/api/tasks/lists', { name: 'Work' })).body.id;
  await a('POST', `/api/tasks/lists/${list}/tasks`, { title: '=cmd() not a formula' });
  await a('POST', '/api/notes', { title: 'Ideas', items: [{ text: 'One' }, { text: 'Two', done: true }] });
  const sum = (await a('GET', '/api/takeout/summary')).body;
  assert.deepEqual([sum.files, sum.events, sum.contacts, sum.notes], [2, 1, 1, 1]);
  const r = await a('GET', '/api/takeout', undefined, { binary: true });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /zip/);
  const zip = await JSZip.loadAsync(r.body);
  const names = Object.keys(zip.files);
  for (const n of ['Drive/Reports/Q3.docx', 'Drive/Budget.xlsx', 'Calendar.ics', 'Contacts.vcf', 'Tasks.csv', 'Notes.md', 'README.txt']) assert.ok(names.includes(n), `${n} in ${names.join(', ')}`);
  assert.match(await zip.file('Calendar.ics').async('string'), /SUMMARY:Review/);
  assert.match(await zip.file('Contacts.vcf').async('string'), /zed@example.com/);
  assert.match(await zip.file('Tasks.csv').async('string'), /Work,'=cmd\(\) not a formula/);
  assert.match(await zip.file('Notes.md').async('string'), /## Ideas[\s\S]*- \[ \] One\n- \[x\] Two/);
});

test('download your data: admins can download a colleague’s (same company only)', async () => {
  const JSZip = (await import('jszip')).default;
  const a = client(); const b = client();
  const aid = (await owner('POST', '/api/users', { local: 'tka', domain: 'acme.com', name: 'Leaving Lee', password: 'password123' })).body.id;
  assert.equal((await owner('POST', '/api/users', { local: 'tkb', domain: 'acme.com', name: 'Nosy Ned', password: 'password123' })).status, 201);
  await login(a, 'tka@acme.com'); await login(b, 'tkb@acme.com');
  await a('POST', '/api/notes', { title: 'Handover', body: 'Keys in drawer' });
  assert.equal((await b('GET', `/api/takeout?user=${aid}`)).status, 403, 'not for colleagues');
  assert.equal((await owner('GET', `/api/takeout/summary?user=${aid}`)).body.notes, 1);
  const r = await owner('GET', `/api/takeout?user=${aid}`, undefined, { binary: true });
  assert.equal(r.status, 200);
  assert.match(decodeURIComponent(r.headers.get('content-disposition')), /tka@acme\.com/);
  const zip = await JSZip.loadAsync(r.body);
  assert.match(await zip.file('Notes.md').async('string'), /Handover/);
  assert.equal((await owner('GET', '/api/takeout?user=nobody')).status, 404);
});

test('working location: usual week, a day different, and colleagues', async () => {
  const a = client(); const b = client();
  const aid = (await owner('POST', '/api/users', { local: 'wla', domain: 'acme.com', name: 'Wendy Where', password: 'password123' })).body.id;
  assert.equal((await owner('POST', '/api/users', { local: 'wlb', domain: 'acme.com', name: 'Walt Watcher', password: 'password123' })).status, 201);
  await login(a, 'wla@acme.com'); await login(b, 'wlb@acme.com');
  assert.equal((await a('PUT', '/api/location/week', { week: { 1: 'castle' } })).status, 400);
  await a('PUT', '/api/location/week', { week: { 1: 'office', 2: 'office', 3: 'home', 4: 'office', 5: 'home', 6: null } });
  // 2026-11-09 is a Monday, 11 a Wednesday.
  let r = (await a('GET', '/api/location?from=2026-11-09&to=2026-11-15')).body;
  assert.deepEqual(Object.values(r.days).map((d) => d?.place ?? null), ['office', 'office', 'home', 'office', 'home', null, null]);
  assert.equal(r.days['2026-11-09'].from, 'week');
  await a('PUT', '/api/location/day', { date: '2026-11-09', place: 'other', label: 'Client site' });
  r = (await a('GET', '/api/location?from=2026-11-09&to=2026-11-09')).body;
  assert.deepEqual(r.days['2026-11-09'], { place: 'other', label: 'Client site', from: 'day' });
  assert.deepEqual((await b('GET', '/api/location/people?date=2026-11-09')).body[aid], { place: 'other', label: 'Client site' }, 'colleagues see it');
  assert.equal((await b('GET', '/api/location/people?date=2026-11-11')).body[aid].place, 'home');
  await a('PUT', '/api/location/day', { date: '2026-11-09', place: null });
  assert.equal((await a('GET', '/api/location?from=2026-11-09&to=2026-11-09')).body.days['2026-11-09'].place, 'office', 'back to the usual');
  assert.equal((await a('PUT', '/api/location/day', { date: 'monday', place: 'home' })).status, 400);
});

test('focus time: declines new invitations and pauses notifications while it lasts', async () => {
  const a = client(); const org = client();
  const aid = (await owner('POST', '/api/users', { local: 'foc', domain: 'acme.com', name: 'Fay Focus', password: 'password123' })).body.id;
  assert.equal((await owner('POST', '/api/users', { local: 'foo', domain: 'acme.com', name: 'Otto Organizer', password: 'password123' })).status, 201);
  await login(a, 'foc@acme.com'); await login(org, 'foo@acme.com');
  const now = Date.now();
  const f = (await a('POST', '/api/events', { title: 'Deep work', kind: 'focus', start: now - 60e3, end: now + 36e5, guests: ['foo@acme.com'] })).body;
  assert.equal(f.kind, 'focus');
  assert.equal((f.guests || []).length, 0, 'just you');
  const p = (await a('GET', '/api/users/me/pause')).body;
  assert.equal(p.paused_until, f.end, 'paused until it ends');
  assert.equal(p.focus, true);
  const inv = (await org('POST', '/api/events', { title: 'Sync', start: now + 10 * 6e4, end: now + 40 * 6e4, guests: ['foc@acme.com'] })).body;
  assert.equal(inv.guests.find((g) => g.id === aid || g.email === 'foc@acme.com').status, 'no', 'declined for them');
  assert.ok((await org('GET', '/api/notifications')).body.items.some((n) => n.title === 'Fay Focus is in focus time and declined “Sync”'));
  // After it: not paused.
  await a('PATCH', `/api/events/${f.id}`, { start: now - 2 * 36e5, end: now - 36e5 });
  assert.equal((await a('GET', '/api/users/me/pause')).body.paused_until, null);
});

test('second time zone for Calendar', async () => {
  const a = client();
  assert.equal((await owner('POST', '/api/users', { local: 'stz', domain: 'acme.com', name: 'Sec Zone', password: 'password123' })).status, 201);
  assert.equal((await login(a, 'stz@acme.com')).second_tz, null);
  assert.equal((await a('PUT', '/api/users/me/second-tz', { tz: 'Mars/Olympus' })).status, 400);
  assert.equal((await a('PUT', '/api/users/me/second-tz', { tz: 'Asia/Kolkata' })).body.second_tz, 'Asia/Kolkata');
  assert.equal((await a('GET', '/api/auth/me')).body.user.second_tz, 'Asia/Kolkata');
  await a('PUT', '/api/users/me/second-tz', { tz: null });
  assert.equal((await a('GET', '/api/auth/me')).body.user.second_tz, null);
});

test('status from the calendar: in a meeting, focusing, out of office; a set status wins', async () => {
  const a = client(); const b = client();
  const aid = (await owner('POST', '/api/users', { local: 'cst', domain: 'acme.com', name: 'Cal Status', password: 'password123' })).body.id;
  assert.equal((await owner('POST', '/api/users', { local: 'csu', domain: 'acme.com', name: 'Cal Viewer', password: 'password123' })).status, 201);
  await login(a, 'cst@acme.com'); await login(b, 'csu@acme.com');
  const statusOfA = async () => (await b('GET', '/api/users/directory')).body.find((u) => u.id === aid).status;
  assert.equal(await statusOfA(), null);
  const now = Date.now();
  // On your own: no status. With someone: in a meeting.
  const solo = (await a('POST', '/api/events', { title: 'Lunch', start: now - 60e3, end: now + 36e5 })).body;
  assert.equal(await statusOfA(), null);
  await a('PATCH', `/api/events/${solo.id}`, { guests: ['csu@acme.com'] });
  const st = await statusOfA();
  assert.deepEqual([st.emoji, st.text, st.auto], ['📅', 'In a meeting', true]);
  assert.equal(st.until, solo.end);
  assert.ok(!JSON.stringify(st).includes('Lunch'), 'no titles');
  // Focus outranks a meeting; out of office outranks both.
  await a('POST', '/api/events', { title: 'Deep', kind: 'focus', start: now - 60e3, end: now + 30 * 6e4 });
  assert.equal((await statusOfA()).text, 'Focusing');
  const ooo = (await a('POST', '/api/events', { title: 'Away', kind: 'ooo', start: now - 864e5, end: now + 864e5, all_day: 1 })).body;
  assert.equal((await statusOfA()).text, 'Out of office');
  // A status you set yourself wins.
  await a('PUT', '/api/users/me/status', { emoji: '🍕', text: 'Lunch', until: now + 36e5 });
  assert.equal((await statusOfA()).text, 'Lunch');
  void ooo;
});

test('locking a file: nobody can change it until whoever locked it (or the owner) unlocks it', async () => {
  const own = client(); const ed = client(); const ed2 = client();
  const ids = {};
  for (const [local, name] of [['lko', 'Lock Owner'], ['lke', 'Lock Editor'], ['lkf', 'Lock Other']]) ids[local] = (await owner('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).body.id;
  await login(own, 'lko@acme.com'); await login(ed, 'lke@acme.com'); await login(ed2, 'lkf@acme.com');
  const doc = (await own('POST', '/api/files/new', { kind: 'doc', name: 'Final' })).body;
  await own('PUT', `/api/files/${doc.id}/shares`, { shares: [{ user_id: ids.lke, role: 'editor' }, { user_id: ids.lkf, role: 'editor' }] });
  const l = (await ed('PUT', `/api/files/${doc.id}/lock`, { locked: true })).body;
  assert.ok(l.locked_at); assert.equal(l.locked_by, ids.lke); assert.equal(l.locked_by_name, 'Lock Editor');
  // Nobody can change it, the owner included.
  const content = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }] };
  const put = await own('PUT', `/api/files/${doc.id}/content`, { content, version: l.version });
  assert.equal(put.status, 423); assert.match(put.body.error, /Lock Editor locked/);
  // Only whoever locked it, or the owner, can unlock it.
  assert.equal((await ed2('PUT', `/api/files/${doc.id}/lock`, { locked: false })).status, 403);
  assert.ok((await own('GET', `/api/files/${doc.id}`)).body.locked_at);
  assert.equal((await own('PUT', `/api/files/${doc.id}/lock`, { locked: false })).body.locked_at, null);
  assert.equal((await own('PUT', `/api/files/${doc.id}/content`, { content, version: l.version })).status, 200);
  // Shown in the file's activity.
  const acts = (await own('GET', `/api/files/${doc.id}/activity`)).body.map((a) => a.action);
  assert.ok(acts.includes('lock') && acts.includes('unlock'));
});

test('calendar sharing: colleagues you choose see what your events are, others only when you are busy', async () => {
  const a = client(); const b = client(); const c = client();
  const ids = {};
  for (const [local, name] of [['csa', 'Cara Share'], ['csb', 'Ben Sees'], ['csc', 'Cy Busy']]) ids[local] = (await owner('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).body.id;
  await login(a, 'csa@acme.com'); await login(b, 'csb@acme.com'); await login(c, 'csc@acme.com');
  const now = Date.now();
  await a('POST', '/api/events', { title: 'Dentist', location: 'High St', start: now + 36e5, end: now + 72e5 });
  const fb = async (who) => (await who('GET', `/api/freebusy?users=${ids.csa}&from=${now}&to=${now + 864e5}`)).body[ids.csa];
  let seen = await fb(b);
  assert.equal(seen.details, false); assert.equal(seen.busy.length, 1); assert.equal(seen.busy[0].title, undefined);
  // Only colleagues.
  assert.equal((await a('PUT', '/api/freebusy/shares', { users: [ids.csb, 'nope'] })).status, 400);
  const sh = (await a('PUT', '/api/freebusy/shares', { users: [ids.csb] })).body;
  assert.deepEqual(sh.with.map((u) => u.name), ['Ben Sees']);
  assert.deepEqual((await b('GET', '/api/freebusy/shares')).body.from.map((u) => u.name), ['Cara Share']);
  seen = await fb(b);
  assert.equal(seen.details, true); assert.equal(seen.busy[0].title, 'Dentist'); assert.equal(seen.busy[0].location, 'High St');
  assert.equal((await fb(c)).busy[0].title, undefined, 'not shared with Cy');
  const bells = (await b('GET', '/api/notifications')).body;
  assert.ok(JSON.stringify(bells).includes('Cara Share shared their calendar with you'));
  // Stop sharing.
  await a('PUT', '/api/freebusy/shares', { users: [] });
  assert.equal((await fb(b)).busy[0].title, undefined);
});

test('sharing until a date: access ends by itself and the owner is told', async () => {
  const own = client(); const tmp = client();
  const ids = {};
  for (const [local, name] of [['sxo', 'Sam Owner'], ['sxt', 'Tia Temp']]) ids[local] = (await owner('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).body.id;
  await login(own, 'sxo@acme.com'); await login(tmp, 'sxt@acme.com');
  const doc = (await own('POST', '/api/files/new', { kind: 'doc', name: 'Audit pack' })).body;
  const share = (expires_at) => own('PUT', `/api/files/${doc.id}/shares`, { shares: [{ user_id: ids.sxt, role: 'editor', expires_at }] });
  assert.equal((await share(Date.now() - 1000)).status, 400, 'not in the past');
  assert.equal((await share(Date.now() + 400 * 864e5)).status, 400, 'at most a year');
  const until = Date.now() + 2000;
  assert.equal((await share(until)).status, 200);
  assert.equal((await own('GET', `/api/files/${doc.id}/shares`)).body[0].expires_at, until);
  assert.equal((await tmp('GET', `/api/files/${doc.id}`)).status, 200);
  assert.ok(JSON.stringify((await tmp('GET', '/api/notifications')).body).includes(`until ${new Date(until).toISOString().slice(0, 10)}`));
  // Once the time has passed it's refused straight away, before the sweep.
  await new Promise((r) => setTimeout(r, 2100));
  assert.equal((await tmp('GET', `/api/files/${doc.id}`)).status, 404);
  const { expireShares } = await import('../src/shareexpiry.js');
  assert.ok(expireShares() >= 1);
  assert.deepEqual((await own('GET', `/api/files/${doc.id}/shares`)).body, []);
  assert.ok(JSON.stringify((await own('GET', '/api/notifications')).body).includes('Tia Temp\'s access to “Audit pack” has ended'));
  const acts = (await own('GET', `/api/files/${doc.id}/activity`)).body;
  assert.ok(JSON.stringify(acts).includes('access ended'));
  // Shared again without an end date: it stays.
  await share(null);
  assert.equal(expireShares(Date.now() + 999 * 864e5), 0);
  assert.equal((await tmp('GET', `/api/files/${doc.id}`)).status, 200);
});

test("who's who: titles, departments, phones and managers in the Directory (no loops)", async () => {
  const me = client();
  const ids = {};
  for (const [local, name] of [['wwc', 'Cleo Chief'], ['wwm', 'Max Manager'], ['wwe', 'Eve Engineer']]) ids[local] = (await owner('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).body.id;
  await login(me, 'wwe@acme.com');
  assert.equal((await me('PUT', '/api/users/me/profile', { job_title: 'Engineer', department: 'R&D', work_phone: '+60 3-1234 5678' })).status, 200);
  assert.equal((await me('PUT', '/api/users/me/profile', { work_phone: 'call me' })).status, 400);
  assert.equal((await me('PATCH', `/api/users/${ids.wwe}`, { manager_id: ids.wwm })).status, 403, 'only admins set managers');
  assert.equal((await owner('PATCH', `/api/users/${ids.wwm}`, { manager_id: ids.wwc, job_title: 'Head of R&D', department: 'R&D' })).status, 200);
  assert.equal((await owner('PATCH', `/api/users/${ids.wwe}`, { manager_id: ids.wwm })).status, 200);
  const loop = await owner('PATCH', `/api/users/${ids.wwc}`, { manager_id: ids.wwe });
  assert.equal(loop.status, 400); assert.match(loop.body.error, /loop/);
  assert.equal((await owner('PATCH', `/api/users/${ids.wwc}`, { manager_id: ids.wwc })).status, 400, 'not themselves');
  const dir = (await me('GET', '/api/users/directory')).body;
  const eve = dir.find((u) => u.id === ids.wwe), max = dir.find((u) => u.id === ids.wwm);
  assert.deepEqual([eve.job_title, eve.department, eve.work_phone, eve.manager_id], ['Engineer', 'R&D', '+60 3-1234 5678', ids.wwm]);
  assert.deepEqual([max.job_title, max.manager_id], ['Head of R&D', ids.wwc]);
  await owner('PATCH', `/api/users/${ids.wwe}`, { manager_id: null });
  assert.equal((await me('GET', '/api/users/directory')).body.find((u) => u.id === ids.wwe).manager_id, null);
});

test("people import and export carry job titles, departments, phones and managers (and update people already here)", async () => {
  const csv = ['Name,Email,Job title,Department,Work phone,Manager',
    'Ivy Boss,ivyb,CEO,,+60 3 1111,',
    'Ian Lead,ianl,Head of Ops,Ops,,ivyb',
    'Ida Crew,idac,Clerk,Ops,not a phone,ianl',
    'Ike Stray,ikes,Intern,Ops,,nobody'].join('\n');
  const dry = (await owner('POST', '/api/users/import', { csv, domain: 'acme.com', dry_run: true })).body.rows;
  assert.match(dry[2].error, /isn't a phone number/);
  const r = (await owner('POST', '/api/users/import', { csv, domain: 'acme.com' })).body;
  assert.equal(r.created, 3);
  assert.match(r.rows.find((x) => x.email === 'ikes@acme.com').warning, /No one called nobody@acme.com/);
  const dir = (await owner('GET', '/api/users/directory')).body;
  const by = (e) => dir.find((u) => u.username === e);
  assert.equal(by('ianl@acme.com').manager_id, by('ivyb@acme.com').id);
  assert.deepEqual([by('ianl@acme.com').job_title, by('ianl@acme.com').department], ['Head of Ops', 'Ops']);
  assert.equal(by('ivyb@acme.com').work_phone, '+60 3 1111');
  // The same file again updates them: a new title, a manager for the stray one, no new people.
  const again = (await owner('POST', '/api/users/import', { csv: 'Email,Job title,Manager\nikes@acme.com,Junior analyst,ianl@acme.com\nivyb@acme.com,,ikes@acme.com', domain: 'acme.com' })).body;
  assert.equal(again.created, 0); assert.equal(again.updated, 2);
  assert.match(again.rows.find((x) => x.email === 'ivyb@acme.com').warning, /loop/);
  const dir2 = (await owner('GET', '/api/users/directory')).body;
  const ike = dir2.find((u) => u.username === 'ikes@acme.com');
  assert.deepEqual([ike.job_title, ike.department, ike.manager_id], ['Junior analyst', 'Ops', by('ianl@acme.com').id]);
  assert.equal(dir2.find((u) => u.username === 'ivyb@acme.com').job_title, 'CEO', 'an empty cell leaves it');
  // Export has the columns.
  const exp = (await owner('GET', '/api/users/export')).body;
  assert.match(exp, /Job title,Department,Work phone,Manager/);
  assert.match(exp, /Ian Lead,ianl@acme.com.*Head of Ops,Ops,,ivyb@acme.com/);
});

test("a colleague's card: job, manager and reports, status, working hours and where they are today", async () => {
  const a = client(); const other = client();
  const ids = {};
  for (const [local, name] of [['pcb', 'Pat Boss'], ['pcm', 'Pia Member'], ['pcr', 'Ray Report']]) ids[local] = (await owner('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).body.id;
  await login(a, 'pcm@acme.com');
  await a('PUT', '/api/users/me/profile', { job_title: 'Analyst', department: 'Finance', work_phone: '+60 3 2222' });
  await owner('PATCH', `/api/users/${ids.pcm}`, { manager_id: ids.pcb });
  await owner('PATCH', `/api/users/${ids.pcr}`, { manager_id: ids.pcm, job_title: 'Junior' });
  await a('PUT', '/api/users/me/status', { emoji: '🎧', text: 'Heads down' });
  await a('PUT', '/api/users/me/work-hours', { hours: { days: [0, 1, 2, 3, 4, 5, 6], start: 0, end: 1440, tz: 'Asia/Tokyo' } });
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  await a('PUT', '/api/location/day', { date: today, place: 'other', label: 'Client site' });
  const card = (await owner('GET', `/api/users/${ids.pcm}/card`)).body;
  assert.deepEqual([card.name, card.email, card.job_title, card.department, card.work_phone], ['Pia Member', 'pcm@acme.com', 'Analyst', 'Finance', '+60 3 2222']);
  assert.equal(card.manager.name, 'Pat Boss');
  assert.deepEqual(card.reports, [{ id: ids.pcr, name: 'Ray Report', job_title: 'Junior' }]);
  assert.equal(card.status.text, 'Heads down');
  assert.equal(card.hours.tz, 'Asia/Tokyo'); assert.equal(card.hours.working_now, true);
  assert.deepEqual(card.where_today, { place: 'other', label: 'Client site' });
  // Only colleagues.
  await other('POST', '/api/auth/login', { username: 'gina@globex.com', password: 'password123' });
  const g = await other('GET', `/api/users/${ids.pcm}/card`);
  assert.ok(g.status === 404 || g.status === 401);
  assert.equal((await owner('GET', '/api/users/nope/card')).status, 404);
});

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
  assert.match(text, /^\uFEFF?Name,E-mail Address,Phone,Company,Notes,Birthday\r\n/); // (the reader drops the byte-order mark)
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

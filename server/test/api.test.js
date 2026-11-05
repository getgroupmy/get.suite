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

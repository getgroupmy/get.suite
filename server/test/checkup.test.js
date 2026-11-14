import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-checkup-'));
const { createApp } = await import('../src/app.js');
const { checkup } = await import('../src/checkup.js');
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

test('security checkup: what’s open, worst first, and what changes it', async () => {
  const ana = client(), kim = client();
  await ana('POST', '/api/auth/setup', { org_name: 'Acme', domain: 'acme.com', name: 'Ana Admin', local: 'ana', password: 'password123' });
  const kimId = (await ana('POST', '/api/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  const oldId = (await ana('POST', '/api/users', { local: 'old', domain: 'acme.com', name: 'Old Timer', password: 'password123' })).body.id;
  await kim('POST', '/api/auth/login', { username: 'kim@acme.com', password: 'password123' });
  const orgId = q('SELECT org_id FROM users WHERE id = ?').get(kimId).org_id;
  // (made now: once two steps are required, Kim must set them up before anything else)
  const made = await kim('POST', '/api/files/new', { kind: 'doc', name: 'Price list' });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const f = made.body;
  const now = Date.now();
  q('UPDATE users SET created_at = ?, last_active = ? WHERE id = ?').run(now - 200 * 864e5, now - 120 * 864e5, oldId);

  const ids = (list) => list.map((x) => `${x.id}:${x.status}`);
  let c = checkup(orgId, now);
  assert.deepEqual(ids(c), ['admin-2fa:warn', 'require-2fa:warn', 'inactive:warn', 'mark-external:tip', 'idle:tip']);
  assert.match(c[0].title, /^1 admin signs in with just a password$/);
  assert.match(c[0].detail, /^Ana Admin\./);
  assert.equal(c[1].title, '3 people sign in with just a password');
  assert.deepEqual(c[2].people, ['Old Timer']);

  // Fixed: Ana's two-step on, two steps required, Old suspended, outside mail marked, idle sign-out.
  q('INSERT INTO two_factor (user_id, secret, enabled) VALUES (?, ?, 1)').run(q("SELECT id FROM users WHERE username = 'ana@acme.com'").get().id, 'JBSWY3DPEHPK3PXP');
  q('UPDATE orgs SET require_2fa = 1, mark_external = 1, session_idle_min = 60 WHERE id = ?').run(orgId);
  q('UPDATE users SET disabled = 1 WHERE id = ?').run(oldId);
  c = checkup(orgId, now);
  assert.deepEqual(ids(c), ['require-2fa:tip', 'admin-2fa:ok']);
  assert.match(c[0].detail, /^1 person still has to set it up/);

  // A share link for anyone, for ever, without a password; an open phishing report.
  q("INSERT INTO share_links (id, token, file_id, created_by, created_at) VALUES ('l1', 't1', ?, ?, ?)").run(f.id, kimId, now);
  q("INSERT INTO phishing_reports (id, org_id, user_id, sender, at) VALUES ('p1', ?, ?, 'x@evil.example', ?)").run(orgId, kimId, now);
  c = checkup(orgId, now);
  assert.deepEqual(ids(c), ['phishing:warn', 'require-2fa:tip', 'links:tip', 'admin-2fa:ok']);
  assert.equal(c.find((x) => x.id === 'links').title, '1 share link never expires and has no password');

  // Over HTTP: admins only.
  assert.equal((await kim('GET', '/api/orgs/current/checkup')).status, 403);
  const r = await ana('GET', '/api/orgs/current/checkup');
  assert.equal(r.status, 200);
  assert.deepEqual(ids(r.body.items), ids(c));
});

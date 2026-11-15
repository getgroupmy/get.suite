import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-breached-'));
// A stand-in for api.pwnedpasswords.com/range/: "Leaked2024!x" has been in 3,861 breaches.
const LEAKED = 'Leaked2024!x';
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').toUpperCase();
const asked = [];
let down = false;
const pwned = http.createServer((req, res) => {
  asked.push({ url: req.url, padding: req.headers['add-padding'] });
  if (down) { res.writeHead(503); return res.end(); }
  const prefix = req.url.split('/').pop();
  const lines = ['0018A45C4D1DEF81644B54AB7F969B88D65:1', 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:0'];
  if (sha(LEAKED).startsWith(prefix)) lines.push(`${sha(LEAKED).slice(5)}:3861`);
  res.end(lines.join('\r\n'));
});
await new Promise((r) => pwned.listen(0, r));
process.env.PWNED_PASSWORDS_URL = `http://127.0.0.1:${pwned.address().port}/range/`;

const { breachCount, rulesText } = await import('../src/passwordrules.js');
const { createApp } = await import('../src/app.js');

let server, base;
test.before(async () => { server = createApp().listen(0); await new Promise((r) => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server.close(); pwned.close(); });
function client() {
  let cookie = '';
  return async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json', ...(cookie && { cookie }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}

test('breachCount: only the first 5 characters of the hash are sent, and the match is made here', async () => {
  asked.length = 0;
  assert.equal(await breachCount(LEAKED), 3861);
  assert.equal(await breachCount('a perfectly unusual passphrase 81'), 0);
  assert.deepEqual(asked.map((a) => a.url), [`/range/${sha(LEAKED).slice(0, 5)}`, `/range/${sha('a perfectly unusual passphrase 81').slice(0, 5)}`]);
  assert.ok(asked.every((a) => a.padding === 'true'), 'asks for padded answers');
  down = true;
  assert.equal(await breachCount(LEAKED), null, 'unreachable: unknown');
  down = false;
  assert.equal(await breachCount(LEAKED, { url: 'http://127.0.0.1:1/range/' }), null);
});

test('rulesText mentions it', () => {
  assert.equal(rulesText({ min: 8, breached: true }), 'Use at least 8 characters, and not one known from data breaches.');
  assert.equal(rulesText({ min: 10, common: true, breached: true }), 'Use at least 10 characters, and nothing easy to guess or not one known from data breaches.');
});

test('with the company rule on, a breached password is refused wherever one is chosen; off, or the list down, it is allowed', async () => {
  const ana = client(), kim = client();
  await ana('POST', '/api/auth/setup', { org_name: 'Acme', domain: 'acme.com', name: 'Ana Admin', local: 'ana', password: 'password123' });
  // Off (the default): allowed.
  let r = await ana('POST', '/api/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: LEAKED });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const kimId = r.body.id;
  r = await ana('PATCH', '/api/orgs/current', { password_rules: { min: 8, breached: true } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await ana('GET', '/api/auth/password-rules')).body.breached, true);
  // An admin adding someone.
  r = await ana('POST', '/api/users', { local: 'lee', domain: 'acme.com', name: 'Lee Chen', password: LEAKED });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /turned up in data breaches 3,861 times/);
  // An admin resetting someone's password.
  r = await ana('PATCH', `/api/users/${kimId}`, { password: LEAKED });
  assert.equal(r.status, 400);
  // Changing your own.
  await kim('POST', '/api/auth/login', { username: 'kim@acme.com', password: LEAKED });
  r = await kim('PATCH', '/api/auth/me', { currentPassword: LEAKED, newPassword: LEAKED });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /data breach/);
  r = await kim('PATCH', '/api/auth/me', { currentPassword: LEAKED, newPassword: 'a perfectly unusual passphrase 81' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // The list can't be reached: allowed, so an outage doesn't stop anyone.
  down = true;
  r = await ana('POST', '/api/users', { local: 'max', domain: 'acme.com', name: 'Max Moss', password: LEAKED });
  down = false;
  assert.equal(r.status, 201);
});

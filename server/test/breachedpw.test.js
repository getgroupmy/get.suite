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

test('signing in with a breached password (rule on): asked to choose a new one first; in the activity log and Security checkup; cleared by a new one', async () => {
  const ana = client(), zed = client();
  await ana('POST', '/api/auth/login', { username: 'ana@acme.com', password: 'password123' });
  await ana('PATCH', '/api/orgs/current', { password_rules: { min: 8, breached: false } });
  let r = await ana('POST', '/api/users', { local: 'zed', domain: 'acme.com', name: 'Zed Old', password: LEAKED }); // chosen before the rule
  assert.equal(r.status, 201);
  let items = (await ana('GET', '/api/orgs/current/checkup')).body.items;
  const tip = items.find((x) => x.id === 'breached');
  assert.equal(tip.status, 'tip');
  assert.equal((await ana('PATCH', '/api/orgs/current', tip.fix.settings)).status, 200, 'its fix turns the rule on');
  assert.equal((await ana('GET', '/api/auth/password-rules')).body.breached, true);
  r = await zed('POST', '/api/auth/login', { username: 'zed@acme.com', password: LEAKED });
  assert.equal(r.status, 200);
  let me = (await zed('GET', '/api/auth/me')).body.user;
  assert.equal(me.must_change_password, true);
  assert.equal(me.password_leaked, true);
  assert.equal((await zed('GET', '/api/files')).status, 403, 'nothing else until it’s changed');
  const log = (await ana('GET', '/api/audit?action=password.leaked')).body;
  assert.ok(JSON.stringify(log).includes('zed@acme.com'), JSON.stringify(log).slice(0, 300));
  items = (await ana('GET', '/api/orgs/current/checkup')).body.items;
  assert.match(items.find((x) => x.id === 'leaked').title, /1 person signed in with a password known from data breaches/);
  assert.equal(items.some((x) => x.id === 'breached'), false);
  // Once more: still one entry in the log.
  await client()('POST', '/api/auth/login', { username: 'zed@acme.com', password: LEAKED });
  assert.equal(JSON.stringify((await ana('GET', '/api/audit?action=password.leaked')).body).split('zed@acme.com').length - 1, 1);
  r = await zed('PATCH', '/api/auth/me', { currentPassword: LEAKED, newPassword: 'quiet-harbour-62' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  me = (await zed('GET', '/api/auth/me')).body.user;
  assert.equal(me.must_change_password, false); assert.equal(me.password_leaked, false);
  assert.equal((await ana('GET', '/api/orgs/current/checkup')).body.items.some((x) => x.id === 'leaked'), false);
  // A password that isn't breached signs in as usual.
  assert.equal((await client()('POST', '/api/auth/login', { username: 'zed@acme.com', password: 'quiet-harbour-62' })).status, 200);
  assert.equal((await zed('GET', '/api/auth/me')).body.user.must_change_password, false);
});

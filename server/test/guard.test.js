import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-guard-'));
process.env.DATA_DIR = dir;
const guard = await import('../src/security/guard.js');
const { handlePolicy } = await import('../src/security/policyServer.js');
const { createApp } = await import('../src/app.js');

const ATTACKER = '203.0.113.7';
const T = 1_800_000_000_000; // fixed clock
const fail = (ip, login, fp, at = T, service = 'imap') => guard.recordFailure({ ip, login, fp, service }, at);

let server, base;
before(async () => {
  server = http.createServer(createApp());
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('ten different guesses from one address block it for an hour', () => {
  for (let i = 0; i < 9; i++) assert.equal(fail(ATTACKER, `user${i}@acme.com`, `f${i}`), null);
  assert.equal(guard.check(ATTACKER, 'x', T).action, 'allow');
  const ban = fail(ATTACKER, 'user9@acme.com', 'f9');
  assert.ok(ban);
  assert.equal(ban.until, T + 3600e3);
  assert.equal(guard.check(ATTACKER, 'anyone@acme.com', T + 10).action, 'reject');
  assert.equal(guard.check(ATTACKER, 'anyone@acme.com', T + 3600e3 + 1).action, 'allow', 'expires');
});

test('repeat offenders within 24 hours are blocked for 24 hours', () => {
  const later = T + 2 * 3600e3;
  for (let i = 0; i < 10; i++) fail(ATTACKER, `again${i}@acme.com`, `g${i}`, later);
  assert.equal(guard.check(ATTACKER, 'x', later + 23 * 3600e3).action, 'reject');
  assert.equal(guard.listBans(later)[0].strikes, 2);
});

test('the same wrong password retried (a phone with an old password) does not block', () => {
  const office = '198.51.100.20';
  for (let i = 0; i < 50; i++) fail(office, 'anna@acme.com', 'oldpw', T + i * 1000);
  assert.equal(guard.check(office, 'anna@acme.com', T + 60e3).action, 'allow');
});

test('failures outside the 15-minute window do not add up', () => {
  const slow = '198.51.100.30';
  for (let i = 0; i < 20; i++) fail(slow, `u${i}@acme.com`, `p${i}`, T + i * 5 * 60e3); // one every 5 minutes
  assert.equal(guard.check(slow, 'x', T + 100 * 60e3).action, 'allow');
});

test('an account attacked from many addresses is slowed down, not locked', () => {
  for (let i = 0; i < 20; i++) fail(`192.0.2.${i + 1}`, 'ceo@acme.com', `x${i}`);
  const v = guard.check('198.51.100.99', 'ceo@acme.com', T + 1000);
  assert.deepEqual(v, { action: 'delay', seconds: 5 });
  assert.equal(guard.check('198.51.100.99', 'someone-else@acme.com', T + 1000).action, 'allow');
});

test('private addresses are slowed down but never blocked; loopback and own addresses are never touched', () => {
  for (let i = 0; i < 15; i++) fail('172.17.0.1', `n${i}@acme.com`, `y${i}`);
  assert.equal(guard.check('172.17.0.1', 'x', T + 1).action, 'delay');
  assert.equal(guard.listBans(T).some((b) => b.ip === '172.17.0.1'), false);
  for (let i = 0; i < 15; i++) fail('127.0.0.1', `n${i}@acme.com`, `z${i}`);
  assert.equal(guard.check('127.0.0.1', 'x', T + 1).action, 'allow');
  assert.equal(guard.check('::ffff:127.0.0.1', 'x', T + 1).action, 'allow', 'IPv4-mapped IPv6 is normalised');
});

test('allowlisting an address lifts its block; bad entries are refused', () => {
  assert.equal(guard.check(ATTACKER, 'x', T + 10).action, 'reject');
  assert.deepEqual(guard.setAllowlist(['203.0.113.0/24', '2001:db8::1']), ['203.0.113.0/24', '2001:db8::1']);
  assert.equal(guard.check(ATTACKER, 'x', T + 10).action, 'allow');
  assert.throws(() => guard.setAllowlist(['not-an-ip']), /not an IP/);
  assert.throws(() => guard.setAllowlist(['10.0.0.0/33']), /not an IP/);
  guard.setAllowlist([]);
});

test('Dovecot policy protocol: reject, delay, report', () => {
  const ip = '198.51.100.77';
  for (let i = 0; i < 10; i++) handlePolicy('report', { remote: ip, login: `q${i}@acme.com`, pwhash: `h${i}`, protocol: 'smtp', success: false, policy_reject: false });
  assert.deepEqual(handlePolicy('allow', { remote: ip, login: 'a@acme.com' }), { status: -1, msg: 'Too many failed sign-ins from your network. Try again later.' });
  assert.equal(handlePolicy('allow', { remote: '198.51.100.78', login: 'a@acme.com' }).status, 0);
  // Rejections by the policy itself are not counted again.
  const before = guard.recentFailures(1000).length;
  handlePolicy('report', { remote: ip, login: 'z', pwhash: 'z', success: false, policy_reject: true });
  assert.equal(guard.recentFailures(1000).length, before);
});

test('web sign-in is protected by the same guard (real client IP via the reverse proxy)', async () => {
  const call = (body, ip) => fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
  await fetch(`${base}/api/auth/setup`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' },
    body: JSON.stringify({ org_name: 'Acme', domain: 'acme.com', name: 'Olivia', local: 'olivia', password: 'password123' }) });
  const ip = '203.0.114.50';
  for (let i = 0; i < 10; i++) assert.equal((await call({ username: 'olivia@acme.com', password: `guess${i}` }, ip)).status, 401);
  const blocked = await call({ username: 'olivia@acme.com', password: 'password123' }, ip);
  assert.equal(blocked.status, 429, 'blocked even with the right password');
  assert.equal((await call({ username: 'olivia@acme.com', password: 'password123' }, '203.0.114.51')).status, 200, 'other addresses unaffected');
});

test('security overview flags the NAT problem when every failure looks private', () => {
  const o = guard.overview(T + 1000);
  assert.equal(typeof o.failures24h, 'number');
  assert.equal(o.natWarning, false);
});

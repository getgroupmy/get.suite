// Web Push, end to end against a stand-in push service: subscriptions, the encrypted delivery a
// browser would get (decrypted here with the device's keys), quiet times, and forgetting gone devices.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-push-'));
const { q } = await import('../src/db.js');
await import('../src/app.js');
const { subscribe, pushTo, devicesOf, vapidKeys } = await import('../src/push.js');
const { notify } = await import('../src/notifications.js');
const ece = (await import('module')).createRequire(import.meta.url)('http_ece');

// A device: its own key pair and secret, as a browser makes them.
const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
const authSecret = crypto.randomBytes(16);
const keys = { p256dh: ecdh.getPublicKey().toString('base64url'), auth: authSecret.toString('base64url') };

// The stand-in push service, over HTTPS like the real ones (a throwaway certificate, trusted here only).
const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-push-tls-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1', '-keyout', `${certDir}/k.pem`, '-out', `${certDir}/c.pem`], { stdio: 'ignore' });
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
let got = [], answer = 201;
const svc = https.createServer({ key: fs.readFileSync(`${certDir}/k.pem`), cert: fs.readFileSync(`${certDir}/c.pem`) }, (req, res) => { const parts = []; req.on('data', (c) => parts.push(c)); req.on('end', () => { got.push({ headers: req.headers, body: Buffer.concat(parts), url: req.url }); res.statusCode = answer; res.end(); }); });
await new Promise((r) => svc.listen(0, r));
after(() => svc.close());
const endpoint = `https://127.0.0.1:${svc.address().port}/push/device-1`;
const read = (g) => JSON.parse(ece.decrypt(g.body, { version: 'aes128gcm', privateKey: ecdh, authSecret: keys.auth }).toString());

q("INSERT INTO orgs (id, name, created_at) VALUES ('po', 'Push Co', 0)").run();
q("INSERT INTO users (id, org_id, username, name, password_hash, created_at) VALUES ('pu', 'po', 'p@push.test', 'Pia', 'x', 0)").run();

test('push: only the browser makers’ services are taken as addresses', () => {
  delete process.env.PUSH_ANY_ENDPOINT;
  assert.throws(() => subscribe('pu', { endpoint: 'https://192.168.1.10/admin', keys }), /Not a push address/);
  assert.throws(() => subscribe('pu', { endpoint: 'https://evil.example/fcm.googleapis.com/x', keys }), /Not a push address/);
  assert.throws(() => subscribe('pu', { endpoint: 'https://fcm.googleapis.com:8443/x', keys }), /Not a push address/);
  subscribe('pu', { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys });
  subscribe('pu', { endpoint: 'https://web.push.apple.com/QGx', keys });
  assert.throws(() => subscribe('pu', { endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'short', auth: 'x' } }), /Not a push subscription/);
  q('DELETE FROM push_subscriptions').run();
});

test('push: a notification reaches the device, encrypted, signed with the server’s key; quiet when paused; a gone device is forgotten', async () => {
  process.env.PUSH_ANY_ENDPOINT = '1';
  subscribe('pu', { endpoint, keys }, 'Test phone');
  assert.equal(devicesOf('pu')[0].device, 'Test phone');
  notify(['pu'], { kind: 'mention', title: 'Kim mentioned you in “Plan”', body: 'Can you check the figures?', link: '/docs/123' });
  for (let i = 0; i < 50 && !got.length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(got.length, 1);
  assert.equal(got[0].headers['content-encoding'], 'aes128gcm');
  assert.match(got[0].headers.authorization, new RegExp(`^vapid t=.+, k=${vapidKeys().publicKey}$`));
  assert.deepEqual(read(got[0]), { title: 'Kim mentioned you in “Plan”', body: 'Can you check the figures?', link: '/docs/123', tag: 'mention', badge: 1 }, 'with the unread count for the icon');
  // Notifications paused: nothing goes out (unless it's the test one).
  q('UPDATE users SET paused_until = ? WHERE id = ?').run(Date.now() + 36e5, 'pu');
  got = [];
  assert.equal(await pushTo('pu', { title: 'x' }), 0);
  assert.equal(await pushTo('pu', { title: 'Test' }, { force: true }), 1);
  q('UPDATE users SET paused_until = NULL WHERE id = ?').run('pu');
  // The device is gone (the app removed): forgotten.
  answer = 410;
  assert.equal(await pushTo('pu', { title: 'x' }), 0);
  assert.deepEqual(devicesOf('pu'), []);
});

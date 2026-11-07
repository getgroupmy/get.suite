import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unsubscribeOptions, isPrivateAddress, oneClickUnsubscribe } from '../src/mail/unsubscribe.js';

const h = (line) => ({ key: line.slice(0, line.indexOf(':')).toLowerCase(), line });

test('List-Unsubscribe: one-click, web link, mailto', () => {
  assert.deepEqual(unsubscribeOptions([h('List-Unsubscribe: <mailto:unsub@news.example?subject=stop%20please>, <https://news.example/u?id=1>'), h('List-Unsubscribe-Post: List-Unsubscribe=One-Click')]),
    { oneClick: true, url: 'https://news.example/u?id=1', mailto: { to: 'unsub@news.example', subject: 'stop please', body: 'unsubscribe' } });
  assert.deepEqual(unsubscribeOptions([h('List-Unsubscribe: <https://news.example/u>')]), { oneClick: false, url: 'https://news.example/u', mailto: null });
  assert.deepEqual(unsubscribeOptions([h('List-Unsubscribe: <mailto:leave@list.example>')]), { oneClick: false, url: null, mailto: { to: 'leave@list.example', subject: 'unsubscribe', body: 'unsubscribe' } });
  assert.equal(unsubscribeOptions([h('List-Unsubscribe: <http://plain.example/u>'), h('List-Unsubscribe-Post: List-Unsubscribe=One-Click')]).oneClick, false, 'never one-click over http');
  assert.equal(unsubscribeOptions([h('Subject: hi')]), null);
  assert.equal(unsubscribeOptions([h('List-Unsubscribe: <mailto:not an address>')]), null);
});

test('private addresses are refused', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.10', '172.20.0.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:192.168.0.1', 'nonsense']) assert.ok(isPrivateAddress(ip), ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '1.1.1.1', '2606:4700::1111']) assert.ok(!isPrivateAddress(ip), ip);
});

test('one-click: POSTs the RFC 8058 body over https; refuses http and private addresses', async () => {
  await assert.rejects(oneClickUnsubscribe('http://news.example/u'), /https/);
  await assert.rejects(oneClickUnsubscribe('https://127.0.0.1/u'), /private/);
  await assert.rejects(oneClickUnsubscribe('https://localhost:9/u'), /private/, 'names that resolve to the NAS too');
  // A real https server (on this machine, so the private check is relaxed for the test).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unsub-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${dir}/k.pem`, '-out', `${dir}/c.pem`, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  let got = null;
  const server = https.createServer({ key: fs.readFileSync(`${dir}/k.pem`), cert: fs.readFileSync(`${dir}/c.pem`) }, (req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { got = { method: req.method, url: req.url, type: req.headers['content-type'], body }; res.writeHead(200); res.end('ok'); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const status = await oneClickUnsubscribe(`https://127.0.0.1:${server.address().port}/u?id=7`, { allowPrivate: true, tls: { rejectUnauthorized: false } });
    assert.equal(status, 200);
    assert.deepEqual(got, { method: 'POST', url: '/u?id=7', type: 'application/x-www-form-urlencoded', body: 'List-Unsubscribe=One-Click' });
  } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

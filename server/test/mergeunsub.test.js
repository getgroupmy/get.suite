// Unsubscribing from mail merge: the link's page, mail apps' one-click request, the sender's list.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-unsub-'));
process.env.DATA_DIR = dir;
let server, base, m;
before(async () => {
  const { createApp } = await import('../src/app.js');
  m = await import('../src/mail/mergeunsub.js');
  server = http.createServer(createApp());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
function client() {
  let cookie = '';
  return async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json', ...(cookie && { cookie }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const c = res.headers.get('set-cookie'); if (c) cookie = c.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}
const anon = (method, url, body) => fetch(base + url, { method, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: body && JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

let olivia, mia, oliviaId, miaId;
test('set up', async () => {
  olivia = client();
  assert.equal((await olivia('POST', '/api/auth/setup', { org_name: 'Acme', domain: 'acme.com', name: 'Olivia Owner', local: 'olivia', password: 'password123' })).status, 200);
  assert.equal((await olivia('POST', '/api/users', { local: 'mia', domain: 'acme.com', name: 'Mia Member', password: 'password123' })).status, 201);
  mia = client(); assert.equal((await mia('POST', '/api/auth/login', { username: 'mia@acme.com', password: 'password123' })).status, 200);
  oliviaId = (await olivia('GET', '/api/auth/me')).body.id ?? (await olivia('GET', '/api/auth/me')).body.user?.id;
  miaId = (await mia('GET', '/api/auth/me')).body.id ?? (await mia('GET', '/api/auth/me')).body.user?.id;
  assert.ok(oliviaId && miaId);
});

test('one token per sender and address, the same each time; random, so it says nothing about who it is for', () => {
  const t = m.unsubscribeToken(oliviaId, 'Pat@Example.com');
  assert.equal(m.unsubscribeToken(oliviaId, 'pat@example.com'), t);
  assert.notEqual(m.unsubscribeToken(miaId, 'pat@example.com'), t, "another sender's list is their own");
  assert.match(t, /^[\w-]{24}$/);
  assert.doesNotMatch(Buffer.from(t, 'base64url').toString('latin1'), /pat/i);
  const p = m.unsubscribeParts('https://work.acme.com', t);
  assert.equal(p.headers['List-Unsubscribe'], `<https://work.acme.com/u/${t}>`);
  assert.equal(p.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.match(p.text, new RegExp(`https://work\\.acme\\.com/u/${t}$`));
  assert.match(p.html, /<a href="https:\/\/work\.acme\.com\/u\/[\w-]+">Unsubscribe<\/a>/);
});

test('the page: who it is from and a hidden address; confirming leaves; nothing changes just by opening it', async () => {
  const t = m.unsubscribeToken(oliviaId, 'pat@example.com');
  const info = await anon('GET', `/api/public/unsubscribe/${t}`);
  assert.deepEqual(info.body, { email: 'pa•@example.com', from: 'Olivia Owner', left: false });
  assert.equal(m.leftOf(oliviaId).size, 0, 'opening the page (or a link scanner) does not unsubscribe');
  assert.equal((await anon('POST', `/api/public/unsubscribe/${t}`)).status, 200);
  assert.equal((await anon('GET', `/api/public/unsubscribe/${t}`)).body.left, true);
  assert.deepEqual([...m.leftOf(oliviaId)], ['pat@example.com']);
  assert.equal(m.leftOf(miaId).size, 0, "Mia's list is untouched");
  assert.equal((await anon('GET', '/api/public/unsubscribe/nope')).status, 404);
  assert.equal((await anon('POST', '/api/public/unsubscribe/nope')).status, 404);
});

test("a mail app's one-click unsubscribe: a plain form POST to the link, no cookie or header", async () => {
  const t = m.unsubscribeToken(oliviaId, 'sam@example.org');
  const r = await fetch(`${base}/u/${t}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.ok(m.leftOf(oliviaId).has('sam@example.org'));
  assert.equal((await fetch(`${base}/u/unknown-token`, { method: 'POST', body: 'List-Unsubscribe=One-Click' })).status, 404);
});

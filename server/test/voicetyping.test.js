import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-voice-'));
const { createApp } = await import('../src/app.js');
let server, base;
test.before(async () => { server = createApp().listen(0); await new Promise((r) => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
function client() {
  let cookie = '';
  return async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json', ...(cookie && { cookie }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}

test('voice typing: on unless the company turns it off; only admins change it; everyone sees it', async () => {
  const ana = client(), kim = client();
  await ana('POST', '/api/auth/setup', { org_name: 'Acme', domain: 'acme.com', name: 'Ana Admin', local: 'ana', password: 'password123' });
  await ana('POST', '/api/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  await kim('POST', '/api/auth/login', { username: 'kim@acme.com', password: 'password123' });
  assert.equal((await kim('GET', '/api/auth/me')).body.user.voice_typing, true);
  assert.equal((await ana('GET', '/api/orgs/current')).body.voice_typing, true);
  assert.equal((await kim('PATCH', '/api/orgs/current', { voice_typing: false })).status, 403);
  const r = await ana('PATCH', '/api/orgs/current', { voice_typing: false });
  assert.equal(r.status, 200);
  assert.equal(r.body.voice_typing, false);
  assert.equal((await kim('GET', '/api/auth/me')).body.user.voice_typing, false);
  await ana('PATCH', '/api/orgs/current', { voice_typing: true });
  assert.equal((await kim('GET', '/api/auth/me')).body.user.voice_typing, true);
});

// Admin → Activity log → Open in Sheets: what the log shows (its filters too) as a spreadsheet; admins only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-auditsheet-'));
process.env.DATA_DIR = dir;
let server, base;
before(async () => {
  const { createApp } = await import('../src/app.js');
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

test('the activity log as a spreadsheet, filtered as on screen; admins only', async () => {
  const ann = client(), ben = client();
  assert.equal((await ann('POST', '/api/auth/setup', { org_name: 'Acme', domain: 'acme.com', name: 'Ann Owner', local: 'ann', password: 'password123' })).status, 200);
  assert.equal((await ann('POST', '/api/users', { local: 'ben', domain: 'acme.com', name: 'Ben Bell', password: 'password123' })).status, 201);
  assert.equal((await ben('POST', '/api/auth/login', { username: 'ben@acme.com', password: 'password123' })).status, 200);
  const log = (await ann('GET', '/api/audit')).body.entries;
  const r = await ann('POST', '/api/audit/sheet', {});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.entries, log.length);
  assert.match(r.body.name, /^Activity log \d{4}-\d\d-\d\d$/);
  const sh = (await ann('GET', `/api/files/${r.body.id}/content`)).body.content.sheets[0];
  assert.deepEqual([sh.cells.A1, sh.cells.B1, sh.cells.C1, sh.cells.F1, sh.formats.A1, sh.frozen], ['Time (UTC)', 'Who', 'What', 'IP address', { b: true }, { rows: 1, cols: 0 }]);
  assert.match(sh.cells.A2, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  assert.equal(sh.cells.C2, log[0].label, 'newest first, as the log reads');
  // With a filter: only those.
  const only = await ann('POST', '/api/audit/sheet?q=Ann', {});
  const os = (await ann('GET', `/api/files/${only.body.id}/content`)).body.content.sheets[0];
  const want = (await ann('GET', '/api/audit?q=Ann')).body.entries;
  assert.ok(want.length > 0 && want.length < log.length, 'the filter keeps some, not all');
  assert.equal(only.body.entries, want.length);
  assert.equal(os.cells[`A${want.length + 2}`], undefined, 'no more rows than the filter keeps');
  assert.equal((await ann('POST', '/api/audit/sheet?q=nothing-matches-this', {})).status, 400);
  assert.equal((await ben('POST', '/api/audit/sheet', {})).status, 403);
});

// Admin → Users → Open in Sheets: everyone in the company as a spreadsheet, the CSV’s columns; admins only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-peoplesheet-'));
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

test('everyone in the company as a spreadsheet: the CSV’s columns, the heading row kept in view, a phone as written; admins only', async () => {
  const ann = client(), ben = client();
  assert.equal((await ann('POST', '/api/auth/setup', { org_name: 'Acme', domain: 'acme.com', name: 'Ann Owner', local: 'ann', password: 'password123' })).status, 200);
  assert.equal((await ann('POST', '/api/users', { local: 'ben', domain: 'acme.com', name: 'Ben Bell', password: 'password123' })).status, 201);
  assert.equal((await ben('POST', '/api/auth/login', { username: 'ben@acme.com', password: 'password123' })).status, 200);
  const benId = (await ben('GET', '/api/auth/me')).body.user.id;
  await ann('PATCH', `/api/users/${benId}`, { job_title: 'Designer', work_phone: '+44 20 7946 0001' });
  const r = await ann('POST', '/api/users/sheet', {});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual([r.body.name, r.body.people], ['People', 2]);
  const sh = (await ann('GET', `/api/files/${r.body.id}/content`)).body.content.sheets[0];
  assert.deepEqual([sh.name, sh.cells.A1, sh.cells.B1, sh.cells.K1, sh.formats.A1, sh.frozen], ['People', 'Name', 'Email', 'Work phone', { b: true }, { rows: 1, cols: 0 }]);
  assert.deepEqual([sh.cells.A2, sh.cells.B2, sh.cells.C2, sh.cells.A3, sh.cells.I3], ['Ann Owner', 'ann@acme.com', 'yes', 'Ben Bell', 'Designer']);
  assert.equal(sh.cells.K3, "'+44 20 7946 0001", 'a work phone kept as written');
  // Not for someone who isn't an admin.
  assert.equal((await ben('POST', '/api/users/sheet', {})).status, 403);
});

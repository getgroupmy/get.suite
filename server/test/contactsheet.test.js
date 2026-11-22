// Contacts → Open in Sheets: your contacts (or the ticked ones) as a spreadsheet, phones kept as written.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-contactsheet-'));
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

test('contacts as a spreadsheet: the CSV’s columns, a bold heading row kept in view, phones kept as written', async () => {
  const ann = client(), ben = client();
  assert.equal((await ann('POST', '/api/auth/setup', { org_name: 'Acme', domain: 'acme.com', name: 'Ann Owner', local: 'ann', password: 'password123' })).status, 200);
  assert.equal((await ann('POST', '/api/users', { local: 'ben', domain: 'acme.com', name: 'Ben Member', password: 'password123' })).status, 201);
  assert.equal((await ben('POST', '/api/auth/login', { username: 'ben@acme.com', password: 'password123' })).status, 200);
  assert.equal((await ann('POST', '/api/contacts/sheet', {})).status, 400, 'no contacts yet');
  const kim = (await ann('POST', '/api/contacts', { name: 'Kim Park', email: 'kim@client.example', phone: '+44 20 7946 0000', company: 'Client Co' })).body;
  await ann('POST', '/api/contacts', { name: 'Lee Wong', email: 'lee@example.com', phone: '0123 456789' });
  const r = await ann('POST', '/api/contacts/sheet', {});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual([r.body.name, r.body.contacts], ['Contacts', 2]);
  const sh = (await ann('GET', `/api/files/${r.body.id}/content`)).body.content.sheets[0];
  assert.deepEqual([sh.name, sh.cells.A1, sh.cells.B1, sh.cells.C1, sh.formats.A1, sh.frozen], ['Contacts', 'Name', 'E-mail Address', 'Phone', { b: true }, { rows: 1, cols: 0 }]);
  assert.deepEqual([sh.cells.A2, sh.cells.B2, sh.cells.C2, sh.cells.D2, sh.cells.A3, sh.cells.C3], ['Kim Park', 'kim@client.example', "'+44 20 7946 0000", 'Client Co', 'Lee Wong', "'0123 456789"]);
  // Shown as written.
  const shown = (await ann('GET', `/api/files/${r.body.id}/table?range=C2:C3`)).body.rows.map((row) => row[0].text);
  assert.deepEqual(shown, ['+44 20 7946 0000', '0123 456789']);
  // Just the ticked ones; another's contacts aren't yours.
  const one = await ann('POST', '/api/contacts/sheet', { ids: [kim.id] });
  assert.deepEqual([one.body.name, one.body.contacts], ['Contacts (1)', 1]);
  assert.equal((await ben('POST', '/api/contacts/sheet', { ids: [kim.id] })).status, 404);
});

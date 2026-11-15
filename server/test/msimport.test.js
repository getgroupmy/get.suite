import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-msimport-'));
const { createOrg } = await import('../src/tenancy.js');
const { q } = await import('../src/db.js');
const { startMsImport, msStatusOf, msAppOf, cleanMsApp, MS_SCOPE } = await import('../src/mail/msimport.js');

// A stand-in for login.microsoftonline.com: the device code, then "pending" twice, then a token (or what the test says).
let ms, polls = 0, answer = 'token';
const seen = [];
before(async () => {
  ms = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const f = Object.fromEntries(new URLSearchParams(body));
      seen.push({ url: req.url, ...f });
      res.setHeader('content-type', 'application/json');
      if (req.url.endsWith('/devicecode')) return res.end(JSON.stringify({ device_code: 'DEV123', user_code: 'ABCD-EFGH', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 1 }));
      polls++;
      if (polls <= 2) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'authorization_pending' })); }
      if (answer === 'declined') { res.statusCode = 400; return res.end(JSON.stringify({ error: 'authorization_declined', error_description: 'The user declined.' })); }
      res.end(JSON.stringify({ access_token: 'AT-xyz', refresh_token: 'RT', token_type: 'Bearer', expires_in: 3600 }));
    });
  });
  await new Promise((r) => ms.listen(0, '127.0.0.1', r));
  process.env.MS_LOGIN_URL = `http://127.0.0.1:${ms.address().port}`;
});
after(() => ms.close());

const until = async (fn, ms2 = 5000) => { const end = Date.now() + ms2; while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); } };

test('the company’s Microsoft app: a client ID (and tenant), checked', () => {
  assert.deepEqual(cleanMsApp({ client_id: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0', tenant: 'Contoso.onmicrosoft.com' }), { clientId: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0', tenant: 'contoso.onmicrosoft.com' });
  assert.deepEqual(cleanMsApp({ client_id: '', tenant: '' }), { clientId: null, tenant: null }, 'cleared');
  assert.throws(() => cleanMsApp({ client_id: 'my-app' }), /client\) ID/);
  assert.throws(() => cleanMsApp({ client_id: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0', tenant: 'not a tenant!' }), /tenant/);
});

test('sign in at Microsoft with a code, then the import starts with the token (no password)', async () => {
  const { id: orgId, userId } = createOrg({ name: 'Acme', domain: 'acme.com', adminName: 'Ana', adminLocal: 'ana', adminPassword: 'password123' });
  const user = q('SELECT * FROM users WHERE id = ?').get(userId);
  await assert.rejects(startMsImport(user, { email: 'ana@contoso.com' }), /hasn’t set up importing from Microsoft 365/);
  q('UPDATE orgs SET ms_client_id = ?, ms_tenant = ? WHERE id = ?').run('0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0', 'organizations', orgId);
  assert.deepEqual(msAppOf(orgId), { clientId: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0', tenant: 'organizations' });
  await assert.rejects(startMsImport(user, { email: 'not an address' }), /address/);
  const started = [];
  const shown = await startMsImport(user, { email: 'Ana@Contoso.com' }, { start: async (u, opts) => { started.push(opts); }, sleep: () => new Promise((r) => setTimeout(r, 10)) });
  assert.deepEqual([shown.status, shown.user_code, shown.verification_uri, shown.email], ['waiting', 'ABCD-EFGH', 'https://microsoft.com/devicelogin', 'ana@contoso.com']);
  assert.equal(shown.device_code, undefined, 'the device code stays on the server');
  assert.equal(seen[0].url, '/organizations/oauth2/v2.0/devicecode');
  assert.equal(seen[0].scope, MS_SCOPE);
  await until(() => started.length === 1);
  assert.deepEqual(started[0], { host: 'outlook.office365.com', port: 993, username: 'ana@contoso.com', accessToken: 'AT-xyz' });
  assert.equal(seen[1].grant_type, 'urn:ietf:params:oauth:grant-type:device_code');
  assert.equal(seen[1].device_code, 'DEV123');
  await until(() => msStatusOf(userId).status === 'importing');
});

test('declined at Microsoft: said so, nothing started', async () => {
  polls = 0; answer = 'declined';
  const { userId } = createOrg({ name: 'Globex', domain: 'globex.com', adminName: 'Gil', adminLocal: 'gil', adminPassword: 'password123' });
  q('UPDATE orgs SET ms_client_id = ? WHERE id = (SELECT org_id FROM users WHERE id = ?)').run('0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0', userId);
  const user = q('SELECT * FROM users WHERE id = ?').get(userId);
  const started = [];
  await startMsImport(user, { email: 'gil@contoso.com' }, { start: async (u, o) => { started.push(o); }, sleep: () => new Promise((r) => setTimeout(r, 10)) });
  await until(() => msStatusOf(userId).status === 'declined');
  assert.match(msStatusOf(userId).error, /declined/);
  assert.equal(started.length, 0);
});

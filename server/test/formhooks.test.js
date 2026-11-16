// Form webhooks: responses sent as signed JSON to the owner's web address, tried again when it fails;
// only https, never the server's own network; the owner only; the company's outside-sharing setting holds.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-hooks-'));
process.env.DATA_DIR = path.join(dir, 'data');
let server, base, hooks, receiver, hookUrl;
const got = [];
let answerWith = 200;
before(async () => {
  const { createApp } = await import('../src/app.js');
  hooks = await import('../src/formhooks.js');
  server = http.createServer(createApp());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${dir}/k.pem`, '-out', `${dir}/c.pem`, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  receiver = https.createServer({ key: fs.readFileSync(`${dir}/k.pem`), cert: fs.readFileSync(`${dir}/c.pem`) }, (req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { got.push({ headers: req.headers, body }); res.writeHead(answerWith); res.end(); });
  });
  await new Promise((r) => receiver.listen(0, '127.0.0.1', r));
  hookUrl = `https://127.0.0.1:${receiver.address().port}/hooks/forms`;
});
after(() => { server.close(); receiver.close(); fs.rmSync(dir, { recursive: true, force: true }); });
function client() {
  let cookie = '';
  return async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json', ...(cookie && { cookie }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const c = res.headers.get('set-cookie'); if (c) cookie = c.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (!(await fn())) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 50)); } };

let olivia, mia, form;
test('set up: a form, and Mia helping edit it', async () => {
  olivia = client();
  assert.equal((await olivia('POST', '/api/auth/setup', { org_name: 'Acme', domain: 'acme.com', name: 'Olivia Owner', local: 'olivia', password: 'password123' })).status, 200);
  assert.equal((await olivia('PATCH', '/api/orgs/current', { allow_links: true })).status, 200);
  assert.equal((await olivia('POST', '/api/users', { local: 'mia', domain: 'acme.com', name: 'Mia Member', password: 'password123' })).status, 201);
  mia = client(); assert.equal((await mia('POST', '/api/auth/login', { username: 'mia@acme.com', password: 'password123' })).status, 200);
  const made = (await olivia('POST', '/api/forms', { title: 'Leads' })).body;
  form = (await olivia('PUT', `/api/forms/${made.id}`, { allow_edit: true, questions: [{ id: 'name', type: 'short', title: 'Your name', required: true }, { id: 'size', type: 'choice', title: 'Team size', options: ['1-10', '11-50'] }, { id: 'want', type: 'checkbox', title: 'Interested in', options: ['Mail', 'Drive', 'Chat'] }] })).body;
  assert.equal((await olivia('POST', `/api/forms/${form.id}/editors`, { email: 'mia@acme.com' })).status, 200);
});

test('the address: https and public only; the owner only', async () => {
  for (const [url, why] of [['http://example.com/x', /secure address/], ['not a url', /isn’t a web address/], ['https://localhost/x', /private network/], ['https://10.0.0.5/x', /private network/], ['https://192.168.1.2/x', /private network/], ['https://u:p@example.com/x', /password/]]) {
    const r = await olivia('PUT', `/api/forms/${form.id}/webhook`, { url });
    assert.equal(r.status, 400, url);
    assert.match(r.body.error, why, url);
  }
  assert.equal((await mia('PUT', `/api/forms/${form.id}/webhook`, { url: 'https://example.com/x' })).status, 403, 'an editor can’t send responses outside');
  assert.equal((await mia('GET', `/api/forms/${form.id}/webhook`)).status, 403, 'nor see the secret');
  assert.equal((await olivia('GET', `/api/forms/${form.id}/webhook`)).body, null);
  // The form's ordinary details never carry the secret.
  assert.doesNotMatch(JSON.stringify((await olivia('GET', `/api/forms/${form.id}`)).body), /whsec_/);
});

let secret;
test('each response is sent, signed; a changed one too', async () => {
  hooks.setHookOptions({ allowPrivate: true, tls: { rejectUnauthorized: false }, retries: [100, 200] });
  const h = (await olivia('PUT', `/api/forms/${form.id}/webhook`, { url: hookUrl })).body;
  assert.equal(h.url, hookUrl);
  assert.match(h.secret, /^whsec_[\w-]{32}$/);
  secret = h.secret;
  const sent = await olivia('POST', `/api/public/forms/${form.token}`, { answers: { name: 'Pat Lee', size: '11-50', want: ['Mail', 'Chat'] } });
  assert.equal(sent.status, 201);
  await until(() => got.length === 1);
  const { headers, body } = got[0];
  assert.equal(headers['content-type'], 'application/json');
  assert.equal(headers['x-workspace-event'], 'response.created');
  assert.equal(headers['x-workspace-signature'], `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`);
  const p = JSON.parse(body);
  assert.equal(p.event, 'response.created');
  assert.deepEqual(p.form, { id: form.id, title: 'Leads' });
  assert.deepEqual(p.response.from, { name: 'Olivia Owner', email: 'olivia@acme.com' });
  assert.deepEqual(p.response.answers.map((a) => [a.question, a.answer, a.text]), [['Your name', 'Pat Lee', 'Pat Lee'], ['Team size', '11-50', '11-50'], ['Interested in', ['Mail', 'Chat'], 'Mail, Chat']]);
  assert.equal((await olivia('PUT', `/api/public/forms/${form.token}/response/${sent.body.edit_key}`, { answers: { name: 'Pat Lee', size: '1-10' } })).status, 200);
  await until(() => got.length === 2);
  assert.equal(JSON.parse(got[1].body).event, 'response.updated');
  assert.equal(JSON.parse(got[1].body).response.answers[1].answer, '1-10');
  const shown = (await olivia('GET', `/api/forms/${form.id}/webhook`)).body;
  assert.equal(shown.last_status, 200);
  assert.equal(shown.last_error, null);
});

test('a failing receiver is tried twice more, and the settings say why; a test delivery reports at once', async () => {
  answerWith = 500;
  got.length = 0;
  assert.equal((await olivia('POST', `/api/public/forms/${form.token}`, { answers: { name: 'Sam' } })).status, 201);
  await until(() => got.length === 3, 3000);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(got.length, 3, 'no more than three tries');
  assert.equal((await olivia('GET', `/api/forms/${form.id}/webhook`)).body.last_error, 'It answered 500');
  const t = (await olivia('POST', `/api/forms/${form.id}/webhook/test`)).body;
  assert.deepEqual([t.ok, t.status, t.error], [false, 500, 'It answered 500']);
  answerWith = 204;
  const ok = (await olivia('POST', `/api/forms/${form.id}/webhook/test`)).body;
  assert.equal(ok.ok, true);
  assert.equal(JSON.parse(got.at(-1).body).event, 'test');
  assert.equal(JSON.parse(got.at(-1).body).response.answers[0].answer, 'Sam', 'the latest response');
});

test('a new secret replaces the old; turning it off stops deliveries; outside sharing off stops new ones', async () => {
  const fresh = (await olivia('POST', `/api/forms/${form.id}/webhook/secret`)).body.secret;
  assert.notEqual(fresh, secret);
  await olivia('POST', `/api/forms/${form.id}/webhook/test`);
  assert.equal(got.at(-1).headers['x-workspace-signature'], `sha256=${crypto.createHmac('sha256', fresh).update(got.at(-1).body).digest('hex')}`);
  assert.equal((await olivia('DELETE', `/api/forms/${form.id}/webhook`)).status, 200);
  const n = got.length;
  await olivia('POST', `/api/public/forms/${form.token}`, { answers: { name: 'Kim' } });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(got.length, n);
  assert.equal((await olivia('POST', `/api/forms/${form.id}/webhook/test`)).status, 400);
  assert.equal((await olivia('PATCH', '/api/orgs/current', { allow_links: false })).status, 200);
  const r = await olivia('PUT', `/api/forms/${form.id}/webhook`, { url: hookUrl });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /turned off sharing outside/);
  const log = (await olivia('GET', '/api/audit?limit=50')).body;
  const entries = Array.isArray(log) ? log : log.entries || log.items || [];
  assert.ok(entries.some((e) => e.action === 'form.webhook'), JSON.stringify(entries.slice(0, 3)));
});

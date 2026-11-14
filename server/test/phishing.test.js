import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-phish-'));
const { createApp } = await import('../src/app.js');
const { recordPhishing, phishingFor } = await import('../src/phishing.js');
const { securityAlert } = await import('../src/alerts.js');
const { q } = await import('../src/db.js');

let server, base;
test.before(async () => { server = createApp().listen(0); await new Promise((r) => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
function client() {
  let cookie = '';
  return async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json', ...(cookie && { cookie }) }, body: body ? JSON.stringify(body) : undefined });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}

test('phishing reports: grouped by sender for admins, once per person and email, handled and back again; admins told', async () => {
  const ana = client(), kim = client();
  await ana('POST', '/api/auth/setup', { org_name: 'Acme', domain: 'acme.com', name: 'Ana Admin', local: 'ana', password: 'password123' });
  const kimId = (await ana('POST', '/api/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  const leoId = (await ana('POST', '/api/users', { local: 'leo', domain: 'acme.com', name: 'Leo Ruiz', password: 'password123' })).body.id;
  await kim('POST', '/api/auth/login', { username: 'kim@acme.com', password: 'password123' });
  const kimU = q('SELECT * FROM users WHERE id = ?').get(kimId), leoU = q('SELECT * FROM users WHERE id = ?').get(leoId);
  const anaId = q("SELECT id FROM users WHERE username = 'ana@acme.com'").get().id;

  assert.deepEqual(recordPhishing(kimU, { from: 'Payroll@Evil.example', subject: 'Update your bank details', messageId: '<m1@evil>' }, 1000), { reports: 1 });
  assert.deepEqual(recordPhishing(kimU, { from: 'payroll@evil.example', subject: 'Update your bank details', messageId: '<m1@evil>' }, 1100), { already: true, reports: 1 }, 'the same email twice counts once');
  assert.deepEqual(recordPhishing(leoU, { from: 'payroll@evil.example', subject: 'URGENT: bank details', messageId: '<m2@evil>' }, 2000), { reports: 2 });
  recordPhishing(leoU, { from: 'ceo@lookalike.example', subject: 'Gift cards', messageId: '<m3@x>' }, 3000);
  assert.throws(() => recordPhishing(kimU, { from: '', subject: 'x' }), /no sender/);

  // Kim isn't an admin: no list for Kim.
  assert.equal((await kim('GET', '/api/orgs/current/phishing')).status, 403);
  let list = (await ana('GET', '/api/orgs/current/phishing')).body;
  assert.deepEqual(list.map((g) => [g.sender, g.reports, g.people.sort().join('+')]), [['ceo@lookalike.example', 1, 'Leo Ruiz'], ['payroll@evil.example', 2, 'Kim Park+Leo Ruiz']]);
  assert.deepEqual(list[1].subjects, ['URGENT: bank details', 'Update your bank details']);
  assert.equal(list[1].domain, 'evil.example');

  // Handled: goes to the bottom; a new report brings it back.
  list = (await ana('POST', '/api/orgs/current/phishing/handled', { sender: 'ceo@lookalike.example' })).body;
  assert.equal(list[1].sender, 'ceo@lookalike.example');
  assert.equal(list[1].handled_by, 'Ana Admin');
  assert.equal((await ana('POST', '/api/orgs/current/phishing/handled', { sender: 'nobody@x.example' })).status, 404);
  recordPhishing(kimU, { from: 'ceo@lookalike.example', subject: 'Gift cards again', messageId: '<m4@x>' }, 4000);
  assert.equal(phishingFor(kimU.org_id)[0].sender, 'ceo@lookalike.example');
  assert.equal(phishingFor(kimU.org_id)[0].handled_at, null);

  // Admins are told (not the person who reported, if they're an admin themselves).
  securityAlert({ orgId: kimU.org_id, action: 'mail.phishing', actor: { id: kimId, name: 'Kim Park' }, target: 'payroll@evil.example', details: { subject: 'Update your bank details', reports: 2 } });
  const n = q("SELECT title, body FROM notifications WHERE user_id = ? AND kind = 'security' ORDER BY rowid DESC LIMIT 1").get(anaId);
  assert.equal(n.title, 'Kim Park reported a phishing email from payroll@evil.example');
  assert.match(n.body, /“Update your bank details”\. 2 reports of this sender so far\./);
  assert.equal(q("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND kind = 'security'").get(kimId).n, 0);
});

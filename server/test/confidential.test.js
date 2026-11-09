import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-conf-'));
const { createApp } = await import('../src/app.js');
const conf = await import('../src/mail/confidential.js');

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

test('the notice that goes out instead of the message: who, what, the link and until when', () => {
  const n = conf.noticeOf({ fromName: 'Olivia <Boss>', subject: 'Salaries 2027', link: 'https://ws.example/c/abc', expiresAt: Date.UTC(2026, 10, 16, 12) });
  assert.match(n.text, /Olivia <Boss> sent you a confidential message: Salaries 2027\./);
  assert.match(n.text, /Read it here: https:\/\/ws\.example\/c\/abc/);
  assert.match(n.text, /until Monday, 16 November 2026/);
  assert.ok(n.html.includes('Olivia &lt;Boss&gt;') && !n.html.includes('<Boss>'), 'escaped');
  assert.ok(!n.text.includes('the message body'));
});

test('reading it: signed-in recipients and the sender; others by a code emailed to them; expiry and taking it back', async () => {
  const olivia = client(), kim = client(), zed = client(), stranger = client();
  await olivia('POST', '/api/auth/setup', { org_name: 'Acme', domain: 'acme.com', name: 'Olivia Owner', local: 'olivia', password: 'password123' });
  for (const [c, local, name] of [[kim, 'kim', 'Kim Park'], [zed, 'zed', 'Zed Other']]) {
    await olivia('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' });
    await c('POST', '/api/auth/login', { username: `${local}@acme.com`, password: 'password123' });
  }
  const meBody = (await olivia('GET', '/api/auth/me')).body; const me = meBody.user || meBody;
  const sent = [];
  conf.setCodeSender(async (to, { code, fromUser, subject }) => { sent.push({ to, code, from: fromUser.username, subject }); });
  const token = conf.newToken();
  assert.throws(() => conf.keepConfidential({ token, user: me, from: { address: 'olivia@acme.com' }, subject: 'x', recipients: [], days: 3 }), /how long/);
  conf.keepConfidential({ token, user: me, from: { name: 'Olivia Owner', address: 'olivia@acme.com' }, subject: 'Salaries 2027', html: '<p>The numbers</p>', text: 'The numbers',
    recipients: [{ address: 'kim@acme.com' }, { address: 'Client@Example.org' }], days: 7 });
  // Kim (signed in, a recipient) reads it; Olivia (sender) too; Zed (signed in, not a recipient) and strangers only see who and what.
  const k = (await kim('GET', `/api/public/confidential/${token}`)).body;
  assert.deepEqual([k.subject, k.html, k.from.name], ['Salaries 2027', '<p>The numbers</p>', 'Olivia Owner']);
  assert.equal((await olivia('GET', `/api/public/confidential/${token}`)).body.mine, true);
  const z = (await zed('GET', `/api/public/confidential/${token}`)).body;
  assert.deepEqual([z.need, z.html, z.text, z.subject], ['code', undefined, undefined, 'Salaries 2027']);
  // A code: only emailed to its recipients (the answer is the same either way).
  assert.deepEqual((await stranger('POST', `/api/public/confidential/${token}/code`, { email: 'nosy@example.org' })).body, { ok: true, sent_to: 'nosy@example.org' });
  assert.equal(sent.length, 0);
  assert.equal((await stranger('POST', `/api/public/confidential/${token}/code`, { email: 'client@example.org' })).status, 200);
  assert.equal(sent.length, 1);
  assert.deepEqual([sent[0].to, sent[0].from, sent[0].subject], ['client@example.org', 'olivia@acme.com', 'Salaries 2027']);
  assert.equal((await stranger('POST', `/api/public/confidential/${token}/code`, { email: 'client@example.org' })).status, 429, 'one a minute');
  assert.equal((await stranger('POST', `/api/public/confidential/${token}/open`, { email: 'client@example.org', code: '000000' === sent[0].code ? '111111' : '000000' })).status, 400);
  const opened = await stranger('POST', `/api/public/confidential/${token}/open`, { email: 'client@example.org', code: sent[0].code });
  assert.equal(opened.status, 200);
  assert.equal(opened.body.text, 'The numbers');
  assert.equal((await stranger('POST', `/api/public/confidential/${token}/open`, { email: 'client@example.org', code: sent[0].code })).status, 400, 'a code works once');
  // The sender's list: opened twice (Kim, the client), and taking it back.
  assert.equal((await olivia('GET', '/api/mail/confidential')).status, 503, 'the list is under Mail, which is off on this server');
  assert.equal((await kim('POST', `/api/mail/confidential/${token}/revoke`)).status, 503);
  // Taken back (directly here, as Mail is off): gone for everyone.
  const { q } = await import('../src/db.js');
  assert.equal(q('SELECT opened FROM confidential_mail WHERE token = ?').get(token).opened, 2);
  q('UPDATE confidential_mail SET revoked_at = ? WHERE token = ?').run(Date.now(), token);
  const after = await kim('GET', `/api/public/confidential/${token}`);
  assert.equal(after.status, 410);
  assert.match(after.body.error, /Olivia Owner took this message back/);
  // Expired.
  const t2 = conf.newToken();
  conf.keepConfidential({ token: t2, user: me, from: { address: 'olivia@acme.com' }, subject: 'Old', text: 'x', recipients: ['kim@acme.com'], days: 1, now: Date.now() - 2 * 864e5 });
  assert.match((await kim('GET', `/api/public/confidential/${t2}`)).body.error, /expired/);
  assert.equal((await kim('GET', '/api/public/confidential/nope')).status, 404);
});

// Integration test against a running mail server (Postfix + Dovecot + Rspamd from mail/).
// Run: MAIL_IT_CONFIG_DIR=/etc/nw MAIL_IT_IMAP_HOST=127.0.0.1 npm run test:mail
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { ImapFlow } from 'imapflow';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-mail-'));
process.env.DATA_DIR = dir;
process.env.MAIL_CONFIG_DIR = process.env.MAIL_IT_CONFIG_DIR || '/etc/nw';
process.env.MAIL_IMAP_HOST = process.env.MAIL_IT_IMAP_HOST || '127.0.0.1';
process.env.MAIL_HOSTNAME = 'mail.acme.com';
for (const sub of ['postfix', 'dovecot', 'dkim']) fs.rmSync(path.join(process.env.MAIL_CONFIG_DIR, sub), { recursive: true, force: true });

const { createApp } = await import('../src/app.js');
const { setResolver } = await import('../src/routes/mailAdmin.js');
const { closeAll } = await import('../src/mail/imap.js');

let server, base;
before(async () => {
  server = http.createServer(createApp());
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { closeAll(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  return async (method, url, body, { raw } = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'x-requested-with': 'nas-workspace', ...(cookie && { cookie }), ...(body !== undefined && !raw && { 'content-type': 'application/json' }) },
      body: raw ? body : body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function eventually(fn, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch (e) { if (Date.now() > end) throw e; }
    if (Date.now() > end) throw new Error('timed out');
    await sleep(500);
  }
}
async function imapLogin(user, pass) {
  const c = new ImapFlow({ host: process.env.MAIL_IMAP_HOST, port: 993, secure: true, tls: { rejectUnauthorized: false }, auth: { user, pass }, logger: false });
  c.on('error', () => {});
  await c.connect();
  return c;
}
const inbox = async (c, q = '') => (await c('GET', `/api/mail/messages?folder=INBOX${q ? `&q=${encodeURIComponent(q)}` : ''}`)).body.messages || [];

const olivia = client(), bob = client(), gina = client();
let globexId, bobId, salesId;

test('set up two companies, users and an alias', async () => {
  await olivia('POST', '/api/auth/setup', { org_name: 'Acme', domain: 'acme.com', name: 'Olivia Owner', local: 'olivia', password: 'password123' });
  bobId = (await olivia('POST', '/api/users', { local: 'bob', domain: 'acme.com', name: 'Bob Builder', password: 'password123' })).body.id;
  globexId = (await olivia('POST', '/api/orgs', { name: 'Globex', domain: 'globex.com', admin_name: 'Gina Globex', admin_local: 'gina', admin_password: 'password123' })).body.id;
  const a = await olivia('POST', '/api/mail-admin/aliases', { local: 'sales', domain: 'acme.com', targets: 'olivia@acme.com, bob@acme.com' });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  salesId = a.body.id;
  assert.equal((await olivia('POST', '/api/mail-admin/aliases', { local: 'bob', domain: 'acme.com', targets: 'x@y.com' })).status, 400, 'clashes with a user');
  assert.equal((await olivia('POST', '/api/users', { local: 'sales', domain: 'acme.com', name: 'S', password: 'password123' })).status, 400, 'clashes with an alias');
  for (const [c, u] of [[bob, 'bob@acme.com'], [gina, 'gina@globex.com']]) {
    assert.equal((await c('POST', '/api/auth/login', { username: u, password: 'password123' })).status, 200);
  }
  // Tables are written shortly after changes (debounced).
  const files = await eventually(() => {
    const t = fs.readFileSync(path.join(process.env.MAIL_CONFIG_DIR, 'postfix/aliases'), 'utf8');
    return t.includes('sales@') && t;
  }, 3000);
  assert.match(files, /^sales@acme\.com olivia@acme\.com,bob@acme\.com$/m);
  assert.match(files, /^postmaster@globex\.com gina@globex\.com$/m, 'postmaster@ routed to company admins');
  assert.ok(fs.existsSync(path.join(process.env.MAIL_CONFIG_DIR, 'dkim/globex.com.mail.key')));
});

test('webmail is reachable once the mail server picked up the accounts', async () => {
  const folders = await eventually(async () => {
    const r = await gina('GET', '/api/mail/folders');
    return r.status === 200 && r.body;
  });
  assert.deepEqual(folders.map((f) => f.name), ['Inbox', 'Drafts', 'Sent', 'Archive', 'Junk', 'Trash']);
});

test('send across companies and to an alias, with a Drive attachment', async () => {
  const file = (await olivia('POST', '/api/files/upload?name=price-list.csv', 'item,price\nbolt,0.10\n', { raw: true })).body;
  const r = await olivia('POST', '/api/mail/send', {
    to: 'Gina Globex <gina@globex.com>', cc: 'sales@acme.com', subject: 'Price list', text: 'Hi Gina,\nattached.\n', attachments: [file.id],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const msg = await eventually(async () => (await inbox(gina)).find((m) => m.subject === 'Price list'));
  assert.equal(msg.from.address, 'olivia@acme.com');
  assert.equal(msg.attachment, true);
  assert.equal(msg.seen, false);
  const full = (await gina('GET', `/api/mail/messages/${msg.uid}?folder=INBOX`)).body;
  assert.match(full.text, /attached/);
  assert.deepEqual(full.cc.map((a) => a.address), ['sales@acme.com']);
  assert.equal(full.attachments[0].filename, 'price-list.csv');
  const att = await gina('GET', `/api/mail/messages/${msg.uid}/attachments/0?folder=INBOX`);
  assert.equal(att.headers.get('content-type'), 'application/octet-stream');
  assert.equal(att.body.toString(), 'item,price\nbolt,0.10\n');
  assert.equal((await inbox(gina)).find((m) => m.uid === msg.uid).seen, true, 'opening marks it read');

  await eventually(async () => (await inbox(bob)).some((m) => m.subject === 'Price list'));
  const sent = (await olivia('GET', '/api/mail/messages?folder=Sent')).body.messages;
  assert.ok(sent.some((m) => m.subject === 'Price list'), 'copy saved in Sent');
});

test('send as an alias only if you are a member', async () => {
  const ids = (await bob('GET', '/api/mail/status')).body.identities.map((i) => i.address);
  assert.deepEqual(ids, ['bob@acme.com', 'sales@acme.com']);
  assert.equal((await bob('POST', '/api/mail/send', { from: 'sales@acme.com', to: 'gina@globex.com', subject: 'From sales', text: 'x' })).status, 200);
  assert.equal((await gina('POST', '/api/mail/send', { from: 'sales@acme.com', to: 'bob@acme.com', subject: 'spoof', text: 'x' })).status, 400);
  const m = await eventually(async () => (await inbox(gina)).find((x) => x.subject === 'From sales'));
  assert.equal(m.from.address, 'sales@acme.com');
});

test('reply marks the original as answered; search finds it', async () => {
  const orig = (await inbox(gina)).find((m) => m.subject === 'Price list');
  const full = (await gina('GET', `/api/mail/messages/${orig.uid}?folder=INBOX`)).body;
  const r = await gina('POST', '/api/mail/send', {
    to: 'olivia@acme.com', subject: 'Re: Price list', text: 'Thanks!', inReplyTo: full.messageId, references: full.references, replyTo: { folder: 'INBOX', uid: orig.uid },
  });
  assert.equal(r.status, 200);
  assert.equal((await inbox(gina)).find((m) => m.uid === orig.uid).answered, true);
  await eventually(async () => (await inbox(olivia)).some((m) => m.subject === 'Re: Price list'));
  assert.deepEqual((await inbox(olivia, 'Thanks')).map((m) => m.subject), ['Re: Price list']);
});

test('flag, archive, delete to trash, delete forever', async () => {
  const m = (await inbox(gina)).find((x) => x.subject === 'From sales');
  await gina('POST', '/api/mail/messages/flags', { folder: 'INBOX', uids: [m.uid], flagged: true, seen: false });
  const after1 = (await inbox(gina)).find((x) => x.uid === m.uid);
  assert.equal(after1.flagged, true);
  assert.equal(after1.seen, false);
  await gina('POST', '/api/mail/messages/move', { folder: 'INBOX', uids: [m.uid], to: 'archive' });
  const archived = (await gina('GET', '/api/mail/messages?folder=Archive')).body.messages;
  assert.equal(archived.length, 1);
  await gina('POST', '/api/mail/messages/delete', { folder: 'Archive', uids: [archived[0].uid] });
  const trash = (await gina('GET', '/api/mail/messages?folder=Trash')).body.messages;
  assert.equal(trash.length, 1);
  await gina('POST', '/api/mail/messages/delete', { folder: 'Trash', uids: [trash[0].uid] });
  assert.equal((await gina('GET', '/api/mail/messages?folder=Trash')).body.messages.length, 0);
});

test('phones and Outlook sign in with the account password; resets and disabling apply', async () => {
  const c = await imapLogin('bob@acme.com', 'password123');
  await c.logout();
  await olivia('PATCH', `/api/users/${bobId}`, { password: 'new-password-456', mail_quota_mb: 1 });
  await eventually(async () => { const x = await imapLogin('bob@acme.com', 'new-password-456'); await x.logout(); return true; });
  await assert.rejects(imapLogin('bob@acme.com', 'password123'));
  const q = await imapLogin('bob@acme.com', 'new-password-456');
  const quota = await q.getQuota('INBOX');
  await q.logout();
  assert.equal(quota.storage.limit, 1024 * 1024);

  await olivia('PATCH', `/api/users/${bobId}`, { disabled: true });
  await eventually(async () => { try { await imapLogin('bob@acme.com', 'new-password-456'); return false; } catch { return true; } });
  // A disabled account still receives mail (it is suspended, not deleted).
  assert.equal((await gina('POST', '/api/mail/send', { to: 'bob@acme.com', subject: 'While away', text: 'x' })).status, 200);
});

test('postmaster@ reaches the company admin', async () => {
  assert.equal((await olivia('POST', '/api/mail/send', { to: 'postmaster@globex.com', subject: 'DMARC report', text: 'x' })).status, 200);
  await eventually(async () => (await inbox(gina)).some((m) => m.subject === 'DMARC report'));
});

test('DNS records and live check', async () => {
  const domains = (await gina('GET', '/api/mail-admin/domains')).body;
  assert.deepEqual(domains.map((d) => d.name), ['globex.com']);
  const recs = domains[0].records;
  assert.deepEqual(recs.map((r) => `${r.type} ${r.host}`), ['MX globex.com', 'TXT globex.com', 'TXT mail._domainkey.globex.com', 'TXT _dmarc.globex.com']);
  assert.equal(recs[0].value, '10 mail.acme.com');
  const dkim = recs[2].value;
  const fake = {
    resolveMx: async () => [{ priority: 10, exchange: 'mail.acme.com' }],
    resolveTxt: async (name) => ({
      'globex.com': [['v=spf1 mx ~all']],
      'mail._domainkey.globex.com': [[dkim.slice(0, 200), dkim.slice(200)]], // long TXT split into strings
      '_dmarc.globex.com': [],
    }[name] || []),
  };
  setResolver(fake);
  const check = (await gina('GET', '/api/mail-admin/domains/globex.com/check')).body;
  assert.deepEqual(check.results.map((r) => r.ok), [true, true, true, false]);
  assert.equal(check.ok, false);
  assert.equal((await gina('GET', '/api/mail-admin/domains/acme.com/check')).status, 404, 'other company domain');
});

test('alias admin is per company', async () => {
  assert.equal((await gina('PATCH', `/api/mail-admin/aliases/${salesId}`, { targets: 'gina@globex.com' })).status, 404);
  assert.equal((await gina('POST', '/api/mail-admin/aliases', { local: 'info', domain: 'acme.com', targets: 'gina@globex.com' })).status, 400);
  assert.equal((await gina('POST', '/api/mail-admin/aliases', { local: 'info', domain: 'globex.com', targets: 'gina@globex.com, partner@example.org' })).status, 201);
  assert.equal((await bob('GET', '/api/mail-admin/aliases')).status, 401, 'bob is disabled');
});

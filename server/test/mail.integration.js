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
// Sign-in protection: Dovecot calls our policy service; loopback 127.0.0.1 (webmail) stays exempt,
// while 127.0.0.6+ stand in for attackers on the internet.
process.env.AUTH_POLICY_PORT = '18081';
process.env.MAIL_NOTIFY_LINGER_MS = '500';
process.env.AUTH_POLICY_URL = 'http://127.0.0.1:18081/';
process.env.AUTH_NEVER_BAN = '127.0.0.1/32,::1';
process.env.AUTH_SOFT_NETS = ''; // treat 127.0.0.6+ like internet addresses
for (const sub of ['postfix', 'dovecot', 'dkim']) fs.rmSync(path.join(process.env.MAIL_CONFIG_DIR, sub), { recursive: true, force: true });

const { createApp } = await import('../src/app.js');
const { setResolver } = await import('../src/routes/mailAdmin.js');
const { closeAll } = await import('../src/mail/imap.js');
const { startPolicyServer } = await import('../src/security/policyServer.js');
const { attachHub } = await import('../src/hub.js');
const notify = await import('../src/mail/notify.js');
const { default: WS } = await import('ws');
const tls = await import('node:tls');
const nodemailer = (await import('nodemailer')).default;

let server, base, policy;
before(async () => {
  policy = startPolicyServer();
  server = http.createServer(createApp());
  attachHub(server);
  notify.startMailNotifications();
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { notify.stopAll(); closeAll(); server.close(); policy.close(); fs.rmSync(dir, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  const call = async (method, url, body, { raw } = {}) => {
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
  call.cookie = () => cookie;
  return call;
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

// ---- vacation auto-replies (Sieve) ----
test('vacation: validation, one reply per sender, scheduling, turning off', async () => {
  assert.equal((await gina('PUT', '/api/mail/vacation', { enabled: true, body: '' })).status, 400, 'needs a message');
  assert.equal((await gina('PUT', '/api/mail/vacation', { enabled: true, body: 'x', start_date: '2026-12-10', end_date: '2026-12-01' })).status, 400);
  const on = await gina('PUT', '/api/mail/vacation', { enabled: true, subject: 'Away "this week"', body: 'I am at the trade fair.\nBack Monday.' });
  assert.equal(on.status, 200);
  assert.equal(on.body.active, true);
  assert.equal((await gina('GET', '/api/mail/status')).body.vacation.active, true);
  const script = path.join(process.env.MAIL_CONFIG_DIR, 'sieve/gina@globex.com.sieve');
  // Includes the aliases Gina receives (info@ from the alias test, postmaster@/abuse@ as admin).
  const expected = /:addresses \["gina@globex\.com", "info@globex\.com", "postmaster@globex\.com", "abuse@globex\.com"\]/;
  await eventually(() => { try { return expected.test(fs.readFileSync('/run/nw/sieve/gina@globex.com.sieve', 'utf8')); } catch { return false; } }, 15000);

  await olivia('POST', '/api/mail/send', { to: 'gina@globex.com', subject: 'Meeting next week?', text: 'hi' });
  await olivia('POST', '/api/mail/send', { to: 'gina@globex.com', subject: 'Following up', text: 'hi again' });
  const replies = await eventually(async () => {
    const r = (await inbox(olivia)).filter((m) => m.subject === 'Away "this week"');
    return r.length && r;
  });
  const full = (await olivia('GET', `/api/mail/messages/${replies[0].uid}?folder=INBOX`)).body;
  assert.equal(full.from.address, 'gina@globex.com');
  assert.match(full.text, /trade fair\.\nBack Monday\./);
  await sleep(3000);
  assert.equal((await inbox(olivia)).filter((m) => m.subject === 'Away "this week"').length, 1, 'only one reply per sender per day');

  const later = await gina('PUT', '/api/mail/vacation', { enabled: true, subject: 'Away', body: 'Later', start_date: '2099-01-01', end_date: '2099-01-10' });
  assert.equal(later.body.active, false);
  assert.equal(later.body.scheduled, true);
  await eventually(() => /currentdate :value "ge" "date" "2099-01-01"/.test(fs.readFileSync(script, 'utf8')), 3000);

  const past = await gina('PUT', '/api/mail/vacation', { enabled: true, subject: 'Away', body: 'Old', start_date: '2020-01-01', end_date: '2020-01-02' });
  assert.equal(past.body.active, false);
  await eventually(() => !fs.existsSync(script), 3000); // expired: no script at all

  await gina('PUT', '/api/mail/vacation', { enabled: false, subject: 'Away', body: 'Old' });
  assert.equal((await gina('GET', '/api/mail/vacation')).body.enabled, false);
});

// ---- drafts ----
test('drafts: save, update in place, reopen with Bcc and attachments, send removes the draft', async () => {
  const file = (await olivia('POST', '/api/files/upload?name=terms.txt', 'payment in 30 days', { raw: true })).body;
  const first = await olivia('POST', '/api/mail/drafts', { to: 'gina@globex.com, half-typed@', bcc: 'boss@acme.com', subject: 'Contract', text: 'Draft v1', attachments: [file.id] });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const drafts = async () => (await olivia('GET', '/api/mail/messages?folder=Drafts')).body.messages;
  assert.equal((await drafts()).length, 1);

  const second = await olivia('POST', '/api/mail/drafts', { uid: first.body.uid, to: 'gina@globex.com, half-typed@', bcc: 'boss@acme.com', subject: 'Contract v2', text: 'Draft v2', attachments: [file.id] });
  const list = await drafts();
  assert.equal(list.length, 1, 'the previous copy is replaced');
  assert.equal(list[0].subject, 'Contract v2');
  assert.equal(list[0].uid, second.body.uid);

  const d = (await olivia('GET', `/api/mail/drafts/${second.body.uid}`)).body;
  assert.equal(d.to, 'gina@globex.com, half-typed@', 'kept exactly as typed');
  assert.equal(d.bcc, 'boss@acme.com');
  assert.equal(d.text.trim(), 'Draft v2');
  assert.deepEqual(d.attachments.map((a) => a.name), ['terms.txt']);

  const sent = await olivia('POST', '/api/mail/send', { to: 'gina@globex.com', subject: 'Contract v2', text: 'Final', attachments: [file.id], draftUid: second.body.uid });
  assert.equal(sent.status, 200);
  assert.equal((await drafts()).length, 0, 'sending removes the draft');
  await eventually(async () => (await inbox(gina)).some((m) => m.subject === 'Contract v2'));

  const third = await olivia('POST', '/api/mail/drafts', { to: '', subject: '', text: 'just a note' });
  assert.equal((await olivia('DELETE', `/api/mail/drafts/${third.body.uid}`)).status, 200);
  assert.equal((await drafts()).length, 0);
});

// ---- filter rules (Sieve) ----
test('filter rules: move + mark read, star + forward, delete, chained rules, folders', async () => {
  const bad = await olivia('PUT', '/api/mail/rules', { rules: [{ conditions: [], actions: { star: true } }] });
  assert.equal(bad.status, 400);
  const saved = await olivia('PUT', '/api/mail/rules', { rules: [
    { name: 'Newsletters', conditions: [{ field: 'from', op: 'contains', value: 'news@' }], actions: { moveTo: 'Newsletters', markRead: true } },
    { name: 'Invoices', conditions: [{ field: 'subject', op: 'contains', value: 'invoice' }], actions: { star: true, forwardTo: 'gina@globex.com', stop: false } },
    { name: 'Block pest', conditions: [{ field: 'from', op: 'is', value: 'pest@acme.com' }], actions: { delete: true } },
    { name: 'Finance', conditions: [{ field: 'subject', op: 'contains', value: 'invoice' }], actions: { moveTo: 'Finance/2026' } },
    { name: 'Disabled', enabled: false, conditions: [{ field: 'subject', op: 'contains', value: 'hello' }], actions: { delete: true } },
  ] });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal((await olivia('GET', '/api/mail/rules')).body.length, 5);
  await eventually(() => { try { return /Finance\/2026/.test(fs.readFileSync('/run/nw/sieve/olivia@acme.com.sieve', 'utf8')); } catch { return false; } }, 15000);

  const t = nodemailer.createTransport({ host: process.env.MAIL_IMAP_HOST, port: 25, secure: false, ignoreTLS: true, name: 'test.acme.com' });
  const send = (from, subject) => t.sendMail({ from, to: 'olivia@acme.com', subject, text: 'x' });
  await send('Acme News <news@acme.com>', 'Weekly digest');
  await send('Supplier <supplier@acme.com>', 'Your invoice #42');
  await send('Pest Control <pest@acme.com>', 'Buy now');
  await send('Friend <friend@acme.com>', 'hello there');

  const folders = await eventually(async () => {
    const f = (await olivia('GET', '/api/mail/folders')).body;
    return f.some((x) => x.path === 'Newsletters') && f.some((x) => x.path === 'Finance/2026') && f;
  });
  assert.ok(folders);
  const list = async (folder) => (await olivia('GET', `/api/mail/messages?folder=${encodeURIComponent(folder)}`)).body.messages;
  const news = await eventually(async () => (await list('Newsletters')).find((m) => m.subject === 'Weekly digest'));
  assert.equal(news.seen, true, 'marked read');
  const invoice = await eventually(async () => (await list('Finance/2026')).find((m) => m.subject === 'Your invoice #42'));
  assert.equal(invoice.flagged, true, 'starred by the first rule, filed by a later one');
  await eventually(async () => (await inbox(olivia)).some((m) => m.subject === 'hello there'));
  const inboxSubjects = (await inbox(olivia)).map((m) => m.subject);
  assert.ok(!inboxSubjects.includes('Weekly digest') && !inboxSubjects.includes('Your invoice #42'));
  assert.ok(!inboxSubjects.includes('Buy now'), 'deleted by rule');
  for (const f of folders) assert.ok(!(await list(f.path)).some((m) => m.subject === 'Buy now'), `not in ${f.path}`);
  await eventually(async () => (await inbox(gina)).some((m) => m.subject === 'Your invoice #42'), 20000);

  assert.equal((await olivia('POST', '/api/mail/folders', { name: 'Projects/Alpha' })).status, 201);
  assert.equal((await olivia('POST', '/api/mail/folders', { name: 'projects/alpha' })).status, 400, 'duplicate');
  assert.ok((await olivia('GET', '/api/mail/folders')).body.some((f) => f.path === 'Projects/Alpha'));

  await olivia('PUT', '/api/mail/rules', { rules: [] });
  await eventually(() => !fs.existsSync(path.join(process.env.MAIL_CONFIG_DIR, 'sieve/olivia@acme.com.sieve')), 3000);
});

// ---- folders: rename / delete ----
test('folders: rename with subfolders updates filters; delete moves mail to Trash and switches filters off', async () => {
  assert.equal((await olivia('POST', '/api/mail/folders', { name: 'Clients/Acme' })).status, 201);
  await olivia('PUT', '/api/mail/rules', { rules: [{ name: 'Acme', conditions: [{ field: 'subject', op: 'contains', value: 'acme-order' }], actions: { moveTo: 'Clients/Acme' } }] });
  await olivia('POST', '/api/mail/send', { to: 'olivia@acme.com', subject: 'Note to self', text: 'file me' });
  const note = await eventually(async () => (await inbox(olivia)).find((m) => m.subject === 'Note to self'));
  await olivia('POST', '/api/mail/messages/move', { folder: 'INBOX', uids: [note.uid], to: 'Clients/Acme' });

  // Phones only show subscribed folders.
  const phone = await imapLogin('olivia@acme.com', 'password123');
  assert.ok((await phone.list()).find((b) => b.path === 'Clients/Acme')?.subscribed, 'new folder is subscribed');

  assert.equal((await olivia('PATCH', '/api/mail/folders', { path: 'INBOX', newPath: 'Old' })).status, 400, 'Inbox is protected');
  assert.equal((await olivia('PATCH', '/api/mail/folders', { path: 'Sent', newPath: 'Old' })).status, 400, 'Sent is protected');
  assert.equal((await olivia('DELETE', '/api/mail/folders?path=Trash')).status, 400, 'Trash is protected');
  assert.equal((await olivia('PATCH', '/api/mail/folders', { path: 'Clients', newPath: 'Clients/Inner' })).status, 400, 'not into itself');
  assert.equal((await olivia('PATCH', '/api/mail/folders', { path: 'Clients', newPath: 'Archive' })).status, 400, 'name taken');

  const ren = await olivia('PATCH', '/api/mail/folders', { path: 'Clients', newPath: 'Customers' });
  assert.equal(ren.status, 200, JSON.stringify(ren.body));
  assert.equal(ren.body.updatedFilters, 1);
  const paths = (await olivia('GET', '/api/mail/folders')).body.map((f) => f.path);
  assert.ok(paths.includes('Customers/Acme') && !paths.some((p) => p.startsWith('Clients')), paths.join(','));
  assert.deepEqual((await olivia('GET', '/api/mail/messages?folder=Customers%2FAcme')).body.messages.map((m) => m.subject), ['Note to self']);
  assert.equal((await olivia('GET', '/api/mail/rules')).body[0].actions.moveTo, 'Customers/Acme');
  assert.ok((await phone.list()).find((b) => b.path === 'Customers/Acme')?.subscribed, 'renamed folder stays subscribed');
  await phone.logout();

  const del = await olivia('DELETE', '/api/mail/folders?path=Customers');
  assert.equal(del.status, 200, JSON.stringify(del.body));
  assert.equal(del.body.movedToTrash, 1);
  assert.equal(del.body.disabledFilters, 1);
  assert.ok(!(await olivia('GET', '/api/mail/folders')).body.some((f) => f.path.startsWith('Customers')));
  assert.ok((await olivia('GET', '/api/mail/messages?folder=Trash')).body.messages.some((m) => m.subject === 'Note to self'), 'mail kept in Trash');
  assert.equal((await olivia('GET', '/api/mail/rules')).body[0].enabled, false);
  await olivia('PUT', '/api/mail/rules', { rules: [] });
});

test('signatures: one per sending address, only for your own identities', async () => {
  // Olivia belongs to the sales@ alias, so she has two sending addresses.
  const mine = (await olivia('GET', '/api/mail/signatures')).body;
  assert.deepEqual(mine.map((x) => x.address), ['olivia@acme.com', 'sales@acme.com']);
  assert.ok(mine.every((x) => x.html === '' && x.on_new && x.on_reply));
  await olivia('PUT', '/api/mail/signatures/olivia@acme.com', { html: '<p><strong>Olivia Owner</strong></p>', on_reply: false });
  await olivia('PUT', '/api/mail/signatures/SALES@acme.com', { html: '<p>Acme Sales Team</p>' });
  const after = Object.fromEntries((await olivia('GET', '/api/mail/signatures')).body.map((x) => [x.address, x]));
  assert.equal(after['olivia@acme.com'].html, '<p><strong>Olivia Owner</strong></p>');
  assert.equal(after['olivia@acme.com'].on_reply, false);
  assert.equal(after['sales@acme.com'].html, '<p>Acme Sales Team</p>');
  assert.equal((await gina('PUT', '/api/mail/signatures/sales@acme.com', { html: 'x' })).status, 400, 'not her alias');
  assert.equal((await olivia('PUT', '/api/mail/signatures/olivia@acme.com', { html: 'x'.repeat(20001) })).status, 400);
});

test('inline images: Drive pictures are embedded as cid parts; others refused', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const pic = (await olivia('POST', '/api/files/upload?name=logo.png', png, { raw: true })).body;
  const doc = (await olivia('POST', '/api/files/upload?name=notes.txt', 'text', { raw: true })).body;
  const html = `<p>Our logo:</p><p><img src="/api/files/${pic.id}/raw" alt="logo.png"></p><p>again <img src="/api/files/${pic.id}/raw"></p>`;
  const r = await olivia('POST', '/api/mail/send', { to: 'gina@globex.com', subject: 'Logo inline', text: 'Our logo: [image: logo.png]', html });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const m = await eventually(async () => (await inbox(gina)).find((x) => x.subject === 'Logo inline'));
  const full = (await gina('GET', `/api/mail/messages/${m.uid}?folder=INBOX`)).body;
  // mailparser turns cid: references into data: URIs for display; the picture is not a separate attachment.
  assert.equal((full.html.match(/src="data:image\/png;base64,/g) || []).length, 2, 'both references point at the embedded picture');
  assert.ok(!full.html.includes('/api/files/'), 'no links back to this server');
  assert.deepEqual(full.attachments, [], 'embedded once, shown inline, not listed as an attachment');

  assert.equal((await olivia('POST', '/api/mail/send', { to: 'gina@globex.com', subject: 'x', text: 'x', html: `<img src="/api/files/${doc.id}/raw">` })).status, 400, 'not an image');
  assert.equal((await gina('POST', '/api/mail/send', { to: 'olivia@acme.com', subject: 'x', text: 'x', html: `<img src="/api/files/${pic.id}/raw">` })).status, 400, 'someone else\'s file');
});

test('catch-all: unknown addresses go to the chosen mailbox; real mailboxes are untouched', async () => {
  const catcher = client();
  await olivia('POST', '/api/users', { local: 'catch', domain: 'acme.com', name: 'Catch All', password: 'password123' });
  await catcher('POST', '/api/auth/login', { username: 'catch@acme.com', password: 'password123' });
  assert.equal((await olivia('PATCH', '/api/mail-admin/domains/acme.com', { catchall: 'gina@globex.com' })).status, 400, 'must be in this company');
  assert.equal((await gina('PATCH', '/api/mail-admin/domains/acme.com', { catchall: 'gina@globex.com' })).status, 404, 'not her domain');
  const before = await gina('POST', '/api/mail/send', { to: 'nobody-here@acme.com', subject: 'x', text: 'x' });
  assert.equal(before.status, 400, 'unknown address rejected while there is no catch-all');

  const on = await olivia('PATCH', '/api/mail-admin/domains/acme.com', { catchall: 'catch@acme.com' });
  assert.equal(on.body.catchall, 'catch@acme.com');
  assert.equal((await olivia('GET', '/api/mail-admin/domains')).body[0].catchall, 'catch@acme.com');
  await eventually(() => { try { return /^@acme\.com catch@acme\.com$/m.test(fs.readFileSync('/run/nw/postfix/aliases', 'utf8')); } catch { return false; } }, 15000);
  const t = fs.readFileSync('/run/nw/postfix/aliases', 'utf8');
  assert.match(t, /^olivia@acme\.com olivia@acme\.com$/m, 'real mailboxes keep their mail');

  assert.equal((await gina('POST', '/api/mail/send', { to: 'quotes@acme.com', subject: 'Quote request via catch-all', text: 'x' })).status, 200);
  assert.equal((await gina('POST', '/api/mail/send', { to: 'olivia@acme.com', subject: 'For Olivia only', text: 'x' })).status, 200);
  await eventually(async () => (await inbox(catcher)).some((m) => m.subject === 'Quote request via catch-all'), 20000);
  await eventually(async () => (await inbox(olivia)).some((m) => m.subject === 'For Olivia only'));
  assert.ok(!(await inbox(catcher)).some((m) => m.subject === 'For Olivia only'), 'catch-all does not take real mailboxes’ mail');

  await olivia('PATCH', '/api/mail-admin/domains/acme.com', { catchall: null });
  await eventually(() => !/^@acme\.com /m.test(fs.readFileSync('/run/nw/postfix/aliases', 'utf8')), 15000);
  await sleep(1500); // Postfix reload
  assert.equal((await gina('POST', '/api/mail/send', { to: 'nobody-again@acme.com', subject: 'x', text: 'x' })).status, 400, 'off again');
});

test('forwarding includes the attachments you keep; forward drafts remember them', async () => {
  const a = (await olivia('POST', '/api/files/upload?name=contract.txt', 'CONTRACT BODY', { raw: true })).body;
  const b = (await olivia('POST', '/api/files/upload?name=prices.csv', 'a,b\n1,2\n', { raw: true })).body;
  await olivia('POST', '/api/mail/send', { to: 'gina@globex.com', subject: 'Two files', text: 'see attached', attachments: [a.id, b.id] });
  const orig = await eventually(async () => (await inbox(gina)).find((m) => m.subject === 'Two files'));
  const full = (await gina('GET', `/api/mail/messages/${orig.uid}?folder=INBOX`)).body;
  assert.deepEqual(full.attachments.map((x) => x.filename), ['contract.txt', 'prices.csv']);

  const draft = await gina('POST', '/api/mail/drafts', { to: 'olivia@acme.com', subject: 'Fwd: Two files', text: 'fyi',
    forwardOf: { folder: 'INBOX', uid: orig.uid, attachments: [1], files: [full.attachments[1]] } });
  const d = (await gina('GET', `/api/mail/drafts/${draft.body.uid}`)).body;
  assert.deepEqual(d.forwardOf.attachments, [1]);
  assert.equal(d.forwardOf.files[0].filename, 'prices.csv');

  const r = await gina('POST', '/api/mail/send', { to: 'olivia@acme.com', subject: 'Fwd: Two files', text: 'fyi',
    forwardOf: { folder: 'INBOX', uid: orig.uid, attachments: [1] }, draftUid: draft.body.uid });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const fwd = await eventually(async () => (await inbox(olivia)).find((m) => m.subject === 'Fwd: Two files'));
  const ff = (await olivia('GET', `/api/mail/messages/${fwd.uid}?folder=INBOX`)).body;
  assert.deepEqual(ff.attachments.map((x) => x.filename), ['prices.csv'], 'only the kept attachment');
  assert.equal((await olivia('GET', `/api/mail/messages/${fwd.uid}/attachments/0?folder=INBOX`)).body.toString(), 'a,b\n1,2\n');
  assert.equal((await gina('POST', '/api/mail/send', { to: 'olivia@acme.com', subject: 'x', text: 'x', forwardOf: { folder: 'INBOX', uid: 999999, attachments: [0] } })).status, 400, 'original gone');
});

test('forward as attachment: the original arrives whole as an .eml file', async () => {
  const orig = await eventually(async () => (await inbox(gina)).find((m) => m.subject === 'Two files'));
  const draft = await gina('POST', '/api/mail/drafts', { to: 'olivia@acme.com', subject: 'Fwd: Two files (as attachment)', text: 'fyi',
    forwardOf: { folder: 'INBOX', uid: orig.uid, asEml: true, attachments: [], eml: { filename: 'Two files.eml', size: 1234 } } });
  const d = (await gina('GET', `/api/mail/drafts/${draft.body.uid}`)).body;
  assert.equal(d.forwardOf.asEml, true);
  assert.equal(d.forwardOf.eml.filename, 'Two files.eml');
  const r = await gina('POST', '/api/mail/send', { to: 'olivia@acme.com', subject: 'Fwd: Two files (as attachment)', text: 'fyi',
    forwardOf: { folder: 'INBOX', uid: orig.uid, asEml: true }, draftUid: draft.body.uid });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const m = await eventually(async () => (await inbox(olivia)).find((x) => x.subject === 'Fwd: Two files (as attachment)'));
  const full = (await olivia('GET', `/api/mail/messages/${m.uid}?folder=INBOX`)).body;
  const eml = full.attachments.find((a) => a.filename === 'Two files.eml');
  assert.ok(eml, JSON.stringify(full.attachments));
  assert.equal(eml.contentType, 'message/rfc822');
  const raw = (await olivia('GET', `/api/mail/messages/${m.uid}/attachments/${eml.index}?folder=INBOX`)).body.toString();
  assert.match(raw, /^Subject: Two files$/m, 'the original headers are intact');
  assert.match(raw, /contract\.txt/, 'with its own attachments inside');
  assert.match(raw, /DKIM-Signature:/, 'including the original signature, for investigations');
});

test('new mail is pushed to open Workspace tabs within seconds (IMAP IDLE)', async () => {
  const ws = new WS(`${base.replace('http', 'ws')}/ws`, { headers: { cookie: olivia.cookie() } });
  const events = [];
  ws.on('message', (d) => events.push(JSON.parse(d)));
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  try {
  await eventually(() => events.some((e) => e.type === 'mail-unread'), 15000); // watcher connected
  assert.equal(notify.watchingCount(), 1);

  const t0 = Date.now();
  await gina('POST', '/api/mail/send', { to: 'olivia@acme.com', subject: 'Ping via IDLE', text: 'x' });
  const ev = await eventually(() => events.find((e) => e.type === 'mail-new' && e.subject === 'Ping via IDLE'), 15000);
  assert.equal(ev.from.address, 'gina@globex.com');
  assert.equal(ev.from.name, 'Gina Globex');
  assert.ok(Date.now() - t0 < 10000, `took ${Date.now() - t0} ms`);
  const unread = await eventually(() => events.filter((e) => e.type === 'mail-unread').at(-1)?.unseen >= 1 && events.filter((e) => e.type === 'mail-unread').at(-1));
  assert.equal((await olivia('GET', '/api/mail/unread')).body.unseen, unread.unseen);
  assert.ok(!events.some((e) => e.type === 'mail-new' && e.subject === 'Ping via IDLE' && e !== ev), 'one notification per message');
  assert.equal((await inbox(olivia)).find((m) => m.subject === 'Ping via IDLE').seen, false, 'watching never marks mail as read');

  } finally { ws.close(); }
  await eventually(() => notify.watchingCount() === 0, 5000); // closed shortly after the last tab goes away
});

// ---- sign-in protection against the real Dovecot + Postfix ----
function rawImapLogin(user, pass, localAddress) {
  return new Promise((resolve) => {
    const sock = tls.connect({ host: process.env.MAIL_IMAP_HOST, port: 993, localAddress, rejectUnauthorized: false });
    let buf = '', sent = false;
    sock.on('data', (d) => {
      buf += d;
      if (!sent && buf.includes('* OK')) { sent = true; sock.write(`a1 LOGIN "${user}" "${pass}"\r\n`); }
      const m = buf.match(/a1 (OK|NO|BAD)([^\r\n]*)/);
      if (m) { sock.end(); resolve(`${m[1]}${m[2]}`); }
    });
    sock.on('error', (e) => resolve(`ERR ${e.message}`));
  });
}
async function smtpLogin(user, pass, localAddress) {
  const t = nodemailer.createTransport({ host: process.env.MAIL_IMAP_HOST, port: 465, secure: true, localAddress, tls: { rejectUnauthorized: false }, auth: { user, pass } });
  try { await t.verify(); return 'OK'; } catch (e) { return `FAIL ${e.response || e.message}`; }
}

test('password guessing over IMAP blocks the address for IMAP and SMTP, others unaffected', async () => {
  await eventually(() => fs.readFileSync('/run/nw/dovecot/policy.conf', 'utf8').includes('18081'), 15000).catch(() => {});
  const attacker = '127.0.0.6';
  const guesses = await Promise.all(Array.from({ length: 10 }, (_, i) => rawImapLogin('olivia@acme.com', `guess-${i}`, attacker)));
  assert.ok(guesses.every((g) => g.startsWith('NO')), guesses.join(' | '));
  const blocked = await rawImapLogin('olivia@acme.com', 'password123', attacker);
  assert.match(blocked, /^NO .*Too many failed sign-ins/, 'right password is refused from a blocked address');
  // Refused either by our policy ("Too many failed sign-ins") or, right after a burst of failures,
  // by Dovecot's own slow-down making Postfix give up ("Temporary authentication failure").
  const smtp = await smtpLogin('olivia@acme.com', 'password123', attacker);
  assert.match(smtp, /^FAIL .*(Too many failed sign-ins|Temporary authentication failure)/, 'blocked for SMTP too');
  assert.match(await rawImapLogin('olivia@acme.com', 'password123', '127.0.0.7'), /^OK/, 'other addresses still sign in');
  assert.equal((await olivia('GET', '/api/mail/folders')).status, 200, 'webmail keeps working');

  const sec = (await olivia('GET', '/api/security')).body;
  assert.equal(sec.bans[0].ip, attacker);
  assert.match(sec.bans[0].reason, /10 failed sign-ins .*imap/);
  assert.equal((await gina('GET', '/api/security')).status, 403, 'platform owner only');

  assert.equal((await olivia('DELETE', `/api/security/bans/${attacker}`)).status, 200);
  assert.match(await rawImapLogin('olivia@acme.com', 'password123', attacker), /^OK/, 'unblocked');
});

test('password guessing over SMTP submission is caught too', async () => {
  const attacker = '127.0.0.8';
  const tries = await Promise.all(Array.from({ length: 10 }, (_, i) => smtpLogin(`user${i}@acme.com`, `pw${i}`, attacker)));
  assert.ok(tries.every((t) => t.startsWith('FAIL')));
  assert.match(await rawImapLogin('olivia@acme.com', 'password123', attacker), /Too many failed sign-ins/);
});

test('a phone retrying an old password is not blocked', async () => {
  const office = '127.0.0.9';
  for (let i = 0; i < 12; i++) assert.match(await rawImapLogin('olivia@acme.com', 'old-password', office), /^NO/);
  assert.match(await rawImapLogin('olivia@acme.com', 'password123', office), /^OK/);
});

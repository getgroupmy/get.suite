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
process.env.MAIL_STATUS_DIR = process.env.MAIL_IT_STATUS_DIR || '/var/nw-status'; // the queue report (mail/entrypoint.sh)
process.env.MAIL_IMPORT_ALLOW_PRIVATE = '1'; // importing from this machine's own mail server
// Sign-in protection: Dovecot calls our policy service; loopback 127.0.0.1 (webmail) stays exempt,
// while 127.0.0.6+ stand in for attackers on the internet.
process.env.AUTH_POLICY_PORT = '18081';
process.env.MAIL_NOTIFY_LINGER_MS = '500';
process.env.MAIL_NOTIFY_FRESH_MS = '8000'; // mail older than this that is moved into a followed folder isn't "new"
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
const rsvp = await import('../src/mail/rsvp.js');
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
  const call = async (method, url, body, { raw, headers = {} } = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'x-requested-with': 'nas-workspace', ...(cookie && { cookie }), ...(body !== undefined && !raw && { 'content-type': 'application/json' }), ...headers },
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

test('a mail-app password replaces the account password for mail apps (not for webmail)', async () => {
  const before = await imapLogin('gina@globex.com', 'password123');
  await before.logout();
  assert.equal((await gina('POST', '/api/auth/mail-app', { password: 'wrong' })).status, 400, 'needs the account password');
  const made = await gina('POST', '/api/auth/mail-app', { password: 'password123' });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.match(made.body.password, /^[a-z]{4}-[a-z]{4}-[a-z]{4}-[a-z]{4}$/);
  assert.ok(made.body.appPassword.created);
  const app = made.body.password; // exactly as shown, with the dashes
  // Within a few seconds the mail server only accepts the app password.
  await eventually(async () => { try { await imapLogin('gina@globex.com', 'password123'); return false; } catch { return true; } });
  const phone = await imapLogin('gina@globex.com', app);
  await phone.logout();
  assert.equal((await gina('GET', '/api/mail/folders')).status, 200, 'webmail is unaffected');
  assert.equal((await gina('GET', '/api/auth/mail-app')).body.appPassword !== null, true);
  // Removing it brings the account password back for mail apps.
  assert.equal((await gina('DELETE', '/api/auth/mail-app', { password: 'password123' })).status, 200);
  await eventually(async () => { const c = await imapLogin('gina@globex.com', 'password123'); await c.logout(); return true; });
  await assert.rejects(imapLogin('gina@globex.com', app));
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

test('scheduled send: waits, then goes out dated when sent; cancelling puts it back in Drafts', async () => {
  const { sendDue } = await import('../src/routes/webmail.js');
  const { q } = await import('../src/db.js');
  const at = Date.now() + 2 * 36e5;
  const s = await olivia('POST', '/api/mail/send', { to: 'gina@globex.com', subject: 'Scheduled hello', text: 'Sent later', sendAt: at });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  assert.deepEqual((await olivia('GET', '/api/mail/scheduled')).body.map((m) => [m.subject, m.status]), [['Scheduled hello', 'scheduled']]);
  await sendDue();
  assert.equal((await inbox(gina)).some((m) => m.subject === 'Scheduled hello'), false, 'not before its time');
  q('UPDATE scheduled_mail SET send_at = ? WHERE id = ?').run(Date.now() - 1000, s.body.scheduled.id); // its time has come
  const madeAt = Date.now();
  assert.equal(await sendDue(), 1);
  const got = await eventually(async () => (await inbox(gina)).find((m) => m.subject === 'Scheduled hello'));
  assert.ok(new Date(got.date).getTime() >= madeAt - 2000, 'dated when it was sent, not when it was scheduled');
  assert.deepEqual((await olivia('GET', '/api/mail/scheduled')).body, []);
  await eventually(async () => (await olivia('GET', '/api/mail/messages?folder=Sent')).body.messages.some((m) => m.subject === 'Scheduled hello'));

  const later = await olivia('POST', '/api/mail/send', { to: 'gina@globex.com', subject: 'Changed my mind', text: 'Not yet', sendAt: at });
  const back = await olivia('DELETE', `/api/mail/scheduled/${later.body.scheduled.id}`);
  assert.deepEqual(back.body, { ok: true, draft: true });
  const drafts = (await olivia('GET', '/api/mail/messages?folder=Drafts')).body.messages;
  const d = drafts.find((m) => m.subject === 'Changed my mind');
  assert.ok(d, 'back in Drafts');
  assert.equal((await olivia('GET', `/api/mail/drafts/${d.uid}`)).body.text.trim(), 'Not yet');
  await olivia('DELETE', `/api/mail/drafts/${d.uid}`);
});

test('snooze: off to Snoozed, back to the Inbox unread when due; snooze again; unsnooze; moved out by hand stays out', async () => {
  const { wakeDue } = await import('../src/routes/webmail.js');
  const { q } = await import('../src/db.js');
  for (const subject of ['Snooze me', 'Snooze me too', 'Snooze me three']) {
    assert.ok([200, 201].includes((await gina('POST', '/api/mail/send', { to: 'olivia@acme.com', subject, text: 'later' })).status));
  }
  const find = async (folder, subject) => (await olivia('GET', `/api/mail/messages?folder=${folder}`)).body.messages?.find((m) => m.subject === subject);
  const [a, b, c] = await Promise.all(['Snooze me', 'Snooze me too', 'Snooze me three'].map((s) => eventually(() => find('INBOX', s))));
  await olivia('POST', '/api/mail/messages/flags', { folder: 'INBOX', uids: [a.uid], seen: true });
  assert.equal((await olivia('POST', '/api/mail/messages/snooze', { folder: 'INBOX', uids: [a.uid], until: Date.now() - 1 })).status, 400, 'not in the past');
  const until = Date.now() + 36e5;
  const r = await olivia('POST', '/api/mail/messages/snooze', { folder: 'INBOX', uids: [a.uid, b.uid, c.uid], until });
  assert.deepEqual(r.body, { ok: true, snoozed: 3 });
  assert.equal(await find('INBOX', 'Snooze me'), undefined, 'gone from the Inbox');
  const sa = await find('Snoozed', 'Snooze me');
  assert.equal(sa.snoozedUntil, until);
  assert.ok((await olivia('GET', '/api/mail/folders')).body.some((f) => f.path === 'Snoozed'));
  // Snooze one for longer; take one out by hand (it stays where it's put).
  const sb = await find('Snoozed', 'Snooze me too'), sc = await find('Snoozed', 'Snooze me three');
  await olivia('POST', '/api/mail/messages/snooze', { folder: 'Snoozed', uids: [sb.uid], until: until + 864e5 });
  assert.equal((await find('Snoozed', 'Snooze me too')).snoozedUntil, until + 864e5);
  await olivia('POST', '/api/mail/messages/move', { folder: 'Snoozed', uids: [sc.uid], to: 'archive' });
  assert.equal(await wakeDue(), 0, 'nothing due yet');
  q('UPDATE snoozed_mail SET until = ? WHERE until <= ?').run(Date.now() - 1000, until + 1000); // a's time has come
  assert.equal(await wakeDue(), 1);
  const back = await find('INBOX', 'Snooze me');
  assert.ok(back, 'back in the Inbox');
  assert.equal(back.seen, false, 'and unread');
  assert.ok(back.uid > c.uid, 'on top');
  assert.ok(await find('Snoozed', 'Snooze me too'), 'the other one still waits');
  assert.ok(await find('Archive', 'Snooze me three'), 'the one moved out stays in the Archive');
  // Unsnooze now.
  assert.deepEqual((await olivia('POST', '/api/mail/messages/unsnooze', { uids: [sb.uid] })).body, { ok: true });
  assert.ok(await find('INBOX', 'Snooze me too'));
  assert.equal(q('SELECT COUNT(*) AS n FROM snoozed_mail').get().n, 0, 'nothing left waiting');
});

test('labels: made, put on and taken off messages, listed, filtered, kept as IMAP keywords, deleted from every folder', async () => {
  const mk = await olivia('POST', '/api/mail/labels', { name: 'Clients', color: '#0b8043' });
  assert.equal(mk.status, 201);
  const urgent = (await olivia('POST', '/api/mail/labels', { name: 'Urgent', color: '#d50000' })).body;
  assert.equal((await olivia('POST', '/api/mail/labels', { name: 'clients' })).status, 400, 'names are unique');
  assert.equal((await olivia('POST', '/api/mail/labels', { name: 'Bad', color: 'red' })).status, 400);
  assert.deepEqual((await olivia('GET', '/api/mail/labels')).body.labels.map((l) => l.name), ['Clients', 'Urgent']);
  for (const subject of ['Label me', 'Label me too']) assert.ok([200, 201].includes((await gina('POST', '/api/mail/send', { to: 'olivia@acme.com', subject, text: 'x' })).status));
  const find = async (subject, extra = '') => (await olivia('GET', `/api/mail/messages?folder=INBOX${extra}`)).body.messages.find((m) => m.subject === subject);
  const a = await eventually(() => find('Label me')), b = await eventually(() => find('Label me too'));
  await olivia('POST', '/api/mail/messages/labels', { folder: 'INBOX', uids: [a.uid, b.uid], add: [mk.body.id] });
  await olivia('POST', '/api/mail/messages/labels', { folder: 'INBOX', uids: [a.uid], add: [urgent.id] });
  assert.deepEqual((await find('Label me')).labels.sort(), [mk.body.id, urgent.id].sort());
  assert.deepEqual((await olivia('GET', `/api/mail/messages/${a.uid}?folder=INBOX`)).body.labels.sort(), [mk.body.id, urgent.id].sort());
  const only = (await olivia('GET', `/api/mail/messages?folder=INBOX&label=${urgent.id}`)).body.messages.map((m) => m.subject);
  assert.deepEqual(only, ['Label me'], 'only the messages with that label');
  // Mail apps see the keyword.
  const imap = await imapLogin('olivia@acme.com', 'password123');
  await imap.mailboxOpen('INBOX');
  const msg = await imap.fetchOne(String(a.uid), { flags: true }, { uid: true });
  await imap.logout();
  assert.ok([...msg.flags].some((f) => /^nwl_/i.test(f)), `keywords: ${[...msg.flags].join(' ')}`);
  // Take one off; rename; delete (from every folder).
  await olivia('POST', '/api/mail/messages/labels', { folder: 'INBOX', uids: [a.uid], remove: [urgent.id] });
  assert.deepEqual((await find('Label me')).labels, [mk.body.id]);
  assert.equal((await olivia('PATCH', `/api/mail/labels/${mk.body.id}`, { name: 'Customers' })).body.name, 'Customers');
  await olivia('POST', '/api/mail/messages/move', { folder: 'INBOX', uids: [b.uid], to: 'archive' });
  const del = await olivia('DELETE', `/api/mail/labels/${mk.body.id}`);
  assert.equal(del.body.messages, 2, 'taken off in the Inbox and the Archive');
  assert.deepEqual((await find('Label me')).labels, []);
  assert.equal((await olivia('POST', '/api/mail/messages/labels', { folder: 'INBOX', uids: [a.uid], add: [mk.body.id] })).status, 400, 'gone');
  assert.equal((await gina('POST', '/api/mail/messages/labels', { folder: 'INBOX', uids: [1], add: [urgent.id] })).status, 400, "not someone else's");
});

test('templates: saved, changed, listed, deleted; only your own', async () => {
  const a = await olivia('POST', '/api/mail/templates', { name: 'Thanks', subject: 'Thank you', html: '<p>Thanks for your order!</p>' });
  assert.equal(a.status, 201);
  assert.equal((await olivia('POST', '/api/mail/templates', { name: 'thanks', html: '' })).status, 400, 'names are unique');
  assert.equal((await olivia('POST', '/api/mail/templates', { html: 'x' })).status, 400);
  await olivia('PATCH', `/api/mail/templates/${a.body.id}`, { subject: 'Thank you for your order' });
  const list = (await olivia('GET', '/api/mail/templates')).body;
  assert.deepEqual(list.map((t) => [t.name, t.subject, t.html]), [['Thanks', 'Thank you for your order', '<p>Thanks for your order!</p>']]);
  assert.equal((await gina('PATCH', `/api/mail/templates/${a.body.id}`, { name: 'x' })).status, 404);
  assert.deepEqual((await gina('GET', '/api/mail/templates')).body, []);
  await olivia('DELETE', `/api/mail/templates/${a.body.id}`);
  assert.deepEqual((await olivia('GET', '/api/mail/templates')).body, []);
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

test('company signature: a default for people without their own, or the same for everyone', async () => {
  const tpl = '{name}\n{job_title} · {department}\n{email}';
  const sig = client();
  assert.equal((await olivia('POST', '/api/users', { local: 'sigbo', domain: 'acme.com', name: 'Sig Bo', password: 'password123' })).status, 201);
  assert.equal((await sig('POST', '/api/auth/login', { username: 'sigbo@acme.com', password: 'password123' })).status, 200);
  await olivia('PUT', '/api/users/me/profile', { job_title: 'Owner', department: '' });
  assert.equal((await sig('PATCH', '/api/orgs/current', { signature_template: tpl, signature_mode: 'default' })).status, 403, 'admins only');
  assert.equal((await olivia('PATCH', '/api/orgs/current', { signature_template: tpl, signature_mode: 'sometimes' })).status, 400);
  assert.equal((await olivia('PATCH', '/api/orgs/current', { signature_template: tpl, signature_mode: 'default' })).status, 200);
  const bobs = Object.fromEntries((await sig('GET', '/api/mail/signatures')).body.map((x) => [x.address, x]));
  assert.equal(bobs['sigbo@acme.com'].company, 'default');
  assert.match(bobs['sigbo@acme.com'].html, /^<p>Sig Bo<\/p><p>sigbo@acme.com<\/p>$/, 'no title or department: that line left out');
  // Olivia wrote her own: hers stays.
  const all = (await olivia('GET', '/api/mail/signatures')).body;
  const hers = all.find((x) => x.address === 'olivia@acme.com');
  assert.equal(hers.html, '<p><strong>Olivia Owner</strong></p>'); assert.equal(hers.company, undefined);
  // For everyone: the company's, and nobody can change theirs.
  await olivia('PATCH', '/api/orgs/current', { signature_mode: 'always' });
  const now = (await olivia('GET', '/api/mail/signatures')).body.find((x) => x.address === 'olivia@acme.com');
  assert.equal(now.company, 'always'); assert.match(now.html, /<p>Owner · <\/p>/);
  assert.equal((await olivia('PUT', '/api/mail/signatures/olivia@acme.com', { html: '<p>x</p>' })).status, 400);
  // Back to off: her own again.
  await olivia('PATCH', '/api/orgs/current', { signature_mode: 'off' });
  assert.equal((await olivia('GET', '/api/mail/signatures')).body.find((x) => x.address === 'olivia@acme.com').html, '<p><strong>Olivia Owner</strong></p>');
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

  // The mail server picks up the new address table within a few seconds.
  await eventually(async () => (await gina('POST', '/api/mail/send', { to: 'quotes@acme.com', subject: 'Quote request via catch-all', text: 'x' })).status === 200, 20000);
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

test('replies and forwards carry the pictures embedded in the original, cleaned of anything unsafe', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR42mP8z8DwnwEIGAEAHwQC/2t8ZpEAAAAASUVORK5CYII=', 'base64');
  const pic = (await gina('POST', '/api/files/upload?name=chart.png', png, { raw: true })).body;
  const html = `<p>Sales are <b>up</b>:</p><p><img src="/api/files/${pic.id}/raw" alt="chart.png"></p>`
    + '<script>alert(1)</script><p onclick="x()">Tracked <img src="https://tracker.example/p.gif"> <a href="javascript:alert(1)">here</a></p>';
  assert.equal((await gina('POST', '/api/mail/send', { to: 'olivia@acme.com', subject: 'Q3 chart', text: 'Sales are up', html })).status, 200);
  const orig = await eventually(async () => (await inbox(olivia)).find((m) => m.subject === 'Q3 chart'));

  const body = (await olivia('GET', `/api/mail/messages/${orig.uid}/quote?folder=INBOX`)).body;
  assert.equal(body.pictures, 1);
  const src = body.html.match(/<img src="([^"]+)"/)[1];
  assert.match(src, new RegExp(`^/api/mail/messages/${orig.uid}/pictures/\\d+\\?folder=INBOX$`));
  assert.match(body.html, /<p>Sales are <strong>up<\/strong>:<\/p>/);
  assert.doesNotMatch(body.html, /script|onclick|tracker|javascript:/);
  const shown = await olivia('GET', src);
  assert.equal(shown.headers.get('content-type'), 'image/png');
  assert.equal(shown.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(Buffer.compare(shown.body, png) === 0, 'the original picture, byte for byte');
  assert.equal((await olivia('GET', src.replace(/pictures\/\d+/, 'pictures/99'))).status, 404, 'no such picture');

  // Saved as a draft, then sent: the recipient gets the picture embedded, with no link to this server.
  const fwdHtml = `<p>FYI</p><p>---------- Forwarded message ----------</p>${body.html}`;
  const draft = await olivia('POST', '/api/mail/drafts', { to: 'gina@globex.com', subject: 'Fwd: Q3 chart', text: 'FYI', html: fwdHtml });
  assert.match((await olivia('GET', `/api/mail/drafts/${draft.body.uid}`)).body.html, /\/pictures\//, 'drafts keep the picture');
  const r = await olivia('POST', '/api/mail/send', { to: 'gina@globex.com', subject: 'Fwd: Q3 chart', text: 'FYI', html: fwdHtml, draftUid: draft.body.uid });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const got = await eventually(async () => (await inbox(gina)).find((m) => m.subject === 'Fwd: Q3 chart'));
  const full = (await gina('GET', `/api/mail/messages/${got.uid}?folder=INBOX`)).body;
  const data = full.html.match(/src="data:image\/png;base64,([^"]+)"/);
  assert.ok(data, 'picture embedded in the forward');
  assert.ok(Buffer.compare(Buffer.from(data[1], 'base64'), png) === 0);
  assert.ok(!full.html.includes('/api/'), 'no links back to this server');
  assert.deepEqual(full.attachments, [], 'shown inline, not listed as an attachment');

  // Replying quotes the picture too, and marks the original as answered.
  const quote = `<p>Great news!</p><p>On Monday, Gina Globex wrote:</p><blockquote>${body.html}</blockquote>`;
  const rr = await olivia('POST', '/api/mail/send', { to: 'gina@globex.com', subject: 'Re: Q3 chart', text: 'Great news!', html: quote, replyTo: { folder: 'INBOX', uid: orig.uid } });
  assert.equal(rr.status, 200, JSON.stringify(rr.body));
  const re = await eventually(async () => (await inbox(gina)).find((m) => m.subject === 'Re: Q3 chart'));
  const reFull = (await gina('GET', `/api/mail/messages/${re.uid}?folder=INBOX`)).body;
  assert.match(reFull.html, /<blockquote>[\s\S]*src="data:image\/png;base64,[\s\S]*<\/blockquote>/, 'picture inside the quote');
  assert.ok(!reFull.html.includes('/api/'));

  // Plain-text mail has no HTML body to carry over; a deleted original can't be forwarded from.
  await gina('POST', '/api/mail/send', { to: 'olivia@acme.com', subject: 'Plain one', text: 'just text' });
  const plain = await eventually(async () => (await inbox(olivia)).find((m) => m.subject === 'Plain one'));
  assert.equal((await olivia('GET', `/api/mail/messages/${plain.uid}/quote?folder=INBOX`)).body.html, null);
  await olivia('POST', '/api/mail/messages/delete', { folder: 'INBOX', uids: [orig.uid] });
  const gone = await olivia('POST', '/api/mail/send', { to: 'gina@globex.com', subject: 'x', text: 'x', html: fwdHtml });
  assert.equal(gone.status, 400);
  assert.match(gone.body.error, /original message is no longer there/);
});

test('quotes keep data tables and flatten layout tables', async () => {
  const html = '<p>Your order:</p><table border="1"><tr><th>Item</th><th>Price</th></tr><tr><td>Desk</td><td>€200</td></tr></table>'
    + '<table role="presentation"><tr><td>Thanks for shopping with us</td></tr></table>';
  assert.equal((await gina('POST', '/api/mail/send', { to: 'olivia@acme.com', subject: 'Order table', text: 'Your order', html })).status, 200);
  const m = await eventually(async () => (await inbox(olivia)).find((x) => x.subject === 'Order table'));
  const q = (await olivia('GET', `/api/mail/messages/${m.uid}/quote?folder=INBOX`)).body.html;
  assert.match(q, /<table><tbody><tr><th><p>Item<\/p><\/th><th><p>Price<\/p><\/th><\/tr><tr><td><p>Desk<\/p><\/td><td><p>€200<\/p><\/td><\/tr><\/tbody><\/table>/);
  assert.equal(q.match(/<table>/g).length, 1, 'the layout table is flattened');
  assert.match(q, /<p>Thanks for shopping with us<\/p>/);
});

test('quotes keep readable text colours, safely', async () => {
  const html = '<p>Status: <span style="color:#cc0000">late</span> <span style="color:expression(alert(1))">odd</span></p><p style="color:#fff">hidden</p>';
  assert.equal((await gina('POST', '/api/mail/send', { to: 'olivia@acme.com', subject: 'Colour quote', text: 'Status', html })).status, 200);
  const m = await eventually(async () => (await inbox(olivia)).find((x) => x.subject === 'Colour quote'));
  const q = (await olivia('GET', `/api/mail/messages/${m.uid}/quote?folder=INBOX`)).body.html;
  assert.equal(q, '<p>Status: <span style="color: #cc0000">late</span> odd</p><p>hidden</p>');
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
  await eventually(() => events.some((e) => e.type === 'mail-unread' && 'INBOX' in (e.byFolder || {})), 15000); // watcher connected
  assert.equal(notify.watchingCount(), 1);

  const t0 = Date.now();
  await gina('POST', '/api/mail/send', { to: 'olivia@acme.com', subject: 'Ping via IDLE', text: 'x' });
  const ev = await eventually(() => events.find((e) => e.type === 'mail-new' && e.subject === 'Ping via IDLE'), 15000);
  assert.equal(ev.from.address, 'gina@globex.com');
  assert.equal(ev.from.name, 'Gina Globex');
  assert.ok(Date.now() - t0 < 10000, `took ${Date.now() - t0} ms`);
  // The count pushed after the alert (not the one from when the watcher connected).
  const unread = await eventually(() => events.slice(events.indexOf(ev)).find((e) => e.type === 'mail-unread'));
  assert.equal((await olivia('GET', '/api/mail/unread')).body.unseen, unread.unseen);
  assert.ok(!events.some((e) => e.type === 'mail-new' && e.subject === 'Ping via IDLE' && e !== ev), 'one notification per message');
  assert.equal((await inbox(olivia)).find((m) => m.subject === 'Ping via IDLE').seen, false, 'watching never marks mail as read');

  } finally { ws.close(); }
  await eventually(() => notify.watchingCount() === 0, 5000); // closed shortly after the last tab goes away
});

test('notifications for followed folders: filed mail alerts with the folder; follows survive rename, end on delete', async () => {
  assert.deepEqual((await olivia('GET', '/api/mail/notify-folders')).body.folders, ['INBOX']);
  await olivia('POST', '/api/mail/folders', { name: 'Clients/Acme' });
  assert.equal((await olivia('PUT', '/api/mail/notify-folders', { folders: ['Sent'] })).status, 400, 'built-in folders cannot be followed');
  assert.equal((await olivia('PUT', '/api/mail/notify-folders', { folders: ['Nope'] })).status, 400, 'must exist');
  assert.deepEqual((await olivia('PUT', '/api/mail/notify-folders', { folders: ['Clients/Acme'] })).body.folders, ['INBOX', 'Clients/Acme']);
  await olivia('PUT', '/api/mail/rules', { rules: [{ name: 'Acme', conditions: [{ field: 'subject', op: 'contains', value: '[acme]' }], actions: { moveTo: 'Clients/Acme' } }] });
  await eventually(() => { try { return /Clients\/Acme/.test(fs.readFileSync('/run/nw/sieve/olivia@acme.com.sieve', 'utf8')); } catch { return false; } }, 15000);

  const ws = new WS(`${base.replace('http', 'ws')}/ws`, { headers: { cookie: olivia.cookie() } });
  const events = [];
  ws.on('message', (d) => events.push(JSON.parse(d)));
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  try {
    await eventually(() => events.some((e) => e.type === 'mail-unread' && 'Clients/Acme' in (e.byFolder || {})), 15000);
    const meId = (await olivia('GET', '/api/auth/me')).body.user.id;
    assert.deepEqual(notify.watchedFolders(meId).sort(), ['Clients/Acme', 'INBOX']);

    await gina('POST', '/api/mail/send', { to: 'olivia@acme.com', subject: 'Order 55 [acme]', text: 'x' });
    const ev = await eventually(() => events.find((e) => e.type === 'mail-new' && e.subject === 'Order 55 [acme]'), 15000);
    assert.equal(ev.folder, 'Clients/Acme', 'filed by a filter, announced with its folder');
    const last = await eventually(() => { const u = events.filter((e) => e.type === 'mail-unread').at(-1); return u?.byFolder?.['Clients/Acme'] >= 1 && u; });
    const api = (await olivia('GET', '/api/mail/unread')).body;
    assert.equal(api.unseen, last.unseen);
    assert.equal(api.byFolder['Clients/Acme'], last.byFolder['Clients/Acme']);

    // Unfollowing stops the extra watcher straight away, while online.
    await olivia('PUT', '/api/mail/notify-folders', { folders: [] });
    await eventually(() => notify.watchedFolders(meId).length === 1, 5000);
    await olivia('PUT', '/api/mail/notify-folders', { folders: ['Clients/Acme'] });

    const ren = await olivia('PATCH', '/api/mail/folders', { path: 'Clients', newPath: 'Customers' });
    assert.equal(ren.status, 200);
    assert.deepEqual((await olivia('GET', '/api/mail/notify-folders')).body.folders, ['INBOX', 'Customers/Acme'], 'follow survives rename');
    await eventually(() => notify.watchedFolders(meId).includes('Customers/Acme'), 5000);
    await olivia('DELETE', '/api/mail/folders?path=Customers');
    assert.deepEqual((await olivia('GET', '/api/mail/notify-folders')).body.folders, ['INBOX'], 'unfollowed on delete');
    await eventually(() => notify.watchedFolders(meId).length === 1, 5000);
  } finally { ws.close(); }
  await olivia('PUT', '/api/mail/rules', { rules: [] });
  await eventually(() => notify.watchingCount() === 0, 5000);
});

test('following the Archive: filed mail alerts live; mail you archive yourself does not', async () => {
  assert.equal((await olivia('PUT', '/api/mail/notify-folders', { folders: ['Sent'] })).status, 400, 'Sent still cannot be followed');
  assert.equal((await olivia('PUT', '/api/mail/notify-folders', { folders: ['Junk'] })).status, 400);
  assert.deepEqual((await olivia('PUT', '/api/mail/notify-folders', { folders: ['Archive'] })).body.folders, ['INBOX', 'Archive']);
  await olivia('PUT', '/api/mail/rules', { rules: [{ name: 'Receipts', conditions: [{ field: 'subject', op: 'contains', value: '[receipt]' }], actions: { moveTo: 'Archive' } }] });
  await eventually(() => { try { return /"Archive"/.test(fs.readFileSync('/run/nw/sieve/olivia@acme.com.sieve', 'utf8')); } catch { return false; } }, 15000);
  // An unread message that arrived a while ago, to archive by hand later.
  await gina('POST', '/api/mail/send', { to: 'olivia@acme.com', subject: 'Old unread news', text: 'x' });
  const old = await eventually(async () => (await inbox(olivia)).find((m) => m.subject === 'Old unread news'));
  const oldAt = Date.now();

  const ws = new WS(`${base.replace('http', 'ws')}/ws`, { headers: { cookie: olivia.cookie() } });
  const events = [];
  ws.on('message', (d) => events.push(JSON.parse(d)));
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  const archived = () => events.filter((e) => e.type === 'mail-unread').at(-1)?.byFolder?.Archive ?? -1;
  try {
    await eventually(() => archived() >= 0 && events.some((e) => e.type === 'mail-unread' && 'INBOX' in e.byFolder), 15000);

    // Filed straight into the Archive by a filter: announced right away, with the folder.
    await gina('POST', '/api/mail/send', { to: 'olivia@acme.com', subject: 'Your order [receipt]', text: 'x' });
    const ev = await eventually(() => events.find((e) => e.type === 'mail-new' && e.subject === 'Your order [receipt]'), 15000);
    assert.equal(ev.folder, 'Archive');

    // New mail in the Inbox, archived unread at once: announced once (from the Inbox), not again.
    await gina('POST', '/api/mail/send', { to: 'olivia@acme.com', subject: 'Quick one', text: 'x' });
    await eventually(() => events.find((e) => e.type === 'mail-new' && e.subject === 'Quick one' && e.folder === 'INBOX'), 15000);
    const quick = (await inbox(olivia)).find((m) => m.subject === 'Quick one');
    let before = archived();
    await olivia('POST', '/api/mail/messages/move', { folder: 'INBOX', uids: [quick.uid], to: 'archive' });
    await eventually(() => archived() === before + 1, 10000); // the Archive watcher saw it arrive

    // Older unread mail archived by hand: counted, but no "new mail" alert.
    await new Promise((r) => setTimeout(r, Math.max(0, 8500 - (Date.now() - oldAt))));
    before = archived();
    await olivia('POST', '/api/mail/messages/move', { folder: 'INBOX', uids: [old.uid], to: 'archive' });
    await eventually(() => archived() === before + 1, 10000);
    await new Promise((r) => setTimeout(r, 500));
    const alerts = events.filter((e) => e.type === 'mail-new');
    assert.equal(alerts.filter((e) => e.subject === 'Quick one').length, 1, 'archived new mail is not announced twice');
    assert.ok(!alerts.some((e) => e.subject === 'Old unread news'), 'mail you archive yourself is not "new mail"');
    assert.equal((await olivia('GET', '/api/mail/unread')).body.byFolder.Archive, archived(), 'the badge counts the Archive too');
  } finally { ws.close(); }
  await olivia('PUT', '/api/mail/rules', { rules: [] });
  await olivia('PUT', '/api/mail/notify-folders', { folders: [] });
  await eventually(() => notify.watchingCount() === 0, 5000);
});

test('picture sizes survive sending', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const pic = (await olivia('POST', '/api/files/upload?name=half.png', png, { raw: true })).body;
  const html = `<p><img src="/api/files/${pic.id}/raw" alt="half.png" data-width="50" width="50%" style="width:50%; max-width:100%; height:auto"></p>`;
  assert.equal((await olivia('POST', '/api/mail/send', { to: 'gina@globex.com', subject: 'Half-size picture', text: '[image: half.png]', html })).status, 200);
  const m = await eventually(async () => (await inbox(gina)).find((x) => x.subject === 'Half-size picture'));
  const full = (await gina('GET', `/api/mail/messages/${m.uid}?folder=INBOX`)).body;
  assert.match(full.html, /<img[^>]*src="data:image\/png;base64,[^"]+"[^>]*width="50%"[^>]*style="width:50%; max-width:100%; height:auto"/);
});

test('a brand-new account that opens Workspace right away still gets notifications', async () => {
  const newbie = client();
  await olivia('POST', '/api/users', { local: 'newbie', domain: 'acme.com', name: 'New Starter', password: 'password123' });
  await newbie('POST', '/api/auth/login', { username: 'newbie@acme.com', password: 'password123' });
  // Connect immediately: the mail server has not loaded the new mailbox yet, so the first
  // watcher sign-in is refused and must be retried rather than given up.
  const ws = new WS(`${base.replace('http', 'ws')}/ws`, { headers: { cookie: newbie.cookie() } });
  const events = [];
  ws.on('message', (d) => events.push(JSON.parse(d)));
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  try {
    await eventually(() => events.some((e) => e.type === 'mail-unread' && 'INBOX' in (e.byFolder || {})), 30000); // watcher got in on a retry
    // Postfix accepts mail for the new address once it has reloaded its tables (a second or two).
    await eventually(async () => (await gina('POST', '/api/mail/send', { to: 'newbie@acme.com', subject: 'Welcome aboard', text: 'x' })).status === 200, 15000);
    await eventually(() => events.some((e) => e.type === 'mail-new' && e.subject === 'Welcome aboard'), 15000);
  } finally { ws.close(); }
  await eventually(() => notify.watchingCount() === 0, 5000);
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

test('people outside the server get calendar invitations, updates and cancellations, and answer on a page', async () => {
  const planner = client(), pub = client();
  assert.equal((await olivia('POST', '/api/users', { local: 'planner', domain: 'acme.com', name: 'Pat Planner', password: 'password123' })).status, 201);
  await eventually(async () => (await planner('POST', '/api/auth/login', { username: 'planner@acme.com', password: 'password123' })).status === 200);
  // A brand-new account: wait until the mail server knows it (it can send, and its mailbox opens).
  await eventually(async () => (await planner('POST', '/api/mail/send', { to: 'planner@acme.com', subject: 'ready', text: 'x' })).status === 200, 60000);
  await eventually(async () => (await inbox(planner)).some((m) => m.subject === 'ready'), 60000);
  const outsider = 'client@clients-test.example';
  const t = Date.UTC(2026, 11, 3, 10);
  assert.equal((await planner('POST', '/api/events', { title: 'x', start: t, end: t + 36e5, guests: ['nobody@acme.com'] })).status, 400, 'a typo on our own domain');
  const ev = await planner('POST', '/api/events', { title: 'Kick-off, phase 2', location: 'Room 4', start: t, end: t + 36e5, guests: [outsider, 'olivia@acme.com'], tz: 'Europe/London' });
  assert.equal(ev.status, 201, JSON.stringify(ev.body));
  assert.deepEqual(ev.body.guests.map((g) => [g.email, g.status, !!g.external]), [['olivia@acme.com', 'needs', false], [outsider, 'needs', true]]);
  const { q } = await import('../src/db.js');
  const token = q('SELECT token FROM event_outside_guests WHERE email = ?').get(outsider).token;

  // The answer page.
  const page = (await pub('GET', `/api/public/invites/${token}`)).body;
  assert.equal(page.title, 'Kick-off, phase 2');
  assert.match(page.when, /Thursday,? 3 December 2026, 10:00 – 11:00 \(Europe\/London\)/);
  assert.deepEqual(page.organizer, { name: 'Pat Planner', email: 'planner@acme.com' });
  assert.equal((await pub('POST', `/api/public/invites/${token}/answer`, { status: 'perhaps' })).status, 400);
  const withNote = (await pub('POST', `/api/public/invites/${token}/answer`, { status: 'yes', note: 'Bringing the samples' })).body;
  assert.equal(withNote.status, 'yes');
  assert.equal(withNote.note, 'Bringing the samples', 'a note with the answer, kept for the organizer');
  const mine = (await planner('GET', `/api/events?from=${t - 864e5}&to=${t + 864e5}`)).body[0];
  assert.equal(mine.guests.find((g) => g.email === outsider).status, 'yes');
  const file = await pub('GET', `/api/public/invites/${token}/ics`);
  assert.match(String(file.body).replace(/\r\n /g, ""), /METHOD:PUBLISH[\s\S]*PARTSTAT=ACCEPTED/);
  assert.equal((await pub('GET', `/api/public/invites/nope${token}`)).status, 404);

  // The emails. There's no internet here, so each one bounces back to the organizer with the
  // original attached; that's where we read them.
  const imap = await imapLogin('planner@acme.com', 'password123');
  const bounces = async (n) => {
    const lock = await imap.getMailboxLock('INBOX');
    try {
      const out = [];
      for await (const m of imap.fetch('1:*', { source: true })) out.push(m.source.toString().replace(/=\r?\n/g, '').replace(/\r\n /g, ''));
      const returned = out.filter((m) => m.includes('BEGIN:VCALENDAR'));
      return returned.length >= n ? returned : null;
    } catch { return null; } finally { lock.release(); }
  };
  try {
    const [first] = await eventually(() => bounces(1), 60000);
    assert.match(first, /Subject: Invitation: Kick-off, phase 2/);
    assert.match(first, /METHOD:REQUEST/);
    assert.match(first, /SUMMARY:Kick-off\\, phase 2/);
    assert.ok(first.includes(`/i/${token}`), 'the personal answer link');

    // Moving it sends an update (a higher SEQUENCE); taking them off sends a cancellation.
    await planner('PATCH', `/api/events/${ev.body.id}`, { start: t + 36e5, end: t + 72e5, tz: 'Europe/London' });
    const second = (await eventually(() => bounces(2), 60000)).find((m) => m.includes('Updated invitation'));
    assert.ok(second && /SEQUENCE:1/.test(second) && /DTSTART:20261203T110000Z/.test(second), 'update');
    // Colleagues get an "Updated:" email too.
    await eventually(async () => (await inbox(olivia)).some((m) => m.subject === 'Updated: Kick-off, phase 2'), 30000);
    await planner('PATCH', `/api/events/${ev.body.id}`, { title: 'Kick-off (room only)', guests: ['olivia@acme.com'] });
    const third = (await eventually(() => bounces(3), 60000)).find((m) => /Subject: Cancelled: /.test(m));
    assert.ok(third && /METHOD:CANCEL/.test(third), 'cancellation');
    assert.equal((await pub('GET', `/api/public/invites/${token}`)).status, 404, 'the link ends with the invitation');
  } finally { await imap.logout().catch(() => {}); }
});

test('answers from the guest\'s own mail app (Outlook Accept, Gmail Yes) are read from the organizer\'s inbox', async () => {
  const planner = client();
  await planner('POST', '/api/auth/login', { username: 'planner@acme.com', password: 'password123' });
  const t = Date.UTC(2027, 0, 12, 15);
  const ev = (await planner('POST', '/api/events', { title: 'Review', start: t, end: t + 36e5, guests: ['erin@clients-test.example', 'finn@clients-test.example'], tz: 'Europe/London' })).body;
  // What Outlook sends back, through the internet's front door (port 25, no sign-in).
  const mx = nodemailer.createTransport({ host: process.env.MAIL_IMAP_HOST, port: 25, secure: false, ignoreTLS: true, name: 'mx.clients-test.example' });
  const reply = (who, partstat, from = who) => mx.sendMail({
    // (The envelope sender is local: this sandbox can't look up outside domains, which Postfix requires.)
    from, to: 'planner@acme.com', envelope: { from: 'relay@acme.com', to: 'planner@acme.com' }, subject: `${partstat === 'DECLINED' ? 'Declined' : 'Accepted'}: Review`, text: 'Reply',
    icalEvent: { method: 'REPLY', content: ['BEGIN:VCALENDAR', 'VERSION:2.0', 'METHOD:REPLY', 'BEGIN:VEVENT', `UID:${ev.id}@mail.acme.com`,
      `ATTENDEE;PARTSTAT=${partstat}:mailto:${who}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n') },
  });
  await reply('erin@clients-test.example', 'DECLINED');
  await reply('finn@clients-test.example', 'ACCEPTED', 'mallory@elsewhere-test.example'); // not from Finn: ignored
  await eventually(async () => (await inbox(planner)).filter((m) => /: Review$/.test(m.subject)).length >= 2, 30000);
  assert.equal(await rsvp.checkReplies(), 1);
  const guests = (await planner('GET', `/api/events?from=${t - 864e5}&to=${t + 864e5}`)).body.find((e) => e.id === ev.id).guests;
  assert.deepEqual(guests.map((g) => [g.email, g.status]), [['erin@clients-test.example', 'no'], ['finn@clients-test.example', 'needs']]);
  assert.equal(await rsvp.checkReplies(), 0, 'each reply is read once');
  assert.ok((await inbox(planner)).some((m) => m.subject === 'Declined: Review'), 'the email stays in the inbox');
});

test('renaming an address keeps the mailbox; mail to old and new address arrives; a reused address starts empty', async () => {
  const kim = client();
  const id = (await olivia('POST', '/api/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  await eventually(async () => (await kim('POST', '/api/auth/login', { username: 'kim@acme.com', password: 'password123' })).status === 200);
  await eventually(async () => (await olivia('POST', '/api/mail/send', { to: 'kim@acme.com', subject: 'Before the rename', text: 'x' })).status === 200, 60000);
  await eventually(async () => (await inbox(kim)).some((m) => m.subject === 'Before the rename'), 60000);

  assert.equal((await olivia('PATCH', `/api/users/${id}`, { local: 'kim.park' })).status, 200);
  // The mail server picks up the new name within a few seconds.
  await eventually(async () => (await olivia('POST', '/api/mail/send', { to: 'kim.park@acme.com', subject: 'To the new address', text: 'x' })).status === 200, 60000);
  await olivia('POST', '/api/mail/send', { to: 'kim@acme.com', subject: 'To the old address', text: 'x' });
  const subjects = await eventually(async () => {
    const s = (await inbox(kim)).map((m) => m.subject);
    return ['Before the rename', 'To the new address', 'To the old address'].every((x) => s.includes(x)) ? s : null;
  }, 60000);
  assert.ok(subjects.includes('Before the rename'), 'old mail is still there');
  const imap = await eventually(() => imapLogin('kim.park@acme.com', 'password123'), 30000);
  const status = await imap.status('INBOX', { messages: true });
  assert.ok(status.messages >= 3);
  await imap.logout();
  // Kim can still send as the old address (it's an alias of theirs now).
  assert.equal((await kim('POST', '/api/mail/send', { from: 'kim@acme.com', to: 'olivia@acme.com', subject: 'From my old address', text: 'x' })).status, 200);

  // Free the old address and give it to someone new: they must not see Kim's mail.
  const alias = (await olivia('GET', '/api/mail-admin/aliases')).body.find((a) => a.address === 'kim@acme.com');
  assert.equal((await olivia('DELETE', `/api/mail-admin/aliases/${alias.id}`)).status, 200);
  const kim2 = client();
  assert.equal((await olivia('POST', '/api/users', { local: 'kim', domain: 'acme.com', name: 'Kim Two', password: 'password123' })).status, 201);
  await eventually(async () => (await kim2('POST', '/api/auth/login', { username: 'kim@acme.com', password: 'password123' })).status === 200);
  // Wait until the mail server's tables say kim@ is a mailbox again (no longer the alias).
  const table = (f) => { try { return fs.readFileSync(`/run/nw/${f}`, 'utf8'); } catch { return ''; } };
  await eventually(() => /^kim@acme\.com OK$/m.test(table('postfix/mailboxes')) && !/^kim@acme\.com /m.test(table('postfix/aliases'))
    && /^kim@acme\.com:.*:\/var\/vmail\/acme\.com\/kim\.[0-9a-f]{8}:/m.test(table('dovecot/passwd')), 30000);
  await sleep(4000); // the mail container rebuilds its lookup tables every 2 seconds
  await eventually(async () => (await olivia('POST', '/api/mail/send', { to: 'kim@acme.com', subject: 'Welcome, new Kim', text: 'x' })).status === 200, 60000);
  const mine = await eventually(async () => { const s = (await inbox(kim2)).map((m) => m.subject); return s.includes('Welcome, new Kim') ? s : null; }, 60000);
  assert.deepEqual(mine, ['Welcome, new Kim'], 'an empty mailbox of their own');
  assert.ok(!(await inbox(kim)).some((m) => m.subject === 'Welcome, new Kim'), 'not delivered to Kim Park');
});

// ---- block a sender ----
test('block a sender: a rule first in the list sends their mail to Junk, read', async () => {
  assert.equal((await olivia('POST', '/api/mail/block', { address: 'nope' })).status, 400);
  assert.equal((await olivia('POST', '/api/mail/block', { address: 'olivia@acme.com' })).status, 400, 'not yourself');
  const r = await olivia('POST', '/api/mail/block', { address: 'Spammy@Acme.com' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await olivia('POST', '/api/mail/block', { address: 'spammy@acme.com' });
  const rules = (await olivia('GET', '/api/mail/rules')).body;
  assert.equal(rules[0].name, 'Blocked: spammy@acme.com');
  assert.equal(rules.filter((x) => x.name === 'Blocked: spammy@acme.com').length, 1, 'once');
  await eventually(() => { try { return /spammy@acme\.com/.test(fs.readFileSync('/run/nw/sieve/olivia@acme.com.sieve', 'utf8')); } catch { return false; } }, 15000);
  const t = nodemailer.createTransport({ host: process.env.MAIL_IMAP_HOST, port: 25, secure: false, ignoreTLS: true, name: 'test.acme.com' });
  await t.sendMail({ from: 'Spammy <spammy@acme.com>', to: 'olivia@acme.com', subject: 'Cheap watches', text: 'x' });
  const junk = await eventually(async () => (await olivia('GET', `/api/mail/messages?folder=${encodeURIComponent(r.body.folder)}`)).body.messages.find((m) => m.subject === 'Cheap watches'), 20000);
  assert.equal(junk.seen, true);
  assert.ok(!(await inbox(olivia)).some((m) => m.subject === 'Cheap watches'));
});

test('mark all as read: every unread message in a folder', async () => {
  const t = nodemailer.createTransport({ host: process.env.MAIL_IMAP_HOST, port: 25, secure: false, ignoreTLS: true, name: 'test.acme.com' });
  for (const s of ['Unread one', 'Unread two']) await t.sendMail({ from: 'Someone <someone@acme.com>', to: 'olivia@acme.com', subject: s, text: 'x' });
  await eventually(async () => (await inbox(olivia)).filter((m) => /^Unread (one|two)$/.test(m.subject) && !m.seen).length === 2, 20000);
  const r = await olivia('POST', '/api/mail/messages/read-all', { folder: 'INBOX' });
  assert.equal(r.status, 200);
  assert.ok(r.body.marked >= 2);
  assert.ok((await inbox(olivia)).every((m) => m.seen), 'nothing unread left');
  assert.equal((await olivia('POST', '/api/mail/messages/read-all', { folder: 'INBOX' })).body.marked, 0);
});

test('manage subscriptions: lists in the Inbox by sender, most frequent first', async () => {
  const t = nodemailer.createTransport({ host: process.env.MAIL_IMAP_HOST, port: 25, secure: false, ignoreTLS: true, name: 'test.acme.com' });
  for (const n of [1, 2, 3]) await t.sendMail({ from: 'Daily Digest <digest@acme.com>', to: 'olivia@acme.com', subject: `Digest ${n}`, text: 'x', headers: { 'List-Unsubscribe': '<mailto:olivia@acme.com?subject=Leave%20digest>' } });
  await t.sendMail({ from: 'Promo <promo@acme.com>', to: 'olivia@acme.com', subject: 'Promo 1', text: 'x', headers: { 'List-Unsubscribe': '<https://promo.example/out>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } });
  await t.sendMail({ from: 'A Person <person@acme.com>', to: 'olivia@acme.com', subject: 'Not a list', text: 'x' });
  await eventually(async () => (await inbox(olivia)).filter((m) => /^(Digest \d|Promo 1|Not a list)$/.test(m.subject)).length === 5, 20000);
  const subs = (await olivia('GET', '/api/mail/subscriptions')).body;
  const digest = subs.find((g) => g.address === 'digest@acme.com');
  assert.deepEqual([digest.count, digest.how, digest.name, digest.uids.length], [3, 'email', 'Daily Digest', 3]);
  assert.equal(subs.find((g) => g.address === 'promo@acme.com').how, 'one-click');
  assert.ok(!subs.some((g) => g.address === 'person@acme.com'), 'people aren\'t lists');
  assert.ok(subs.indexOf(digest) < subs.findIndex((g) => g.address === 'promo@acme.com'), 'most frequent first');
});

test('unsubscribe: a list with a mailto gets an email from you; one-click to the NAS’s own network is refused', async () => {
  const t = nodemailer.createTransport({ host: process.env.MAIL_IMAP_HOST, port: 25, secure: false, ignoreTLS: true, name: 'test.acme.com' });
  // The list's unsubscribe address is a mailbox here, so the email can be seen arriving.
  await t.sendMail({ from: 'Weekly News <news@acme.com>', to: 'olivia@acme.com', subject: 'Weekly news 45', text: 'x',
    headers: { 'List-Unsubscribe': '<mailto:olivia@acme.com?subject=Unsubscribe%20weekly>' } });
  await t.sendMail({ from: 'Local List <list@acme.com>', to: 'olivia@acme.com', subject: 'Local list post', text: 'x',
    headers: { 'List-Unsubscribe': '<https://127.0.0.1/unsub?id=9>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } });
  await t.sendMail({ from: 'Web Only <web@acme.com>', to: 'olivia@acme.com', subject: 'Web only post', text: 'x', headers: { 'List-Unsubscribe': '<https://news.example/leave>' } });
  await eventually(async () => (await inbox(olivia)).filter((m) => ['Weekly news 45', 'Local list post', 'Web only post'].includes(m.subject)).length === 3, 20000);
  const find = async (s) => (await inbox(olivia)).find((m) => m.subject === s).uid;
  const weekly = (await olivia('GET', `/api/mail/messages/${await find('Weekly news 45')}?folder=INBOX`)).body;
  assert.deepEqual(weekly.unsubscribe, { how: 'email', to: 'olivia@acme.com' });
  const r = await olivia('POST', `/api/mail/messages/${weekly.uid}/unsubscribe`, { folder: 'INBOX' });
  assert.equal(r.status, 200);
  assert.equal(r.body.how, 'email');
  await eventually(async () => (await inbox(olivia)).some((m) => m.subject === 'Unsubscribe weekly'), 20000);
  const local = (await olivia('GET', `/api/mail/messages/${await find('Local list post')}?folder=INBOX`)).body;
  assert.deepEqual(local.unsubscribe, { how: 'one-click' });
  const refused = await olivia('POST', `/api/mail/messages/${local.uid}/unsubscribe`, { folder: 'INBOX' });
  assert.equal(refused.status, 424);
  assert.match(refused.body.error, /private network/);
  const web = (await olivia('GET', `/api/mail/messages/${await find('Web only post')}?folder=INBOX`)).body;
  assert.deepEqual(web.unsubscribe, { how: 'link', url: 'https://news.example/leave' });
  assert.equal((await olivia('POST', `/api/mail/messages/${web.uid}/unsubscribe`, { folder: 'INBOX' })).status, 400, 'a page to open, not done here');
  const plain = (await inbox(olivia)).find((m) => m.subject === 'Unsubscribe weekly');
  assert.equal((await olivia('GET', `/api/mail/messages/${plain.uid}?folder=INBOX`)).body.unsubscribe, null);
});

test('conversation: the other messages with the same subject, your replies from Sent included, oldest first', async () => {
  const t = nodemailer.createTransport({ host: process.env.MAIL_IMAP_HOST, port: 25, secure: false, ignoreTLS: true, name: 'test.acme.com' });
  await t.sendMail({ from: 'Gina Globex <gina@globex.com>', to: 'olivia@acme.com', subject: 'Quote for chairs', text: 'Here is the quote.', date: new Date(Date.now() - 3 * 60e3) });
  await eventually(async () => (await inbox(olivia)).some((m) => m.subject === 'Quote for chairs'), 20000);
  const sent = await olivia('POST', '/api/mail/send', { to: 'gina@globex.com', subject: 'Re: Quote for chairs', text: 'Can you do 10% off?' });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  await new Promise((r) => setTimeout(r, 1100));
  await t.sendMail({ from: 'Gina Globex <gina@globex.com>', to: 'olivia@acme.com', subject: 'RE: Quote for chairs', text: 'Yes, 10% off.' });
  await t.sendMail({ from: 'Gina Globex <gina@globex.com>', to: 'olivia@acme.com', subject: 'Quote for desks', text: 'Not the same.' });
  await eventually(async () => (await inbox(olivia)).some((m) => m.subject === 'RE: Quote for chairs') && (await inbox(olivia)).some((m) => m.subject === 'Quote for desks'), 20000);
  const last = (await inbox(olivia)).find((m) => m.subject === 'RE: Quote for chairs');
  const conv = (await olivia('GET', `/api/mail/messages/${last.uid}/conversation?folder=INBOX`)).body;
  assert.deepEqual(conv.map((m) => m.subject), ['Quote for chairs', 'Re: Quote for chairs'], JSON.stringify(conv));
  assert.equal(conv[0].folder, 'INBOX');
  assert.notEqual(conv[1].folder, 'INBOX', 'your reply, from Sent');
  const desk = (await inbox(olivia)).find((m) => m.subject === 'Quote for desks');
  assert.deepEqual((await olivia('GET', `/api/mail/messages/${desk.uid}/conversation?folder=INBOX`)).body, []);
});

test('import mail from another account: folders, flags and dates copied; a second run skips what is there', async () => {
  // Gina's mailbox (on this mail server) plays "the other account".
  const t = nodemailer.createTransport({ host: process.env.MAIL_IMAP_HOST, port: 25, secure: false, ignoreTLS: true, name: 'test.acme.com' });
  await t.sendMail({ from: 'Old Friend <friend@acme.com>', to: 'gina@globex.com', subject: 'Import me 1', text: 'one', date: new Date('2024-03-01T10:00:00Z') });
  await t.sendMail({ from: 'Old Friend <friend@acme.com>', to: 'gina@globex.com', subject: 'Import me 2', text: 'two' });
  await eventually(async () => (await inbox(gina)).filter((m) => /^Import me/.test(m.subject)).length === 2, 20000);
  const two = (await inbox(gina)).find((m) => m.subject === 'Import me 2');
  await gina('POST', '/api/mail/messages/flags', { folder: 'INBOX', uids: [two.uid], flagged: true });
  assert.equal((await olivia('POST', '/api/mail/import', { host: '127.0.0.1', port: 25, username: 'x', password: 'y' })).status, 400, 'IMAP ports only');
  assert.equal((await olivia('POST', '/api/mail/import', { host: '127.0.0.1', port: 993, username: 'gina@globex.com', password: 'wrong' })).status, 400);
  const started = await olivia('POST', '/api/mail/import', { host: '127.0.0.1', port: 993, username: 'gina@globex.com', password: 'password123' });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const done = await eventually(async () => { const j = (await olivia('GET', '/api/mail/import')).body; return j.status !== 'running' && j; }, 60000);
  assert.equal(done.status, 'done', JSON.stringify(done));
  assert.ok(done.copied >= 2);
  const mine = await inbox(olivia);
  const one = mine.find((m) => m.subject === 'Import me 1'), twoHere = mine.find((m) => m.subject === 'Import me 2');
  assert.ok(one && twoHere);
  assert.equal(new Date(one.date).getUTCFullYear(), 2024, 'its own date');
  assert.equal(twoHere.flagged, true, 'its star');
  // Again: nothing doubled.
  await olivia('POST', '/api/mail/import', { host: '127.0.0.1', port: 993, username: 'gina@globex.com', password: 'password123' });
  const again = await eventually(async () => { const j = (await olivia('GET', '/api/mail/import')).body; return j.status !== 'running' && j; }, 60000);
  assert.equal(again.copied, 0);
  assert.ok(again.skipped >= 2);
  assert.equal((await inbox(olivia)).filter((m) => m.subject === 'Import me 1').length, 1);
});

test('save attachments to Drive: one or all, into "Email attachments"; odd names made safe', async () => {
  const t = nodemailer.createTransport({ host: process.env.MAIL_IMAP_HOST, port: 25, secure: false, ignoreTLS: true, name: 'test.acme.com' });
  await t.sendMail({ from: 'Someone <someone@acme.com>', to: 'olivia@acme.com', subject: 'Files to keep', text: 'x',
    attachments: [{ filename: 'one.txt', content: 'first' }, { filename: '../two.txt', content: 'second' }] });
  const m = await eventually(async () => (await inbox(olivia)).find((x) => x.subject === 'Files to keep'), 20000);
  const one = await olivia('POST', `/api/mail/messages/${m.uid}/attachments/save`, { folder: 'INBOX', indexes: [0] });
  assert.equal(one.status, 201);
  assert.deepEqual(one.body.files.map((f) => f.name), ['one.txt']);
  const all = (await olivia('POST', `/api/mail/messages/${m.uid}/attachments/save`, { folder: 'INBOX' })).body;
  assert.equal(all.folder_id, one.body.folder_id, 'the same folder');
  assert.equal(all.files.length, 2);
  assert.ok(!all.files[1].name.includes('/'), all.files[1].name);
  assert.equal((await olivia('GET', `/api/files/${all.files[1].id}/raw?download`)).body.toString(), 'second');
  assert.equal((await olivia('POST', `/api/mail/messages/${m.uid}/attachments/save`, { folder: 'INBOX', indexes: [7] })).status, 404);
});

test('search operators: from:, subject:, has:attachment, is:unread, -word, two words both needed', async () => {
  const t = nodemailer.createTransport({ host: process.env.MAIL_IMAP_HOST, port: 25, secure: false, ignoreTLS: true, name: 'test.acme.com' });
  await t.sendMail({ from: 'Raj <raj-search@acme.com>', to: 'olivia@acme.com', subject: 'Zq budget plan', text: 'numbers inside' });
  await t.sendMail({ from: 'Kim <kim-search@acme.com>', to: 'olivia@acme.com', subject: 'Zq budget only', text: 'no plan here... wait', attachments: [{ filename: 'a.txt', content: 'x' }] });
  await t.sendMail({ from: 'Raj <raj-search@acme.com>', to: 'olivia@acme.com', subject: 'Zq lunch', text: 'pizza' });
  await eventually(async () => (await inbox(olivia, 'Zq')).filter((m) => m.subject.startsWith('Zq ')).length === 3, 20000);
  const find = async (q) => {
    const r = await olivia('GET', `/api/mail/messages?folder=INBOX&q=${encodeURIComponent(q)}`);
    assert.equal(r.status, 200, `${q}: ${JSON.stringify(r.body)}`);
    return r.body.messages.map((m) => m.subject).filter((s) => s.startsWith('Zq ')).sort();
  };
  assert.deepEqual(await find('from:raj-search'), ['Zq budget plan', 'Zq lunch']);
  assert.deepEqual(await find('subject:budget -lunch'), ['Zq budget only', 'Zq budget plan']);
  assert.deepEqual(await find('Zq has:attachment'), ['Zq budget only']);
  assert.deepEqual(await find('from:raj-search pizza'), ['Zq lunch']);
  assert.deepEqual(await find('subject:Zq subject:plan'), ['Zq budget plan'], 'both subjects needed');
  const one = (await inbox(olivia, 'Zq lunch')).find((m) => m.subject === 'Zq lunch');
  await olivia('POST', '/api/mail/messages/flags', { folder: 'INBOX', uids: [one.uid], seen: true });
  assert.ok(!(await find('Zq is:unread')).includes('Zq lunch'));
  assert.ok((await find('Zq is:read')).includes('Zq lunch'));
  assert.equal((await olivia('GET', '/api/mail/messages?folder=INBOX&q=before:soon')).status, 400);
});

test('read receipts: asked for when sending, offered (not sent) when opened, sent once on request', async () => {
  const sent = await olivia('POST', '/api/mail/send', { to: 'gina@globex.com', subject: 'Receipt please', text: 'Did you get it?', receipt: true });
  assert.equal(sent.status, 200);
  const m = await eventually(async () => (await inbox(gina, 'Receipt please')).find((x) => x.subject === 'Receipt please'), 20000);
  const opened = (await gina('GET', `/api/mail/messages/${m.uid}?folder=INBOX`)).body;
  assert.deepEqual(opened.receipt, { to: 'olivia@acme.com' });
  assert.equal((await gina('POST', `/api/mail/messages/${m.uid}/receipt`, { folder: 'INBOX', send: true })).body.sent, true);
  const back = await eventually(async () => (await inbox(olivia, 'Read: Receipt please')).find((x) => x.subject === 'Read: Receipt please'), 20000);
  assert.ok(back);
  assert.equal((await gina('GET', `/api/mail/messages/${m.uid}?folder=INBOX`)).body.receipt, null, 'not asked again');
  assert.equal((await gina('POST', `/api/mail/messages/${m.uid}/receipt`, { folder: 'INBOX', send: true })).body.already, true, 'never twice');
  // The receipt itself didn't ask for one: nothing to answer.
  const o = (await olivia('GET', `/api/mail/messages/${back.uid}?folder=INBOX`)).body;
  assert.equal(o.receipt, null);
  assert.equal((await olivia('POST', `/api/mail/messages/${back.uid}/receipt`, { folder: 'INBOX', send: true })).status, 400);
});

test('a group email address delivers to its members, who can send as it', async () => {
  const sam = client();
  const samId = (await olivia('POST', '/api/users', { local: 'samgrp', domain: 'acme.com', name: 'Sam Group', password: 'password123' })).body.id;
  assert.equal((await sam('POST', '/api/auth/login', { username: 'samgrp@acme.com', password: 'password123' })).status, 200);
  const g = (await olivia('POST', '/api/groups', { name: 'Help Desk' })).body;
  await olivia('PUT', `/api/groups/${g.id}/members`, { user_ids: [samId] });
  assert.equal((await olivia('PUT', `/api/groups/${g.id}/email`, { local: 'helpdesk', domain: 'acme.com' })).body.email, 'helpdesk@acme.com');
  await new Promise((r) => setTimeout(r, 6500)); // the mail server picks the change up
  assert.equal((await olivia('POST', '/api/mail/send', { to: 'helpdesk@acme.com', subject: 'Printer jam', text: 'Third floor' })).status, 200);
  await eventually(async () => (await inbox(sam, 'Printer jam')).length > 0);
  const ids = (await sam('GET', '/api/mail/status')).body.identities.map((i) => i.address);
  assert.ok(ids.includes('helpdesk@acme.com'), 'they can send from it');
});

test('mail merge: a personal message to each row; unknown placeholders refused; a test goes to you', async () => {
  const columns = ['Email', 'First name', 'Amount'];
  const rows = [
    { email: 'olivia@acme.com', fields: { Email: 'olivia@acme.com', 'First name': 'Olivia', Amount: '120' } },
    { email: 'gina@globex.com', fields: { Email: 'gina@globex.com', 'First name': 'Gina', Amount: '75 & tax' } },
    { email: 'not an address', fields: { 'First name': 'X' } },
  ];
  const bad = await olivia('POST', '/api/mail/merge', { columns, rows, subject: 'Hi {{First name}}', text: 'From {{Team}}' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /No column called “Team”/);
  const test1 = await olivia('POST', '/api/mail/merge', { columns, rows, subject: 'Figures for {{First name}}', text: 'Dear {{first name}},\nyou owe {{Amount}}.', test: true });
  assert.deepEqual(test1.body, { sent: 1, failed: [] });
  await eventually(async () => (await inbox(olivia)).some((m) => m.subject === 'Figures for Olivia'));
  const r = await olivia('POST', '/api/mail/merge', { columns, rows, subject: 'Figures for {{First name}}', text: 'Dear {{first name}},\nyou owe {{Amount}}.' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.sent, 2);
  assert.deepEqual(r.body.failed, [{ email: 'not an address', error: 'Not an email address' }]);
  const g = await eventually(async () => (await inbox(gina)).find((m) => m.subject === 'Figures for Gina'));
  const full = (await gina('GET', `/api/mail/messages/${g.uid}?folder=INBOX`)).body;
  assert.match(full.text, /Dear Gina,\s+you owe 75 & tax\./);
  assert.deepEqual(full.to.map((a) => a.address), ['gina@globex.com'], 'only their own address');
  assert.match(full.html, /75 &amp; tax/);
  await eventually(async () => (await inbox(olivia)).filter((m) => m.subject === 'Figures for Olivia').length === 2, 20000); // the test, then the real one
});

test('follow-ups: a reminder when nobody replied; none when someone did; cancelling', async () => {
  const { checkFollowUps } = await import('../src/routes/webmail.js');
  const { q } = await import('../src/db.js');
  assert.equal((await olivia('POST', '/api/mail/send', { to: 'gina@globex.com', subject: 'Quote request', text: 'x', followUp: 5 })).status, 400, 'only the offered choices');
  for (const subject of ['Any news on the quote?', 'Meeting next week?', 'Cancel me']) {
    const r = await olivia('POST', '/api/mail/send', { to: 'gina@globex.com', subject, text: 'Let me know.', followUp: 3 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  const waiting = (await olivia('GET', '/api/mail/followups')).body;
  assert.equal(waiting.length, 3);
  assert.ok(waiting.every((f) => f.message_id.startsWith('<') && f.due_at > Date.now() + 2.9 * 864e5));
  // Gina answers the second one.
  const m = await eventually(async () => (await inbox(gina)).find((x) => x.subject === 'Meeting next week?'));
  const full = (await gina('GET', `/api/mail/messages/${m.uid}?folder=INBOX`)).body;
  assert.equal((await gina('POST', '/api/mail/send', { to: 'olivia@acme.com', subject: 'Re: Meeting next week?', text: 'Yes!', inReplyTo: full.messageId, references: full.references })).status, 200);
  await eventually(async () => (await inbox(olivia)).some((x) => x.subject === 'Re: Meeting next week?'));
  // Cancel the third.
  const third = waiting.find((f) => f.subject === 'Cancel me');
  assert.equal((await olivia('GET', `/api/mail/followups?message_id=${encodeURIComponent(third.message_id)}`)).body.length, 1);
  assert.equal((await olivia('DELETE', `/api/mail/followups/${third.id}`)).status, 200);
  // Time passes.
  q('UPDATE mail_followups SET due_at = ?').run(Date.now() - 1000);
  assert.equal(await checkFollowUps(), 1);
  const bell = (await olivia('GET', '/api/notifications')).body;
  const list = Array.isArray(bell) ? bell : bell.items || bell.notifications || [];
  const told = list.filter((n) => /^No reply yet/.test(n.title)).map((n) => n.title);
  assert.deepEqual(told, ['No reply yet: “Any news on the quote?”']);
  const n = list.find((x) => /^No reply yet/.test(x.title));
  assert.match(n.link, /^\/mail\?open=%3C/);
  assert.match(n.body, /Sent to Gina Globex|Sent to gina@globex.com/);
  assert.equal((await olivia('GET', '/api/mail/followups')).body.length, 0, 'done with');
});

test('forms: people get a copy of their answers by email, from the form\'s owner', async () => {
  const made = (await olivia('POST', '/api/forms', { title: 'Office survey' })).body;
  const f = (await olivia('PUT', `/api/forms/${made.id}`, { audience: 'public', collect_email: true, send_copy: true, allow_edit: true, questions: [
    { id: 'chair', type: 'choice', title: 'Best chair', options: ['Red', 'Blue'] }, { id: 'why', type: 'short', title: 'Why' },
  ] })).body;
  const r = await gina('POST', `/api/public/forms/${f.token}`, { email: 'gina@globex.com', answers: { chair: 'Blue', why: 'Comfy' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.copy_to, 'gina@globex.com');
  const m = await eventually(async () => (await inbox(gina)).find((x) => x.subject === 'Your response to “Office survey”'));
  assert.equal(m.from.address, 'olivia@acme.com');
  const full = (await gina('GET', `/api/mail/messages/${m.uid}?folder=INBOX`)).body;
  assert.match(full.text, /Best chair: Blue\s+Why: Comfy/);
  assert.match(full.text, /To change your answers: http.*\/f\/.*\?edit=/);
});

test('morning summary: sent once a day after the chosen hour, from the person to themselves', async () => {
  const { sendDueDigests } = await import('../src/digest.js');
  assert.equal((await olivia('PUT', '/api/users/me/digest', { hour: 0, tz: 'UTC' })).status, 200);
  const n = await sendDueDigests();
  assert.ok(n >= 1);
  assert.equal(await sendDueDigests(), 0, 'once a day');
  const m = await eventually(async () => (await inbox(olivia)).find((x) => /^Your day: /.test(x.subject)));
  assert.equal(m.from.address, 'olivia@acme.com');
  const full = (await olivia('GET', `/api/mail/messages/${m.uid}?folder=INBOX`)).body;
  assert.match(full.text, /Good morning, Olivia\./);
  const now = (await olivia('POST', '/api/users/me/digest/send', {})).body;
  assert.equal(now.sent, true, '"Send me one now" works any time');
  await olivia('PUT', '/api/users/me/digest', { hour: null, tz: 'UTC' });
});

test('chat emails: unread direct messages and mentions are emailed after a while; read ones are not', async () => {
  const { sendChatEmails, WAIT_MS } = await import('../src/chatmail.js');
  const { q } = await import('../src/db.js');
  assert.equal((await olivia('PUT', '/api/chat/me/chat-email', { on: true })).status, 200);
  const me = (await olivia('GET', '/api/auth/me')).body.user;
  const chet = client();
  await olivia('POST', '/api/users', { local: 'chatmailer', domain: 'acme.com', name: 'Chet Mailer', password: 'password123' });
  assert.equal((await chet('POST', '/api/auth/login', { username: 'chatmailer@acme.com', password: 'password123' })).status, 200);
  const dm = (await chet('POST', '/api/chat/dm', { user_id: me.id })).body.id;
  await chet('POST', `/api/chat/channels/${dm}/messages`, { body: 'Can you sign the contract today?' });
  const general = (await chet('GET', '/api/chat/channels')).body.channels.find((c) => !c.dm_key && !c.private);
  await chet('POST', `/api/chat/channels/${general.id}/messages`, { body: 'Thanks @olivia@acme.com for the help!' });
  assert.equal(await sendChatEmails(), 0, 'not before 30 minutes');
  q('UPDATE chat_email_queue SET created_at = created_at - ?').run(WAIT_MS + 1000);
  q('UPDATE messages SET created_at = created_at - ? WHERE channel_id IN (?, ?)').run(WAIT_MS + 1000, dm, general.id);
  assert.equal(await sendChatEmails(), 1, 'one email for both');
  const m = await eventually(async () => (await inbox(olivia)).find((x) => x.subject === '2 unread chat messages for you'));
  const full = (await olivia('GET', `/api/mail/messages/${m.uid}?folder=INBOX`)).body;
  assert.match(full.text, /Chet Mailer \(direct message\):\s+Can you sign the contract today\?/);
  assert.match(full.text, /Chet Mailer in #general:\s+Thanks @olivia@acme\.com/);
  // Read before the wait is over: no email.
  await chet('POST', `/api/chat/channels/${dm}/messages`, { body: 'Never mind' });
  await olivia('POST', `/api/chat/channels/${dm}/read`);
  q('UPDATE chat_email_queue SET created_at = created_at - ?').run(WAIT_MS + 1000);
  q('UPDATE messages SET created_at = created_at - ? WHERE body = ?').run(WAIT_MS + 1000, 'Never mind');
  assert.equal(await sendChatEmails(), 0);
  await olivia('PUT', '/api/chat/me/chat-email', { on: false });
});

test('invitations from another calendar: answered in Mail, put on the calendar, and the organizer gets the reply', async () => {
  const { smtpFor } = await import('../src/mail/imap.js');
  const { q } = await import('../src/db.js');
  const pat = client();
  await olivia('POST', '/api/users', { local: 'patinviter', domain: 'acme.com', name: 'Pat Inviter', password: 'password123' });
  assert.equal((await pat('POST', '/api/auth/login', { username: 'patinviter@acme.com', password: 'password123' })).status, 200);
  const patRow = q("SELECT * FROM users WHERE username = 'patinviter@acme.com'").get();
  const start = Date.UTC(2026, 11, 3, 9), uidv = `ext-${Date.now()}@other.example`;
  const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Other//EN', 'METHOD:REQUEST', 'BEGIN:VEVENT', `UID:${uidv}`, 'SEQUENCE:0', `DTSTAMP:${stamp(Date.now())}`,
    `DTSTART:${stamp(start)}`, `DTEND:${stamp(start + 36e5)}`, 'SUMMARY:Supplier visit', 'LOCATION:Gate 2', 'ORGANIZER;CN=Pat Inviter:mailto:patinviter@acme.com',
    'ATTENDEE;CN=Olivia;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:olivia@acme.com', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  // (a new mailbox takes a moment to be ready for sending)
  await eventually(async () => { try { await smtpFor(patRow).sendMail({ from: 'patinviter@acme.com', to: 'olivia@acme.com', subject: 'Invitation: Supplier visit', text: 'Please come', icalEvent: { method: 'REQUEST', content: ics } }); return true; } catch { return false; } });
  const m = await eventually(async () => (await inbox(olivia)).find((x) => x.subject === 'Invitation: Supplier visit'));
  const full = (await olivia('GET', `/api/mail/messages/${m.uid}?folder=INBOX`)).body;
  assert.equal(full.invite.title, 'Supplier visit');
  assert.equal(full.invite.start, start);
  assert.equal(full.invite.organizer.email, 'patinviter@acme.com');
  assert.equal(full.invite.answer, null);
  const r = await olivia('POST', `/api/mail/messages/${m.uid}/invite`, { folder: 'INBOX', answer: 'yes' });
  assert.equal(r.status, 200);
  assert.equal(r.body.answer, 'yes');
  assert.equal(r.body.replied, true);
  const ev = (await olivia('GET', `/api/events?from=${start - 864e5}&to=${start + 864e5}`)).body.find((e) => e.title === 'Supplier visit');
  assert.ok(ev, 'on the calendar');
  assert.equal(ev.ext_organizer.email, 'patinviter@acme.com');
  assert.equal(ev.ext_status, 'yes');
  const reply = await eventually(async () => (await inbox(pat)).find((x) => x.subject === 'Accepted: Supplier visit'));
  const rfull = (await pat('GET', `/api/mail/messages/${reply.uid}?folder=INBOX`)).body;
  assert.ok(rfull.attachments.some((a) => /calendar/.test(a.contentType)) || /accepted/.test(rfull.text));
  // Changing your mind: No takes it off the calendar.
  assert.equal((await olivia('POST', `/api/mail/messages/${m.uid}/invite`, { folder: 'INBOX', answer: 'no' })).body.answer, null);
  assert.ok(!(await olivia('GET', `/api/events?from=${start - 864e5}&to=${start + 864e5}`)).body.some((e) => e.title === 'Supplier visit'));
  assert.equal((await olivia('POST', `/api/mail/messages/${m.uid}/invite`, { folder: 'INBOX', answer: 'remove' })).status, 400, 'not a cancellation');
});

test('a guest\'s answer emailed back from their calendar app goes on the event', async () => {
  const { smtpFor } = await import('../src/mail/imap.js');
  const { q } = await import('../src/db.js');
  const { MAIL_HOSTNAME } = await import('../src/mail/config.js');
  const guest = 'answerer@clients-test.example';
  const t = Date.now() + 5 * 864e5;
  const ev = (await olivia('POST', '/api/events', { title: 'Contract review', start: t, end: t + 36e5, guests: [guest], tz: 'UTC' })).body;
  // Their calendar app's reply, sent through a colleague's mailbox here (it's the calendar file that counts).
  const relay = q("SELECT * FROM users WHERE username = 'patinviter@acme.com'").get();
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Other//EN', 'METHOD:REPLY', 'BEGIN:VEVENT', `UID:${ev.id}@${MAIL_HOSTNAME || 'workspace'}`, 'SEQUENCE:0',
    `DTSTAMP:20261108T120000Z`, 'ATTENDEE;CN=Ann Swerer;PARTSTAT=ACCEPTED:mailto:answerer@clients-test.example', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  await eventually(async () => { try { await smtpFor(relay).sendMail({ from: 'patinviter@acme.com', to: 'olivia@acme.com', subject: 'Accepted: Contract review', text: 'Accepted', icalEvent: { method: 'REPLY', content: ics } }); return true; } catch { return false; } });
  const m = await eventually(async () => (await inbox(olivia)).find((x) => x.subject === 'Accepted: Contract review'));
  const full = (await olivia('GET', `/api/mail/messages/${m.uid}?folder=INBOX`)).body;
  assert.equal(full.invite.method, 'REPLY');
  assert.equal(full.invite.who, 'Ann Swerer');
  assert.equal(full.invite.answer, 'yes');
  const saved = (await olivia('GET', `/api/events?from=${t - 1}&to=${t + 1}`)).body.find((e) => e.id === ev.id);
  assert.equal(saved.guests.find((g) => g.email === guest).status, 'yes');
  assert.ok((await olivia('GET', '/api/notifications')).body.items.some((n) => n.title === 'Ann Swerer accepted “Contract review”'));
});

test('emptying Trash and Junk by themselves: the company setting reaches Dovecot', async () => {
  const { execFileSync } = await import('node:child_process');
  const r = await olivia('PATCH', '/api/orgs/current', { mail_trash_days: 30, mail_junk_days: 7 });
  assert.equal(r.status, 200);
  assert.equal(r.body.mail_trash_days, 30);
  assert.equal((await olivia('PATCH', '/api/orgs/current', { mail_trash_days: 5 })).status, 400);
  const fields = () => execFileSync('doveadm', ['user', 'olivia@acme.com'], { encoding: 'utf8' });
  await eventually(async () => /namespace\/inbox\/mailbox\/Trash\/autoexpunge\s+30d/.test(fields()) && /namespace\/inbox\/mailbox\/Junk\/autoexpunge\s+7d/.test(fields()), 30000);
  // (Dovecot then expunges mail saved in those folders longer ago than that, when the mailbox is used.)
  // Someone on legal hold: their Trash and Junk aren't emptied, and they can't delete mail for good.
  const me = (await olivia('GET', '/api/users')).body.find((u) => u.username === 'olivia@acme.com');
  assert.equal((await olivia('PATCH', `/api/users/${me.id}`, { legal_hold: true, hold_note: 'Audit' })).status, 200);
  await eventually(async () => !/autoexpunge/.test(fields()), 30000);
  const gone = await olivia('POST', '/api/mail/messages/delete', { folder: 'Trash', uids: [999999] });
  assert.equal(gone.status, 409);
  assert.equal((await olivia('PATCH', `/api/users/${me.id}`, { legal_hold: false })).status, 200);
  await eventually(async () => /Trash\/autoexpunge\s+30d/.test(fields()), 30000);
  await olivia('PATCH', '/api/orgs/current', { mail_trash_days: 0, mail_junk_days: 0 });
  await eventually(async () => !/autoexpunge/.test(fields()), 30000);
});

test('out of office in Calendar can turn on the email auto-reply for the same days', async () => {
  const day = 864e5, base = Date.UTC(2026, 11, 21);
  const r = await olivia('POST', '/api/events', { title: 'Out of office', kind: 'ooo', start: base, end: base + 3 * day - 1, all_day: 1, description: 'Back on the 24th.', auto_reply: true, tz: 'UTC' });
  assert.equal(r.status, 201);
  assert.deepEqual([r.body.auto_reply.start_date, r.body.auto_reply.end_date], ['2026-12-21', '2026-12-23']);
  const v = (await olivia('GET', '/api/mail/vacation')).body;
  assert.equal(v.enabled, true); assert.equal(v.body, 'Back on the 24th.');
  assert.equal(v.start_date, '2026-12-21'); assert.equal(v.end_date, '2026-12-23');
  assert.equal(v.scheduled, true);
  await olivia('PUT', '/api/mail/vacation', { enabled: false, subject: 'Out of office', body: '' });
});

test('recent mail with someone: from them and to them, newest first', async () => {
  const { smtpFor } = await import('../src/mail/imap.js');
  const { q } = await import('../src/db.js');
  const pat = q("SELECT * FROM users WHERE username = 'patinviter@acme.com'").get();
  const tag = `with-${Date.now()}`;
  await eventually(async () => { try { await smtpFor(pat).sendMail({ from: 'patinviter@acme.com', to: 'olivia@acme.com', subject: `${tag} from Pat`, text: 'hi' }); return true; } catch { return false; } });
  await eventually(async () => (await olivia('GET', '/api/mail/with?address=patinviter@acme.com')).body.some((m) => m.subject === `${tag} from Pat`));
  await new Promise((r) => setTimeout(r, 1500)); // dates are to the second
  await olivia('POST', '/api/mail/send', { to: 'patinviter@acme.com', subject: `${tag} to Pat`, text: 'hello', html: '' });
  const list = await eventually(async () => { const l = (await olivia('GET', '/api/mail/with?address=PatInviter@acme.com')).body; return l.some((m) => m.subject === `${tag} from Pat`) && l.some((m) => m.subject === `${tag} to Pat`) ? l : null; });
  const mine = list.filter((m) => m.subject.startsWith(tag));
  assert.equal(mine[0].subject, `${tag} to Pat`, 'newest first');
  assert.equal(mine[0].sent, true); assert.equal(mine[1].sent, false);
  assert.ok(list.length <= 10);
  assert.ok(!(await olivia('GET', '/api/mail/with?address=nobody-at-all@nowhere.example')).body.length);
});

test('mute a conversation: replies go to Archive, read; unmuting brings them back to the Inbox', async () => {
  const t = nodemailer.createTransport({ host: process.env.MAIL_IMAP_HOST, port: 25, secure: false, ignoreTLS: true, name: 'test.acme.com' });
  await t.sendMail({ from: 'Chatty <chatty@acme.com>', to: 'olivia@acme.com', subject: 'Big group thread', text: 'first', messageId: '<thread-1@test.acme.com>' });
  const first = await eventually(async () => (await inbox(olivia)).find((m) => m.subject === 'Big group thread'), 20000);
  const msg = (await olivia('GET', `/api/mail/messages/${first.uid}?folder=INBOX`)).body;
  assert.equal(msg.messageId, '<thread-1@test.acme.com>');
  assert.equal((await olivia('POST', '/api/mail/muted', { message_id: 'no-brackets', references: [] })).status, 400);
  const m = await olivia('POST', '/api/mail/muted', { message_id: msg.messageId, references: msg.references, subject: msg.subject });
  assert.equal(m.status, 201, JSON.stringify(m.body));
  assert.equal((await olivia('POST', '/api/mail/muted', { message_id: msg.messageId, subject: msg.subject })).status, 200, 'the same conversation once');
  assert.deepEqual((await olivia('GET', `/api/mail/muted/check?message_id=${encodeURIComponent(msg.messageId)}`)).body, { muted: true, id: m.body.id });
  assert.equal((await olivia('GET', '/api/mail/muted')).body.length, 1);
  await eventually(() => { try { return fs.readFileSync('/run/nw/sieve/olivia@acme.com.sieve', 'utf8').includes('<thread-1@test.acme.com>'); } catch { return false; } }, 15000);
  await t.sendMail({ from: 'Chatty <chatty@acme.com>', to: 'olivia@acme.com', subject: 'Re: Big group thread', text: 'reply 1', messageId: '<thread-2@test.acme.com>', inReplyTo: '<thread-1@test.acme.com>', references: ['<thread-1@test.acme.com>'] });
  await t.sendMail({ from: 'Chatty <chatty@acme.com>', to: 'olivia@acme.com', subject: 'Something else', text: 'not muted' });
  const archived = await eventually(async () => (await olivia('GET', '/api/mail/messages?folder=Archive')).body.messages?.find((x) => x.subject === 'Re: Big group thread'), 20000);
  assert.equal(archived.seen, true);
  await eventually(async () => (await inbox(olivia)).some((x) => x.subject === 'Something else'), 20000);
  assert.ok(!(await inbox(olivia)).some((x) => x.subject === 'Re: Big group thread'));
  // Unmute: the next reply arrives as usual.
  assert.equal((await olivia('DELETE', `/api/mail/muted/${m.body.id}`)).status, 200);
  await eventually(() => { try { return !fs.readFileSync('/run/nw/sieve/olivia@acme.com.sieve', 'utf8').includes('<thread-1@test.acme.com>'); } catch { return true; } }, 15000);
  await t.sendMail({ from: 'Chatty <chatty@acme.com>', to: 'olivia@acme.com', subject: 'Re: Big group thread', text: 'reply 2', inReplyTo: '<thread-2@test.acme.com>', references: ['<thread-1@test.acme.com>', '<thread-2@test.acme.com>'] });
  await eventually(async () => (await inbox(olivia)).some((x) => x.subject === 'Re: Big group thread'), 20000);
});

test('shared mailbox: its members read it and answer as it; nobody signs in to it; others can’t open it', async () => {
  // A colleague of its own for this test (signed in afresh).
  const bob = client();
  const made = await olivia('POST', '/api/users', { local: 'helper', domain: 'acme.com', name: 'Hal Helper', password: 'password123' });
  assert.equal(made.status, 201);
  assert.equal((await bob('POST', '/api/auth/login', { username: 'helper@acme.com', password: 'password123' })).status, 200);
  const bobUser = { id: made.body.id };
  assert.equal((await olivia('POST', '/api/mail-admin/shared', { local: 'helper', domain: 'acme.com', name: 'X' })).status, 400, 'taken by a person');
  const r = await olivia('POST', '/api/mail-admin/shared', { local: 'support', domain: 'acme.com', name: 'Acme Support', members: [bobUser.id] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body.members.map((m) => m.username), ['helper@acme.com']);
  assert.equal((await olivia('POST', '/api/users', { local: 'support', domain: 'acme.com', name: 'S', password: 'password123' })).status, 400, 'its address is taken');
  const mb = r.body.id;
  await eventually(() => { try { return fs.readFileSync('/run/nw/dovecot/passwd', 'utf8').includes('support@acme.com:{SHA512-CRYPT}*'); } catch { return false; } }, 15000);
  // Mail arrives in it.
  const t = nodemailer.createTransport({ host: process.env.MAIL_IMAP_HOST, port: 25, secure: false, ignoreTLS: true, name: 'test.acme.com' });
  await eventually(async () => { try { await t.sendMail({ from: 'Customer <cust@acme.com>', to: 'support@acme.com', subject: 'My order is late', text: 'Where is it?' }); return true; } catch { return false; } }, 20000);
  const as = { headers: { 'x-mailbox': mb } };
  const got = await eventually(async () => (await bob('GET', '/api/mail/messages?folder=INBOX', undefined, as)).body.messages?.find((m) => m.subject === 'My order is late'), 20000);
  assert.ok(!(await inbox(bob)).some((m) => m.subject === 'My order is late'), 'not in Bob’s own inbox');
  assert.deepEqual((await bob('GET', '/api/mail/shared-unread')).body, [{ id: mb, unseen: 1 }], 'its unread count, for the picker');
  assert.deepEqual((await olivia('GET', '/api/mail/shared-unread')).body, [], 'only yours');
  assert.ok((await bob('GET', '/api/mail/status')).body.shared.some((x) => x.address === 'support@acme.com'));
  // Not a member: not even its existence.
  assert.equal((await olivia('GET', '/api/mail/messages?folder=INBOX', undefined, as)).status, 404);
  // Per-person things aren't available there.
  assert.equal((await bob('GET', '/api/mail/rules', undefined, as)).status, 400);
  // Reading and answering as it.
  const full = (await bob('GET', `/api/mail/messages/${got.uid}?folder=INBOX&mailbox=${mb}`)).body;
  assert.equal(full.subject, 'My order is late');
  assert.equal((await bob('POST', '/api/mail/send', { from: 'helper@acme.com', to: 'olivia@acme.com', subject: 'x', text: 'x' }, as)).status, 400, 'only as the mailbox');
  assert.equal((await bob('POST', '/api/mail/send', { from: 'support@acme.com', to: 'olivia@acme.com', subject: 'x', text: 'x', sendAt: Date.now() + 864e5 }, as)).status, 400, 'no scheduling');
  const sent = await bob('POST', '/api/mail/send', { from: 'support@acme.com', to: 'olivia@acme.com', subject: 'Re: My order is late', text: 'It ships today.', inReplyTo: full.messageId, replyTo: { folder: 'INBOX', uid: got.uid } }, as);
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const arrived = await eventually(async () => (await inbox(olivia)).find((m) => m.subject === 'Re: My order is late'), 20000);
  assert.equal(arrived.from.address, 'support@acme.com');
  const folders = (await bob('GET', '/api/mail/folders', undefined, as)).body;
  const sentBox = folders.find((f) => f.specialUse === '\\Sent');
  assert.ok((await bob('GET', `/api/mail/messages?folder=${encodeURIComponent(sentBox.path)}`, undefined, as)).body.messages.some((m) => m.subject === 'Re: My order is late'), 'in the mailbox’s own Sent');
  assert.ok((await bob('GET', '/api/mail/messages?folder=INBOX', undefined, as)).body.messages.find((m) => m.uid === got.uid).answered !== false);
  // Giving a message to a member (who is told) and marking it done.
  const oliviaId = (await olivia('GET', '/api/auth/me')).body.user.id;
  await olivia('PATCH', `/api/mail-admin/shared/${mb}`, { members: [bobUser.id, oliviaId] });
  assert.deepEqual((await bob('GET', '/api/mail/members', undefined, as)).body.map((m) => m.name).sort(), ['Hal Helper', 'Olivia Owner']);
  assert.equal((await bob('POST', '/api/mail/assign', { message_id: full.messageId, assignee_id: 'nobody' }, as)).status, 400);
  assert.equal((await bob('POST', '/api/mail/assign', { message_id: full.messageId, assignee_id: oliviaId }, undefined)).status, 400, 'only in a shared mailbox');
  const given = await bob('POST', '/api/mail/assign', { message_id: full.messageId, subject: full.subject, assignee_id: oliviaId }, as);
  assert.deepEqual(given.body, { message_id: full.messageId, assignee: { id: oliviaId, name: 'Olivia Owner' }, done: false });
  const bell = (await olivia('GET', '/api/notifications')).body;
  assert.ok((bell.items || bell).some((n) => n.kind === 'assign' && /Hal Helper gave you an email in support@acme.com/.test(n.title)), JSON.stringify(bell).slice(0, 300));
  await bob('POST', '/api/mail/assign', { message_id: full.messageId, done: true }, as);
  const listed = (await olivia('GET', '/api/mail/messages?folder=INBOX', undefined, as)).body.messages.find((m) => m.uid === got.uid);
  assert.deepEqual([listed.assignee?.name, listed.done], ['Olivia Owner', true]);
  assert.equal((await olivia('GET', `/api/mail/messages/${got.uid}?folder=INBOX`, undefined, as)).body.assignee.name, 'Olivia Owner');
  // Internal notes: only the mailbox's people see them; only the writer deletes one.
  assert.equal((await bob('POST', '/api/mail/notes', { message_id: full.messageId, body: '  ' }, as)).status, 400);
  const n1 = await bob('POST', '/api/mail/notes', { message_id: full.messageId, body: 'Customer is on the gold plan' }, as);
  assert.equal(n1.status, 201);
  const n2 = (await olivia('POST', '/api/mail/notes', { message_id: full.messageId, body: 'Refund approved' }, as)).body;
  assert.deepEqual(n2.map((n) => [n.user_name, n.body]), [['Hal Helper', 'Customer is on the gold plan'], ['Olivia Owner', 'Refund approved']]);
  assert.equal((await bob('GET', `/api/mail/notes?message_id=${encodeURIComponent(full.messageId)}`)).status, 400, 'not outside the shared mailbox');
  assert.equal((await bob('DELETE', `/api/mail/notes/${n2[1].id}`, undefined, as)).status, 400, 'not someone else’s');
  assert.equal((await bob('DELETE', `/api/mail/notes/${n2[0].id}`, undefined, as)).body.length, 1);
  assert.equal((await bob('GET', '/api/mail/messages?folder=INBOX', undefined, as)).body.messages.find((m) => m.uid === got.uid).notes, 1);
  // An automatic reply to whoever writes in (once a day per sender, as a vacation reply).
  assert.equal((await olivia('PATCH', `/api/mail-admin/shared/${mb}`, { auto_reply: 'x'.repeat(4001) })).status, 400);
  const ar = await olivia('PATCH', `/api/mail-admin/shared/${mb}`, { auto_subject: 'We got your message', auto_reply: 'Thanks for writing to Acme Support. We answer within a day.' });
  assert.equal(ar.body.auto_subject, 'We got your message');
  await eventually(() => { try { return fs.readFileSync('/run/nw/sieve/support@acme.com.sieve', 'utf8').includes('We answer within a day'); } catch { return false; } }, 15000);
  await olivia('POST', '/api/mail/send', { to: 'support@acme.com', subject: 'Another question', text: 'Hi' });
  const ack = await eventually(async () => (await inbox(olivia)).find((m) => m.subject === 'We got your message'), 30000);
  assert.equal(ack.from.address, 'support@acme.com');
  await olivia('PATCH', `/api/mail-admin/shared/${mb}`, { auto_reply: '' });
  await eventually(() => !fs.existsSync('/run/nw/sieve/support@acme.com.sieve') || !fs.readFileSync('/run/nw/sieve/support@acme.com.sieve', 'utf8').includes('We answer within a day'), 15000);
  // Its signature (set by an admin) reaches its people with the mailbox.
  assert.equal((await olivia('PATCH', `/api/mail-admin/shared/${mb}`, { signature: 'y'.repeat(2001) })).status, 400);
  assert.equal((await olivia('PATCH', `/api/mail-admin/shared/${mb}`, { signature: '{name}\nAcme Support' })).body.signature, '{name}\nAcme Support');
  assert.equal((await bob('GET', '/api/mail/status')).body.shared.find((x) => x.id === mb).signature, '{name}\nAcme Support');
  // Nobody can sign in to it with a password.
  await assert.rejects(imapLogin('support@acme.com', 'password123'));
  // Taking Bob off: he can't open it any more. Deleting it frees the address.
  await olivia('PATCH', `/api/mail-admin/shared/${mb}`, { members: [] });
  assert.equal((await bob('GET', '/api/mail/messages?folder=INBOX', undefined, as)).status, 404);
  assert.equal((await olivia('DELETE', `/api/mail-admin/shared/${mb}`)).status, 200);
  assert.equal((await olivia('GET', '/api/mail-admin/shared')).body.length, 0);
});

test('plus addresses into folders: you+name@ goes into your folder “Name”, when you have one and turned it on', async () => {
  const t = nodemailer.createTransport({ host: process.env.MAIL_IMAP_HOST, port: 25, secure: false, ignoreTLS: true, name: 'test.acme.com' });
  assert.deepEqual((await olivia('GET', '/api/mail/plus-folders')).body, { on: false, example: 'olivia+receipts@acme.com' });
  // Off: plus mail just arrives in the Inbox.
  await t.sendMail({ from: 'Shop <shop@acme.com>', to: 'olivia+receipts@acme.com', subject: 'Receipt one', text: 'x' });
  await eventually(async () => (await inbox(olivia)).some((m) => m.subject === 'Receipt one'), 20000);
  await olivia('POST', '/api/mail/folders', { name: 'Receipts' });
  assert.equal((await olivia('PUT', '/api/mail/plus-folders', { on: true })).body.on, true);
  await eventually(() => { try { return fs.readFileSync('/run/nw/sieve/olivia@acme.com.sieve', 'utf8').includes('subaddress'); } catch { return false; } }, 15000);
  await t.sendMail({ from: 'Shop <shop@acme.com>', to: 'olivia+receipts@acme.com', subject: 'Receipt two', text: 'x' });
  await t.sendMail({ from: 'Spammer <s@acme.com>', to: 'olivia+madeup@acme.com', subject: 'No such folder', text: 'x' });
  await eventually(async () => (await olivia('GET', '/api/mail/messages?folder=Receipts')).body.messages?.some((m) => m.subject === 'Receipt two'), 20000);
  await eventually(async () => (await inbox(olivia)).some((m) => m.subject === 'No such folder'), 20000);
  assert.ok(!(await olivia('GET', '/api/mail/folders')).body.some((f) => /madeup/i.test(f.path)), 'no folder made by a sender');
  await olivia('PUT', '/api/mail/plus-folders', { on: false });
});

test('delegation: a colleague reads and answers someone’s mail as them (Sender: shows who); only those given it', async () => {
  const dana = client(), eve = client();
  for (const [local, name] of [['dana', 'Dana Delegate'], ['eve', 'Eve Elsewhere']]) assert.equal((await olivia('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).status, 201);
  assert.equal((await dana('POST', '/api/auth/login', { username: 'dana@acme.com', password: 'password123' })).status, 200);
  assert.equal((await eve('POST', '/api/auth/login', { username: 'eve@acme.com', password: 'password123' })).status, 200);
  const oliviaId = (await olivia('GET', '/api/auth/me')).body.user.id;
  assert.equal((await olivia('POST', '/api/mail/delegates', { email: 'olivia@acme.com' })).status, 400, 'not yourself');
  assert.equal((await olivia('POST', '/api/mail/delegates', { email: 'nobody@acme.com' })).status, 400);
  const given = await olivia('POST', '/api/mail/delegates', { email: 'dana@acme.com' });
  assert.equal(given.status, 201);
  assert.deepEqual(given.body.map((d) => d.username), ['dana@acme.com']);
  assert.deepEqual((await dana('GET', '/api/mail/delegates')).body.toMe.map((d) => d.username), ['olivia@acme.com']);
  const box = (await dana('GET', '/api/mail/status')).body.shared.find((x) => x.delegated);
  assert.deepEqual([box.id, box.address, box.name], [`d:${oliviaId}`, 'olivia@acme.com', 'Olivia Owner']);
  assert.ok(JSON.stringify((await dana('GET', '/api/notifications')).body).includes('Olivia Owner gave you access to their mail'));

  // Reading Olivia's inbox; Eve can't; per-person things and team-mailbox extras aren't there.
  await olivia('POST', '/api/mail/send', { to: 'olivia@acme.com', subject: 'Board pack for Thursday', text: 'Attached soon.' });
  const as = { headers: { 'x-mailbox': `d:${oliviaId}` } };
  const msg = await eventually(async () => (await dana('GET', '/api/mail/messages?folder=INBOX', undefined, as)).body.messages?.find((m) => m.subject === 'Board pack for Thursday'), 20000);
  assert.ok(!(await inbox(dana)).some((m) => m.subject === 'Board pack for Thursday'), 'not in Dana’s own inbox');
  assert.equal((await eve('GET', '/api/mail/messages?folder=INBOX', undefined, { headers: { 'x-mailbox': `d:${oliviaId}` } })).status, 404);
  assert.equal((await dana('GET', '/api/mail/rules', undefined, as)).status, 400);
  assert.equal((await dana('GET', '/api/mail/members', undefined, as)).status, 400);
  assert.equal((await dana('POST', '/api/mail/delegates', { email: 'eve@acme.com' }, as)).status, 400, 'she can’t pass it on');
  assert.ok((await dana('GET', '/api/mail/shared-unread')).body.some((x) => x.id === `d:${oliviaId}`));

  // Answering: from Olivia, saying Dana sent it; in Olivia's Sent.
  const sent = await dana('POST', '/api/mail/send', { from: 'olivia@acme.com', to: 'eve@acme.com', subject: 'Re: Board pack', text: 'Olivia will bring it.' }, as);
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const got = await eventually(async () => (await inbox(eve)).find((m) => m.subject === 'Re: Board pack'), 20000);
  assert.equal(got.from.address, 'olivia@acme.com');
  const full = (await eve('GET', `/api/mail/messages/${got.uid}?folder=INBOX`)).body;
  assert.deepEqual([full.sentBy?.address, full.sentBy?.name], ['dana@acme.com', 'Dana Delegate']);
  const sentBox = (await olivia('GET', '/api/mail/folders')).body.find((f) => f.specialUse === '\\Sent');
  assert.ok((await olivia('GET', `/api/mail/messages?folder=${encodeURIComponent(sentBox.path)}`)).body.messages.some((m) => m.subject === 'Re: Board pack'));

  // Taken away: no more access.
  const danaId = given.body[0].id;
  assert.equal((await olivia('DELETE', `/api/mail/delegates/${danaId}`)).body.length, 0);
  assert.equal((await dana('GET', '/api/mail/messages?folder=INBOX', undefined, as)).status, 404);
  assert.ok(!(await dana('GET', '/api/mail/status')).body.shared.some((x) => x.delegated));
  const log = JSON.stringify((await olivia('GET', '/api/audit?limit=50')).body);
  assert.match(log, /mail\.delegate/);
  assert.match(log, /mail\.undelegate/);
});

test('outgoing queue: mail that can’t go out is listed for the platform owner, and deleted from there', async () => {
  const t = nodemailer.createTransport({ host: process.env.MAIL_IMAP_HOST, port: 465, secure: true, tls: { rejectUnauthorized: false }, auth: { user: 'olivia@acme.com', pass: 'password123' } });
  // An address on a documentation-only network: nothing answers, so Postfix keeps it to retry.
  await t.sendMail({ from: 'olivia@acme.com', to: 'client@[192.0.2.10]', subject: 'Stuck quote', text: 'Will not arrive.' });
  const waiting = await eventually(async () => {
    const r = (await olivia('GET', '/api/orgs/system/mail-queue')).body;
    return r.available && r.messages.find((m) => m.recipients.some((x) => x.address === 'client@[192.0.2.10]') && m.queue === 'deferred');
  }, 90000); // deferred only once Postfix's connection attempt times out (30 seconds), later when the queue is busy
  assert.equal(waiting.sender, 'olivia@acme.com');
  assert.match(waiting.recipients[0].reason, /192\.0\.2\.10/);
  const health = (await olivia('GET', '/api/orgs/system/health')).body;
  assert.match(health.checks.find((c) => c.id === 'queue').detail, /waiting/);
  assert.equal((await gina('GET', '/api/orgs/system/mail-queue')).status, 403, 'not company admins');
  assert.equal((await olivia('POST', '/api/orgs/system/mail-queue', { op: 'delete', id: 'not/an-id' })).status, 400);
  const { seq } = (await olivia('POST', '/api/orgs/system/mail-queue', { op: 'delete', id: waiting.id })).body;
  await eventually(async () => {
    const r = (await olivia('GET', '/api/orgs/system/mail-queue')).body;
    return r.done >= seq && !r.messages.some((m) => m.id === waiting.id);
  }, 20000);
  assert.ok(JSON.stringify((await olivia('GET', '/api/audit')).body).includes('mail-queue.delete'));
});

test('large files as links: over 25 MB goes out as a download link, the rest attached; only your own files', async () => {
  const big = (await olivia('POST', '/api/files/upload?name=Site%20video.mp4', Buffer.alloc(26 * 1024 * 1024, 7), { raw: true })).body;
  const small = (await olivia('POST', '/api/files/upload?name=agenda.txt', 'Agenda', { raw: true })).body;
  const tooBig = await olivia('POST', '/api/mail/send', { to: 'olivia@acme.com', subject: 'Too big', text: 'x', attachments: [big.id, small.id] });
  assert.equal(tooBig.status, 400);
  assert.match(tooBig.body.error, /send the large files as links/);
  const r = await olivia('POST', '/api/mail/send', { to: 'olivia@acme.com', subject: 'Site video', text: 'Here it is.', html: '<p>Here it is.</p>', attachments: [big.id, small.id], linkAttachments: [big.id] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const msg = await eventually(async () => (await inbox(olivia, 'Site video'))[0]);
  const full = (await olivia('GET', `/api/mail/messages/${msg.uid}?folder=INBOX`)).body;
  assert.deepEqual(full.attachments.map((a) => a.filename), ['agenda.txt'], 'the small one attached');
  const token = (full.text || '').match(/\/s\/([\w-]+)/)?.[1];
  assert.ok(token, full.text);
  assert.match(full.text, /Site video\.mp4 \(26\.0 MB\)/);
  assert.match(full.html, /<a href="[^"]+\/s\/[\w-]+">Site video\.mp4<\/a>/);
  const pub = await fetch(`${base}/api/public/links/${token}`).then((x) => x.json());
  assert.equal(pub.name, 'Site video.mp4');
  assert.ok(pub.expires_at > Date.now() + 29 * 864e5);
  // Someone else's file, even shared with you, can't go out as a link.
  const lee = client();
  const leeId = (await olivia('POST', '/api/users', { local: 'linklee', domain: 'acme.com', name: 'Link Lee', password: 'password123' })).body.id;
  assert.equal((await lee('POST', '/api/auth/login', { username: 'linklee@acme.com', password: 'password123' })).status, 200);
  await olivia('PUT', `/api/files/${small.id}/shares`, { shares: [{ user_id: leeId, role: 'viewer' }] });
  const notMine = await lee('POST', '/api/mail/send', { to: 'olivia@acme.com', subject: 'x', text: 'x', attachments: [small.id], linkAttachments: [small.id] });
  assert.equal(notMine.status, 400);
  assert.match(notMine.body.error, /isn’t yours/);
});

test('booking reminders: the visitor is emailed the day before, once, with the link to change or cancel', async () => {
  const { sendBookingReminders } = await import('../src/routes/booking.js');
  const { q } = await import('../src/db.js');
  q('UPDATE bookings SET reminded_at = 1 WHERE reminded_at IS NULL').run(); // earlier tests' bookings aren't this test's
  const page = (await olivia('POST', '/api/bookings', { title: 'Site visit', duration: 60, days: [0, 1, 2, 3, 4, 5, 6], from_min: 0, to_min: 1440, tz: 'UTC', notice_hours: 0, days_ahead: 3 })).body;
  assert.equal(page.remind, true, 'on unless turned off');
  const token = page.url.split('/b/')[1];
  const slots = (await fetch(`${base}/api/public/book/${token}`).then((x) => x.json())).days.flatMap((d) => d.slots);
  const book = (start, name) => fetch(`${base}/api/public/book/${token}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'nas-workspace' }, body: JSON.stringify({ start, name, email: 'olivia@acme.com' }) }).then((x) => x.json());
  // Booked this afternoon for this evening: no reminder (it was booked less than 12 hours before).
  const soon = slots.find((t) => t > Date.now() + 5 * 3600e3);
  assert.ok((await book(soon, 'Sam Soon')).cancel_url);
  assert.equal(await sendBookingReminders(), 0, 'booked just now for a few hours away: no reminder');
  // The visitor here is a mailbox on this server, so the reminder can be read back.
  const start = slots.find((t) => t > Date.now() + 20 * 3600e3);
  const b = await book(start, 'Vic Visitor');
  assert.ok(b.cancel_url);
  assert.equal(await sendBookingReminders(start - 30 * 3600e3), 0, 'not yet: more than a day ahead');
  assert.equal(await sendBookingReminders(), 1);
  assert.equal(await sendBookingReminders(), 0, 'once');
  const msg = await eventually(async () => (await inbox(olivia, 'Reminder: Site visit'))[0]);
  const full = (await olivia('GET', `/api/mail/messages/${msg.uid}?folder=INBOX`)).body;
  assert.match(full.subject, /^Reminder: Site visit with Olivia Owner, /);
  assert.match(full.text, /Hello Vic Visitor,/);
  assert.ok(full.text.includes(b.cancel_url), full.text);
  // A page with reminders turned off sends none.
  await olivia('PATCH', `/api/bookings/${page.id}`, { remind: false });
  q('UPDATE bookings SET reminded_at = NULL WHERE page_id = ?').run(page.id);
  assert.equal(await sendBookingReminders(), 0);
});

test('new mail on phones: the mail server tells the app as it delivers, and the device gets it (encrypted)', async () => {
  const https = await import('node:https');
  const crypto = await import('node:crypto');
  const { execFileSync } = await import('node:child_process');
  const ece = (await import('module')).createRequire(import.meta.url)('http_ece');
  // A stand-in push service, and a device's keys (as a browser makes them).
  const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-mpush-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1', '-keyout', `${certDir}/k.pem`, '-out', `${certDir}/c.pem`], { stdio: 'ignore' });
  const got = [];
  const svc = https.createServer({ key: fs.readFileSync(`${certDir}/k.pem`), cert: fs.readFileSync(`${certDir}/c.pem`) }, (req, res) => { const parts = []; req.on('data', (c) => parts.push(c)); req.on('end', () => { got.push(Buffer.concat(parts)); res.statusCode = 201; res.end(); }); });
  await new Promise((r) => svc.listen(0, '127.0.0.1', r));
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  const keys = { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') };
  process.env.PUSH_ANY_ENDPOINT = '1'; process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try {
    assert.equal((await olivia('POST', '/api/push/subscribe', { endpoint: `https://127.0.0.1:${svc.address().port}/d1`, keys })).status, 200);
    const t = nodemailer.createTransport({ host: process.env.MAIL_IMAP_HOST, port: 25, secure: false, ignoreTLS: true, name: 'test.acme.com' });
    await t.sendMail({ from: '"Pat Partner" <pat@acme.com>', to: 'olivia@acme.com', subject: 'Contract signed', text: 'Done.' });
    await eventually(() => got.length > 0, 20000);
    const msg = JSON.parse(ece.decrypt(got[0], { version: 'aes128gcm', privateKey: ecdh, authSecret: keys.auth }).toString());
    assert.equal(msg.title, 'Pat Partner');
    assert.equal(msg.body, 'Contract signed');
    assert.match(msg.link, /^\/mail\/INBOX\/\d+$/);
    // Turned off in notification settings: nothing more.
    await olivia('PUT', '/api/notifications/settings', { off: ['mail'] });
    await t.sendMail({ from: 'pat@acme.com', to: 'olivia@acme.com', subject: 'Second', text: 'x' });
    await eventually(async () => (await inbox(olivia, 'Second')).length, 20000);
    await sleep(1500);
    assert.equal(got.length, 1);
    await olivia('PUT', '/api/notifications/settings', { off: [] });
  } finally {
    delete process.env.PUSH_ANY_ENDPOINT; delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    svc.close();
  }
});

test('inbox tabs: newsletters and automatic mail in Updates, people in Primary; moved by hand; turned off', async () => {
  assert.equal((await olivia('POST', '/api/users', { local: 'tabby', domain: 'acme.com', name: 'Tabby Tabs', password: 'password123' })).status, 201);
  const tabby = client();
  assert.equal((await tabby('POST', '/api/auth/login', { username: 'tabby@acme.com', password: 'password123' })).status, 200);
  await eventually(async () => (await tabby('GET', '/api/mail/folders')).status === 200);
  const t = nodemailer.createTransport({ host: process.env.MAIL_IMAP_HOST, port: 25, secure: false, ignoreTLS: true, name: 'test.acme.com' });
  const to = 'tabby@acme.com';
  const send = (opts) => eventually(async () => { try { await t.sendMail(opts); return true; } catch { return false; } }, 30000); // once the mail server knows the new address
  await send({ from: 'Pat <pat@acme.com>', to, subject: 'Lunch on Friday?', text: 'x' });
  await send({ from: 'Shop <news@globex.com>', to, subject: 'Our autumn sale', text: 'x', headers: { 'List-Unsubscribe': '<mailto:unsub@globex.com>' } });
  await send({ from: 'Club <club@globex.com>', to, subject: 'Meeting minutes', text: 'x', headers: { 'List-Id': 'Club members <members.club.example>' } });
  await send({ from: 'Billing <billing@globex.com>', to, subject: 'Your receipt', text: 'x', headers: { 'Auto-Submitted': 'auto-generated' } });
  await send({ from: 'Kim <kim@acme.com>', to, subject: 'Contract draft', text: 'x' });
  const tab = async (name) => (await tabby('GET', `/api/mail/messages?folder=INBOX&tab=${name}`)).body;
  const subjects = (r) => r.messages.map((m) => m.subject).sort();
  const primary = await eventually(async () => { const r = await tab('primary'); return r.total === 2 && r; }, 30000);
  assert.deepEqual(subjects(primary), ['Contract draft', 'Lunch on Friday?']);
  assert.equal(primary.otherUnread, 3, 'unread in Updates, for its badge');
  const updates = await eventually(async () => { const r = await tab('updates'); return r.total === 3 && r; });
  assert.deepEqual(subjects(updates), ['Meeting minutes', 'Our autumn sale', 'Your receipt']);
  assert.equal(updates.otherUnread, 2);
  // The plain Inbox (no tab), and searching, still show everything.
  assert.equal((await tabby('GET', '/api/mail/messages?folder=INBOX')).body.total, 5);
  assert.equal((await tabby('GET', '/api/mail/messages?folder=INBOX&tab=updates&q=minutes')).body.messages.length, 1);
  // Moved by hand: the club minutes matter; Kim's draft doesn't.
  const minutes = updates.messages.find((m) => m.subject === 'Meeting minutes');
  assert.equal((await tabby('POST', `/api/mail/messages/${minutes.uid}/tab`, { tab: 'primary' })).status, 200);
  const kim = primary.messages.find((m) => m.subject === 'Contract draft');
  await tabby('POST', `/api/mail/messages/${kim.uid}/tab`, { tab: 'updates' });
  assert.deepEqual(subjects(await tab('primary')), ['Lunch on Friday?', 'Meeting minutes']);
  assert.deepEqual(subjects(await tab('updates')), ['Contract draft', 'Our autumn sale', 'Your receipt']);
  assert.equal((await tabby('POST', `/api/mail/messages/${kim.uid}/tab`, { tab: 'other' })).status, 400);
  // Turned off: one Inbox, whatever the tab asked for.
  assert.deepEqual((await tabby('PUT', '/api/mail/inbox-tabs', { on: false })).body, { on: false });
  const all = await tab('primary');
  assert.equal(all.total, 5);
  assert.equal(all.tab, undefined);
  await tabby('PUT', '/api/mail/inbox-tabs', { on: true });
  assert.deepEqual((await tabby('GET', '/api/mail/inbox-tabs')).body, { on: true });
});


/** Bob is disabled and his password changed early on ('phones and Outlook…'): tests later on that need him active and signed in call this. */
async function bobBack() {
  await olivia('PATCH', `/api/users/${bobId}`, { disabled: false, password: 'password123' });
  await eventually(async () => (await bob('POST', '/api/auth/login', { username: 'bob@acme.com', password: 'password123' })).status === 200);
}

test('confidential mode: the email carries a link, not the message; readable by its recipients; taken back', async () => {
  await bobBack();
  const subject = `Salaries ${Date.now()}`;
  assert.equal((await olivia('POST', '/api/mail/send', { to: 'bob@acme.com', subject, html: '<p>Secret numbers</p>', text: 'Secret numbers', confidential: { days: 3 } })).status, 400, 'days from the list');
  assert.equal((await olivia('POST', '/api/mail/send', { to: 'bob@acme.com', subject, text: 'x', confidential: { days: 7 }, sendAt: Date.now() + 36e5 })).status, 400, 'not scheduled');
  const sent = await olivia('POST', '/api/mail/send', { to: 'bob@acme.com', cc: 'gina@globex.com', subject, html: '<p>Secret numbers</p>', text: 'Secret numbers', confidential: { days: 7 } });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const { token } = sent.body.confidential;
  const got = await eventually(async () => (await inbox(bob, subject))[0]);
  const msg = (await bob('GET', `/api/mail/messages/${got.uid}?folder=INBOX`)).body;
  assert.ok(!JSON.stringify(msg).includes('Secret numbers'), 'the message itself never goes by email');
  assert.match(msg.text, new RegExp(`/c/${token}`));
  assert.match(msg.text, /Olivia Owner sent you a confidential message/);
  // Bob (signed in) reads it; Gina (another company) isn't signed in as a recipient there, so she'd need a code.
  const read = (await bob('GET', `/api/public/confidential/${token}`)).body;
  assert.equal(read.html, '<p>Secret numbers</p>');
  // A code by email to Gina, from Olivia.
  assert.equal((await gina('POST', `/api/public/confidential/${token}/code`, { email: 'gina@globex.com' })).status, 200);
  const codeMail = await eventually(async () => (await inbox(gina, 'Your code to read'))[0]);
  const codeText = (await gina('GET', `/api/mail/messages/${codeMail.uid}?folder=INBOX`)).body.text;
  const code = /Your code is (\d{6})/.exec(codeText)[1];
  assert.equal((await gina('POST', `/api/public/confidential/${token}/open`, { email: 'gina@globex.com', code })).body.text, 'Secret numbers');
  // Olivia's list; she takes it back; nobody can read it now.
  const mine = (await olivia('GET', '/api/mail/confidential')).body.find((x) => x.token === token);
  assert.deepEqual([mine.subject, mine.state, mine.opened, mine.recipients.sort()], [subject, 'open', 2, ['bob@acme.com', 'gina@globex.com']]);
  assert.equal((await bob('POST', `/api/mail/confidential/${token}/revoke`)).status, 404, 'only the sender');
  assert.equal((await olivia('POST', `/api/mail/confidential/${token}/revoke`)).body.state, 'revoked');
  assert.equal((await bob('GET', `/api/public/confidential/${token}`)).status, 410);
  // Attachments aren't sent confidentially.
  const f = (await olivia('POST', '/api/files/upload?name=plan.txt', 'plan', { raw: true })).body;
  assert.equal((await olivia('POST', '/api/mail/send', { to: 'bob@acme.com', subject: 'x', text: 'x', attachments: [f.id], confidential: { days: 7 } })).status, 400);
});

test('when someone leaves, mail to their address arrives in the colleague\'s inbox', async () => {
  const id = (await olivia('POST', '/api/users', { local: 'leaving', domain: 'acme.com', name: 'Lee Leaving', password: 'password123' })).body.id;
  const lee = client();
  await lee('POST', '/api/auth/login', { username: 'leaving@acme.com', password: 'password123' });
  await eventually(async () => (await lee('GET', '/api/mail/folders')).status === 200);
  const me = (await olivia('GET', '/api/auth/me')).body;
  const del = await olivia('DELETE', `/api/users/${id}?mail_to=${me.user?.id || me.id}`);
  assert.equal(del.body.mail_to, 'olivia@acme.com');
  // Once the mail server has the change (it reads it every couple of seconds): no mailbox, an alias.
  const live = (f) => { try { return fs.readFileSync(path.join('/run/nw/postfix', f), 'utf8'); } catch { return fs.readFileSync(path.join(process.env.MAIL_CONFIG_DIR, 'postfix', f), 'utf8'); } };
  await eventually(() => /^leaving@acme\.com olivia@acme\.com$/m.test(live('aliases')) && !/^leaving@acme\.com\s/m.test(live('mailboxes')), 20000);
  await new Promise((r) => setTimeout(r, 3000)); // and Postfix has reloaded them
  const t = nodemailer.createTransport({ host: process.env.MAIL_IMAP_HOST, port: 25, secure: false, ignoreTLS: true, name: 'test.acme.com' });
  const subject = `For Lee ${Date.now()}`;
  await eventually(async () => { try { await t.sendMail({ from: 'Client <client@globex.com>', to: 'leaving@acme.com', subject, text: 'Is Lee still there?' }); return true; } catch { return false; } }, 30000);
  const got = await eventually(async () => (await inbox(olivia, subject))[0], 30000);
  assert.ok(got);
});

test('saved searches: kept with their folder, unread matches counted by the mail server, renamed, removed', async () => {
  await bobBack();
  assert.equal((await olivia('POST', '/api/mail/searches', { query: '' })).status, 400);
  assert.equal((await olivia('POST', '/api/mail/searches', { query: 'before:yesterdayish' })).status, 400, 'a search that can\'t be read');
  const tag = `Inv${Date.now()}`;
  const saved = await olivia('POST', '/api/mail/searches', { name: 'Invoices', folder: 'INBOX', query: `subject:${tag}` });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.equal((await olivia('POST', '/api/mail/searches', { folder: 'INBOX', query: `subject:${tag}` })).status, 400, 'saved already');
  const t = nodemailer.createTransport({ host: process.env.MAIL_IMAP_HOST, port: 25, secure: false, ignoreTLS: true, name: 'test.acme.com' });
  for (const n of [1, 2]) await t.sendMail({ from: 'Supplier <billing@globex.com>', to: 'olivia@acme.com', subject: `${tag} number ${n}`, text: 'x' });
  await t.sendMail({ from: 'Friend <friend@globex.com>', to: 'olivia@acme.com', subject: 'Something else', text: 'x' });
  const count = async () => (await olivia('GET', '/api/mail/searches')).body.find((x) => x.id === saved.body.id);
  await eventually(async () => (await count())?.unseen === 2, 30000);
  // Reading one: one unread left.
  const first = (await inbox(olivia, tag))[0];
  await olivia('GET', `/api/mail/messages/${first.uid}?folder=INBOX`);
  await eventually(async () => (await count()).unseen === 1);
  assert.equal((await bob('PATCH', `/api/mail/searches/${saved.body.id}`, { name: 'Mine now' })).status, 404, 'your own only');
  await olivia('PATCH', `/api/mail/searches/${saved.body.id}`, { name: 'Supplier invoices' });
  assert.deepEqual([(await count()).name, (await count()).query], ['Supplier invoices', `subject:${tag}`]);
  assert.equal((await olivia('DELETE', `/api/mail/searches/${saved.body.id}`)).status, 200);
  assert.equal(await count(), undefined);
});

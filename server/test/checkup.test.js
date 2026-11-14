import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-checkup-'));
const { createApp } = await import('../src/app.js');
const { checkup } = await import('../src/checkup.js');
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

test('security checkup: what’s open, worst first, and what changes it', async () => {
  const ana = client(), kim = client();
  await ana('POST', '/api/auth/setup', { org_name: 'Acme', domain: 'acme.com', name: 'Ana Admin', local: 'ana', password: 'password123' });
  const kimId = (await ana('POST', '/api/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  const oldId = (await ana('POST', '/api/users', { local: 'old', domain: 'acme.com', name: 'Old Timer', password: 'password123' })).body.id;
  await kim('POST', '/api/auth/login', { username: 'kim@acme.com', password: 'password123' });
  const orgId = q('SELECT org_id FROM users WHERE id = ?').get(kimId).org_id;
  // (made now: once two steps are required, Kim must set them up before anything else)
  const made = await kim('POST', '/api/files/new', { kind: 'doc', name: 'Price list' });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const f = made.body;
  const now = Date.now();
  q('UPDATE users SET created_at = ?, last_active = ? WHERE id = ?').run(now - 200 * 864e5, now - 120 * 864e5, oldId);

  const ids = (list) => list.map((x) => `${x.id}:${x.status}`);
  let c = await checkup(orgId, now, { mail: false });
  assert.deepEqual(ids(c), ['admin-2fa:warn', 'require-2fa:warn', 'inactive:warn', 'recovery:tip', 'mark-external:tip', 'idle:tip']);
  assert.equal(c.find((x) => x.id === 'recovery').title, '3 people have no recovery email');
  assert.match(c[0].title, /^1 admin signs in with just a password$/);
  assert.match(c[0].detail, /^Ana Admin\./);
  assert.equal(c[1].title, '3 people sign in with just a password');
  assert.deepEqual(c[2].people, ['Old Timer']);
  assert.deepEqual(c[2].ids, [oldId], 'so they can be suspended from the checkup');
  assert.deepEqual(c.find((x) => x.id === 'mark-external').fix, { label: 'Turn it on', settings: { mark_external: true } });
  assert.deepEqual(c.find((x) => x.id === 'require-2fa').fix.settings, { require_2fa: true });
  // The fix is what Company settings takes: applied, the item goes.
  assert.equal((await ana('PATCH', '/api/orgs/current', c.find((x) => x.id === 'idle').fix.settings)).status, 200);
  assert.ok(!(await checkup(orgId, now, { mail: false })).some((x) => x.id === 'idle'));
  q('UPDATE orgs SET session_idle_min = 0 WHERE id = ?').run(orgId);

  // Everyone adds a recovery address: that tip goes.
  q("UPDATE users SET recovery_email = 'home@example.org' WHERE org_id = ?").run(orgId);
  assert.ok(!(await checkup(orgId, now, { mail: false })).some((x) => x.id === 'recovery'));
  // Fixed: Ana's two-step on, two steps required, Old suspended, outside mail marked, idle sign-out.
  q('INSERT INTO two_factor (user_id, secret, enabled) VALUES (?, ?, 1)').run(q("SELECT id FROM users WHERE username = 'ana@acme.com'").get().id, 'JBSWY3DPEHPK3PXP');
  q('UPDATE orgs SET require_2fa = 1, mark_external = 1, session_idle_min = 60 WHERE id = ?').run(orgId);
  q('UPDATE users SET disabled = 1 WHERE id = ?').run(oldId);
  c = await checkup(orgId, now, { mail: false });
  assert.deepEqual(ids(c), ['require-2fa:tip', 'admin-2fa:ok']);
  assert.match(c[0].detail, /^1 person still has to set it up/);

  // A share link for anyone, for ever, without a password; an open phishing report.
  q("INSERT INTO share_links (id, token, file_id, created_by, created_at) VALUES ('l1', 't1', ?, ?, ?)").run(f.id, kimId, now);
  q("INSERT INTO phishing_reports (id, org_id, user_id, sender, at) VALUES ('p1', ?, ?, 'x@evil.example', ?)").run(orgId, kimId, now);
  c = await checkup(orgId, now, { mail: false });
  assert.deepEqual(ids(c), ['phishing:warn', 'require-2fa:tip', 'links:tip', 'admin-2fa:ok']);
  assert.equal(c.find((x) => x.id === 'links').title, '1 share link never expires and has no password');

  // Over HTTP: admins only.
  assert.equal((await kim('GET', '/api/orgs/current/checkup')).status, 403);
  const r = await ana('GET', '/api/orgs/current/checkup');
  assert.equal(r.status, 200);
  assert.deepEqual(ids(r.body.items), ids(c));
});

test('security checkup: the domain’s sender records (SPF, DKIM, DMARC), when email is on', async () => {
  const orgId = q("SELECT org_id FROM users WHERE username = 'ana@acme.com'").get().org_id;
  q("INSERT OR IGNORE INTO domains (org_id, name, created_at) VALUES (?, 'acme.org', ?)").run(orgId, Date.now() + 1);
  const answers = {
    'acme.com': [{ name: 'SPF', ok: true, found: ['v=spf1 mx ~all'] }, { name: 'DKIM', ok: false, found: [] }, { name: 'DMARC', ok: false, found: [] }],
    'acme.org': [{ name: 'SPF', ok: true }, { name: 'DKIM', ok: true }, { name: 'DMARC', ok: true, found: ['v=DMARC1; p=none; rua=mailto:x@acme.org'] }],
  };
  const c = await checkup(orgId, Date.now(), { mail: true, dns: async (d) => answers[d] });
  const dns = c.filter((x) => /^(dns|dmarc)-/.test(x.id)).map((x) => [x.id, x.status, x.title]);
  assert.deepEqual(dns, [['dns-acme.com', 'warn', 'acme.com: DKIM, DMARC aren’t set up right'], ['dmarc-acme.org', 'tip', 'acme.org: DMARC only reports forged mail']]);
  answers['acme.org'][2].found = ['v=DMARC1; p=quarantine'];
  answers['acme.com'] = answers['acme.org'];
  const c2 = await checkup(orgId, Date.now(), { mail: true, dns: async (d) => answers[d] });
  assert.deepEqual(c2.filter((x) => x.id.startsWith('dns-')).map((x) => x.status), ['ok', 'ok']);
  // A lookup that fails isn't reported as a problem.
  const c3 = await checkup(orgId, Date.now(), { mail: true, dns: async () => { throw new Error('no network'); } });
  assert.equal(c3.filter((x) => x.id.startsWith('dns-')).length, 0);
});

test('weekly notice: admins of a company with warnings are told, at most once a week', async () => {
  const { weeklyCheckupNotice, NOTICE_EVERY_MS } = await import('../src/checkup.js');
  const orgId = q("SELECT org_id FROM users WHERE username = 'ana@acme.com'").get().org_id;
  const anaId = q("SELECT id FROM users WHERE username = 'ana@acme.com'").get().id;
  const notes = () => q("SELECT title, body, link FROM notifications WHERE user_id = ? AND title LIKE 'Security checkup:%' ORDER BY rowid").all(anaId);
  const t0 = Date.now();
  assert.deepEqual(await weeklyCheckupNotice(t0, { mail: false }), [orgId], 'there is an open phishing report');
  assert.equal(notes().length, 1);
  assert.match(notes()[0].title, /^Security checkup: 1 thing needs attention$/);
  assert.match(notes()[0].body, /phishing report/);
  assert.equal(notes()[0].link, '/admin?tab=checkup');
  assert.deepEqual(await weeklyCheckupNotice(t0 + 864e5, { mail: false }), [], 'not again the next day');
  assert.deepEqual(await weeklyCheckupNotice(t0 + NOTICE_EVERY_MS + 1, { mail: false }), [orgId], 'a week on');
  // Nothing to warn about: no notice.
  q("UPDATE phishing_reports SET handled_at = 1 WHERE org_id = ?").run(orgId);
  assert.deepEqual(await weeklyCheckupNotice(t0 + 3 * NOTICE_EVERY_MS, { mail: false }), []);
});

test('remind people without a recovery email: a notification each, at most daily, admins only', async () => {
  const { remindRecovery } = await import('../src/checkup.js');
  const ana = client(), kim = client();
  // Ana has an authenticator app (from the first test): the code step too.
  const step = (await ana('POST', '/api/auth/login', { username: 'ana@acme.com', password: 'password123' })).body;
  const { codeAt } = await import('../src/totp.js');
  assert.equal((await ana('POST', '/api/auth/login/code', { ticket: step.ticket, code: codeAt('JBSWY3DPEHPK3PXP', Math.floor(Date.now() / 30000)) })).status, 200);
  const orgId = q("SELECT org_id FROM users WHERE username = 'ana@acme.com'").get().org_id;
  q("UPDATE users SET recovery_email = NULL WHERE username = 'kim@acme.com'").run();
  q("UPDATE users SET recovery_email = 'ana.home@example.org' WHERE username = 'ana@acme.com'").run();
  const item = (await checkup(orgId, Date.now(), { mail: false })).find((x) => x.id === 'recovery');
  assert.equal(item.remind, 'recovery');
  // Kim can't (and needs two steps first anyway); Ana can.
  await kim('POST', '/api/auth/login', { username: 'kim@acme.com', password: 'password123' });
  assert.notEqual((await kim('POST', '/api/orgs/current/checkup/remind-recovery')).status, 200);
  const r = await ana('POST', '/api/orgs/current/checkup/remind-recovery');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.reminded, 1, 'only Kim: Ana has one, Old is suspended');
  const kimId = q("SELECT id FROM users WHERE username = 'kim@acme.com'").get().id;
  assert.equal(q("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND title = 'Add a recovery email to your account'").get(kimId).n, 1);
  assert.equal((await ana('POST', '/api/orgs/current/checkup/remind-recovery')).status, 429, 'not twice in a day');
  assert.throws(() => remindRecovery(orgId, Date.now() + 3600e3), /less than a day/);
  assert.equal(remindRecovery(orgId, Date.now() + 2 * 864e5), 1, 'a day later, again');
});

test('remind people with just a password to add a second step; an unknown reminder is refused', async () => {
  const { remind } = await import('../src/checkup.js');
  const orgId = q("SELECT org_id FROM users WHERE username = 'ana@acme.com'").get().org_id;
  q('UPDATE orgs SET require_2fa = 0 WHERE id = ?').run(orgId);
  const item = (await checkup(orgId, Date.now(), { mail: false })).find((x) => x.id === 'require-2fa');
  assert.equal(item.remind, 'two-step');
  const kimId = q("SELECT id FROM users WHERE username = 'kim@acme.com'").get().id;
  assert.equal(remind(orgId, 'two-step'), 1, 'Kim (Ana has an app, Old is suspended)');
  assert.equal(q("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND title = 'Protect your account with a second step'").get(kimId).n, 1);
  assert.throws(() => remind(orgId, 'two-step'), /less than a day/);
  assert.throws(() => remind(orgId, 'everything'), /Unknown reminder/);
});

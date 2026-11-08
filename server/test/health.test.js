import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-health-db-')); // a database of its own
const { collectHealth, checkAndNotify, probeMail } = await import('../src/health.js');
const { q } = await import('../src/db.js');

const GB = 1024 ** 3;
const disk = (freeGb, totalGb) => () => ({ bsize: 4096, blocks: (totalGb * GB) / 4096, bavail: (freeGb * GB) / 4096 });
const now = Date.parse('2026-11-08T12:00:00Z');
const backups = (...ageHours) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-health-'));
  ageHours.forEach((h, i) => { const f = path.join(dir, `workspace-2026-11-0${i + 1}.db`); fs.writeFileSync(f, 'x'); fs.utimesSync(f, (now - h * 3600e3) / 1000, (now - h * 3600e3) / 1000); });
  return dir;
};
const byId = (h) => Object.fromEntries(h.checks.map((c) => [c.id, c]));
const base = { now, started: now - 864e5, mail: false };

test('health: disk space, database snapshots', async () => {
  let h = await collectHealth({ ...base, statfs: disk(400, 1000), backupDir: backups(5, 29) });
  assert.equal(h.status, 'ok');
  assert.match(byId(h).disk.detail, /400\.0 GB free of 1000\.0 GB \(40%\)/);
  assert.match(byId(h).backups.detail, /2 kept; the newest is 5 hours old/);
  assert.equal((await collectHealth({ ...base, statfs: disk(100, 1000), backupDir: backups(5) })).status, 'warn', 'under 15% free');
  assert.equal(byId(await collectHealth({ ...base, statfs: disk(0.5, 10), backupDir: backups(5) })).disk.status, 'bad', 'under 1 GB');
  h = await collectHealth({ ...base, statfs: disk(400, 1000), backupDir: backups(50) });
  assert.deepEqual([h.status, byId(h).backups.status], ['bad', 'bad'], 'two days without a snapshot');
  assert.equal(byId(await collectHealth({ ...base, statfs: disk(400, 1000), backupDir: backups(36) })).backups.status, 'warn');
  assert.equal(byId(await collectHealth({ ...base, statfs: disk(400, 1000), backupDir: backups() })).backups.status, 'bad', 'none, long after starting');
  assert.equal(byId(await collectHealth({ ...base, started: now - 600e3, statfs: disk(400, 1000), backupDir: backups() })).backups.status, 'ok', 'none yet, just started');
  assert.ok(h.facts.database_bytes >= 0 && h.facts.people >= 0 && h.facts.version);
});

test('health: the mail server and its certificate', async () => {
  const mail = async (probe) => byId(await collectHealth({ ...base, statfs: disk(400, 1000), backupDir: backups(1), mail: true, probe }));
  let c = await mail(async () => ({ ok: false, error: 'ECONNREFUSED' }));
  assert.deepEqual([c.mail.status, c.mail.detail, c.certificate], ['bad', 'Not reachable (ECONNREFUSED)', undefined]);
  c = await mail(async () => ({ ok: true, valid_to: now + 60 * 864e5, self_signed: false }));
  assert.deepEqual([c.mail.status, c.certificate.status], ['ok', 'ok']);
  assert.match(c.certificate.detail, /Valid for 60 more days/);
  assert.equal((await mail(async () => ({ ok: true, valid_to: now + 10 * 864e5 }))).certificate.status, 'warn');
  assert.equal((await mail(async () => ({ ok: true, valid_to: now + 3 * 864e5 }))).certificate.status, 'bad');
  assert.match((await mail(async () => ({ ok: true, valid_to: now - 2 * 864e5 }))).certificate.detail, /Expired 2 days ago/);
  assert.match((await mail(async () => ({ ok: true, valid_to: now + 300 * 864e5, self_signed: true }))).certificate.detail, /Self-signed/);
  const stuck = { at: now, done: 0, messages: [{ id: 'AAA111', queue: 'deferred', arrived: now - 30 * 3600e3, recipients: [{ address: 'a@b.test', reason: 'Connection timed out' }] }] };
  const h = byId(await collectHealth({ ...base, statfs: disk(400, 1000), backupDir: backups(1), mail: true, probe: async () => ({ ok: true, valid_to: now + 60 * 864e5 }), queue: () => stuck }));
  assert.deepEqual([h.queue.label, h.queue.status], ['Outgoing mail', 'bad']);
  assert.equal(byId(await collectHealth({ ...base, statfs: disk(400, 1000), backupDir: backups(1), mail: true, probe: async () => ({ ok: true }), queue: () => null })).queue, undefined, 'not reported: no check');
});

test('health: probing a real TLS server reads its certificate; a closed port is reported', async () => {
  assert.equal((await probeMail({ host: '127.0.0.1', port: 1, timeout: 2000 })).ok, false);
  // A tiny TLS server with a throwaway self-signed certificate, if openssl is around.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-tls-'));
  const { execFileSync } = await import('node:child_process');
  try { execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30', '-subj', '/CN=mail.test', '-keyout', `${dir}/k.pem`, '-out', `${dir}/c.pem`], { stdio: 'ignore' }); } catch { return; }
  const server = tls.createServer({ key: fs.readFileSync(`${dir}/k.pem`), cert: fs.readFileSync(`${dir}/c.pem`) }, (s) => s.end());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const p = await probeMail({ host: '127.0.0.1', port: server.address().port });
    assert.equal(p.ok, true);
    assert.equal(p.self_signed, true);
    assert.ok(Math.abs(p.valid_to - (Date.now() + 30 * 864e5)) < 2 * 864e5);
  } finally { server.close(); }
});

test('health: platform owners are told about problems once a day each, again if they come back', async () => {
  const id = `hsuper${Date.now()}`;
  q("INSERT INTO orgs (id, name, created_at) VALUES ('horg', 'H Org', 0) ON CONFLICT DO NOTHING").run();
  q("INSERT INTO users (id, org_id, username, name, password_hash, is_super, created_at) VALUES (?, 'horg', ?, 'Hal Super', 'x', 1, 0)").run(id, `${id}@h.test`);
  const count = () => q("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND kind = 'system'").get(id).n;
  const bad = { ...base, statfs: disk(0.5, 10), backupDir: backups(1) };
  await checkAndNotify(bad);
  assert.equal(count(), 1);
  assert.match(q("SELECT title FROM notifications WHERE user_id = ? AND kind = 'system'").get(id).title, /Needs attention: Disk space/);
  await checkAndNotify({ ...bad, now: now + 3600e3 });
  assert.equal(count(), 1, 'not again within the day');
  await checkAndNotify({ ...base, now: now + 2 * 3600e3, statfs: disk(400, 1000), backupDir: backups(1) }); // fixed
  await checkAndNotify({ ...bad, now: now + 3 * 3600e3 }); // back again
  assert.equal(count(), 2);
});

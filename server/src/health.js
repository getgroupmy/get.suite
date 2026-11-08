// System health, for the platform owner: is everything all right on this NAS? Disk space, the
// daily database snapshots, the mail server and its certificate, and how big things are. Checked
// every hour too: the platform owners get a notification (once a day per problem) when something
// needs attention.
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { q, DATA_DIR } from './db.js';
import { BACKUP_DIR } from './backup.js';
import { mailEnabled } from './mail/config.js';
import { IMAP_SETTINGS } from './mail/imap.js';
import { notify } from './notifications.js';

const GB = 1024 ** 3;
const STARTED = Date.now();
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; } catch { return null; } })();

/** The mail server's TLS certificate: { ok, valid_to, self_signed } or { ok: false, error }. */
export function probeMail({ host = IMAP_SETTINGS.host, port = IMAP_SETTINGS.port, timeout = 5000 } = {}) {
  return new Promise((resolve) => {
    const done = (v) => { try { sock.destroy(); } catch { /* gone */ } resolve(v); };
    const sock = tls.connect({ host, port, servername: host, rejectUnauthorized: false, timeout }, () => {
      const c = sock.getPeerCertificate();
      done({ ok: true, valid_to: c?.valid_to ? Date.parse(c.valid_to) : null, self_signed: !!c && JSON.stringify(c.subject) === JSON.stringify(c.issuer) });
    });
    sock.on('timeout', () => done({ ok: false, error: 'No answer' }));
    sock.on('error', (e) => done({ ok: false, error: e.code || e.message }));
  });
}

const dirSize = (dir) => { try { return fs.readdirSync(dir).reduce((n, f) => { try { return n + fs.statSync(path.join(dir, f)).size; } catch { return n; } }, 0); } catch { return 0; } };

/**
 * The checks ({ id, label, status: ok | warn | bad, detail }) and facts. Everything outside is
 * passed in, so tests can try each case: statfs(dir) → { bsize, blocks, bavail }, the backups
 * folder, probe() → as probeMail, and now.
 */
export async function collectHealth({ statfs = (d) => fs.statfsSync(d), dataDir = DATA_DIR, backupDir = BACKUP_DIR, mail = mailEnabled(), probe = probeMail, now = Date.now(), started = STARTED } = {}) {
  const checks = [];
  const add = (id, label, status, detail) => checks.push({ id, label, status, detail });

  // Disk: where the data lives.
  try {
    const s = statfs(dataDir);
    const free = s.bavail * s.bsize, total = s.blocks * s.bsize, pct = total ? (free / total) * 100 : 0;
    const text = `${(free / GB).toFixed(1)} GB free of ${(total / GB).toFixed(1)} GB (${Math.round(pct)}%)`;
    add('disk', 'Disk space', free < GB || pct < 5 ? 'bad' : pct < 15 ? 'warn' : 'ok', text);
  } catch (e) { add('disk', 'Disk space', 'warn', `Couldn't be read (${e.code || e.message})`); }

  // Database snapshots: one a day.
  let snaps = [];
  try { snaps = fs.readdirSync(backupDir).filter((f) => /^workspace-\d{4}-\d{2}-\d{2}\.db$/.test(f)).map((f) => ({ f, at: fs.statSync(path.join(backupDir, f)).mtimeMs })).sort((a, b) => b.at - a.at); } catch { /* none yet */ }
  if (!snaps.length) add('backups', 'Database snapshots', now - started > 2 * 3600e3 ? 'bad' : 'ok', now - started > 2 * 3600e3 ? 'None written yet' : 'The first is written shortly after starting');
  else {
    const age = (now - snaps[0].at) / 3600e3;
    add('backups', 'Database snapshots', age > 48 ? 'bad' : age > 30 ? 'warn' : 'ok', `${snaps.length} kept; the newest is ${age < 1 ? 'less than an hour' : `${Math.round(age)} hours`} old`);
  }

  // Mail server and its certificate.
  if (mail) {
    const m = await probe();
    if (!m.ok) add('mail', 'Mail server', 'bad', `Not reachable (${m.error})`);
    else {
      add('mail', 'Mail server', 'ok', 'Reachable');
      const days = m.valid_to ? Math.floor((m.valid_to - now) / 864e5) : null;
      if (days === null) add('certificate', 'Mail certificate', 'warn', 'Its expiry date couldn’t be read');
      else if (days < 0) add('certificate', 'Mail certificate', 'bad', `Expired ${-days} day${days === -1 ? '' : 's'} ago: phones and mail apps will refuse to connect`);
      else add('certificate', 'Mail certificate', m.self_signed ? 'warn' : days < 7 ? 'bad' : days < 21 ? 'warn' : 'ok',
        `${m.self_signed ? 'Self-signed (phones and mail apps will warn): use a real certificate, such as DSM’s Let’s Encrypt one. ' : ''}Valid for ${days} more day${days === 1 ? '' : 's'}`);
    }
  }

  const dbFile = path.join(dataDir, 'workspace.db');
  const size = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
  const facts = {
    version: VERSION, node: process.version, up_since: started,
    database_bytes: size(dbFile) + size(`${dbFile}-wal`),
    files_bytes: q('SELECT COALESCE(SUM(size), 0) AS n FROM files WHERE storage IS NOT NULL').get().n,
    backups_bytes: dirSize(backupDir),
    companies: q('SELECT COUNT(*) AS n FROM orgs').get().n,
    people: q('SELECT COUNT(*) AS n FROM users WHERE disabled = 0').get().n,
  };
  const worst = checks.some((c) => c.status === 'bad') ? 'bad' : checks.some((c) => c.status === 'warn') ? 'warn' : 'ok';
  return { status: worst, checked_at: now, checks, facts };
}

const told = new Map(); // check id → when the owners were last told about it
/** Check, and tell the platform owners about problems (each at most once a day). */
export async function checkAndNotify(opts = {}) {
  const h = await collectHealth(opts);
  const owners = q('SELECT id FROM users WHERE is_super = 1 AND disabled = 0').all().map((u) => u.id);
  for (const c of h.checks.filter((x) => x.status !== 'ok')) {
    if (told.has(c.id) && h.checked_at - told.get(c.id) < 864e5) continue;
    told.set(c.id, h.checked_at);
    notify(owners, { kind: 'system', title: `${c.status === 'bad' ? 'Needs attention' : 'Check soon'}: ${c.label}`, body: c.detail, link: '/admin?tab=system', actor: null });
  }
  for (const c of h.checks.filter((x) => x.status === 'ok')) told.delete(c.id); // fixed: tell again if it comes back
  return h;
}

export function scheduleHealthChecks() {
  setInterval(() => checkAndNotify().catch((e) => console.error('[health]', e.message)), 3600e3).unref();
}

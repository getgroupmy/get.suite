// System health, for the platform owner: is everything all right on this NAS? Disk space, the
// daily database snapshots, the mail server and its certificate, and how big things are. Checked
// every hour too: the platform owners get a notification (once a day per problem) when something
// needs attention.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { q, DATA_DIR } from './db.js';
import { BACKUP_DIR } from './backup.js';
import { mailEnabled } from './mail/config.js';
import { IMAP_SETTINGS } from './mail/imap.js';
import { notify } from './notifications.js';
import { readQueue, queueCheck } from './mail/queue.js';

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
export async function collectHealth({ statfs = (d) => fs.statfsSync(d), dataDir = DATA_DIR, backupDir = BACKUP_DIR, mail = mailEnabled(), probe = probeMail, queue = readQueue, blocklists = defaultBlocklists, mailDns = defaultMailDns, memory = containerMemory, machine = thisMachine, connection = null, now = Date.now(), started = STARTED } = {}) {
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

  // Outgoing mail stuck in the queue (when the mail server reports it).
  const qc = mail ? queueCheck(queue(), now) : null;
  if (qc) add('queue', 'Outgoing mail', qc.status, qc.detail);

  // Mail DNS: each domain's records (MX, SPF, DKIM, DMARC…) and the mail host's reverse DNS, as Admin → Email checks them.
  const dc = dnsCheck(mail ? await mailDns().catch(() => null) : null);
  if (dc) add('maildns', 'Mail DNS records', dc.status, dc.detail);

  // The mail server's address on spam blocklists (looked up every few hours): mail from a listed one is refused or goes to Junk.
  const bl = mail ? await blocklists().catch(() => null) : null;
  const blc = blocklistCheck(bl);
  if (blc) add('blocklists', 'Spam blocklists', blc.status, blc.detail);

  // How this page was reached (when asked from a browser): over HTTPS, or plain HTTP from the internet.
  const cc = connectionCheck(connection);
  if (cc) add('https', 'HTTPS', cc.status, cc.detail);

  // Memory: how close the app is to its container's limit (mem_limit in the compose file), when it has one.
  const mem = memory();
  const mc = memoryCheck(mem);
  if (mc) add('memory', 'Memory', mc.status, mc.detail);

  const dbFile = path.join(dataDir, 'workspace.db');
  const size = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
  const facts = {
    version: VERSION, node: process.version, up_since: started,
    // What it runs on: arm64 on an Apple Silicon Mac (or a Raspberry Pi), x64 on most NAS and PCs.
    ...machine(), ...(mem && { memory_used: mem.used, ...(mem.limit && { memory_limit: mem.limit }) }),
    database_bytes: size(dbFile) + size(`${dbFile}-wal`),
    files_bytes: q('SELECT COALESCE(SUM(size), 0) AS n FROM files WHERE storage IS NOT NULL').get().n,
    backups_bytes: dirSize(backupDir),
    companies: q('SELECT COUNT(*) AS n FROM orgs').get().n,
    people: q('SELECT COUNT(*) AS n FROM users WHERE disabled = 0').get().n,
  };
  const worst = checks.some((c) => c.status === 'bad') ? 'bad' : checks.some((c) => c.status === 'warn') ? 'warn' : 'ok';
  return { status: worst, checked_at: now, checks, facts };
}

const MB = 1024 ** 2;
/** Whether an address is this machine or a private network's (home or office, Docker's own). */
export function isLocalAddress(ip = '') {
  const a = String(ip).replace(/^::ffff:/, '');
  return a === '::1' || /^127\./.test(a) || /^10\./.test(a) || /^192\.168\./.test(a) || /^172\.(1[6-9]|2\d|3[01])\./.test(a)
    || /^169\.254\./.test(a) || /^f[cd][0-9a-f]{2}:/i.test(a) || /^fe80:/i.test(a);
}
/**
 * The check for how a page was reached ({ secure, ip, proxied } from the request), or null without one. Over HTTPS
 * is fine; plain HTTP is fine from this machine or your own network, and needs attention from the internet.
 */
export function connectionCheck(c) {
  if (!c) return null;
  if (c.secure) return { status: 'ok', detail: `Over HTTPS${c.proxied ? ', through a proxy' : ''}` };
  if (isLocalAddress(c.ip)) return { status: 'ok', detail: 'Over plain HTTP from your own network: fine there; from the internet, use HTTPS (a proxy such as Caddy or the NAS reverse proxy)' };
  return { status: 'bad', detail: `Over plain HTTP from the internet (${String(c.ip).replace(/^::ffff:/, '')}): passwords and everything else travel unencrypted. Put HTTPS in front (README: Publish it securely, or Run it on a Mac → From the internet)${c.proxied ? '; if a proxy already does HTTPS, it must say so (X-Forwarded-Proto: https)' : ''}.` };
}
/** The machine: { arch, os, cpus, machine_memory }. */
export function thisMachine() {
  return { arch: process.arch, os: `${os.type()} ${os.release()}`, cpus: os.cpus().length, machine_memory: os.totalmem() };
}
/**
 * The container's memory in use and its limit, from its control group (cgroup v2, or v1 on older systems), or null
 * when there is none to read (not in a container). "In use" leaves out file cache the system can drop, as docker stats
 * counts it; limit is null when the container has none.
 */
export function containerMemory(read = (f) => fs.readFileSync(f, 'utf8')) {
  const num = (f) => { try { const t = read(f).trim(); return /^\d+$/.test(t) ? Number(t) : null; } catch { return undefined; } };
  const cache = (f, key) => { try { const m = read(f).match(new RegExp(`^${key} (\\d+)$`, 'm')); return m ? Number(m[1]) : 0; } catch { return 0; } };
  let used = num('/sys/fs/cgroup/memory.current');
  if (used !== undefined && used !== null) {
    const limit = num('/sys/fs/cgroup/memory.max'); // "max" (no limit) reads as null
    return { used: Math.max(0, used - cache('/sys/fs/cgroup/memory.stat', 'inactive_file')), limit: limit ?? null };
  }
  used = num('/sys/fs/cgroup/memory/memory.usage_in_bytes');
  if (used === undefined || used === null) return null;
  const limit = num('/sys/fs/cgroup/memory/memory.limit_in_bytes');
  return { used: Math.max(0, used - cache('/sys/fs/cgroup/memory/memory.stat', 'total_inactive_file')), limit: limit && limit < 2 ** 60 ? limit : null }; // v1's "no limit" is a huge number
}
/** The health check for memory ({ used, limit } as containerMemory gives it), or null without a limit to compare with. */
export function memoryCheck(m) {
  if (!m?.limit) return null;
  const pct = Math.round((m.used / m.limit) * 100);
  const text = `${Math.round(m.used / MB)} MB of the container's ${Math.round(m.limit / MB)} MB in use (${pct}%)`;
  if (pct >= 95) return { status: 'bad', detail: `${text}: it may be stopped and restarted for running out. Raise mem_limit in the compose file.` };
  if (pct >= 85) return { status: 'warn', detail: `${text}: close to its limit. Consider raising mem_limit in the compose file.` };
  return { status: 'ok', detail: text };
}

/** The health check for blocklist results (as mailBlocklists gives them), or null when there's nothing to say. */
export function blocklistCheck(bl) {
  const answered = (bl?.results || []).filter((r) => r.lists.some((l) => l.status !== 'unknown'));
  if (!answered.length) return null; // no public address, or no list answered: nothing to go on
  const listed = answered.flatMap((r) => r.lists.filter((l) => l.status === 'listed').map((l) => `${r.ip} on ${l.name}`));
  return listed.length
    ? { status: 'bad', detail: `${listed.join(', ')}: mail from it may be refused or go to Junk. Admin → Email → Check blocklists has where to ask to be removed.` }
    : { status: 'ok', detail: `Not on any list that answered (${answered.map((r) => r.ip).join(', ')})` };
}
/** The health check for mail DNS results (as mailDnsHealth gives them), or null when there's nothing to check. */
export function dnsCheck(d) {
  if (!d || (!d.domains && !d.ptr)) return null;
  const parts = d.problems.map((p) => `${p.domain}: ${p.records.join(', ')} not right`);
  if (d.ptr && !d.ptr.ok) parts.push(d.ptr.note);
  if (!parts.length) return { status: 'ok', detail: `${d.domains} domain${d.domains === 1 ? '' : 's'}: records as they should be${d.ptr ? ', and reverse DNS matches' : ''}` };
  // Mail isn't delivered without MX, and is widely refused without SPF, DKIM or matching reverse DNS.
  const serious = (d.ptr && !d.ptr.ok) || d.problems.some((p) => p.records.some((r) => ['MX', 'SPF', 'DKIM'].includes(r)));
  return { status: serious ? 'bad' : 'warn', detail: `${parts.join('; ')}. Admin → Email → Check DNS shows what to set.` };
}
const defaultMailDns = async () => (await import('./routes/mailAdmin.js')).mailDnsHealth();
const defaultBlocklists = async () => (await import('./routes/mailAdmin.js')).mailBlocklists();

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

// Importing mail from another account (Gmail, Outlook.com, an old mail server…) over IMAP: every
// folder is copied into the person's mailbox, with its read/starred flags and dates. Folders the
// other server marks as Sent, Drafts, Archive go into ours; Junk and Trash are left behind; others
// keep their names. Messages already here (the same Message-ID in that folder) are skipped, so an
// import can be run again. The password is used for this import only and never stored.
import { ImapFlow } from 'imapflow';
import dns from 'node:dns/promises';
import net from 'node:net';
import { q } from '../db.js';
import { uid as newId, now, bad, HttpError } from '../util.js';
import { sendTo } from '../hub.js';
import { ownConnection } from './imap.js';
import { isPrivateAddress } from './unsubscribe.js';

q(`CREATE TABLE IF NOT EXISTS mail_imports (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  host TEXT NOT NULL,
  username TEXT NOT NULL,
  status TEXT NOT NULL,          -- running | done | failed
  total INTEGER NOT NULL DEFAULT 0,
  copied INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  folder TEXT,
  error TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
)`).run();

const PORTS = [993, 143];
const LEAVE = new Set(['\\Junk', '\\Trash', '\\All', '\\Flagged', '\\Important']); // Gmail's All Mail and the like hold copies
const MAP = { '\\Sent': '\\Sent', '\\Drafts': '\\Drafts', '\\Archive': '\\Archive' };
const running = new Map(); // userId → import id

export const importOf = (userId) => q('SELECT id, host, username, status, total, copied, skipped, folder, error, started_at, finished_at FROM mail_imports WHERE user_id = ? ORDER BY started_at DESC LIMIT 1').get(userId) || null;

/** Check the other server's address: a name or address, an IMAP port, and (unless allowed) not on this network. */
async function checkHost(host, port) {
  if (!/^[a-z0-9.-]{1,253}$/i.test(host) && !net.isIP(host)) throw bad('Give the mail server’s name, like imap.gmail.com');
  if (!PORTS.includes(port)) throw bad('Use port 993 (secure) or 143');
  if (process.env.MAIL_IMPORT_ALLOW_PRIVATE === '1') return;
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addrs.length) throw bad('That mail server can’t be found');
  if (addrs.some(isPrivateAddress)) throw bad('That address is on a private network; only mail servers on the internet can be imported from');
}

/** Start importing for this user: checks the details (signing in once), then copies in the background. */
export async function startImport(user, { host, port = 993, username, password }) {
  host = String(host || '').trim().toLowerCase();
  port = Number(port);
  username = String(username || '').trim();
  if (!host || !username || !password) throw bad('Give the server, your user name there and your password');
  if (running.has(user.id)) throw bad('An import is already running');
  await checkHost(host, port);
  const remote = new ImapFlow({ host, port, secure: port === 993, auth: { user: username, pass: String(password) }, logger: false, emitLogs: false, disableAutoIdle: true, tls: { rejectUnauthorized: process.env.MAIL_IMPORT_ALLOW_PRIVATE !== '1' } });
  remote.on('error', () => {});
  try { await remote.connect(); } catch (e) {
    throw new HttpError(400, e.authenticationFailed ? 'The other server didn’t accept that user name and password (Gmail and others need an app password)' : `Couldn’t connect to ${host}: ${e.message}`);
  }
  const id = newId();
  q('INSERT INTO mail_imports (id, user_id, host, username, status, started_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, user.id, host, username, 'running', now());
  running.set(user.id, id);
  run(user, id, remote).catch(() => {}).finally(() => running.delete(user.id));
  return importOf(user.id);
}

async function run(user, id, remote) {
  const update = (set) => {
    const keys = Object.keys(set);
    q(`UPDATE mail_imports SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => set[k]), id);
    sendTo([user.id], { type: 'mail-import', import: importOf(user.id) });
  };
  let local;
  try {
    local = await ownConnection(user);
    const ours = await local.list();
    const special = (use) => ours.find((b) => b.specialUse === use)?.path;
    const theirs = (await remote.list()).filter((b) => !b.flags?.has('\\Noselect') && !LEAVE.has(b.specialUse));
    // How many, first (for progress).
    let total = 0;
    for (const b of theirs) total += (await remote.status(b.path, { messages: true })).messages || 0;
    update({ total });
    let copied = 0, skipped = 0;
    for (const b of theirs) {
      const target = b.path.toUpperCase() === 'INBOX' ? 'INBOX' : (MAP[b.specialUse] && special(MAP[b.specialUse])) || b.path.replace(/^INBOX[./]/i, '').replace(/^\[Gmail\][./]/, '');
      if (!ours.some((x) => x.path === target)) { await local.mailboxCreate(target).catch(() => {}); ours.push({ path: target }); }
      update({ folder: target });
      // What's already here, by Message-ID.
      const have = new Set();
      const lock = await local.getMailboxLock(target);
      try {
        if (local.mailbox.exists) for await (const m of local.fetch('1:*', { envelope: true })) if (m.envelope?.messageId) have.add(m.envelope.messageId);
      } finally { lock.release(); }
      const rlock = await remote.getMailboxLock(b.path, { readOnly: true });
      try {
        if (!remote.mailbox.exists) continue;
        // One at a time, so a large mailbox never has to fit in memory.
        const seqs = [];
        for await (const m of remote.fetch('1:*', { uid: true, envelope: true })) seqs.push({ uid: m.uid, messageId: m.envelope?.messageId });
        for (const s of seqs) {
          if (s.messageId && have.has(s.messageId)) { skipped++; continue; }
          const m = await remote.fetchOne(String(s.uid), { source: true, flags: true, internalDate: true }, { uid: true });
          if (!m?.source) { skipped++; continue; }
          await local.append(target, m.source, [...(m.flags || [])].filter((f) => ['\\Seen', '\\Flagged', '\\Answered', '\\Draft'].includes(f)), m.internalDate);
          if (s.messageId) have.add(s.messageId);
          copied++;
          if (copied % 20 === 0) update({ copied, skipped });
        }
      } finally { rlock.release(); }
      update({ copied, skipped });
    }
    update({ status: 'done', folder: null, finished_at: now() });
  } catch (e) {
    update({ status: 'failed', error: String(e.message || e).slice(0, 300), finished_at: now() });
  } finally {
    try { await remote.logout(); } catch {}
    try { await local?.logout(); } catch {}
  }
}

// Importing mail from another account (Gmail, Outlook.com, an old mail server…) over IMAP: every
// folder is copied into the person's mailbox, with its read/starred flags and dates. Folders the
// other server marks as Sent, Drafts, Archive go into ours; Junk and Trash are left behind; others
// keep their names. Messages already here (the same Message-ID in that folder) are skipped, so an
// import can be run again. The password is used for this import only and never stored.
import { ImapFlow } from 'imapflow';
import dns from 'node:dns/promises';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { q, FILES_DIR } from '../db.js';
import { roleFor, atLeast } from '../access.js';
import { readMbox, countMbox, flagsOf } from './mbox.js';
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

// ---- importing an .mbox file from Drive (Gmail's Takeout, Thunderbird, Apple Mail, Workspace's own
// download): its messages go into a folder named after the file (Inbox, Sent, Drafts and Archive go
// into those), with their dates, read and starred as the file says. Messages already in that folder
// (the same Message-ID) are skipped, so it can be run again.
const SPECIAL_NAMES = { inbox: 'INBOX', sent: '\\Sent', 'sent mail': '\\Sent', 'sent items': '\\Sent', drafts: '\\Drafts', archive: '\\Archive' };

/** The folder an .mbox file goes into, from its name ("Acme.mbox" → "Acme"; "Inbox.mbox" → the Inbox). */
export function folderForMbox(name, ours = []) {
  const base = String(name || '').replace(/\.mbox$/i, '').replace(/[\r\n\t]/g, ' ').replace(/[/\\]/g, '-').trim().slice(0, 80) || 'Imported';
  const special = SPECIAL_NAMES[base.toLowerCase()];
  if (special === 'INBOX') return 'INBOX';
  if (special) return ours.find((b) => b.specialUse === special)?.path || base;
  return base;
}

/**
 * file_id: one .mbox from Drive; or file_ids with folders: several in turn, as one import (Bring in your data), each into
 * the folder its path names ({ id, folder: "Projects/Acme" }: a folder inside a folder).
 */
export async function startMboxImport(user, { file_id: fileId, files: many }) {
  if (running.has(user.id)) throw bad('An import is already running');
  const list = Array.isArray(many) ? many.slice(0, 500) : [{ id: fileId }];
  const found = list.map((x) => {
    const f = q("SELECT * FROM files WHERE id = ? AND kind = 'file' AND trashed = 0").get(String(x?.id || ''));
    if (!f || !atLeast(roleFor(f.id, user.id) || '', 'viewer')) throw new HttpError(404, 'File not found');
    if (!/\.mbox$/i.test(f.name) && !/mbox/i.test(f.mime || '')) throw bad('Choose an .mbox file (Gmail’s Takeout, Thunderbird or Apple Mail give one)');
    return { file: path.join(FILES_DIR, f.storage), name: f.name, folder: typeof x.folder === 'string' ? x.folder : null };
  });
  if (!found.length) throw bad('Choose an .mbox file');
  const id = newId();
  const label = found.length === 1 ? found[0].name : `${found.length} mail folders`;
  q('INSERT INTO mail_imports (id, user_id, host, username, status, started_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, user.id, 'file', label, 'running', now());
  running.set(user.id, id);
  runMbox(user, id, found).catch(() => {}).finally(() => running.delete(user.id));
  return importOf(user.id);
}

async function runMbox(user, id, files) {
  const update = (set) => {
    const keys = Object.keys(set);
    q(`UPDATE mail_imports SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => set[k]), id);
    sendTo([user.id], { type: 'mail-import', import: importOf(user.id) });
  };
  let local;
  try {
    let total = 0;
    for (const f of files) total += await countMbox(fs.createReadStream(f.file));
    update({ total });
    local = await ownConnection(user);
    let copied = 0, skipped = 0;
    for (const { file, name, folder } of files) {
      const ours = await local.list();
      const delim = ours.find((x) => x.delimiter)?.delimiter || '/';
      // "Projects/Acme" → a folder inside a folder (in the mail server's own way of writing it); Inbox, Sent… as their own.
      const parts = folder ? folder.split('/').map((p) => p.replace(/[\r\n\t]/g, ' ').trim().slice(0, 80)).filter(Boolean) : [];
      const target = parts.length > 1 ? parts.join(delim) : folderForMbox(parts.length ? `${parts[0]}.mbox` : name, ours);
      for (let i = 1; i <= target.split(delim).length; i++) {
        const p = target.split(delim).slice(0, i).join(delim);
        if (p !== 'INBOX' && !ours.some((x) => x.path === p)) await local.mailboxCreate(p).catch(() => {});
      }
      update({ folder: target });
      const have = new Set();
      const lock = await local.getMailboxLock(target);
      try {
        if (local.mailbox.exists) for await (const m of local.fetch('1:*', { envelope: true })) if (m.envelope?.messageId) have.add(m.envelope.messageId);
      } finally { lock.release(); }
      for await (const m of readMbox(fs.createReadStream(file, { highWaterMark: 256 * 1024 }))) {
        const messageId = /^Message-ID:[ \t]*(<[^>\r\n]+>)/im.exec(m.source.subarray(0, 64 * 1024).toString('latin1').split(/\r\n\r\n/)[0])?.[1];
        if (messageId && have.has(messageId)) { skipped++; continue; }
        try { await local.append(target, m.source, flagsOf(m.source), m.date || undefined); }
        catch { skipped++; continue; } // one the mail server won't take (too big, broken): the rest still go in
        if (messageId) have.add(messageId);
        copied++;
        if (copied % 20 === 0) update({ copied, skipped });
      }
    }
    update({ copied, skipped, status: 'done', folder: null, finished_at: now() });
  } catch (e) {
    update({ status: 'failed', error: String(e.message || e).slice(0, 300), finished_at: now() });
  } finally {
    try { await local?.logout(); } catch {}
  }
}

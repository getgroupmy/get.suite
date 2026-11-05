// Webmail connections: the app opens each user's mailbox as "user*webmail" (Dovecot
// master user), so users' passwords are never stored. One pooled IMAP connection per user.
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { HttpError } from '../util.js';
import { webmailSecret } from './config.js';

const IMAP = { host: process.env.MAIL_IMAP_HOST || 'mail', port: Number(process.env.MAIL_IMAP_PORT || 993) };
const SMTP = { host: process.env.MAIL_SMTP_HOST || IMAP.host, port: Number(process.env.MAIL_SMTP_PORT || 465) };
// Container-to-container traffic on the private Docker network; the mail server's
// certificate is issued for its public name, so verification is off by default.
const TLS = { rejectUnauthorized: process.env.MAIL_TLS_VERIFY === 'true' };
const IDLE_MS = 5 * 60e3;
export const IMAP_SETTINGS = { ...IMAP, secure: true, tls: TLS };

const pool = new Map(); // userId -> { client, lastUsed, ready }

function unavailable(e) {
  if (e instanceof HttpError) return e;
  // A brand-new account is unknown to the mail server for a few seconds, until it reloads its tables.
  const msg = e?.authenticationFailed ? 'Your mailbox is being set up. Try again in a few seconds.' : 'The mail server is not reachable';
  const err = new HttpError(503, msg);
  err.cause = e;
  return err;
}

export async function imapFor(user) {
  const entry = pool.get(user.id);
  if (entry) {
    entry.lastUsed = Date.now();
    if (entry.ready) {
      // Another request is already connecting for this user: share its outcome.
      try { await entry.ready; } catch (e) { throw unavailable(e); }
    }
    if (entry.client.usable) return entry.client;
    if (pool.get(user.id) === entry) pool.delete(user.id);
  }
  const client = new ImapFlow({
    host: IMAP.host, port: IMAP.port, secure: true, tls: TLS,
    auth: { user: `${user.username}*webmail`, pass: webmailSecret() },
    logger: false, emitLogs: false, disableAutoIdle: true,
  });
  client.on('error', () => {});
  client.on('close', () => { if (pool.get(user.id)?.client === client) pool.delete(user.id); });
  const ready = client.connect();
  const e = { client, lastUsed: Date.now(), ready };
  pool.set(user.id, e);
  try { await ready; } catch (err) { if (pool.get(user.id) === e) pool.delete(user.id); throw unavailable(err); }
  e.ready = null;
  return client;
}

const OP_TIMEOUT_MS = Number(process.env.MAIL_OP_TIMEOUT_MS || 45000);

function drop(user, client) {
  if (pool.get(user.id)?.client === client) pool.delete(user.id);
  try { client.close(); } catch {}
}

/**
 * Run fn(client) on this user's pooled connection with a time limit. If the connection
 * died underneath us (e.g. the mail server restarted), reconnect and try once more.
 */
export async function withClient(user, fn, { retry = true } = {}) {
  const client = await imapFor(user);
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new HttpError(504, 'The mail server took too long to answer. Try again.'), { timedOut: true })), OP_TIMEOUT_MS);
  });
  try {
    return await Promise.race([fn(client), timeout]);
  } catch (e) {
    if (e.timedOut) { drop(user, client); throw e; }
    if (retry && !client.usable && !(e instanceof HttpError)) {
      drop(user, client);
      return withClient(user, fn, { retry: false });
    }
    throw e instanceof HttpError ? e : unavailable(e);
  } finally {
    clearTimeout(timer);
  }
}

/** Run fn with the folder selected and exclusively locked on this user's connection. */
export function withFolder(user, folder, fn) {
  return withClient(user, async (client) => {
    let lock;
    const wasSelected = client.mailbox && client.mailbox.path === folder;
    try { lock = await client.getMailboxLock(folder); }
    catch (e) { throw e.responseStatus === 'NO' ? new HttpError(404, 'Folder not found') : e; }
    try {
      // A pooled connection keeps the folder selected; the server only reports new
      // messages in reply to a command, so ask before reading the message count.
      if (wasSelected) await client.noop();
      return await fn(client);
    } finally { lock.release(); }
  });
}

/** Drop someone's pooled connection (e.g. after their address changed); the next request reconnects. */
export function forgetConnection(userId) {
  const entry = pool.get(userId);
  if (!entry) return;
  pool.delete(userId);
  try { entry.client.close(); } catch {}
}

export function closeAll() {
  for (const { client } of pool.values()) client.logout().catch(() => {});
  pool.clear();
}

setInterval(() => {
  const cutoff = Date.now() - IDLE_MS;
  for (const [id, e] of pool) if (e.lastUsed < cutoff && !e.ready) { pool.delete(id); e.client.logout().catch(() => {}); }
}, 60e3).unref();

export function smtpFor(user) {
  return nodemailer.createTransport({
    host: SMTP.host, port: SMTP.port, secure: true, tls: TLS,
    auth: { user: `${user.username}*webmail`, pass: webmailSecret() },
  });
}

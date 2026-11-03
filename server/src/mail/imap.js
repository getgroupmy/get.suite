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

/** Run fn with the folder selected and exclusively locked on this user's connection. */
export async function withFolder(user, folder, fn) {
  const client = await imapFor(user);
  let lock;
  const wasSelected = client.mailbox && client.mailbox.path === folder;
  try { lock = await client.getMailboxLock(folder); }
  catch (e) { throw e.responseStatus === 'NO' ? new HttpError(404, 'Folder not found') : unavailable(e); }
  // A pooled connection keeps the folder selected; the server only reports new
  // messages in reply to a command, so ask before reading the message count.
  if (wasSelected) await client.noop().catch(() => {});
  try { return await fn(client); } finally { lock.release(); }
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

// Two-step verification for web sign-in: an authenticator-app code (TOTP) or a one-time recovery
// code after the password. Mail apps (IMAP/SMTP) keep using the password; sign-in protection
// covers them.
import crypto from 'node:crypto';
import { q } from './db.js';
import { now, bad } from './util.js';
import { newSecret, verifyCode, newRecoveryCodes, hashRecovery } from './totp.js';

// (Table two_factor is created in db.js.)

const row = (userId) => q('SELECT * FROM two_factor WHERE user_id = ?').get(userId);

export function status(userId) {
  const r = row(userId);
  return r?.enabled ? { enabled: true, recoveryLeft: JSON.parse(r.recovery).length, since: r.enabled_at } : { enabled: false };
}
export const isEnabled = (userId) => !!row(userId)?.enabled;

/** Start (or restart) setup: a new key, not active until confirmed with a code. */
export function startSetup(userId) {
  if (isEnabled(userId)) throw bad('Two-step verification is already on');
  const secret = newSecret();
  q(`INSERT INTO two_factor (user_id, secret, enabled) VALUES (?, ?, 0)
     ON CONFLICT(user_id) DO UPDATE SET secret = excluded.secret, enabled = 0, last_step = -1, recovery = '[]'`).run(userId, secret);
  return secret;
}

/** Confirm setup with the first code from the app; returns the recovery codes (shown once). */
export function confirmSetup(userId, code, at = Date.now()) {
  const r = row(userId);
  if (!r || r.enabled) return null;
  const step = verifyCode(r.secret, code, { now: at });
  if (step === null) return null;
  const codes = newRecoveryCodes();
  q('UPDATE two_factor SET enabled = 1, last_step = ?, recovery = ?, enabled_at = ? WHERE user_id = ?')
    .run(step, JSON.stringify(codes.map(hashRecovery)), now(), userId);
  return codes;
}

/** Check a sign-in code: 'app' or 'recovery' (that recovery code is then used up), or null. */
export function verifySecondStep(userId, code, at = Date.now()) {
  const r = row(userId);
  if (!r?.enabled) return null;
  const step = verifyCode(r.secret, code, { lastStep: r.last_step, now: at });
  if (step !== null) {
    q('UPDATE two_factor SET last_step = ? WHERE user_id = ?').run(step, userId);
    return 'app';
  }
  const hashes = JSON.parse(r.recovery);
  const h = hashRecovery(code);
  const i = hashes.findIndex((x) => crypto.timingSafeEqual(Buffer.from(x), Buffer.from(h)));
  if (String(code || '').replace(/[^a-z0-9]/gi, '').length >= 8 && i >= 0) {
    hashes.splice(i, 1);
    q('UPDATE two_factor SET recovery = ? WHERE user_id = ?').run(JSON.stringify(hashes), userId);
    return 'recovery';
  }
  return null;
}

export function newCodes(userId) {
  if (!isEnabled(userId)) return null;
  const codes = newRecoveryCodes();
  q('UPDATE two_factor SET recovery = ? WHERE user_id = ?').run(JSON.stringify(codes.map(hashRecovery)), userId);
  return codes;
}

export function disable(userId) {
  q('DELETE FROM two_factor WHERE user_id = ?').run(userId);
}

// ---- sign-in tickets: password checked, waiting for the code (5 minutes, 5 tries) ----
const tickets = new Map(); // token -> { userId, expires, tries }
const TICKET_MS = 5 * 60e3;
export function newTicket(userId) {
  for (const [t, v] of tickets) if (v.expires < Date.now()) tickets.delete(t);
  const token = crypto.randomBytes(24).toString('base64url');
  tickets.set(token, { userId, expires: Date.now() + TICKET_MS, tries: 0 });
  return token;
}
export function ticketUser(token) {
  const t = tickets.get(String(token || ''));
  if (!t || t.expires < Date.now()) { tickets.delete(String(token || '')); return null; }
  return t;
}
export const endTicket = (token) => tickets.delete(String(token || ''));

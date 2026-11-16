// Unsubscribing from mail merge (Sheets → Mail merge). Each person a sender mails gets a link of their own
// (/u/<token>); following it and confirming, or their mail app's one-click unsubscribe (RFC 8058: a POST to
// the address in the List-Unsubscribe header), puts them on the sender's list of people who left, and the
// sender's later mail merges skip them. The sender sees who left and can take someone off the list (when
// they've asked to hear again). Tokens are random, so a link says nothing about who it's for.
import crypto from 'node:crypto';
import express, { Router } from 'express';
import { q } from '../db.js';
import { notFound } from '../util.js';

q(`CREATE TABLE IF NOT EXISTS merge_unsubscribes (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  left_at INTEGER,
  UNIQUE (user_id, email)
)`).run();

/** The link token for one person a sender mails (made the first time, the same after). */
export function unsubscribeToken(userId, email) {
  const e = String(email).trim().toLowerCase();
  const had = q('SELECT token FROM merge_unsubscribes WHERE user_id = ? AND email = ?').get(userId, e);
  if (had) return had.token;
  const token = crypto.randomBytes(18).toString('base64url');
  q('INSERT INTO merge_unsubscribes (token, user_id, email, created_at) VALUES (?, ?, ?, ?)').run(token, userId, e, Date.now());
  return token;
}

/** The addresses that have left a sender's mail merges. */
export const leftOf = (userId) => new Set(q('SELECT email FROM merge_unsubscribes WHERE user_id = ? AND left_at IS NOT NULL').all(userId).map((r) => r.email));

/** The sender's list: [{ email, left_at }], latest first. */
export const unsubscribedList = (userId) => q('SELECT email, left_at FROM merge_unsubscribes WHERE user_id = ? AND left_at IS NOT NULL ORDER BY left_at DESC').all(userId);

/** Take someone off the list again (they've asked to hear from you). */
export function resubscribe(userId, email) {
  return q('UPDATE merge_unsubscribes SET left_at = NULL WHERE user_id = ? AND email = ? AND left_at IS NOT NULL').run(userId, String(email).trim().toLowerCase()).changes > 0;
}

/** Mark the link's person as having left; returns the row, or null for an unknown token. */
export function leave(token, now = Date.now()) {
  const row = q('SELECT token, email, left_at FROM merge_unsubscribes WHERE token = ?').get(String(token));
  if (!row) return null;
  if (!row.left_at) q('UPDATE merge_unsubscribes SET left_at = ? WHERE token = ?').run(now, row.token);
  return row;
}

/** The footer added to each message, and the headers that let mail apps offer "Unsubscribe". */
export function unsubscribeParts(base, token) {
  const url = `${base}/u/${token}`;
  return {
    url,
    text: `\n\n--\nTo stop getting these emails: ${url}`,
    html: `<p style="margin-top:24px;font-size:12px;color:#666">Don’t want these emails? <a href="${url}">Unsubscribe</a></p>`,
    headers: { 'List-Unsubscribe': `<${url}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
  };
}

const mask = (email) => { const [name, domain] = email.split('@'); return `${name.slice(0, 2)}${'•'.repeat(Math.max(1, Math.min(6, name.length - 2)))}@${domain}`; };

/** /api/public/unsubscribe/:token — for the page the link opens (no account). */
export function publicUnsubscribeRoutes() {
  const r = Router();
  r.get('/:token', (req, res) => {
    const row = q('SELECT m.email, m.left_at, u.name, u.username FROM merge_unsubscribes m JOIN users u ON u.id = m.user_id WHERE m.token = ?').get(String(req.params.token));
    if (!row) throw notFound('This unsubscribe link isn’t valid');
    res.json({ email: mask(row.email), from: row.name || row.username, left: !!row.left_at });
  });
  r.post('/:token', (req, res) => {
    if (!leave(req.params.token)) throw notFound('This unsubscribe link isn’t valid');
    res.json({ ok: true });
  });
  return r;
}

/** POST /u/:token — a mail app's one-click unsubscribe (RFC 8058), sent without cookies or our header. */
export function oneClickRoute() {
  return [express.urlencoded({ extended: false, limit: '2kb' }), (req, res) => {
    if (!leave(req.params.token)) return res.status(404).type('text').send('Not found');
    res.status(200).type('text').send('Unsubscribed');
  }];
}

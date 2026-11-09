// Confidential mode (Mail → Compose → 🔒): the message itself stays on this server; what goes out by
// email is a link to read it. The link works until the date the sender chose (or until they take it
// back), only for the people it was sent to: colleagues signed in as themselves, anyone else after
// typing a code emailed to their address. The page has no forward, download or print (that stops
// casual sharing, not photos of the screen).
import crypto from 'node:crypto';
import { Router } from 'express';
import { q } from '../db.js';
import { HttpError, bad, notFound } from '../util.js';
import { userFromToken, tokenFromReq } from '../auth.js';

q(`CREATE TABLE IF NOT EXISTS confidential_mail (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_name TEXT, from_address TEXT NOT NULL,
  subject TEXT NOT NULL, html TEXT, text TEXT,
  recipients TEXT NOT NULL,          -- JSON: lower-case addresses (To, Cc and Bcc)
  expires_at INTEGER NOT NULL, revoked_at INTEGER, created_at INTEGER NOT NULL,
  opened INTEGER NOT NULL DEFAULT 0
)`).run();
q(`CREATE TABLE IF NOT EXISTS confidential_codes (
  token TEXT NOT NULL, email TEXT NOT NULL, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0, sent_at INTEGER NOT NULL,
  PRIMARY KEY (token, email)
)`).run();

export const EXPIRY_DAYS = [1, 7, 30, 90];
const DAY = 864e5, CODE_MS = 10 * 60e3, MAX_TRIES = 5;
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/** A new link's secret (made before the message is built, as the email carries it). */
export const newToken = () => crypto.randomBytes(18).toString('base64url');

/** Keep a confidential message: { token, user, from, subject, html, text, recipients, days }. */
export function keepConfidential({ token, user, from, subject, html, text, recipients, days, now = Date.now() }) {
  if (!EXPIRY_DAYS.includes(Number(days))) throw bad('Choose how long it can be read');
  q(`INSERT INTO confidential_mail (token, user_id, from_name, from_address, subject, html, text, recipients, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(token, user.id, from.name || user.name, from.address, String(subject || ''), html || null, text || null,
      JSON.stringify([...new Set(recipients.map((r) => String(r.address || r).toLowerCase()))]), now + Number(days) * DAY, now);
  return { token, expires_at: now + Number(days) * DAY };
}

/** The email that goes out instead of the message: who, what, the link and until when. */
export function noticeOf({ fromName, subject, link, expiresAt }) {
  const until = new Date(expiresAt).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const text = `${fromName} sent you a confidential message${subject ? `: ${subject}` : ''}.\n\nRead it here: ${link}\n\nYou can read it until ${until}. It can't be forwarded, copied into a download or printed from there.`;
  const html = `<p><strong>${esc(fromName)}</strong> sent you a confidential message${subject ? `: <strong>${esc(subject)}</strong>` : ''}.</p>
<p><a href="${esc(link)}" style="display:inline-block;padding:10px 18px;background:#0b57d0;color:#fff;border-radius:18px;text-decoration:none">Read the message</a></p>
<p style="color:#5f6368;font-size:13px">You can read it until ${esc(until)}. It can't be forwarded, downloaded or printed from there.</p>`;
  return { text, html };
}

const state = (m, now = Date.now()) => (m.revoked_at ? 'revoked' : m.expires_at <= now ? 'expired' : 'open');
const load = (token) => {
  const m = q('SELECT * FROM confidential_mail WHERE token = ?').get(String(token || ''));
  if (!m) throw notFound('This link isn’t valid.');
  return { ...m, recipients: JSON.parse(m.recipients) };
};
const gone = (m) => {
  const s = state(m);
  if (s === 'revoked') throw new HttpError(410, `${m.from_name} took this message back.`);
  if (s === 'expired') throw new HttpError(410, 'This message has expired.');
};
const content = (m) => ({ from: { name: m.from_name, address: m.from_address }, subject: m.subject, html: m.html, text: m.text, expires_at: m.expires_at });
const opened = (m) => q('UPDATE confidential_mail SET opened = opened + 1 WHERE token = ?').run(m.token);

let codeSender = null; // (to, { code, fromUser, subject }) => Promise: set by the mail routes (or tests)
export const setCodeSender = (fn) => { codeSender = fn; };

/** The public page's API: /api/public/confidential/:token */
export function publicConfidentialRoutes() {
  const r = Router();
  r.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Robots-Tag', 'noindex'); next(); });
  // What it is (never what it says), and whether you can read it now: signed in as a recipient (or its sender).
  r.get('/:token', (req, res) => {
    const m = load(req.params.token);
    gone(m);
    const cookie = tokenFromReq(req);
    const me = cookie ? userFromToken(cookie) : null;
    if (me && (me.id === m.user_id || m.recipients.includes(String(me.username).toLowerCase()))) {
      if (me.id !== m.user_id) opened(m);
      return res.json({ ...content(m), mine: me.id === m.user_id });
    }
    res.json({ from: { name: m.from_name }, subject: m.subject, expires_at: m.expires_at, need: 'code' });
  });
  // Ask for a code by email (only for its recipients; one a minute).
  r.post('/:token/code', async (req, res) => {
    const m = load(req.params.token);
    gone(m);
    const email = String(req.body?.email || '').trim().toLowerCase();
    // The same answer whether or not the address is one it was sent to.
    const answer = { ok: true, sent_to: email };
    if (!m.recipients.includes(email)) return res.json(answer);
    const last = q('SELECT sent_at FROM confidential_codes WHERE token = ? AND email = ?').get(m.token, email);
    if (last && last.sent_at > Date.now() - 60e3) throw new HttpError(429, 'A code was just sent; wait a minute before asking again');
    const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
    q(`INSERT INTO confidential_codes (token, email, code_hash, expires_at, tries, sent_at) VALUES (?, ?, ?, ?, 0, ?)
       ON CONFLICT (token, email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, tries = 0, sent_at = excluded.sent_at`)
      .run(m.token, email, hash(`${m.token}:${code}`), Date.now() + CODE_MS, Date.now());
    if (!codeSender) throw new HttpError(503, 'Codes can’t be emailed from this server');
    const fromUser = q('SELECT * FROM users WHERE id = ?').get(m.user_id);
    await codeSender(email, { code, fromUser, subject: m.subject });
    res.json(answer);
  });
  // Read it with the code.
  r.post('/:token/open', (req, res) => {
    const m = load(req.params.token);
    gone(m);
    const email = String(req.body?.email || '').trim().toLowerCase();
    const c = q('SELECT * FROM confidential_codes WHERE token = ? AND email = ?').get(m.token, email);
    if (!c || c.expires_at < Date.now() || c.tries >= MAX_TRIES) throw bad('Ask for a new code');
    if (c.code_hash !== hash(`${m.token}:${String(req.body?.code || '').trim()}`)) {
      q('UPDATE confidential_codes SET tries = tries + 1 WHERE token = ? AND email = ?').run(m.token, email);
      throw bad(c.tries + 1 >= MAX_TRIES ? 'That code is wrong. Ask for a new one.' : 'That code is wrong');
    }
    q('DELETE FROM confidential_codes WHERE token = ? AND email = ?').run(m.token, email); // once
    opened(m);
    res.json(content(m));
  });
  return r;
}

/** The sender's own: list (newest first) and take back. Mounted under /api/mail/confidential. */
export function confidentialRoutes() {
  const r = Router();
  r.get('/', (req, res) => res.json(q('SELECT token, subject, recipients, expires_at, revoked_at, created_at, opened FROM confidential_mail WHERE user_id = ? ORDER BY created_at DESC LIMIT 100')
    .all(req.user.id).map((m) => ({ ...m, recipients: JSON.parse(m.recipients), state: state(m) }))));
  r.post('/:token/revoke', (req, res) => {
    const m = q('SELECT * FROM confidential_mail WHERE token = ? AND user_id = ?').get(String(req.params.token), req.user.id);
    if (!m) throw notFound('Message not found');
    if (!m.revoked_at) q('UPDATE confidential_mail SET revoked_at = ? WHERE token = ?').run(Date.now(), m.token);
    res.json({ ok: true, state: 'revoked' });
  });
  return r;
}

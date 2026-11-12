// "Include Kim?": while you write to some people, the people you usually write to together with them.
// Every message you send counts once for each person on it (mail_sent_to) and for each pair of people on
// it together (mail_together, with a < b), for messages to 2 to 20 people. Someone is suggested when, on
// average across those already on the message, at least half the mail to them also went to that person
// (and that happened at least twice).
import { q } from '../db.js';

q(`CREATE TABLE IF NOT EXISTS mail_sent_to (
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, email TEXT NOT NULL, name TEXT, times INTEGER NOT NULL, last_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, email)
)`).run();
q(`CREATE TABLE IF NOT EXISTS mail_together (
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, a TEXT NOT NULL, b TEXT NOT NULL, times INTEGER NOT NULL, last_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, a, b)
)`).run();
export const MAX_GROUP = 20;
const KEEP_PAIRS = 20000, KEEP_PEOPLE = 5000;
export const MIN_SHARE = 0.5, MIN_TIMES = 2, MAX_SUGGESTIONS = 3;

const clean = (e) => String(e || '').trim().toLowerCase();

/** Count a message sent by `user` to `addresses` ([{ address, name }]). */
export function recordTogether(user, addresses, at = Date.now()) {
  const me = clean(user.username);
  const seen = new Map();
  for (const a of addresses || []) {
    const e = clean(a?.address);
    if (e && e !== me && e.length <= 254 && !seen.has(e)) seen.set(e, String(a.name || '').trim().slice(0, 200) || null);
  }
  for (const [email, name] of seen) {
    q(`INSERT INTO mail_sent_to (owner_id, email, name, times, last_at) VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(owner_id, email) DO UPDATE SET times = times + 1, last_at = excluded.last_at, name = COALESCE(excluded.name, mail_sent_to.name)`).run(user.id, email, name, at);
  }
  const list = [...seen.keys()].sort();
  if (list.length >= 2 && list.length <= MAX_GROUP) {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      q(`INSERT INTO mail_together (owner_id, a, b, times, last_at) VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(owner_id, a, b) DO UPDATE SET times = times + 1, last_at = excluded.last_at`).run(user.id, list[i], list[j], at);
    }
  }
  const prune = (table, keep) => {
    const n = q(`SELECT COUNT(*) AS n FROM ${table} WHERE owner_id = ?`).get(user.id).n;
    if (n > keep) q(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE owner_id = ? ORDER BY last_at LIMIT ?)`).run(user.id, n - keep);
  };
  prune('mail_together', KEEP_PAIRS);
  prune('mail_sent_to', KEEP_PEOPLE);
}

/** Up to three people to add to a message already going to `emails`: [{ email, name, times }], likeliest first. */
export function suggestIncludes(user, emails, { not = [] } = {}) {
  const me = clean(user.username);
  const current = [...new Set((emails || []).map(clean).filter((e) => e && e !== me))].slice(0, MAX_GROUP);
  if (!current.length) return [];
  const skip = new Set([me, ...current, ...(not || []).map(clean)]);
  const sent = new Map();
  for (const e of current) sent.set(e, q('SELECT times FROM mail_sent_to WHERE owner_id = ? AND email = ?').get(user.id, e)?.times || 0);
  const score = new Map(); // candidate -> { share (sum over current), times }
  for (const e of current) {
    if (!sent.get(e)) continue;
    const rows = q('SELECT a, b, times FROM mail_together WHERE owner_id = ? AND (a = ? OR b = ?)').all(user.id, e, e);
    for (const r of rows) {
      const other = r.a === e ? r.b : r.a;
      if (skip.has(other)) continue;
      const s = score.get(other) || { share: 0, times: 0 };
      s.share += Math.min(1, r.times / sent.get(e));
      s.times += r.times;
      score.set(other, s);
    }
  }
  return [...score.entries()]
    .map(([email, s]) => ({ email, share: s.share / current.length, times: s.times }))
    .filter((x) => x.share >= MIN_SHARE && x.times >= MIN_TIMES)
    .sort((x, y) => y.share - x.share || y.times - x.times || x.email.localeCompare(y.email))
    .slice(0, MAX_SUGGESTIONS)
    .map(({ email, times }) => ({ email, name: q('SELECT name FROM mail_sent_to WHERE owner_id = ? AND email = ?').get(user.id, email)?.name || null, times }));
}

export function includeRoutes(r) {
  // ?to=a@x,b@y (everyone on the message so far) [&not=c@z: suggestions waved away]
  r.get('/includes', (req, res) => {
    const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 100);
    res.json(suggestIncludes(req.user, list(req.query.to), { not: list(req.query.not) }));
  });
}

/**
 * Frequently contacted: the people you've emailed most from Workspace in the last `days` (most first,
 * then latest), each with whether they're in your contacts or a colleague, for Contacts → Frequent.
 */
export function frequentOf(user, { days = 180, limit = 20, now = Date.now() } = {}) {
  const rows = q(`SELECT email, name, times, last_at FROM mail_sent_to WHERE owner_id = ? AND last_at >= ?
                  ORDER BY times DESC, last_at DESC LIMIT ?`).all(user.id, now - days * 864e5, limit);
  return rows.map((r) => {
    const contact = q('SELECT id, name FROM contacts WHERE owner_id = ? AND LOWER(email) = ?').get(user.id, r.email);
    const colleague = contact ? null : q('SELECT id, name FROM users WHERE LOWER(username) = ? AND org_id = ? AND disabled = 0').get(r.email, user.org_id);
    return { email: r.email, name: contact?.name || colleague?.name || r.name || null, times: r.times, last_at: r.last_at,
      contact_id: contact?.id || null, colleague_id: colleague?.id || null };
  });
}

/** Forget one person (and every pairing with them), or everyone when `email` is empty. Gives how many people were forgotten. */
export function forgetSent(user, email = null) {
  if (!email) {
    const n = q('SELECT COUNT(*) AS n FROM mail_sent_to WHERE owner_id = ?').get(user.id).n;
    q('DELETE FROM mail_sent_to WHERE owner_id = ?').run(user.id);
    q('DELETE FROM mail_together WHERE owner_id = ?').run(user.id);
    return n;
  }
  const e = clean(email);
  const n = q('DELETE FROM mail_sent_to WHERE owner_id = ? AND email = ?').run(user.id, e).changes;
  q('DELETE FROM mail_together WHERE owner_id = ? AND (a = ? OR b = ?)').run(user.id, e, e);
  return n;
}

// "Other contacts": people you've emailed who aren't in your contacts, remembered as you send, so
// they're suggested next time. Colleagues on the server and your own contacts aren't kept here.
import { q } from './db.js';
import { recordTogether } from './mail/includes.js';

q(`CREATE TABLE IF NOT EXISTS other_contacts (
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  name TEXT,
  times INTEGER NOT NULL DEFAULT 1,
  last_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, email)
)`).run();
const MAX_PER_PERSON = 2000;

/** Remember who was written to: [{ name, address }]. */
export function recordSent(user, addresses, at = Date.now()) {
  recordTogether(user, addresses, at); // who you write to together, for "Include Kim?"
  for (const a of addresses) {
    const email = String(a?.address || '').trim().toLowerCase();
    if (!email || email.length > 254 || email === String(user.username).toLowerCase()) continue;
    q('UPDATE contacts SET last_contact = ? WHERE owner_id = ? AND LOWER(email) = ?').run(at, user.id, email); // Keep in touch: writing to them counts
    if (q('SELECT 1 FROM users WHERE LOWER(username) = ? AND org_id = ?').get(email, user.org_id)) continue; // a colleague
    const name = String(a.name || '').trim().slice(0, 200) || null;
    q(`INSERT INTO other_contacts (owner_id, email, name, times, last_at) VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(owner_id, email) DO UPDATE SET times = times + 1, last_at = excluded.last_at, name = COALESCE(excluded.name, other_contacts.name)`).run(user.id, email, name, at);
  }
  const n = q('SELECT COUNT(*) AS n FROM other_contacts WHERE owner_id = ?').get(user.id).n;
  if (n > MAX_PER_PERSON) q(`DELETE FROM other_contacts WHERE owner_id = ? AND email IN (SELECT email FROM other_contacts WHERE owner_id = ? ORDER BY last_at LIMIT ?)`).run(user.id, user.id, n - MAX_PER_PERSON);
}

const NOT_A_CONTACT = "NOT EXISTS (SELECT 1 FROM contacts c WHERE c.owner_id = o.owner_id AND LOWER(c.email) = o.email)";

/** Your other contacts, most written to first (those since added to your contacts left out). */
export function otherContactsOf(userId) {
  return q(`SELECT o.email, o.name, o.times, o.last_at FROM other_contacts o WHERE o.owner_id = ? AND ${NOT_A_CONTACT}
            ORDER BY o.times DESC, o.last_at DESC LIMIT 500`).all(userId);
}

/** Matches for address suggestions (lower-case LIKE patterns). */
export function matchOther(userId, like) {
  return q(`SELECT o.email, o.name FROM other_contacts o WHERE o.owner_id = ? AND ${NOT_A_CONTACT}
            AND (LOWER(COALESCE(o.name, '')) LIKE ? ESCAPE '\\' OR o.email LIKE ? ESCAPE '\\') ORDER BY o.times DESC, o.last_at DESC LIMIT 8`).all(userId, like, like);
}

export function forgetOther(userId, email) {
  return q('DELETE FROM other_contacts WHERE owner_id = ? AND email = ?').run(userId, String(email).toLowerCase()).changes;
}

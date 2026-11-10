// Automatic forwarding: a copy of all incoming mail goes to one other address, once that address
// has confirmed with a code sent to it (so nobody can quietly send their mail to a stranger, or flood
// someone with it). The mail server does it (Sieve, see sieve.js), so it works for mail read on phones too.
// Companies can stop forwarding to addresses outside their own domains (orgs.allow_forwarding).
import crypto from 'node:crypto';
import { q, db } from '../db.js';

q(`CREATE TABLE IF NOT EXISTS mail_forwarding (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  address TEXT NOT NULL,
  code_hash TEXT,                 -- sha256 of the code sent to the address (until confirmed)
  code_sent_at INTEGER,
  tries INTEGER NOT NULL DEFAULT 0,
  confirmed INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 0,
  keep TEXT NOT NULL DEFAULT 'inbox', -- what happens to your own copy: inbox, read, archive, trash
  sends TEXT NOT NULL DEFAULT '[]'    -- when codes were sent (JSON times), to limit them
)`).run();
if (!db.prepare('PRAGMA table_info(orgs)').all().some((c) => c.name === 'allow_forwarding')) db.exec('ALTER TABLE orgs ADD COLUMN allow_forwarding INTEGER NOT NULL DEFAULT 1');

export const KEEP_CHOICES = ['inbox', 'read', 'archive', 'trash'];
export const CODE_DAYS = 7;
export const MAX_TRIES = 10;
export const MAX_SENDS_PER_DAY = 5;
const EMAIL_RE = /^[^\s@"\\<>,;]+@[^\s@"\\<>,;]+\.[^\s@"\\<>,;]+$/;

export const hashCode = (code) => crypto.createHash('sha256').update(String(code).replace(/\D/g, '')).digest('hex');
export const newCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');
export const cleanAddress = (v) => { const a = String(v ?? '').trim().toLowerCase(); return a.length <= 254 && EMAIL_RE.test(a) ? a : null; };

/** Is the address in one of the company's own domains? */
export function insideCompany(orgId, address) {
  const domain = String(address).split('@').pop();
  return !!q('SELECT 1 FROM domains WHERE org_id = ? AND name = ?').get(orgId, domain);
}

/** Does the company let mail go to this address automatically? */
export function forwardingAllowed(orgId, address) {
  const org = q('SELECT allow_forwarding FROM orgs WHERE id = ?').get(orgId);
  return (org ? !!org.allow_forwarding : true) || insideCompany(orgId, address);
}

export const rowOf = (userId) => q('SELECT * FROM mail_forwarding WHERE user_id = ?').get(userId);

/** What the person sees: { address, confirmed, enabled, keep, pending, allowed_outside } (address null when none). */
export function describeForwarding(user, row = rowOf(user.id)) {
  const allowedOutside = !!(q('SELECT allow_forwarding FROM orgs WHERE id = ?').get(user.org_id)?.allow_forwarding ?? 1);
  if (!row) return { address: null, confirmed: false, enabled: false, keep: 'inbox', allowed_outside: allowedOutside };
  return {
    address: row.address, confirmed: !!row.confirmed, enabled: !!row.enabled && !!row.confirmed, keep: row.keep,
    allowed_outside: allowedOutside,
    blocked: !!row.confirmed && !forwardingAllowed(user.org_id, row.address), // the company stopped it since
    code_sent_at: row.confirmed ? null : row.code_sent_at,
  };
}

/** Times codes were sent in the last day, after `now` (for the limit). */
export const recentSends = (row, now = Date.now()) => JSON.parse(row?.sends || '[]').filter((t) => now - t < 86400000);

/** Check a typed code against the row: 'ok', 'wrong', 'expired' or 'locked'. */
export function checkCode(row, code, now = Date.now()) {
  if (!row?.code_hash) return 'expired';
  if (row.tries >= MAX_TRIES) return 'locked';
  if (now - row.code_sent_at > CODE_DAYS * 86400000) return 'expired';
  const a = Buffer.from(row.code_hash, 'hex'), b = Buffer.from(hashCode(code), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? 'ok' : 'wrong';
}

/** For the mail config: users' active forwarding, by user id: { address, keep }. */
export function activeForwarding() {
  const out = new Map();
  for (const r of q(`SELECT f.*, u.org_id FROM mail_forwarding f JOIN users u ON u.id = f.user_id WHERE f.confirmed = 1 AND f.enabled = 1`).all()) {
    if (forwardingAllowed(r.org_id, r.address)) out.set(r.user_id, { address: r.address, keep: r.keep });
  }
  return out;
}

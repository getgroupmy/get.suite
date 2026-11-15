// "You don't often get email from …": an email from outside the company, from an address this person has
// never had mail from before (in the Inbox or Archive), never written to and doesn't keep as a contact.
// First contact is when impersonation usually happens (a new "supplier", a "CEO" on a private address),
// so Mail says so quietly above it. The answer is kept for an hour per person and address.
import { q } from '../db.js';
import { withFolder, withClient } from './imap.js';

const cache = new Map(); // `${userId}\n${address}` → { known, at }
const HOUR = 36e5;

/** Whether this address is new to this person (true), or known, or couldn't be told (false). */
export async function isFirstContact(user, address, { folder, uid } = {}) {
  const a = String(address || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(a)) return false;
  const domain = a.split('@')[1];
  if (q('SELECT 1 FROM domains WHERE org_id = ? AND name = ?').get(user.org_id, domain)) return false; // a colleague
  try { if (q('SELECT 1 FROM mail_sent_to WHERE owner_id = ? AND email = ?').get(user.id, a)) return false; } catch { /* no table yet */ }
  try { if (q('SELECT 1 FROM contacts WHERE owner_id = ? AND lower(email) = ?').get(user.id, a)) return false; } catch { /* no table yet */ }
  const key = `${user.id}\n${a}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < HOUR) return !hit.known;
  let known = false;
  try {
    const boxes = await withClient(user, (c) => c.list());
    const archive = boxes.find((b) => b.specialUse === '\\Archive')?.path;
    for (const f of ['INBOX', archive].filter(Boolean)) {
      const uids = await withFolder(user, f, async (c) => (await c.search({ from: a }, { uid: true })) || []);
      if (uids.some((u) => !(f === folder && u === Number(uid)))) { known = true; break; }
    }
  } catch { return false; } // can't tell: say nothing
  cache.set(key, { known, at: Date.now() });
  if (cache.size > 5000) cache.delete(cache.keys().next().value);
  return !known;
}

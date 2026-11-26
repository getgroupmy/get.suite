import { q } from './db.js';
import { bad } from './util.js';

/**
 * The people with these addresses (as typed in an @mention: "@kim@acme.com" or "kim@acme.com"), by id; an address
 * no one has is an error. Whether they may be added is for the caller to check (same company, reachable).
 */
export function byAddress(list, user) {
  const wanted = [...new Set(list.slice(0, 50).map((a) => String(a || '').trim().replace(/^@/, '').toLowerCase()).filter(Boolean))];
  return wanted.map((a) => {
    const u = q('SELECT id FROM users WHERE LOWER(username) = ? AND disabled = 0').get(a);
    if (!u) throw bad(`No one here has the address ${a}`);
    if (u.id === user.id) return null;
    return u.id;
  }).filter(Boolean);
}

/** The addresses @mentioned in a comment ("@kim@acme.com"), lower case, each once. */
export const mentionedAddresses = (text) => new Set([...String(text || '').matchAll(/@([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/gi)].map((m) => m[1].toLowerCase()));

/** The people (ids) a changed comment mentions that it didn't before: told, as a new comment's would be. */
export function newlyMentioned(before, after) {
  const had = mentionedAddresses(before);
  const added = [...mentionedAddresses(after)].filter((a) => !had.has(a));
  return added.length ? q('SELECT id FROM users WHERE LOWER(username) IN (SELECT value FROM json_each(?)) AND disabled = 0').all(JSON.stringify(added)).map((u) => u.id) : [];
}

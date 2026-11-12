// Nudges: email from people in the Inbox (the Primary tab: not newsletters or notifications) that arrived
// between 3 and 14 days ago and hasn't been answered, for Home. "Not now" puts a keyword on the message
// so it isn't suggested again (on every device that reads keywords).
import { withFolder, withClient } from './imap.js';
import { q } from '../db.js';
import { tabQuery } from './tabs.js';
import { allOf } from './searchquery.js';

export const NO_NUDGE = '$NwNoNudge';
// mail_nudges: 0 when someone turned nudges off (Settings → Mail); on otherwise.
if (!q('PRAGMA table_info(users)').all().some((c) => c.name === 'mail_nudges')) q('ALTER TABLE users ADD COLUMN mail_nudges INTEGER').run();
export const nudgesOn = (user) => q('SELECT mail_nudges FROM users WHERE id = ?').get(user.id)?.mail_nudges !== 0;
const FROM_DAYS = 3, TO_DAYS = 14;

/** The IMAP search: in Primary, arrived 3–14 days before now, not answered, not dismissed, not deleted. */
export function nudgeQuery(now = Date.now()) {
  return allOf([tabQuery('primary'), { since: new Date(now - TO_DAYS * 864e5), before: new Date(now - FROM_DAYS * 864e5) }, { answered: false }, { unKeyword: NO_NUDGE }, { deleted: false }]);
}

/** Up to `limit` of someone's nudges, newest first: [{ uid, subject, from, date, message_id }], and how many there are. */
export async function nudgesFor(user, { now = Date.now(), limit = 5, mine = [user.username] } = {}) {
  if (!nudgesOn(user)) return { items: [], total: 0 };
  const own = new Set(mine.map((a) => a.toLowerCase()));
  return withFolder(user, 'INBOX', async (c) => {
    const uids = ((await c.search(nudgeQuery(now), { uid: true })) || []).slice(-50);
    const out = [];
    if (uids.length) {
      for await (const m of c.fetch(uids.join(','), { uid: true, envelope: true, internalDate: true }, { uid: true })) {
        const from = m.envelope?.from?.[0];
        if (!from?.address || own.has(from.address.toLowerCase())) continue; // your own mail to yourself
        out.push({ uid: m.uid, subject: m.envelope?.subject || '', from: { name: from.name || '', email: from.address }, date: (m.envelope?.date || m.internalDate)?.getTime?.() ?? null, message_id: m.envelope?.messageId || null });
      }
    }
    out.sort((a, b) => (b.date || 0) - (a.date || 0));
    return { items: out.slice(0, limit), total: out.length };
  });
}

/** The search in Sent: sent 3–14 days before now, not dismissed. */
export function sentNudgeQuery(now = Date.now()) {
  return { since: new Date(now - TO_DAYS * 864e5), before: new Date(now - FROM_DAYS * 864e5), unKeyword: NO_NUDGE, deleted: false };
}
const SKIP = new Set(['\\Sent', '\\Drafts', '\\Junk', '\\Trash']);
const sentCache = new Map(); // user id -> { at, uids }
/**
 * Sent mail with no reply yet, 3 to 14 days on ("Sent 4 days ago. Follow up?"): the uids in Sent. Replies are
 * looked for in every folder but Sent, Drafts, Junk and Trash, by In-Reply-To or References, with one search
 * per folder for all of them. Kept for 5 minutes.
 */
export async function sentNudges(user, { now = Date.now(), fresh = false } = {}) {
  if (!nudgesOn(user)) return [];
  const hit = sentCache.get(user.id);
  if (!fresh && hit && now - hit.at < 5 * 60e3) return hit.uids;
  const uids = await withClient(user, async (c) => {
    const boxes = await c.list();
    const sent = boxes.find((b) => b.specialUse === '\\Sent')?.path;
    if (!sent) return [];
    const byId = new Map(); // Message-ID -> uid in Sent
    let lock = await c.getMailboxLock(sent);
    try {
      const found = ((await c.search(sentNudgeQuery(now), { uid: true })) || []).slice(-30);
      if (found.length) for await (const m of c.fetch(found.join(','), { uid: true, envelope: true }, { uid: true })) if (m.envelope?.messageId) byId.set(m.envelope.messageId, m.uid);
    } finally { lock.release(); }
    if (!byId.size) return [];
    const ids = [...byId.keys()];
    const replied = new Set();
    for (const b of boxes) {
      if (b.flags?.has?.('\\Noselect') || SKIP.has(b.specialUse) || b.path === sent) continue;
      lock = await c.getMailboxLock(b.path).catch(() => null);
      if (!lock) continue;
      try {
        const hits = (await c.search({ or: ids.flatMap((id) => [{ header: { 'in-reply-to': id } }, { header: { references: id } }]) }, { uid: true })) || [];
        if (hits.length) {
          for await (const m of c.fetch(hits.join(','), { uid: true, headers: ['in-reply-to', 'references'] }, { uid: true })) {
            const h = m.headers?.toString() || '';
            for (const id of ids) if (h.includes(id)) replied.add(id);
          }
        }
      } finally { lock.release(); }
    }
    return ids.filter((id) => !replied.has(id)).map((id) => byId.get(id));
  });
  sentCache.set(user.id, { at: now, uids });
  return uids;
}

/** GET /mail/nudges and POST /mail/nudges/:uid/dismiss. `addresses(user)`: the addresses that are theirs. */
export function nudgeRoutes(r, addresses = (u) => [u.username]) {
  r.get('/nudges', async (req, res) => res.json(await nudgesFor(req.user, { mine: addresses(req.user) })));
  // Sent mail with no reply yet: { uids } in Sent.
  r.get('/nudges/sent', async (req, res) => res.json({ uids: await sentNudges(req.user, { fresh: req.query.fresh === '1' }) }));
  // On or off for you (Settings → Mail).
  r.get('/nudges/settings', (req, res) => res.json({ on: nudgesOn(req.user) }));
  r.put('/nudges/settings', (req, res) => {
    q('UPDATE users SET mail_nudges = ? WHERE id = ?').run(req.body?.on === false ? 0 : null, req.user.id);
    sentCache.delete(req.user.id);
    res.json({ on: req.body?.on !== false });
  });
  // Not now: in the Inbox, or (?folder=) in Sent.
  r.post('/nudges/:uid/dismiss', async (req, res) => {
    const uid = Number(req.params.uid);
    if (!Number.isInteger(uid) || uid < 1) { res.status(400).json({ error: 'Not a message' }); return; }
    const folder = String(req.query.folder || 'INBOX');
    await withFolder(req.user, folder, (c) => c.messageFlagsAdd(String(uid), [NO_NUDGE], { uid: true }));
    sentCache.delete(req.user.id);
    res.json({ ok: true });
  });
}

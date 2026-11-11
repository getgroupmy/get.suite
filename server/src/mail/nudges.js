// Nudges: email from people in the Inbox (the Primary tab: not newsletters or notifications) that arrived
// between 3 and 14 days ago and hasn't been answered, for Home. "Not now" puts a keyword on the message
// so it isn't suggested again (on every device that reads keywords).
import { withFolder } from './imap.js';
import { tabQuery } from './tabs.js';
import { allOf } from './searchquery.js';

export const NO_NUDGE = '$NwNoNudge';
const FROM_DAYS = 3, TO_DAYS = 14;

/** The IMAP search: in Primary, arrived 3–14 days before now, not answered, not dismissed, not deleted. */
export function nudgeQuery(now = Date.now()) {
  return allOf([tabQuery('primary'), { since: new Date(now - TO_DAYS * 864e5), before: new Date(now - FROM_DAYS * 864e5) }, { answered: false }, { unKeyword: NO_NUDGE }, { deleted: false }]);
}

/** Up to `limit` of someone's nudges, newest first: [{ uid, subject, from, date, message_id }], and how many there are. */
export async function nudgesFor(user, { now = Date.now(), limit = 5, mine = [user.username] } = {}) {
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

/** GET /mail/nudges and POST /mail/nudges/:uid/dismiss. `addresses(user)`: the addresses that are theirs. */
export function nudgeRoutes(r, addresses = (u) => [u.username]) {
  r.get('/nudges', async (req, res) => res.json(await nudgesFor(req.user, { mine: addresses(req.user) })));
  r.post('/nudges/:uid/dismiss', async (req, res) => {
    const uid = Number(req.params.uid);
    if (!Number.isInteger(uid) || uid < 1) { res.status(400).json({ error: 'Not a message' }); return; }
    await withFolder(req.user, 'INBOX', (c) => c.messageFlagsAdd(String(uid), [NO_NUDGE], { uid: true }));
    res.json({ ok: true });
  });
}

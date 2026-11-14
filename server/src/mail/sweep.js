// Taking a phishing email out of everyone's Inbox (Admin → Phishing → Remove from inboxes): each person's
// Inbox in the company is searched for mail from the sender (an address, or a domain and its subdomains),
// and what's found is moved to Junk, marked read. Through webmail's own sign-in to each mailbox.
import { withFolder, withClient } from './imap.js';

/** Is this From address covered by a block value (an address, or a domain with its subdomains)? */
export function matchesBlock(address, value) {
  const a = String(address || '').toLowerCase(), v = String(value || '').toLowerCase();
  if (!a || !v) return false;
  if (v.includes('@')) return a === v;
  const domain = a.split('@')[1] || '';
  return domain === v || domain.endsWith(`.${v}`);
}

/** Sweep these people's Inboxes: { people (with some moved), messages, failed (couldn't be reached) }. */
export async function sweepInboxes(users, value, io = { withFolder, withClient }) {
  let people = 0, messages = 0;
  const failed = [];
  for (const u of users) {
    try {
      const junk = await io.withClient(u, async (c) => (await c.list()).find((b) => b.specialUse === '\\Junk')?.path || 'Junk');
      const n = await io.withFolder(u, 'INBOX', async (c) => {
        const found = await c.search({ from: value.includes('@') ? value : value.replace(/^@/, '') }, { uid: true });
        if (!found?.length) return 0;
        const uids = [];
        for await (const m of c.fetch(found.join(','), { envelope: true }, { uid: true })) {
          if ((m.envelope?.from || []).some((f) => matchesBlock(f.address, value))) uids.push(m.uid);
        }
        if (!uids.length) return 0;
        await c.messageFlagsAdd(uids.join(','), ['\\Seen'], { uid: true });
        await c.messageMove(uids.join(','), junk, { uid: true });
        return uids.length;
      });
      if (n) { people += 1; messages += n; }
    } catch { failed.push(u.username); }
  }
  return { people, messages, failed };
}

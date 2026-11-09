// Manage subscriptions: the newsletters and mailing lists in someone's Inbox, by sender, with how
// often each writes and how to leave (see unsubscribe.js).
import { unsubscribeOptions } from './unsubscribe.js';

/** Raw header text (as IMAP gives it) → the { key, line } entries unsubscribeOptions reads. */
export function headerLinesOf(raw) {
  return String(raw || '').replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/).filter((l) => l.includes(':'))
    .map((line) => ({ key: line.slice(0, line.indexOf(':')).trim().toLowerCase(), line }));
}

/**
 * Messages ({ uid, from: { address, name }, date, headers }) grouped by sender, most frequent first:
 * [{ address, name, count, last_at, uids, uid (the newest, to unsubscribe with), how }] where how is
 * 'one-click' | 'email' | 'web' (a page to open). Senders with no way to leave are left out.
 */
export function groupSubscriptions(messages) {
  const by = new Map();
  for (const m of messages) {
    const address = String(m.from?.address || '').toLowerCase();
    if (!address) continue;
    const opts = unsubscribeOptions(headerLinesOf(m.headers));
    if (!opts) continue;
    const at = new Date(m.date || 0).getTime() || 0;
    let g = by.get(address);
    if (!g) by.set(address, (g = { address, name: '', count: 0, last_at: 0, uids: [], uid: null, how: null, url: null }));
    g.count++;
    g.uids.push(m.uid);
    if (at >= g.last_at) {
      g.last_at = at; g.uid = m.uid; g.name = m.from?.name || g.name;
      g.how = opts.oneClick ? 'one-click' : opts.mailto ? 'email' : 'web';
      g.url = g.how === 'web' ? opts.url : null;
    }
  }
  return [...by.values()].sort((a, b) => b.count - a.count || b.last_at - a.last_at);
}

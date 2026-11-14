// "Also apply to messages already in the Inbox": a filter rule (see sieve.js) run once over a folder's
// mail with IMAP, as the mail server runs it on new mail. Each condition is one IMAP search; "all"
// keeps the messages every search found, "any" those any search found. "Is exactly" is searched as
// "contains", then checked exactly against the message's envelope (as Sieve compares: case aside).
import { parseSize } from './sieve.js';
import { TO_PRIMARY, TO_UPDATES } from './tabs.js';

export const MAX_APPLY = 5000;

/** One condition as an IMAP search ({ query, exact }). `exact`: also check the envelope. */
export function conditionQuery(c) {
  const neg = (q) => (c.op === 'not_contains' || c.op === 'has_not' ? { not: q } : q);
  switch (c.field) {
    case 'from': return { query: neg({ from: c.value }), exact: c.op === 'is' };
    case 'to': return { query: neg({ or: [{ to: c.value }, { cc: c.value }] }), exact: c.op === 'is' };
    case 'subject': return { query: neg({ subject: c.value }), exact: c.op === 'is' };
    case 'body': return { query: neg({ body: c.value }), exact: false };
    case 'list': return { query: neg({ header: { 'list-id': c.value } }), exact: false };
    case 'size': { const bytes = (parseSize(c.value)?.kb || 1) * 1024; return { query: c.op === 'under' ? { smaller: bytes } : { larger: bytes }, exact: false }; }
    case 'attachment': return { query: neg({ header: { 'content-type': 'multipart/mixed' } }), exact: false };
    default: throw new Error(`unknown field ${c.field}`);
  }
}

/** Does an envelope meet an "is exactly" condition? */
export function exactly(c, env) {
  const v = String(c.value).trim().toLowerCase();
  const addrs = (list) => (list || []).map((a) => String(a.address || '').toLowerCase());
  if (c.field === 'subject') return String(env?.subject || '').trim().toLowerCase() === v;
  if (c.field === 'from') return addrs(env?.from).includes(v);
  if (c.field === 'to') return [...addrs(env?.to), ...addrs(env?.cc)].includes(v);
  return false;
}

/** The uids in the open folder that a rule matches (client: an imapflow client with the folder open). */
export async function matchingUids(client, rule) {
  const sets = [];
  for (const c of rule.conditions) {
    const { query, exact } = conditionQuery(c);
    let uids = (await client.search(query, { uid: true })) || [];
    if (exact && uids.length) {
      const keep = [];
      for await (const m of client.fetch(uids.slice(-MAX_APPLY).join(','), { uid: true, envelope: true }, { uid: true })) if (exactly(c, m.envelope)) keep.push(m.uid);
      uids = keep;
    }
    sets.push(new Set(uids));
  }
  const all = rule.match === 'any'
    ? new Set(sets.flatMap((s) => [...s]))
    : sets.reduce((a, b) => new Set([...a].filter((x) => b.has(x))));
  return [...all].sort((a, b) => a - b).slice(-MAX_APPLY);
}

/**
 * Do a rule's actions to the messages it matches in the open folder: read, starred, labelled, then moved
 * (or to `trash` when it deletes). Forwarding is left out: old mail isn't sent on. → { matched, moved }
 */
export async function applyRule(client, rule, { keyword = null, trash = 'Trash', folder = 'INBOX' } = {}) {
  const uids = await matchingUids(client, rule);
  if (!uids.length) return { matched: 0, moved: 0 };
  const set = uids.join(',');
  const a = rule.actions;
  const flags = [a.markRead && '\\Seen', a.star && '\\Flagged', keyword, a.tab && (a.tab === 'primary' ? TO_PRIMARY : TO_UPDATES)].filter(Boolean);
  if (a.tab && !a.delete) await client.messageFlagsRemove(set, [a.tab === 'primary' ? TO_UPDATES : TO_PRIMARY], { uid: true });
  if (flags.length && !a.delete) await client.messageFlagsAdd(set, flags, { uid: true });
  let moved = 0;
  const to = a.delete ? trash : a.moveTo && a.moveTo !== folder ? a.moveTo : null;
  if (to) {
    if (!a.delete) await client.mailboxCreate(to).then(() => client.mailboxSubscribe(to)).catch(() => {}); // already there: fine
    await client.messageMove(set, to, { uid: true });
    moved = uids.length;
  }
  return { matched: uids.length, moved };
}

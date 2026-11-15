// Chat search filters, as typed in the search box (from:me has:file …), and the words to mark in results.

const FILTER = /^-?[a-z]+:/i;

/** The query's tokens, keeping "quoted phrases" (and from:"Ann Lee") together. */
const tokens = (q) => String(q || '').match(/-?(?:[a-z]+:)?(?:"[^"]*"?|\S+)/gi) || [];

/** Whether the search has this filter (from:me, has:file…), in any letter case. */
export const hasFilter = (q, f) => tokens(q).some((t) => t.toLowerCase() === f.toLowerCase());

/** The search with this filter added, or taken off if it's there. */
export function toggleFilter(q, f) {
  const list = tokens(q);
  const kept = list.filter((t) => t.toLowerCase() !== f.toLowerCase());
  return (kept.length < list.length ? kept : [...list, f]).join(' ');
}

/** The words to mark in results: not the filters, and not the words left out. */
export function markWords(q) {
  return tokens(q).filter((t) => !FILTER.test(t) && !t.startsWith('-')).map((t) => t.replace(/"/g, '')).join(' ');
}

/** The search's filter for a conversation: in:#name for a channel, in:"Their Name" for a direct message. */
export function inFilter(c, otherName) {
  if (!c) return null;
  if (c.dm_key) return otherName ? `in:"${otherName}"` : null;
  return /\s/.test(c.name) ? null : `in:#${c.name}`;
}

/** The filter buttons under the results. */
export const QUICK = [
  ['from:me', 'From me'], ['has:file', 'Has files'], ['has:image', 'Has pictures'], ['has:link', 'Has links'], ['is:thread', 'In threads'],
];

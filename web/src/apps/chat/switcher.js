// Ctrl+K "Jump to" in Chat: your conversations, and colleagues you have no direct message with yet.

/** How well `label` matches what's typed: 0 starts with it, 1 a word starts with it, 2 contains it; -1 no. */
export function matchScore(label, query) {
  const l = String(label || '').toLowerCase().replace(/^#\s*/, ''), q = query.trim().toLowerCase().replace(/^[#@]\s*/, '');
  if (!q) return 0;
  if (l.startsWith(q)) return 0;
  if (l.split(/[\s\-_.]+/).some((w) => w.startsWith(q))) return 1;
  return l.includes(q) ? 2 : -1;
}

/**
 * The choices for what's typed, best first: closer matches first, then unread ones, then in list order.
 * With nothing typed, your conversations with unread messages first. At most `max`.
 */
export function jumpChoices(items, query, max = 12) {
  const typed = query.trim();
  return items
    .map((it, i) => ({ it, i, s: Math.min(...[it.label, ...(it.also || [])].map((x) => { const v = matchScore(x, typed); return v < 0 ? 9 : v; })) }))
    .filter(({ it, s }) => s < 9 && (typed || it.kind !== 'person'))
    .sort((a, b) => a.s - b.s || (b.it.unread > 0) - (a.it.unread > 0) || (a.it.kind === 'person') - (b.it.kind === 'person') || a.i - b.i)
    .slice(0, max)
    .map(({ it }) => it);
}

/** The list for jumpChoices: conversations (not archived ones you left behind), then people without a direct message. */
export function jumpItems(channels, people, unread, meId) {
  const withDm = new Set(channels.filter((c) => c.dm_key).map((c) => c.dm_user_id));
  return [
    ...channels.filter((c) => !c.left).map((c) => (c.dm_key
      ? { kind: 'dm', id: c.id, label: c.dm_name || 'Notes to self', unread: unread[c.id] || 0 }
      : { kind: 'channel', id: c.id, label: `#${c.name}`, private: !!c.private, archived: !!c.archived_at, unread: unread[c.id] || 0 })),
    ...people.filter((p) => p.id !== meId && !withDm.has(p.id)).map((p) => ({ kind: 'person', id: p.id, label: p.name || p.username, also: [p.username], unread: 0, sub: p.job_title || '' })),
  ];
}

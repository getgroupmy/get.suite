// What a note says under its title in search results: the comment that found it (when its own text didn't), its labels, how far a checklist is (ticked of all), a reminder
// still to come, Archived, and whose it is when it was shared with you. me is your user id; now in milliseconds.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function noteSub(n, me, now = Date.now()) {
  const items = Array.isArray(n.items) ? n.items : null;
  const done = items ? items.filter((i) => i.done).length : 0;
  const at = n.remind_at && n.remind_at > now ? new Date(n.remind_at) : null;
  const said = n.comment_match ? String(n.comment_match).replace(/\s+/g, ' ').trim() : '';
  return [
    said ? `💬 “${said.length > 60 ? `${said.slice(0, 59)}…` : said}”` : null,
    ...(n.labels || []).map((l) => `#${l}`),
    items?.length ? `${done} of ${items.length} ticked` : null,
    at ? `🔔 ${at.getDate()} ${MONTHS[at.getMonth()]}${n.remind_repeat ? ' 🔁' : ''}` : null,
    n.archived ? 'Archived' : null,
    n.owner && n.owner.id !== me ? `from ${n.owner.name}` : null,
  ].filter(Boolean).join(' · ');
}

// Keyboard moves in Chat's conversation list (ids in the order the list shows them).

/** Alt+↑/↓: the conversation above or below (none past either end). With `unread`, the next one in that
 * direction that has unread messages, going round past the end; none if nothing else is unread. */
export function nextConversation(ids, current, dir, unread = null) {
  const list = [...new Set(ids)];
  if (!list.length) return null;
  const at = list.indexOf(current);
  if (!unread) {
    if (at < 0) return list[dir > 0 ? 0 : list.length - 1];
    return list[at + dir] ?? null;
  }
  for (let k = 1; k <= list.length; k++) {
    const i = ((at < 0 ? (dir > 0 ? -1 : 0) : at) + dir * k + list.length * k) % list.length;
    if (list[i] !== current && unread(list[i])) return list[i];
  }
  return null;
}

/** ↑ in an empty message box: your latest message that can still be changed. */
export function lastEditable(messages, meId) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.user_id === meId && !m.poll && !m.deleted_at && !m.bot) return m;
  }
  return null;
}

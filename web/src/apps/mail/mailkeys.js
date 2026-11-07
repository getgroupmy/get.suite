// Keyboard shortcuts in Mail, the familiar ones: c compose, / search, j/k older/newer message,
// u back to the list, r reply, a reply all, f forward, e archive, # delete, s star, Shift+U unread.

const KEYS = { c: 'compose', '/': 'search', j: 'next', k: 'prev', u: 'list', r: 'reply', a: 'replyAll', f: 'forward', e: 'archive', '#': 'delete', s: 'star', U: 'unread' };

/** Is this key press inside something you type in (so it isn't a shortcut)? */
export function typingIn(el) {
  if (!el) return false;
  const tag = el.tagName;
  return el.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/** The action a key press asks for, or null. */
export function mailKey(e) {
  if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return null;
  if (typingIn(e.target)) return null;
  return KEYS[e.key] || null;
}

/** The message to open for next/prev in a list (newest first): next is the older one. */
export function stepMessage(list, openUid, action) {
  if (!list?.length) return null;
  const i = list.findIndex((m) => m.uid === openUid);
  if (i < 0) return action === 'next' || action === 'prev' ? list[0].uid : null;
  const j = action === 'next' ? i + 1 : i - 1;
  return j >= 0 && j < list.length ? list[j].uid : null;
}

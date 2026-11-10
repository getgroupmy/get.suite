// Keyboard shortcuts in Mail, the familiar ones: c compose, / search, j/k older/newer message,
// u back to the list, r reply, a reply all, f forward, e archive, # delete, s star, Shift+U unread,
// v move to a folder, l put on a label (each with a picker you type in).

const KEYS = { c: 'compose', '/': 'search', j: 'next', k: 'prev', u: 'list', r: 'reply', a: 'replyAll', f: 'forward', e: 'archive', '#': 'delete', s: 'star', U: 'unread', v: 'moveTo', l: 'labelAs' };

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

/** The choices whose name has what was typed (ignoring case and accents), those starting with it first. */
export function pickMatches(items, typed) {
  const norm = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const q = norm(typed).trim();
  if (!q) return items;
  const hits = items.filter((it) => norm(it.name).includes(q));
  return [...hits.filter((it) => norm(it.name).startsWith(q)), ...hits.filter((it) => !norm(it.name).startsWith(q))];
}

// "Go to" keys, as in Gmail: G, then a letter within a second and a half, opens an app.
export const GO_TO = [
  ['h', '/home', 'Home'], ['m', '/mail', 'Mail'], ['d', '/drive', 'Drive'], ['c', '/calendar', 'Calendar'], ['k', '/contacts', 'Contacts'],
  ['t', '/tasks', 'Tasks'], ['a', '/chat', 'Chat'], ['n', '/notes', 'Notes'], ['f', '/forms', 'Forms'], ['s', '/settings', 'Settings'],
];
export const GO_WAIT_MS = 1500;

/** Is a key press one to leave alone: typed into something, with a modifier, or while composing text? */
export function notAShortcut(e) {
  if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return true;
  const el = e.target;
  if (!el) return false;
  return !!(el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.closest?.('.grid-wrap, [contenteditable="true"]'));
}

/**
 * A key reader: feed it each key press (key, time in ms) and it says what to do:
 * { wait: true } after G (swallow the key), { to: '/mail' } after G then M, or null (not ours).
 */
export function goReader() {
  let since = 0;
  return (key, at) => {
    const k = String(key || '').toLowerCase();
    if (since && at - since <= GO_WAIT_MS) {
      since = 0;
      const hit = GO_TO.find(([letter]) => letter === k);
      return hit ? { to: hit[1] } : null;
    }
    since = 0;
    if (key === 'g') { since = at; return { wait: true }; }
    return null;
  };
}

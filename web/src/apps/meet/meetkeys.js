// Meet's keyboard: Ctrl+D (⌘D on a Mac) the microphone, Ctrl+E (⌘E) the camera, and holding Space talks while muted
// (push to talk). Not while typing in the chat, a question or any other box.

/** The element takes Space itself: somewhere to type, or a control Space presses (a button, a tick box, a link…). */
export const typingIn = (el) => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON|A|SUMMARY)$/.test(el.tagName || '') || /^(button|checkbox|radio|switch|menuitem|tab|option|slider)$/.test(el.getAttribute?.('role') || ''));

/** What a keydown asks for: 'mic', 'cam', 'hand', 'talk' (Space held down, first press only) or null. (? lists them: Shortcuts.jsx.) */
export function meetKey(e) {
  const mod = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey;
  if (mod && (e.key === 'd' || e.key === 'D')) return 'mic';
  if (mod && (e.key === 'e' || e.key === 'E')) return 'cam';
  if ((e.ctrlKey || e.metaKey) && e.altKey && !e.shiftKey && (e.code === 'KeyH' || /^h$/i.test(e.key))) return 'hand';
  if ((e.key === ' ' || e.code === 'Space') && !mod && !e.altKey && !e.repeat && !typingIn(e.target)) return 'talk';
  return null;
}


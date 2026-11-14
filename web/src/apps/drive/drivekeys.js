// Keyboard shortcuts in Drive's file list. Arrows, F2 and Delete always work; the single letters (J/K,
// S, #, U, X) only while single-key shortcuts are on (Settings → Keyboard shortcuts).
import { notAShortcut } from '../../components/goto.js';

const ALWAYS = { ArrowDown: 'next', ArrowUp: 'prev', F2: 'rename', Delete: 'trash', Home: 'first', End: 'last' };
const LETTERS = { j: 'next', k: 'prev', s: 'star', '#': 'trash', u: 'up', x: 'check' };

/**
 * What a key press asks for: { action, letter } (letter: a single-key shortcut), or null.
 * `onItem`: the focus is on a file (arrows elsewhere, such as in a menu, are left alone).
 */
export function driveKey(e, onItem) {
  if (notAShortcut(e)) return null;
  const always = ALWAYS[e.key];
  if (always) return onItem || ((always === 'next' || always === 'prev') && e.target?.tagName === 'BODY') ? { action: always, letter: false } : null;
  if (e.shiftKey && e.key !== '#') return null;
  const letter = LETTERS[String(e.key || '').toLowerCase()];
  return letter ? { action: letter, letter: true } : null;
}

/** The index to go to from `i` (-1: none yet) among `n` items. */
export function stepIndex(n, i, action) {
  if (!n) return -1;
  if (action === 'first') return 0;
  if (action === 'last') return n - 1;
  if (i < 0) return action === 'prev' ? n - 1 : 0;
  return Math.max(0, Math.min(n - 1, i + (action === 'prev' ? -1 : 1)));
}

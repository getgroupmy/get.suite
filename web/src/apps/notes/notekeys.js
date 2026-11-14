// Keyboard shortcuts in Notes (single keys, off with Settings → Keyboard shortcuts): J / K next or
// previous note, Enter opens it, F pins it, E archives it, # deletes it, C takes a new note.
import { notAShortcut } from '../../components/goto.js';

const KEYS = { j: 'next', k: 'prev', f: 'pin', e: 'archive', '#': 'delete', c: 'new' };

/** What a key press asks for in Notes, or null. */
export function noteKey(e) {
  if (notAShortcut(e) || (e.shiftKey && e.key !== '#')) return null;
  return KEYS[String(e.key || '').toLowerCase()] || null;
}

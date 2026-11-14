// Keyboard shortcuts in Contacts (single keys, off with Settings → Keyboard shortcuts): J / K next or
// previous person, Enter or O opens them (edit, or a colleague's card), S stars, # deletes, C a new contact.
import { notAShortcut } from '../../components/goto.js';

const KEYS = { j: 'next', k: 'prev', o: 'open', s: 'star', '#': 'delete', c: 'new' };

/** What a key press asks for in Contacts, or null. `onRow`: the focus is on a person (Enter opens them). */
export function contactKey(e, onRow) {
  if (e.key === 'Enter' && onRow && !e.ctrlKey && !e.metaKey && !e.altKey) return 'open';
  if (notAShortcut(e) || (e.shiftKey && e.key !== '#')) return null;
  return KEYS[String(e.key || '').toLowerCase()] || null;
}

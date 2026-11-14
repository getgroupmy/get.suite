// Keyboard shortcuts in Tasks (single keys, off with Settings → Keyboard shortcuts):
// J / K next or previous task, O open it, X tick it off, S star it, # delete it, N add a task.
import { notAShortcut } from '../../components/goto.js';

const KEYS = { j: 'next', k: 'prev', o: 'open', x: 'done', s: 'star', '#': 'delete', n: 'new' };

/** What a key press asks for in Tasks, or null. */
export function taskKey(e) {
  if (notAShortcut(e) || e.shiftKey && e.key !== '#') return null;
  return KEYS[String(e.key || '').toLowerCase()] || null;
}

/** The task to move to from `current` (an id, or null for none yet) among `ids`, in order. */
export function stepTask(ids, current, action) {
  if (!ids.length) return null;
  const i = ids.indexOf(current);
  if (i < 0) return action === 'prev' ? ids[ids.length - 1] : ids[0];
  return ids[Math.max(0, Math.min(ids.length - 1, i + (action === 'prev' ? -1 : 1)))];
}

/** After a task leaves the list (ticked off or deleted): the one to go to next (the one below, else above). */
export function afterLeaving(ids, gone) {
  const i = ids.indexOf(gone);
  if (i < 0) return null;
  return ids[i + 1] ?? ids[i - 1] ?? null;
}

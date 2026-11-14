// Calendar's single-key shortcuts (off with Settings → Keyboard shortcuts): T today; D, W, M, Y and A
// for the day, week, month, year and schedule views; J / N next and K / P previous; C a new event.
import { notAShortcut } from '../../components/goto.js';

const KEYS = { t: { today: true }, d: { view: 'day' }, w: { view: 'week' }, m: { view: 'month' }, y: { view: 'year' }, a: { view: 'schedule' },
  j: { step: 1 }, n: { step: 1 }, k: { step: -1 }, p: { step: -1 }, c: { create: true } };

/** What a key press asks the calendar for: { today } | { view } | { step } | { create }, or null. */
export function calKey(e) {
  if (notAShortcut(e) || e.shiftKey) return null;
  return KEYS[String(e.key || '').toLowerCase()] || null;
}

// Dropdown chips in documents (web/src/apps/docs/dropchip.js), as plain text for downloads and search.
/** A dropdown chip's text: its choice, or its first choice before one is picked. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** A date chip's text (web/src/apps/docs/datechip.js): "2026-11-09" → "9 Nov 2026". */
export function dateText(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m || +m[2] < 1 || +m[2] > 12 || +m[3] < 1 || +m[3] > 31) return 'No date';
  return `${+m[3]} ${MONTHS[+m[2] - 1]} ${m[1]}`;
}
export const chipText = (a) => (Array.isArray(a?.options) && (a.options.find((o) => o?.label === a.value)?.label || a.options[0]?.label)) || '—';

/** An event draft's fields as [label, text] lines (for Word, Markdown and search): Event, When, Guests, Where. */
export function eventLines(a = {}) {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(a.date || '') ? dateText(a.date) : '';
  const time = a.start ? `${a.start}${a.end ? `–${a.end}` : ''}` : day ? 'all day' : '';
  return [['Event', a.title || 'Untitled'], ['When', [day, time].filter(Boolean).join(', ')], ['Guests', a.guests || ''], ['Where', a.location || '']].filter(([k, v]) => v || k === 'Event');
}

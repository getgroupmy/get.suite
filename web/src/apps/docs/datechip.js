// Date chips in a document: "@today", "@tomorrow" or "@date" puts in a date as a small pill that
// anyone who can edit changes with a click (a calendar to pick another day). The date is kept as
// YYYY-MM-DD, so every reader, download and search sees the same day; it reads as "9 Nov 2026".
import { Node } from '@tiptap/core';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))
  && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

/** "2026-11-09" → "9 Nov 2026" (the same for everyone, and in downloads and search). */
export function dateText(iso) {
  if (!isDate(iso)) return 'No date';
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** A local day `days` from `now`, as YYYY-MM-DD. */
export function isoDay(now = new Date(), days = 0) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The dates offered for what's typed after "@": today, tomorrow, yesterday, or "date" (pick one). */
export function matchDates(query, now = new Date()) {
  const q = String(query || '').toLowerCase();
  if (!q) return [];
  return [['today', 'Today', 0], ['tomorrow', 'Tomorrow', 1], ['yesterday', 'Yesterday', -1], ['date', 'Date…', 0, true]]
    .filter(([word]) => word.startsWith(q))
    .map(([word, label, days, pick]) => ({ kind: 'date', id: `date:${word}`, label, date: isoDay(now, days), pick: !!pick }));
}

/** How the date stands against today: 'past', 'today' or 'future' (overdue dates show red). */
export function dateWhen(iso, now = new Date()) {
  const today = isoDay(now);
  return iso < today ? 'past' : iso === today ? 'today' : 'future';
}

export const DateChip = Node.create({
  name: 'datechip',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => ({
    date: { default: null, parseHTML: (el) => (isDate(el.getAttribute('data-date')) ? el.getAttribute('data-date') : null), renderHTML: (a) => ({ 'data-date': a.date }) },
  }),
  parseHTML: () => [{ tag: 'span[data-date]' }],
  renderHTML: ({ node, HTMLAttributes }) => ['span', { ...HTMLAttributes, class: `doc-date when-${isDate(node.attrs.date) ? dateWhen(node.attrs.date) : 'none'}`, role: 'button', 'aria-label': `Date: ${dateText(node.attrs.date)}` }, dateText(node.attrs.date)],
  renderText: ({ node }) => dateText(node.attrs.date),
  addCommands() {
    return {
      insertDateChip: (date) => ({ commands }) => commands.insertContent([{ type: this.name, attrs: { date } }, { type: 'text', text: ' ' }]),
    };
  },
});

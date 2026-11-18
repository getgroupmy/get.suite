// Table cells (Docs) with a background colour of their own: Table → Cell colour, kept in Word and .odt.
import { TableCell, TableHeader } from '@tiptap/extension-table';

/** The colours offered for a cell (light ones, so text stays readable; Google Docs' and Word's own first row). */
export const CELL_COLORS = [['', 'None'], ['#fce8e6', 'Light red'], ['#fef7e0', 'Light yellow'], ['#e6f4ea', 'Light green'], ['#e8f0fe', 'Light blue'], ['#f3e8fd', 'Light purple'], ['#e0e0e0', 'Grey']];

/** A cell's colour as #rrggbb, from what a style says (#abc, #aabbcc or rgb(…)); none for white, transparent or anything else. */
export function cellColor(v) {
  const s = String(v || '').trim().toLowerCase();
  let hex = null;
  if (/^#[0-9a-f]{6}$/.test(s)) hex = s;
  else if (/^#[0-9a-f]{3}$/.test(s)) hex = `#${[...s.slice(1)].map((c) => c + c).join('')}`;
  else { const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(s); if (m && (m[4] === undefined || Number(m[4]) > 0)) hex = `#${[m[1], m[2], m[3]].map((n) => Math.min(255, Number(n)).toString(16).padStart(2, '0')).join('')}`; }
  return hex && hex !== '#ffffff' ? hex : null;
}

const background = {
  background: {
    default: null,
    parseHTML: (el) => cellColor(el.getAttribute('data-bg') || el.style.backgroundColor),
    renderHTML: (a) => (a.background ? { 'data-bg': a.background, style: `background-color: ${a.background}` } : {}),
  },
};
export const DocTableCell = TableCell.extend({ addAttributes() { return { ...this.parent?.(), ...background }; } });
export const DocTableHeader = TableHeader.extend({ addAttributes() { return { ...this.parent?.(), ...background }; } });

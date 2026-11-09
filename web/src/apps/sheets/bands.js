// Alternating colours (Sheets): a range coloured in stripes, with a heading row (and optionally a
// footer row) in a stronger shade. Kept on the sheet as
// bands: [{ id, range: "A1:D20", header: true, footer: false, head: "#…", odd: "#…", even: "#…", foot: "#…" }].
// A cell's own fill colour wins over the stripes; conditional formatting wins over both.
import { parseRange } from './charts.js';
import { adjustRange } from './structure.js';

export const BAND_STYLES = [
  { name: 'Blue', head: '#4a86e8', odd: '#ffffff', even: '#e8f0fe', foot: '#c6dafc' },
  { name: 'Green', head: '#34a853', odd: '#ffffff', even: '#e6f4ea', foot: '#bfe3c8' },
  { name: 'Orange', head: '#f6911e', odd: '#ffffff', even: '#feefe3', foot: '#fcd5b2' },
  { name: 'Purple', head: '#8e63ce', odd: '#ffffff', even: '#f3e8fd', foot: '#dccbf3' },
  { name: 'Teal', head: '#16a2b8', odd: '#ffffff', even: '#e4f7fb', foot: '#b9e6ee' },
  { name: 'Grey', head: '#5f6368', odd: '#ffffff', even: '#f1f3f4', foot: '#dadce0' },
];

const HEX = /^#[0-9a-f]{6}$/i;

/** Whether text on a colour should be white (dark colours) or near-black. */
export function textOn(hex) {
  if (!HEX.test(hex || '')) return '#202124';
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.4 ? '#ffffff' : '#202124';
}

/** A band as stored, or null when it isn't a usable one. */
export function cleanBand(b) {
  const g = parseRange(b?.range);
  if (!g) return null;
  const base = BAND_STYLES[0];
  const colour = (k) => (HEX.test(b[k] || '') ? b[k].toLowerCase() : base[k]);
  return {
    id: String(b.id || Math.random().toString(36).slice(2, 10)).slice(0, 20),
    range: String(b.range).toUpperCase().replace(/\$/g, ''),
    header: b.header !== false, footer: !!b.footer,
    head: colour('head'), odd: colour('odd'), even: colour('even'), foot: colour('foot'),
  };
}

/** Two ranges share a cell. */
export function overlaps(a, b) {
  const p = parseRange(a), q = parseRange(b);
  return !!(p && q && p.c1 <= q.c2 && q.c1 <= p.c2 && p.r1 <= q.r2 && q.r1 <= p.r2);
}

/** The band covering a cell (0-based column and row), if any. */
export function bandAt(bands, c, r) {
  for (const b of bands || []) {
    const g = parseRange(b.range);
    if (g && c >= g.c1 && c <= g.c2 && r >= g.r1 && r <= g.r2) return { band: b, g };
  }
  return null;
}

/** The fill a cell gets from the stripes: { kind: 'head'|'odd'|'even'|'foot', fill }, or null. */
export function bandFill(bands, c, r) {
  const hit = bandAt(bands, c, r);
  if (!hit) return null;
  const { band: b, g } = hit;
  if (b.header && r === g.r1) return { kind: 'head', fill: b.head };
  if (b.footer && r === g.r2 && g.r2 > g.r1) return { kind: 'foot', fill: b.foot };
  const first = b.header ? g.r1 + 1 : g.r1;
  return (r - first) % 2 === 0 ? { kind: 'odd', fill: b.odd } : { kind: 'even', fill: b.even };
}

/** The style the stripes give a cell (undefined when it has none, or its own fill). */
export function bandStyle(bands, c, r, fmt) {
  if (!bands?.length || fmt?.fill) return undefined;
  const f = bandFill(bands, c, r);
  if (!f) return undefined;
  return { background: f.fill, ...(!fmt?.color && { color: textOn(f.fill) }), ...(f.kind === 'head' && { fontWeight: 700 }) };
}

/** The bands after rows or columns are inserted or deleted. */
export function adjustBands(bands, change) {
  if (!bands) return bands;
  const out = bands.map((b) => ({ ...b, range: adjustRange(b.range, change) })).filter((b) => b.range);
  return out.length ? out : undefined;
}

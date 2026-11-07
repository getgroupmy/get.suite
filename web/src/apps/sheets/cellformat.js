// Cell formatting for Sheets: how numbers show (the value itself never changes), and which style
// keys a format may have. Formats live per sheet in `formats` ({ A1: { b, i, u, s (strikethrough), wrap, bd (borders: sides from "tblr"),
// color, fill, align, num, dp, cur } }).

export const NUMBER_FORMATS = [['', 'Automatic'], ['number', 'Number'], ['currency', 'Currency'], ['percent', 'Percent']];
export const CURRENCIES = ['MYR', 'USD', 'EUR', 'GBP', 'SGD', 'AUD', 'JPY', 'CNY', 'IDR', 'THB', 'INR'];
const KEYS = ['b', 'i', 'u', 's', 'wrap', 'bd', 'color', 'fill', 'align', 'num', 'dp', 'cur'];
const COLOR_RE = /^#[0-9a-f]{6}$/i;

/** Default decimals for a format (currency: the currency's own, e.g. none for yen). */
export function decimals(fmt) {
  if (Number.isInteger(fmt?.dp)) return fmt.dp;
  if (fmt?.num === 'currency') return new Intl.NumberFormat('en', { style: 'currency', currency: fmt.cur || 'MYR' }).resolvedOptions().maximumFractionDigits;
  if (fmt?.num === 'percent') return 0;
  return 2;
}

/** A number as the format shows it, or null when the format doesn't change it. */
export function formatNumber(v, fmt, locale) {
  if (typeof v !== 'number' || !Number.isFinite(v) || !fmt?.num) return null;
  const dp = Math.max(0, Math.min(10, decimals(fmt)));
  const opts = { minimumFractionDigits: dp, maximumFractionDigits: dp };
  if (fmt.num === 'currency') return new Intl.NumberFormat(locale, { ...opts, style: 'currency', currency: fmt.cur || 'MYR' }).format(v);
  if (fmt.num === 'percent') return new Intl.NumberFormat(locale, { ...opts, style: 'percent' }).format(v);
  return new Intl.NumberFormat(locale, { ...opts, useGrouping: true }).format(v);
}

/** Inline styles for a formatted cell. */
export function cellStyle(fmt) {
  if (!fmt) return undefined;
  const s = {};
  if (fmt.b) s.fontWeight = 700;
  if (fmt.i) s.fontStyle = 'italic';
  if (fmt.u || fmt.s) s.textDecoration = [fmt.u && 'underline', fmt.s && 'line-through'].filter(Boolean).join(' ');
  if (fmt.wrap) { s.whiteSpace = 'pre-wrap'; s.overflowWrap = 'anywhere'; s.textOverflow = 'clip'; }
  for (const [side, css] of [['t', 'borderTop'], ['b', 'borderBottom'], ['l', 'borderLeft'], ['r', 'borderRight']]) if (fmt.bd?.includes(side)) s[css] = '1px solid var(--cell-border, #202124)';
  if (fmt.color) s.color = fmt.color;
  if (fmt.fill) s.background = fmt.fill;
  if (fmt.align) s.textAlign = fmt.align;
  return s;
}

/** Merge a change into a format; null/false values remove keys. Returns null when nothing is left. */
export function mergeFormat(fmt, change) {
  const out = { ...(fmt || {}) };
  for (const [k, v] of Object.entries(change)) {
    if (!KEYS.includes(k)) continue;
    if (v === null || v === undefined || v === false || v === '') delete out[k];
    else if ((k === 'color' || k === 'fill') && !COLOR_RE.test(v)) continue;
    else if (k === 'align' && !['left', 'center', 'right'].includes(v)) continue;
    else if (k === 'bd') { const sides = sideSet(v); if (sides) out.bd = sides; else delete out.bd; }
    else if (k === 'dp') out.dp = Math.max(0, Math.min(10, Math.round(v)));
    else out[k] = ['b', 'i', 'u', 's', 'wrap'].includes(k) ? 1 : v;
  }
  if (!out.num) { delete out.dp; delete out.cur; }
  return Object.keys(out).length ? out : null;
}

/** Border sides in a fixed order ("tblr"), from any string of them; '' when none. */
const sideSet = (v) => 'tblr'.split('').filter((x) => String(v || '').includes(x)).join('');
export const BORDERS = [['all', 'All borders'], ['outer', 'Outer border'], ['bottom', 'Bottom border'], ['none', 'No borders']];
/**
 * A cell's borders after applying a border choice to the selected range (r1..r2, c1..c2):
 * all = every side of every cell; outer = the range's edges, added to what's there; bottom = the
 * range's bottom edge, added; none = cleared.
 */
export function borderFor(kind, range, c, r, current = '') {
  if (kind === 'all') return 'tblr';
  if (kind === 'none') return '';
  const add = kind === 'outer'
    ? `${r === range.r1 ? 't' : ''}${r === range.r2 ? 'b' : ''}${c === range.c1 ? 'l' : ''}${c === range.c2 ? 'r' : ''}`
    : kind === 'bottom' && r === range.r2 ? 'b' : '';
  return sideSet(current + add);
}

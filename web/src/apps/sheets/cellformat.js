// Cell formatting for Sheets: how numbers show (the value itself never changes), and which style
// keys a format may have. Formats live per sheet in `formats` ({ A1: { b, i, u, s (strikethrough), wrap, bd (borders: sides from "tblr"),
// color, fill, align, va (vertical: top, middle or bottom), num, dp, cur, code (num 'custom': a format code, numfmt.js) } }).
import { formatCode, cleanCode } from './numfmt.js';

export const NUMBER_FORMATS = [['', 'Automatic'], ['number', 'Number'], ['currency', 'Currency'], ['percent', 'Percent'], ['date', 'Date'], ['custom', 'Custom…']];
/** How a date shows (fmt.ds), with an example. */
export const DATE_STYLES = [['medium', '7 Nov 2026'], ['short', '07/11/2026'], ['long', 'Saturday, 7 November 2026'], ['iso', '2026-11-07'], ['month', 'Nov 2026']];
export const CURRENCIES = ['MYR', 'USD', 'EUR', 'GBP', 'SGD', 'AUD', 'JPY', 'CNY', 'IDR', 'THB', 'INR'];
const KEYS = ['b', 'i', 'u', 's', 'wrap', 'bd', 'color', 'fill', 'align', 'va', 'num', 'dp', 'cur', 'ds', 'code'];
export const VALIGNS = [['top', 'Top'], ['middle', 'Middle'], ['bottom', 'Bottom']];
const COLOR_RE = /^#[0-9a-f]{6}$/i;

/** Default decimals for a format (currency: the currency's own, e.g. none for yen). */
export function decimals(fmt) {
  if (Number.isInteger(fmt?.dp)) return fmt.dp;
  if (fmt?.num === 'currency') return new Intl.NumberFormat('en', { style: 'currency', currency: fmt.cur || 'MYR' }).resolvedOptions().maximumFractionDigits;
  if (fmt?.num === 'percent') return 0;
  return 2;
}

/** A number as the format shows it, or null when the format doesn't change it. */
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
/** A date value as UTC ms: "2026-11-07" (as DATE and TODAY give) or a spreadsheet date number. */
export function dateValue(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 2958466) return EXCEL_EPOCH + Math.floor(v) * 864e5;
  const m = typeof v === 'string' && /^(\d{4})-(\d{2})-(\d{2})/.exec(v.trim());
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null;
}
/** A date as the style shows it. */
export function formatDate(v, style = 'medium', locale) {
  const t = dateValue(v);
  if (t === null) return null;
  const d = new Date(t);
  const opts = { timeZone: 'UTC' };
  switch (style) {
    case 'iso': return d.toISOString().slice(0, 10);
    case 'short': return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
    case 'long': return d.toLocaleDateString(locale || 'en-GB', { ...opts, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    case 'month': return d.toLocaleDateString(locale || 'en-GB', { ...opts, month: 'short', year: 'numeric' });
    default: return d.toLocaleDateString(locale || 'en-GB', { ...opts, day: 'numeric', month: 'short', year: 'numeric' });
  }
}

export function formatNumber(v, fmt, locale) {
  if (fmt?.num === 'custom') return fmt.code ? formatCode(v, fmt.code)?.text ?? null : null;
  if (fmt?.num === 'date') return formatDate(v, fmt.ds, locale);
  if (typeof v !== 'number' || !Number.isFinite(v) || !fmt?.num) return null;
  const dp = Math.max(0, Math.min(10, decimals(fmt)));
  const opts = { minimumFractionDigits: dp, maximumFractionDigits: dp };
  if (fmt.num === 'currency') return new Intl.NumberFormat(locale, { ...opts, style: 'currency', currency: fmt.cur || 'MYR' }).format(v);
  if (fmt.num === 'percent') return new Intl.NumberFormat(locale, { ...opts, style: 'percent' }).format(v);
  return new Intl.NumberFormat(locale, { ...opts, useGrouping: true }).format(v);
}

/** The colour a custom format gives this value ([Red] in its code), or null. */
export function codeColour(v, fmt) {
  return fmt?.num === 'custom' && fmt.code ? formatCode(v, fmt.code)?.colour || null : null;
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
  if (fmt.va) s.verticalAlign = fmt.va;
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
    else if (k === 'va' && !VALIGNS.some(([x]) => x === v)) continue;
    else if (k === 'bd') { const sides = sideSet(v); if (sides) out.bd = sides; else delete out.bd; }
    else if (k === 'dp') out.dp = Math.max(0, Math.min(10, Math.round(v)));
    else if (k === 'code') { const c = cleanCode(v); if (c) out.code = c; else delete out.code; }
    else out[k] = ['b', 'i', 'u', 's', 'wrap'].includes(k) ? 1 : v;
  }
  if (out.num !== 'custom') delete out.code; else { delete out.dp; delete out.cur; delete out.ds; if (!out.code) delete out.num; }
  if (!out.num) { delete out.dp; delete out.cur; }
  if (out.num !== 'date') delete out.ds; else { delete out.dp; delete out.cur; if (out.ds && !DATE_STYLES.some(([k]) => k === out.ds)) delete out.ds; }
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

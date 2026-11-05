// Cell formatting for Sheets: how numbers show (the value itself never changes), and which style
// keys a format may have. Formats live per sheet in `formats` ({ A1: { b, i, u, color, fill, align, num, dp, cur } }).

export const NUMBER_FORMATS = [['', 'Automatic'], ['number', 'Number'], ['currency', 'Currency'], ['percent', 'Percent']];
export const CURRENCIES = ['MYR', 'USD', 'EUR', 'GBP', 'SGD', 'AUD', 'JPY', 'CNY', 'IDR', 'THB', 'INR'];
const KEYS = ['b', 'i', 'u', 'color', 'fill', 'align', 'num', 'dp', 'cur'];
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
  if (fmt.u) s.textDecoration = 'underline';
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
    else if (k === 'dp') out.dp = Math.max(0, Math.min(10, Math.round(v)));
    else out[k] = ['b', 'i', 'u'].includes(k) ? 1 : v;
  }
  if (!out.num) { delete out.dp; delete out.cur; }
  return Object.keys(out).length ? out : null;
}

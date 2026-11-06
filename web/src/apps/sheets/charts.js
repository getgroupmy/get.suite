// Charts in Sheets: turning a range of cells into labelled series, and the scale math the chart
// drawing uses. Kept free of React so it can be tested on its own.
import { parseRef, cellKey } from './formula.js';

export const CHART_TYPES = [['column', 'Column'], ['bar', 'Bar'], ['line', 'Line'], ['pie', 'Pie']];
export const MAX_SERIES = 8; // the palette has eight colours; more would need repeats
export const MAX_POINTS = 500;
export const PIE_SLICES = 6; // beyond this, the smallest slices are folded into "Other"

/** "A1:C6" (either corner order) → { c1, r1, c2, r2 }, or null. */
export function parseRange(text) {
  const [a, b = a] = String(text || '').toUpperCase().replace(/\$/g, '').trim().split(':');
  const p = parseRef(a), q = parseRef(b);
  if (!p || !q) return null;
  return { c1: Math.min(p.c, q.c), r1: Math.min(p.r, q.r), c2: Math.max(p.c, q.c), r2: Math.max(p.r, q.r) };
}
export const rangeText = (g) => `${cellKey(g.c1, g.r1)}:${cellKey(g.c2, g.r2)}`;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isBlank = (v) => v === null || v === undefined || v === '';
const label = (v) => (isBlank(v) ? '' : typeof v === 'object' ? String(v.error || '') : String(v));

/**
 * Read a range as a chart: the first row is the series names when it holds text, and the first
 * column the category labels when it holds text (or when it's the only non-number column).
 * `value(key)` gives a cell's computed value. Returns { categories, series: [{ name, values }] }.
 */
export function chartData(range, value) {
  const g = typeof range === 'string' ? parseRange(range) : range;
  if (!g) return { categories: [], series: [], error: 'Choose cells like A1:C6' };
  const at = (c, r) => value(cellKey(c, r));
  const cols = g.c2 - g.c1 + 1;
  const textIn = (cells) => cells.some((v) => !isBlank(v) && !isNum(v));
  const headRow = textIn(Array.from({ length: cols }, (_, i) => at(g.c1 + i, g.r1)).slice(cols > 1 ? 1 : 0));
  const r0 = headRow ? g.r1 + 1 : g.r1;
  const rows = Math.min(g.r2 - r0 + 1, MAX_POINTS);
  const firstCol = Array.from({ length: Math.max(0, rows) }, (_, i) => at(g.c1, r0 + i));
  const labelCol = cols > 1 && textIn(firstCol);
  const c0 = labelCol ? g.c1 + 1 : g.c1;
  const series = [];
  for (let c = c0; c <= g.c2 && series.length < MAX_SERIES; c++) {
    const values = Array.from({ length: Math.max(0, rows) }, (_, i) => { const v = at(c, r0 + i); return isNum(v) ? v : null; });
    if (values.every((v) => v === null)) continue; // a column of text or blanks isn't a series
    series.push({ name: headRow ? label(at(c, g.r1)) || `Series ${series.length + 1}` : `Series ${series.length + 1}`, values });
  }
  const categories = Array.from({ length: Math.max(0, rows) }, (_, i) => (labelCol ? label(firstCol[i]) : String(i + 1)));
  // Drop trailing rows that are empty everywhere (a range chosen generously, like A1:B100).
  let n = categories.length;
  while (n > 0 && series.every((s) => s.values[n - 1] === null) && (!labelCol || !categories[n - 1])) n--;
  const more = series.length === MAX_SERIES && g.c2 - c0 + 1 > MAX_SERIES;
  return {
    categories: categories.slice(0, n),
    series: series.map((s) => ({ ...s, values: s.values.slice(0, n) })),
    ...(more && { note: `Only the first ${MAX_SERIES} series are shown` }),
    ...(!series.length && { error: 'There are no numbers in these cells' }),
  };
}

/** The cells around `at` that hold data: grows a box while a neighbouring row or column has something in it. */
export function dataRegion(at, has) {
  const g = { c1: at.c, r1: at.r, c2: at.c, r2: at.r };
  const rowHas = (r) => { for (let c = g.c1; c <= g.c2; c++) if (has(c, r)) return true; return false; };
  const colHas = (c) => { for (let r = g.r1; r <= g.r2; r++) if (has(c, r)) return true; return false; };
  for (let grew = true, n = 0; grew && n < 2000; n++) {
    grew = false;
    if (g.r1 > 0 && rowHas(g.r1 - 1)) { g.r1--; grew = true; }
    if (rowHas(g.r2 + 1)) { g.r2++; grew = true; }
    if (g.c1 > 0 && colHas(g.c1 - 1)) { g.c1--; grew = true; }
    if (colHas(g.c2 + 1)) { g.c2++; grew = true; }
  }
  return g;
}

/** Round axis ticks covering [min, max] (always including 0): { lo, hi, step, ticks }. */
export function niceScale(min, max, count = 5) {
  let lo = Math.min(0, min), hi = Math.max(0, max);
  if (lo === hi) hi = lo + 1;
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  lo = Math.floor(lo / step + 1e-9) * step;
  hi = Math.ceil(hi / step - 1e-9) * step;
  const ticks = [];
  for (let t = lo; t <= hi + step / 2; t += step) ticks.push(Math.abs(t) < step / 1e6 ? 0 : +t.toPrecision(12));
  return { lo, hi, step, ticks };
}

/** Short tick labels: 1200 → "1.2K", 3500000 → "3.5M". */
export function shortNumber(n) {
  const a = Math.abs(n);
  for (const [v, s] of [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) if (a >= v) return `${+(n / v).toFixed(a >= v * 100 ? 0 : 1)}${s}`;
  return String(+n.toPrecision(6));
}

/** Pie slices from the first series: positives only, the smallest folded into "Other" past PIE_SLICES. */
export function pieSlices(data) {
  const s = data.series[0];
  if (!s) return [];
  let items = data.categories.map((name, i) => ({ name: name || `Item ${i + 1}`, value: s.values[i], index: i })).filter((x) => x.value > 0);
  if (items.length > PIE_SLICES) {
    const sorted = [...items].sort((a, b) => b.value - a.value);
    const keep = new Set(sorted.slice(0, PIE_SLICES - 1));
    const other = sorted.slice(PIE_SLICES - 1).reduce((t, x) => t + x.value, 0);
    items = [...items.filter((x) => keep.has(x)), { name: 'Other', value: other, index: -1 }];
  }
  const total = items.reduce((t, x) => t + x.value, 0);
  let a = 0;
  return items.map((x, slot) => { const start = a; a += x.value / total; return { ...x, slot, share: x.value / total, start, end: a }; });
}

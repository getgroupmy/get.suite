// Charts in Sheets: turning a range of cells into labelled series, and the scale math the chart
// drawing uses. Kept free of React so it can be tested on its own.
import { parseRef, cellKey } from './formula.js';

export const CHART_TYPES = [['column', 'Column'], ['stackedColumn', 'Stacked column'], ['bar', 'Bar'], ['stackedBar', 'Stacked bar'], ['line', 'Line'], ['area', 'Area'], ['scatter', 'Scatter'], ['pie', 'Pie'], ['doughnut', 'Doughnut'], ['histogram', 'Histogram'], ['waterfall', 'Waterfall']];
export const isStacked = (t) => t === 'stackedColumn' || t === 'stackedBar';
export const isRound = (t) => t === 'pie' || t === 'doughnut';
export const isHorizontal = (t) => t === 'bar' || t === 'stackedBar';

/**
 * Stacked bars: for each series and category, where its piece starts and ends ([from, to], or null):
 * positive values stack up from 0, negative ones down, in series order.
 */
export function stackedRuns(series, n) {
  const out = series.map(() => Array(n).fill(null));
  for (let i = 0; i < n; i++) {
    let up = 0, down = 0;
    series.forEach((s, si) => {
      const v = s.values[i];
      if (v === null || v === undefined || v === 0) return;
      if (v > 0) { out[si][i] = [up, up + v]; up += v; } else { out[si][i] = [down + v, down]; down += v; }
    });
  }
  return out;
}

/**
 * A scatter chart's points: the X values come from the first column of numbers when the rows have
 * no names (its other columns are the Y series), from numeric row names, or else 1, 2, 3….
 * { xName, points: [{ name, values: [[x, y]…] }] } (rows missing either are left out).
 */
export function scatterOf(data) {
  const numericNames = data.categories.length > 0 && data.categories.every((c) => c !== '' && !Number.isNaN(Number(c)));
  const rowNumbers = data.categories.every((c, i) => c === String(i + 1));
  let xs, ys, xName = '';
  if (rowNumbers && data.series.length > 1) { xs = data.series[0].values; ys = data.series.slice(1); xName = data.series[0].name; }
  else { xs = data.categories.map((c, i) => (numericNames ? Number(c) : i + 1)); ys = data.series; }
  return { xName, points: ys.map((s) => ({ name: s.name, values: s.values.map((y, i) => [xs[i], y]).filter(([x, y]) => typeof x === 'number' && typeof y === 'number') })) };
}
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

/** Round axis ticks covering [min, max] (including 0 unless `fit`, for scatter axes): { lo, hi, step, ticks }. */
export function niceScale(min, max, count = 5, fit = false) {
  let lo = fit ? min : Math.min(0, min), hi = fit ? max : Math.max(0, max);
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

/**
 * A histogram: every number in the chart's series, counted into equal, round-numbered ranges
 * (about √n of them, 3 to 30). { categories: ["0–10"…], series: [{ name, values: counts }], bins: [[from, to]…] }.
 * A number on the line between two ranges counts in the higher one; the top range takes its upper end too.
 */
export function histogramOf(data, bucketCount) {
  const vals = data.series.flatMap((s) => s.values).filter(isNum);
  const name = data.series.length === 1 ? data.series[0].name : 'Count';
  if (!vals.length) return { categories: [], series: [], bins: [], error: 'There are no numbers in these cells' };
  const min = Math.min(...vals), max = Math.max(...vals);
  const want = bucketCount || Math.max(3, Math.min(30, Math.ceil(Math.sqrt(vals.length))));
  const sc = min === max ? { lo: Math.floor(min) - 0.5 * want, step: 1 } : niceScale(min, max, want, true);
  const step = sc.step;
  let n = Math.max(1, Math.ceil((max - sc.lo) / step - 1e-9));
  if (sc.lo + n * step <= max - 1e-9 * step) n++;
  const bins = Array.from({ length: n }, (_, k) => [+(sc.lo + k * step).toPrecision(12), +(sc.lo + (k + 1) * step).toPrecision(12)]);
  const counts = bins.map(() => 0);
  for (const v of vals) counts[Math.min(n - 1, Math.max(0, Math.floor((v - sc.lo) / step + 1e-9)))]++;
  return { categories: bins.map(([a, b]) => `${shortNumber(a)}–${shortNumber(b)}`), series: [{ name: name === 'Series 1' ? 'Count' : `${name} (count)`, values: counts }], bins };
}

/**
 * A waterfall: the first series as changes that add up, each bar floating from the running total
 * before it to the one after, and a last bar for the total. { categories, series (the changes and
 * the total, for the table), steps: [{ from, to, kind: 'up' | 'down' | 'total' }] }.
 */
export function waterfallOf(data) {
  const s = data.series[0];
  if (!s) return { categories: [], series: [], steps: [], error: 'There are no numbers in these cells' };
  let at = 0;
  const steps = s.values.map((v) => { const from = at; at += v ?? 0; return { from, to: at, kind: (v ?? 0) < 0 ? 'down' : 'up' }; });
  steps.push({ from: 0, to: at, kind: 'total' });
  return { categories: [...data.categories, 'Total'], series: [{ name: s.name, values: [...s.values, +at.toPrecision(15)] }], steps };
}

// A copy of the chart shapes in web/src/apps/sheets/charts.js (histogramOf, waterfallOf and the scale
// math they use), so PowerPoint and Excel downloads draw the same histogram and waterfall as the page.

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

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


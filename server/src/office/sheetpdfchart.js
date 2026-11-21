// A spreadsheet's chart drawn into a PDF page (pdf-lib, vector): the same reading of its cells as the Excel download
// (chartLayout: a heading row gives the series' names, a text column the categories), its title, and a legend.
// Column, bar, stacked, line, area, scatter, pie and doughnut charts; histograms and waterfalls drawn as columns.
import { rgb } from 'pdf-lib';
import { chartLayout } from './xlsxcharts.js';
import { colName } from '../sheetcalc/formula.js';

const PALETTE = ['1A73E8', 'E8710A', '1E8E3E', 'D93025', '9334E6', '12B5CB', 'F9AB00', '5F6368'];
const colour = (i) => { const n = parseInt(PALETTE[i % PALETTE.length], 16); return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255); };
const GREY = rgb(0.45, 0.45, 0.45), LINE = rgb(0.85, 0.85, 0.85), INK = rgb(0.15, 0.15, 0.15);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

/** The chart's numbers: { categories, series: [{ name, values }] } from `value(key)`, the cells' worked-out values. */
export function chartNumbers(chart, value) {
  const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i.exec(String(chart.range || '').replace(/\$/g, ''));
  if (!m) return null;
  const cells = {};
  const ci = (s) => [...s.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  const [c1, r1, c2, r2] = [ci(m[1]), Number(m[2]) - 1, ci(m[3]), Number(m[4]) - 1];
  if (c2 < c1 || r2 < r1 || (c2 - c1 + 1) * (r2 - r1 + 1) > 20000) return null;
  for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) {
    const k = `${colName(c)}${r + 1}`;
    let v; try { v = value(k); } catch { v = null; }
    if (v !== null && v !== undefined && v !== '' && typeof v !== 'object') cells[k] = typeof v === 'number' ? String(v) : String(v);
  }
  const lay = chartLayout(`${m[1]}${m[2]}:${m[3]}${m[4]}`, cells);
  if (!lay || !lay.series.length) return null;
  const rows = Array.from({ length: Math.min(200, r2 - lay.r0 + 1) }, (_, i) => lay.r0 + i);
  return {
    categories: rows.map((r, i) => (lay.labelCol ? String(cells[`${colName(c1)}${r + 1}`] ?? '') : String(i + 1))),
    series: lay.series.map((s) => ({ name: s.name, values: rows.map((r) => num(cells[`${colName(s.col)}${r + 1}`])) })),
  };
}

/** Draw `chart` with its numbers `data` in the box (x, y = top-left, w, h in points) on `page`, text in `font`. */
export function drawChart(page, chart, data, { x, y, w, h }, font, safe = (t) => t) {
  page.drawRectangle({ x, y: y - h, width: w, height: h, color: rgb(1, 1, 1), borderColor: LINE, borderWidth: 0.6 });
  const fit = (t, size, max) => { let s = safe(String(t ?? '')); while (s.length > 1 && font.widthOfTextAtSize(s, size) > max) s = s.slice(0, -1); return s; };
  let top = y - 6;
  if (chart.title) { page.drawText(fit(chart.title, 10, w - 12), { x: x + 6, y: top - 10, size: 10, font, color: INK }); top -= 16; }
  if (!data) { page.drawText('No numbers to chart', { x: x + 6, y: top - 12, size: 8, font, color: GREY }); return; }
  const type = chart.type || 'column';
  const round = type === 'pie' || type === 'doughnut';
  // The legend: the series (or, for a pie, its slices), along the bottom.
  const keys = round ? data.categories.map((c, i) => ({ name: c, i })) : data.series.map((s, i) => ({ name: s.name, i }));
  let lx = x + 6, ly = y - h + 6;
  if (keys.length > 1 || round) for (const k of keys.slice(0, 12)) {
    const label = fit(k.name, 7, 90);
    const lw = 10 + font.widthOfTextAtSize(label, 7) + 10;
    if (lx + lw > x + w - 4) break;
    page.drawRectangle({ x: lx, y: ly, width: 7, height: 7, color: colour(k.i) });
    page.drawText(label, { x: lx + 10, y: ly, size: 7, font, color: GREY });
    lx += lw;
  }
  const bottom = y - h + ((keys.length > 1 || round) ? 18 : 6);
  const area = { x: x + 34, y: bottom + 12, w: w - 44, h: Math.max(10, top - bottom - 18) };
  if (round) {
    const vals = data.series[0].values.map((v) => Math.max(0, v || 0));
    const total = vals.reduce((a, b) => a + b, 0);
    if (!total) return;
    const r = Math.min(area.w, area.h + 12) / 2 - 2, cx = x + w / 2, cy = (area.y + area.h / 2) + 6;
    let a0 = -Math.PI / 2;
    vals.forEach((v, i) => {
      if (!v) return;
      const a1 = a0 + (v / total) * Math.PI * 2;
      const p = (a, rr) => `${(rr * Math.cos(a)).toFixed(2)} ${(rr * Math.sin(a)).toFixed(2)}`;
      const big = a1 - a0 > Math.PI ? 1 : 0;
      const path = v === total ? `M ${-r} 0 A ${r} ${r} 0 1 1 ${r} 0 A ${r} ${r} 0 1 1 ${-r} 0 Z` : `M 0 0 L ${p(a0, r)} A ${r} ${r} 0 ${big} 1 ${p(a1, r)} Z`;
      page.drawSvgPath(path, { x: cx, y: cy, color: colour(i), borderColor: rgb(1, 1, 1), borderWidth: 0.8 });
      a0 = a1;
    });
    if (type === 'doughnut') page.drawCircle({ x: cx, y: cy, size: r * 0.55, color: rgb(1, 1, 1) });
    return;
  }
  const horiz = type === 'bar' || type === 'stackedBar', stacked = type === 'stackedColumn' || type === 'stackedBar';
  const n = data.categories.length;
  const sums = data.categories.map((_, i) => data.series.reduce((a, s) => a + Math.max(0, s.values[i] || 0), 0));
  const all = stacked ? sums : data.series.flatMap((s) => s.values.filter((v) => v !== null));
  const lo = type === 'scatter' ? Math.min(0, ...all) : Math.min(0, ...all), hi = Math.max(1e-9, ...all);
  const span = hi - lo || 1;
  // Axis lines and the top and bottom values.
  page.drawLine({ start: { x: area.x, y: area.y }, end: { x: area.x + area.w, y: area.y }, thickness: 0.6, color: GREY });
  page.drawLine({ start: { x: area.x, y: area.y }, end: { x: area.x, y: area.y + area.h }, thickness: 0.6, color: GREY });
  const tick = (v) => (Math.abs(v) >= 1000 ? `${Math.round(v / 100) / 10}k` : String(Math.round(v * 100) / 100));
  if (!horiz) { page.drawText(tick(hi), { x: x + 4, y: area.y + area.h - 3, size: 6, font, color: GREY }); page.drawText(tick(lo), { x: x + 4, y: area.y - 3, size: 6, font, color: GREY }); }
  const sx = (i) => area.x + ((i + 0.5) / n) * area.w;
  const sy = (v) => area.y + ((v - lo) / span) * area.h;
  // The category labels (as many as fit).
  const every = Math.max(1, Math.ceil((n * 30) / area.w));
  if (!horiz) data.categories.forEach((c, i) => { if (i % every === 0) { const t = fit(c, 6, (area.w / n) * every - 2); page.drawText(t, { x: sx(i) - font.widthOfTextAtSize(t, 6) / 2, y: area.y - 9, size: 6, font, color: GREY }); } });
  if (type === 'line' || type === 'area' || type === 'scatter') {
    data.series.forEach((s, k) => {
      const pts = s.values.map((v, i) => (v === null ? null : [sx(i), sy(v)])).filter(Boolean);
      if (type === 'scatter') { for (const [px, py] of pts) page.drawCircle({ x: px, y: py, size: 2.2, color: colour(k) }); return; }
      if (type === 'area' && pts.length > 1) {
        const d = `M ${pts[0][0]} ${-area.y} ${pts.map(([px, py]) => `L ${px} ${-py}`).join(' ')} L ${pts.at(-1)[0]} ${-area.y} Z`;
        page.drawSvgPath(d, { x: 0, y: 0, color: colour(k), opacity: 0.45, borderWidth: 0 });
      }
      for (let i = 1; i < pts.length; i++) page.drawLine({ start: { x: pts[i - 1][0], y: pts[i - 1][1] }, end: { x: pts[i][0], y: pts[i][1] }, thickness: 1.4, color: colour(k) });
    });
    return;
  }
  // Bars: side by side in each category, or stacked.
  const groups = stacked ? 1 : data.series.length;
  const slot = (horiz ? area.h : area.w) / n, bw = (slot * 0.7) / groups;
  data.categories.forEach((c, i) => {
    let base = 0;
    data.series.forEach((s, k) => {
      const v = s.values[i];
      if (v === null) return;
      const from = stacked ? base : Math.min(0, v), to = stacked ? base + Math.max(0, v) : Math.max(0, v);
      if (stacked) base = to;
      const g = stacked ? 0 : k;
      if (horiz) {
        const yy = area.y + area.h - (i + 0.15) * slot - (g + 1) * bw;
        const x0 = area.x + ((from - lo) / span) * area.w;
        page.drawRectangle({ x: x0, y: yy, width: Math.max(0.3, ((to - from) / span) * area.w), height: bw * 0.92, color: colour(k) });
      } else {
        const xx = area.x + (i + 0.15) * slot + g * bw;
        page.drawRectangle({ x: xx, y: sy(from), width: bw * 0.92, height: Math.max(0.3, ((to - from) / span) * area.h), color: colour(k) });
      }
    });
  });
}

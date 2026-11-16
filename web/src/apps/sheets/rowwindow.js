// A big sheet draws only the rows near what's on screen (plus its frozen rows), with empty space standing in
// for the rest, so a sheet of tens of thousands of rows opens and scrolls as quickly as a small one.
import { parseRef } from './formula.js';

export const WINDOW_FROM = 400; // sheets with more rows than this draw a window of them
export const ROW_H = 25; // a row's height on screen when none is set (24px and its border)

/** Where each row starts (tops[r]) and the sheet's height (tops[rows]); hidden rows take no space. */
export function rowTops(rows, heightOf, hidden = new Set()) {
  const tops = new Float64Array(rows + 1);
  for (let r = 0; r < rows; r++) tops[r + 1] = tops[r] + (hidden.has(r) ? 0 : heightOf(r) || ROW_H);
  return tops;
}

/** The first row whose bottom is below y. */
function rowAt(tops, y) {
  let lo = 0, hi = tops.length - 2;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (tops[mid + 1] > y) hi = mid; else lo = mid + 1; }
  return Math.max(0, lo);
}

/**
 * The rows to draw for the part of the sheet from y0 to y1 (in sheet pixels): frozen rows, then a gap, the
 * rows in view, and a gap for the rest. Merged cells reaching into the window are drawn whole. Returns a list
 * of row numbers and { gap: height } entries.
 */
export function rowWindow(tops, y0, y1, { frozen = 0, spans = new Map() } = {}) {
  const rows = tops.length - 1;
  let from = rowAt(tops, Math.max(0, y0)), to = Math.min(rows, rowAt(tops, y1) + 1);
  for (let moved = true; moved;) {
    moved = false;
    for (const [k, s] of spans) {
      const p = parseRef(k);
      if (!p) continue;
      const end = p.r + (s.rowSpan || 1);
      if (p.r < from && end > from) { from = p.r; moved = true; }
      if (p.r < to && end > to) { to = Math.min(rows, end); moved = true; }
    }
  }
  const out = [];
  const lead = Math.min(frozen, from);
  for (let r = 0; r < lead; r++) out.push(r);
  if (tops[from] - tops[lead] > 0) out.push({ gap: tops[from] - tops[lead], key: 'gap-top' });
  for (let r = Math.max(from, lead); r < to; r++) out.push(r);
  if (tops[rows] - tops[to] > 0) out.push({ gap: tops[rows] - tops[to], key: 'gap-end' });
  return out;
}

export const COLS_FROM = 40; // sheets with more columns than this draw a window of them

/** Where each column starts (lefts[c]) and the sheet's width (lefts[cols]); hidden columns take no space. */
export function colLefts(cols, widthOf, hidden = new Set()) {
  const lefts = new Float64Array(cols + 1);
  for (let c = 0; c < cols; c++) lefts[c + 1] = lefts[c] + (hidden.has(c) ? 0 : widthOf(c));
  return lefts;
}

/**
 * The columns to draw for the part of the sheet from x0 to x1 (in sheet pixels): frozen columns, then a gap,
 * the columns in view, and a gap for the rest. Merged cells reaching into the window are drawn whole.
 * Returns column numbers and { gap: width, key } entries.
 */
export function colWindow(lefts, x0, x1, { frozen = 0, spans = new Map() } = {}) {
  const cols = lefts.length - 1;
  let from = rowAt(lefts, Math.max(0, x0)), to = Math.min(cols, rowAt(lefts, x1) + 1);
  for (let moved = true; moved;) {
    moved = false;
    for (const [k, s] of spans) {
      const p = parseRef(k);
      if (!p) continue;
      const end = p.c + (s.colSpan || 1);
      if (p.c < from && end > from) { from = p.c; moved = true; }
      if (p.c < to && end > to) { to = Math.min(cols, end); moved = true; }
    }
  }
  const out = [];
  const lead = Math.min(frozen, from);
  for (let c = 0; c < lead; c++) out.push(c);
  if (lefts[from] - lefts[lead] > 0) out.push({ gap: lefts[from] - lefts[lead], key: 'gap-left' });
  for (let c = Math.max(from, lead); c < to; c++) out.push(c);
  if (lefts[cols] - lefts[to] > 0) out.push({ gap: lefts[cols] - lefts[to], key: 'gap-right' });
  return out;
}

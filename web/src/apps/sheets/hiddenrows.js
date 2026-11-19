// Which rows a sheet hides, by its filter, its slicers, Hide row and collapsed groups: for the grid, and for formulas
// (SUBTOTAL 101–111, AGGREGATE). The server has a copy (server/src/sheetcalc), for downloads and PDFs.
import { cellKey, colIndex, display, parseRef } from './formula.js';
import { meetsCondition, cleanCondition } from './filtercond.js';
import { collapsedOn } from './groups.js';

/** 'A1:D20' as { c1, r1, c2, r2 } (0-based), or null. */
function rangeOf(text) {
  const [a, b = a] = String(text || '').toUpperCase().replace(/\$/g, '').trim().split(':');
  const p = parseRef(a), q = parseRef(b);
  if (!p || !q) return null;
  return { c1: Math.min(p.c, q.c), r1: Math.min(p.r, q.r), c2: Math.max(p.c, q.c), r2: Math.max(p.r, q.r) };
}

/** How a value shows in the filter's list ("" for an empty cell). */
export const filterLabel = (v) => (v === null || v === undefined || v === '' ? '' : display(v));

/** The filter's range, reaching down to the last row with data in its columns. */
export function filterArea(filter, cells) {
  const g = rangeOf(filter?.range);
  if (!g) return null;
  let last = g.r2;
  for (const k of Object.keys(cells || {})) {
    const m = /^([A-Z]+)(\d+)$/.exec(k);
    if (!m || cells[k] === '' || cells[k] === undefined) continue;
    const c = colIndex(m[1]), r = Number(m[2]) - 1;
    if (c >= g.c1 && c <= g.c2 && r > last && r <= last + 1000) last = r;
  }
  return { ...g, r2: last };
}

/** The rows (0-based) the filter hides. `value(key)` gives a cell's value. */
export function hiddenRows(filter, cells, value) {
  const out = new Set();
  const g = filterArea(filter, cells);
  if (!g) return out;
  const cols = Object.entries(filter.hidden || {}).filter(([, list]) => list?.length).map(([col, list]) => [colIndex(col), new Set(list)]);
  const conds = Object.entries(filter.cond || {}).filter(([, c]) => cleanCondition(c)).map(([col, c]) => [colIndex(col), c]);
  if (!cols.length && !conds.length) return out;
  for (let r = g.r1 + 1; r <= g.r2; r++) {
    if (cols.some(([c, hide]) => hide.has(filterLabel(value(cellKey(c, r)))))
      || conds.some(([c, cond]) => !meetsCondition(cond, value(cellKey(c, r))))) out.add(r);
  }
  return out;
}

export const slicerAsFilter = (s) => ({ range: s.range, hidden: { [s.col]: s.hidden || [] } });

/** The rows (0-based) all the sheet's slicers hide. */
export function slicerHiddenRows(slicers, cells, value) {
  const out = new Set();
  for (const s of Object.values(slicers || {})) if (s?.hidden?.length) for (const r of hiddenRows(slicerAsFilter(s), cells, value)) out.add(r);
  return out;
}

/** Every row a sheet hides: by its filter, its slicers, Hide row, or a collapsed group. */
export function sheetHiddenRows(sheet, value) {
  const cells = sheet?.cells || {};
  const h = hiddenRows(sheet?.filter, cells, value);
  for (const r of slicerHiddenRows(sheet?.slicers, cells, value)) h.add(r);
  for (const r of sheet?.hide?.rows || []) h.add(r);
  for (const r of collapsedOn(sheet?.groups, 'row')) h.add(r);
  return h;
}

/** The rows a sheet hides, for formulas (SUBTOTAL 101–111, AGGREGATE): { all, filtered }. The sheet's own filter and
 *  slicers count as filtering, and Hide row and collapsed groups as hidden too; a filter view open on one screen
 *  doesn't change what formulas give everyone. */
export function formulaHiddenRows(sheet, value) {
  const cells = sheet?.cells || {};
  const filtered = hiddenRows(sheet?.filter, cells, value);
  for (const r of slicerHiddenRows(sheet?.slicers, cells, value)) filtered.add(r);
  return { all: sheetHiddenRows(sheet, value), filtered };
}

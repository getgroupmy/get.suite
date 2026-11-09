// Filters: a sheet can have one, over a range whose first row holds the headings. For each column,
// the values to hide; rows below the headings with a hidden value aren't shown (for everyone; the
// data is untouched). Kept as { range: "A1:D20", hidden: { B: ["Done", ""] } } ("" = empty cells).
// The range grows to take in rows added below it. A column can also have a condition (filtercond.js):
// { ..., cond: { C: { op: 'gt', a: '10' } } } hides rows whose value doesn't meet it.
import { parseRange, rangeText } from './charts.js';
import { cellKey, colName, colIndex, display } from './formula.js';
import { adjustRange, adjustKey } from './structure.js';
import { meetsCondition, cleanCondition } from './filtercond.js';

/** How a value shows in the filter's list ("" for an empty cell). */
export const filterLabel = (v) => (v === null || v === undefined || v === '' ? '' : display(v));

/** The filter's range, reaching down to the last row with data in its columns. */
export function filterArea(filter, cells) {
  const g = parseRange(filter?.range);
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

/** The different values in a column of the filter (below the headings), with how often each comes. */
export function columnValues(filter, cells, value, c) {
  const g = filterArea(filter, cells);
  const counts = new Map();
  if (!g) return [];
  for (let r = g.r1 + 1; r <= g.r2; r++) { const l = filterLabel(value(cellKey(c, r))); counts.set(l, (counts.get(l) || 0) + 1); }
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  return [...counts].map(([label, count]) => ({ label, count })).sort((a, b) => (a.label === '') - (b.label === '') || collator.compare(a.label, b.label));
}

/** The filter after rows or columns are inserted or deleted (null when its headings are gone). */
export function adjustFilter(filter, change) {
  if (!filter) return filter;
  const g = parseRange(filter.range);
  if (!g) return null;
  if (change.axis === 'row' && change.count < 0 && g.r1 >= change.at && g.r1 < change.at - change.count) return null; // the heading row went
  const range = adjustRange(filter.range, change);
  if (!range) return null;
  const move = (map) => {
    const out = {};
    for (const [col, v] of Object.entries(map || {})) {
      const k = change.axis === 'col' ? adjustKey(`${col}1`, change) : `${col}1`;
      if (k) out[k.replace(/\d+$/, '')] = v;
    }
    return out;
  };
  const cond = move(filter.cond);
  return { range, hidden: move(filter.hidden), ...(Object.keys(cond).length && { cond }) };
}

/** Whether a filter column hides anything (ticked-off values or a condition). */
export function columnFiltered(filter, col) {
  return !!(filter?.hidden?.[col]?.length || cleanCondition(filter?.cond?.[col]));
}

export { rangeText, colName };

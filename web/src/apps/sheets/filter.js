// Filters: a sheet can have one, over a range whose first row holds the headings. For each column,
// the values to hide; rows below the headings with a hidden value aren't shown (for everyone; the
// data is untouched). Kept as { range: "A1:D20", hidden: { B: ["Done", ""] } } ("" = empty cells).
// The range grows to take in rows added below it. A column can also have a condition (filtercond.js):
// { ..., cond: { C: { op: 'gt', a: '10' } } } hides rows whose value doesn't meet it.
import { parseRange, rangeText } from './charts.js';
import { cellKey, colName } from './formula.js';
import { cleanCondition } from './filtercond.js';
import { adjustRange, adjustKey } from './structure.js';
import { filterLabel, filterArea, hiddenRows, slicerAsFilter, slicerHiddenRows, sheetHiddenRows, formulaHiddenRows } from './hiddenrows.js';

export { filterLabel, filterArea, hiddenRows, slicerAsFilter, slicerHiddenRows, sheetHiddenRows, formulaHiddenRows };

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

// ---- slicers: a control on the sheet that filters a table by one column's values, like the filter's
// ▾ menu but always in view (handy above a chart). A sheet keeps them as
// slicers: { id: { range: "A1:D20", col: "B", hidden: ["East"], x, y } }. Their hidden rows add to the filter's.
/** The slicers after rows or columns are inserted or deleted (one whose column or headings went is dropped). */
export function adjustSlicers(slicers, change) {
  if (!slicers) return slicers;
  const out = {};
  for (const [id, s] of Object.entries(slicers)) {
    const f = adjustFilter(slicerAsFilter(s), change);
    const col = f && Object.keys(f.hidden)[0];
    if (!f || !col) continue;
    out[id] = { ...s, range: f.range, col, hidden: f.hidden[col] };
  }
  return out;
}

/** What a slicer's chip says: "All", the one value shown, or "3 of 5". */
export function slicerSummary(s, values) {
  const hidden = new Set(s.hidden || []);
  const shown = values.filter((v) => !hidden.has(v.label));
  if (shown.length === values.length) return 'All';
  if (shown.length === 1) return shown[0].label || '(Blanks)';
  return `${shown.length} of ${values.length}`;
}



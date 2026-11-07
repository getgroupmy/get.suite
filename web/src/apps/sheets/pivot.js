// Pivot tables: summarise a table of data by the values in one column (rows), optionally split by
// another (columns), with a sum, count, average, minimum or maximum of a third. Pure functions:
// the editor keeps the pivot's settings on its own sheet and fills it from the data whenever it changes.
import { cellKey, colName } from './formula.js';

export const FNS = [['sum', 'Sum'], ['count', 'Count'], ['average', 'Average'], ['min', 'Minimum'], ['max', 'Maximum']];
export const BLANK = '(blank)';
export const TOTAL = 'Grand total';

const num = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean' || v == null) return null;
  const s = String(v).replace(/[,\s]/g, '');
  return s !== '' && Number.isFinite(Number(s)) ? Number(s) : null;
};
const keyOf = (v) => (v === null || v === undefined || v === '' ? BLANK : typeof v === 'number' ? v : String(v).trim() || BLANK);
/** Numbers first (smallest up), then text A–Z, "(blank)" last. */
export function compareKeys(a, b) {
  if (a === BLANK || b === BLANK) return a === b ? 0 : a === BLANK ? 1 : -1;
  const na = typeof a === 'number', nb = typeof b === 'number';
  if (na && nb) return a - b;
  if (na !== nb) return na ? -1 : 1;
  return String(a).localeCompare(String(b), undefined, { sensitivity: 'base', numeric: true });
}

function summarise(list, fn) {
  if (fn === 'count') return list.length;
  const nums = list.map(num).filter((x) => x !== null);
  if (!nums.length) return fn === 'sum' ? 0 : '';
  if (fn === 'sum') return nums.reduce((s, x) => s + x, 0);
  if (fn === 'average') return nums.reduce((s, x) => s + x, 0) / nums.length;
  return fn === 'min' ? Math.min(...nums) : Math.max(...nums);
}
const tidy = (v) => (typeof v === 'number' ? Number(v.toPrecision(12)) : v);

/**
 * table: [headings, ...rows] (what the cells show). spec: { rows, cols, value, fn } with column numbers
 * within the table (cols and value may be null: no split; count rows). Returns a grid (array of rows).
 */
export function buildPivot(table, { rows, cols = null, value = null, fn = 'sum' }) {
  const [head = [], ...data] = table;
  const f = value === null ? 'count' : fn;
  const what = value === null ? 'Count of rows' : `${FNS.find(([k]) => k === f)?.[1] || 'Sum'} of ${head[value] || colName(value)}`;
  const groups = new Map(); // rowKey -> Map(colKey -> [values])
  const colKeys = new Map();
  const pick = (r) => (value === null ? 1 : r[value]);
  const filled = (r) => r.some((v) => v !== '' && v !== null && v !== undefined);
  for (const r of data.filter(filled)) {
    const rk = keyOf(r[rows]);
    const ck = cols === null ? TOTAL : keyOf(r[cols]);
    if (!groups.has(rk)) groups.set(rk, new Map());
    const g = groups.get(rk);
    if (!g.has(ck)) g.set(ck, []);
    if (f === 'count' && value !== null && (r[value] === '' || r[value] == null)) { /* counts only filled cells */ } else g.get(ck).push(pick(r));
    colKeys.set(ck, true);
  }
  const rk = [...groups.keys()].sort(compareKeys);
  const ck = cols === null ? [] : [...colKeys.keys()].sort(compareKeys);
  const all = (pred) => data.filter(filled).filter(pred).map(pick).filter((v) => !(f === 'count' && value !== null && (v === '' || v == null)));
  // Headings: without a split, "Region | Sum of Sales"; with one, "Sum of Sales | North | South | Grand total".
  const out = [cols === null ? [head[rows] || colName(rows), what] : [what, ...ck, TOTAL]];
  for (const k of rk) {
    const g = groups.get(k);
    const cellsRow = ck.map((c) => (g.has(c) ? tidy(summarise(g.get(c), f)) : ''));
    out.push([k, ...cellsRow, tidy(summarise(all((r) => keyOf(r[rows]) === k), f))]);
  }
  out.push([TOTAL, ...ck.map((c) => tidy(summarise(all((r) => keyOf(r[cols]) === c), f))), tidy(summarise(all(() => true), f))]);
  return out;
}

/** The grid as sheet cells (raw text, like typed in) and formats (headings and totals bold). */
export function pivotCells(grid) {
  const cells = {};
  const formats = {};
  grid.forEach((row, r) => row.forEach((v, c) => {
    if (v === '' || v === null || v === undefined) return;
    const k = cellKey(c, r);
    cells[k] = typeof v === 'number' ? String(v) : String(v).startsWith('=') ? ` ${v}` : String(v); // text is never run as a formula
    if (r === 0 || c === 0 || r === grid.length - 1 || c === row.length - 1) formats[k] = { b: true };
  }));
  return { cells, formats };
}

/** The rows a pivot reads: its columns, from its heading row down to the last row with anything in them. */
export function sourceTable(spec, value, lastRow) {
  const out = [];
  for (let r = spec.r1; r <= lastRow; r++) {
    const row = [];
    for (let c = spec.c1; c <= spec.c2; c++) row.push(value(cellKey(c, r)));
    out.push(row);
  }
  return out;
}

// Changing a sheet's structure: inserting and deleting rows or columns (formulas, formats, widths,
// chart ranges and commented cells follow), and sorting rows. Pure functions on the sheet's JSON.
import { colName, colIndex, cellKey, parseRef, shiftFormula } from './formula.js';

/**
 * A structural change: on `axis` ('row' | 'col'), `count` > 0 inserts that many before index `at`;
 * `count` < 0 deletes -count starting at `at`.
 */
const moveIndex = (i, { at, count }) => {
  if (count > 0) return i >= at ? i + count : i;
  const gone = -count;
  if (i < at) return i;
  if (i < at + gone) return null; // deleted
  return i - gone;
};

/** A range's start and end along one axis after the change, or null if all of it was deleted. */
function moveSpan(a, b, change) {
  if (change.count > 0) return [moveIndex(a, change), moveIndex(b, change)];
  const gone = -change.count, end = change.at + gone - 1;
  if (a >= change.at && b <= end) return null;
  const na = a >= change.at && a <= end ? change.at : moveIndex(a, change);
  const nb = b >= change.at && b <= end ? change.at - 1 : moveIndex(b, change);
  return [na, nb];
}

const REF = /("(?:[^"]|"")*")|(\$?)([A-Z]+)(\$?)(\d+)(?::(\$?)([A-Z]+)(\$?)(\d+))?(?![A-Z0-9_(])/gi;

/** A formula with its cell references moved for a structural change ("#REF!" where they were deleted). */
export function adjustFormula(raw, change) {
  if (typeof raw !== 'string' || !raw.startsWith('=')) return raw;
  const row = change.axis === 'row';
  return raw.replace(REF, (m, str, ca, col, ra, r, ca2, col2, ra2, r2) => {
    if (str) return str;
    const p = { c: colIndex(col), r: Number(r) - 1 };
    const text = (c, rr, cAbs, rAbs) => `${cAbs}${colName(c)}${rAbs}${rr + 1}`;
    if (col2 === undefined) {
      const n = moveIndex(row ? p.r : p.c, change);
      if (n === null) return '#REF!';
      return row ? text(p.c, n, ca, ra) : text(n, p.r, ca, ra);
    }
    const q = { c: colIndex(col2), r: Number(r2) - 1 };
    const span = row ? moveSpan(Math.min(p.r, q.r), Math.max(p.r, q.r), change) : moveSpan(Math.min(p.c, q.c), Math.max(p.c, q.c), change);
    if (!span) return '#REF!';
    return row
      ? `${text(p.c, span[0], ca, ra)}:${text(q.c, span[1], ca2, ra2)}`
      : `${text(span[0], p.r, ca, ra)}:${text(span[1], q.r, ca2, ra2)}`;
  });
}

/** A cell key ("B7") after the change, or null if deleted. */
export function adjustKey(key, change) {
  const p = parseRef(key);
  if (!p) return key;
  if (change.axis === 'row') { const r = moveIndex(p.r, change); return r === null ? null : cellKey(p.c, r); }
  const c = moveIndex(p.c, change);
  return c === null ? null : cellKey(c, p.r);
}

/** A range ("A1:C9") after the change, or null if all of it was deleted. */
export function adjustRange(text, change) {
  const [a, b = a] = String(text || '').toUpperCase().split(':');
  const p = parseRef(a), q = parseRef(b);
  if (!p || !q) return text;
  const row = change.axis === 'row';
  const span = row ? moveSpan(Math.min(p.r, q.r), Math.max(p.r, q.r), change) : moveSpan(Math.min(p.c, q.c), Math.max(p.c, q.c), change);
  if (!span) return null;
  const [c1, c2] = row ? [Math.min(p.c, q.c), Math.max(p.c, q.c)] : span;
  const [r1, r2] = row ? span : [Math.min(p.r, q.r), Math.max(p.r, q.r)];
  return `${cellKey(c1, r1)}:${cellKey(c2, r2)}`;
}

/** The sheet (one entry of `sheets`) with a row/column change applied to everything in it. */
export function applyStructure(sheet, change) {
  const cells = {}, formats = {}, colWidths = {}, charts = {};
  for (const [k, v] of Object.entries(sheet.cells || {})) { const nk = adjustKey(k, change); if (nk) cells[nk] = adjustFormula(v, change); }
  for (const [k, v] of Object.entries(sheet.formats || {})) { const nk = adjustKey(k, change); if (nk) formats[nk] = v; }
  for (const [k, v] of Object.entries(sheet.colWidths || {})) {
    if (change.axis !== 'col') { colWidths[k] = v; continue; }
    const n = moveIndex(colIndex(k), change);
    if (n !== null) colWidths[colName(n)] = v;
  }
  for (const [id, ch] of Object.entries(sheet.charts || {})) { const range = adjustRange(ch.range, change); if (range) charts[id] = { ...ch, range }; }
  const rules = (sheet.rules || []).map((r) => ({ ...r, range: adjustRange(r.range, change) })).filter((r) => r.range);
  return { ...sheet, cells, colWidths, ...(sheet.formats && { formats }), ...(sheet.charts && { charts }), ...(sheet.rules && { rules }) };
}

/** Does the top row of a range look like headings: all text, over at least one column of numbers? */
export function looksLikeHeader(range, value) {
  if (range.r2 <= range.r1) return false;
  let filled = 0, overNumbers = false;
  for (let c = range.c1; c <= range.c2; c++) {
    const top = value(cellKey(c, range.r1));
    if (top === null || top === '') continue;
    if (typeof top !== 'string') return false;
    filled++;
    if (typeof value(cellKey(c, range.r1 + 1)) === 'number') overNumbers = true;
  }
  return filled > 0 && overNumbers;
}

const rank = (v) => (typeof v === 'number' ? 0 : typeof v === 'boolean' ? 2 : v === null || v === '' ? 4 : v && typeof v === 'object' ? 3 : 1);

/**
 * Sort the rows of `range` by column `byCol` (ascending, or descending with `desc`), keeping the
 * header row in place if `header`. Numbers come before text; empty cells go last either way.
 * Formulas move with their row (their references move as when cut and pasted). Returns the new
 * { cells, formats } for the whole sheet.
 */
export function sortRange(sheet, range, byCol, { desc = false, header = false, value }) {
  const r1 = header ? range.r1 + 1 : range.r1;
  const rows = [];
  for (let r = r1; r <= range.r2; r++) rows.push(r);
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const key = (r) => value(cellKey(byCol, r));
  rows.sort((a, b) => {
    const x = key(a), y = key(b);
    const rx = rank(x), ry = rank(y);
    if (rx === 4 || ry === 4) return rx - ry || a - b; // empty last, in both directions
    let d = rx - ry;
    if (!d) d = rx === 0 ? x - y : rx === 1 ? collator.compare(x, y) : rx === 2 ? Number(x) - Number(y) : 0;
    return (desc ? -d : d) || a - b; // stable
  });
  const cells = { ...(sheet.cells || {}) }, formats = { ...(sheet.formats || {}) };
  const old = sheet.cells || {}, oldF = sheet.formats || {};
  rows.forEach((from, i) => {
    const to = r1 + i;
    for (let c = range.c1; c <= range.c2; c++) {
      const k = cellKey(c, to), src = cellKey(c, from);
      if (old[src] === undefined || old[src] === '') delete cells[k]; else cells[k] = shiftFormula(old[src], 0, to - from);
      if (oldF[src]) formats[k] = oldF[src]; else delete formats[k];
    }
  });
  return { cells, formats };
}

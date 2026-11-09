// Changing a sheet's structure: inserting and deleting rows or columns (formulas, formats, widths,
// chart ranges, rules, dropdowns and commented cells follow), and sorting rows. Pure functions on the sheet's JSON.
import { colName, colIndex, cellKey, parseRef, shiftFormula, sheetPrefix } from './formula.js';
import { adjustHide } from './hide.js';
import { adjustGroups } from './groups.js';
import { adjustBands } from './bands.js';

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

const REF = /("(?:[^"]|"")*")|(?<![A-Z0-9_.$'])(?:('(?:[^']|'')+'|[A-Z_][A-Z0-9_]*)!)?(\$?)([A-Z]+)(\$?)(\d+)(?::(\$?)([A-Z]+)(\$?)(\d+))?(?![A-Z0-9_(])/gi;

const prefixName = (p) => (p.startsWith("'") ? p.slice(1, -1).replace(/''/g, "'") : p).toUpperCase();

/**
 * A formula with its cell references moved for a structural change ("#REF!" where they were deleted).
 * `where`: { here, changed } — the sheet the formula is on and the one that changed (both names);
 * left out, the formula is on the changed sheet. Only references into the changed sheet move.
 */
export function adjustFormula(raw, change, where = null) {
  if (typeof raw !== 'string' || !raw.startsWith('=')) return raw;
  const row = change.axis === 'row';
  const changed = where ? String(where.changed).toUpperCase() : null, here = where ? String(where.here).toUpperCase() : null;
  return raw.replace(REF, (m, str, pre, ca, col, ra, r, ca2, col2, ra2, r2) => {
    if (str) return str;
    const into = pre ? prefixName(pre) : here; // the sheet this reference points into (null: this one, which changed)
    if (where ? into !== changed : !!pre) return m; // points somewhere else: stays
    const lead = pre ? `${pre}!` : '';
    const p = { c: colIndex(col), r: Number(r) - 1 };
    const text = (c, rr, cAbs, rAbs) => `${cAbs}${colName(c)}${rAbs}${rr + 1}`;
    if (col2 === undefined) {
      const n = moveIndex(row ? p.r : p.c, change);
      if (n === null) return '#REF!';
      return lead + (row ? text(p.c, n, ca, ra) : text(n, p.r, ca, ra));
    }
    const q = { c: colIndex(col2), r: Number(r2) - 1 };
    const span = row ? moveSpan(Math.min(p.r, q.r), Math.max(p.r, q.r), change) : moveSpan(Math.min(p.c, q.c), Math.max(p.c, q.c), change);
    if (!span) return '#REF!';
    return lead + (row
      ? `${text(p.c, span[0], ca, ra)}:${text(q.c, span[1], ca2, ra2)}`
      : `${text(span[0], p.r, ca, ra)}:${text(span[1], q.r, ca2, ra2)}`);
  });
}

/** A formula with references to sheet `from` renamed to `to` (Sheet1!A1 -> 'Q1 data'!A1). */
export function renameSheetRefs(raw, from, to) {
  if (typeof raw !== 'string' || !raw.startsWith('=')) return raw;
  return raw.replace(REF, (m, str, pre) => (str || !pre || prefixName(pre) !== String(from).toUpperCase() ? m : `${sheetPrefix(to)}!${m.slice(pre.length + 1)}`));
}

/** Every sheet's formulas after the sheet at `index` had a row/column change (references into it move). */
export function adjustOtherSheets(sheets, index, change) {
  const changed = sheets[index]?.name;
  return sheets.map((s, i) => {
    if (i === index) return s;
    let touched = false;
    const cells = {};
    for (const [k, v] of Object.entries(s.cells || {})) { const n = adjustFormula(v, change, { here: s.name, changed }); if (n !== v) touched = true; cells[k] = n; }
    return touched ? { ...s, cells } : s;
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

/** Named ranges after the change (a name whose cells were all deleted goes). */
export function adjustNames(names, change) {
  const out = {};
  for (const [k, v] of Object.entries(names || {})) {
    const r = adjustRange(v, change);
    if (!r) continue;
    const [a, b] = r.split(':');
    out[k] = String(v).includes(':') ? r : a === b ? a : r;
  }
  return out;
}

/** The sheet (one entry of `sheets`) with a row/column change applied to everything in it. */
export function applyStructure(sheet, change) {
  const cells = {}, formats = {}, colWidths = {}, charts = {}, notes = {};
  const where = sheet.name ? { here: sheet.name, changed: sheet.name } : null;
  for (const [k, v] of Object.entries(sheet.cells || {})) { const nk = adjustKey(k, change); if (nk) cells[nk] = adjustFormula(v, change, where); }
  for (const [k, v] of Object.entries(sheet.formats || {})) { const nk = adjustKey(k, change); if (nk) formats[nk] = v; }
  for (const [k, v] of Object.entries(sheet.notes || {})) { const nk = adjustKey(k, change); if (nk) notes[nk] = v; } // notes stay with their cells
  for (const [k, v] of Object.entries(sheet.colWidths || {})) {
    if (change.axis !== 'col') { colWidths[k] = v; continue; }
    const n = moveIndex(colIndex(k), change);
    if (n !== null) colWidths[colName(n)] = v;
  }
  for (const [id, ch] of Object.entries(sheet.charts || {})) { const range = adjustRange(ch.range, change); if (range) charts[id] = { ...ch, range }; }
  const rules = (sheet.rules || []).map((r) => ({ ...r, range: adjustRange(r.range, change) })).filter((r) => r.range);
  const validations = (sheet.validations || []).map((v) => ({ ...v, range: adjustRange(v.range, change) })).filter((v) => v.range);
  // Merges move and grow or shrink with their cells; one that's down to a single cell is no longer a merge.
  const merges = (sheet.merges || []).map((m) => adjustRange(m, change)).filter((m) => m && m.split(':')[0] !== m.split(':')[1]);
  const hide = adjustHide(sheet.hide, change);
  const bands = adjustBands(sheet.bands, change);
  const names = sheet.names && adjustNames(sheet.names, change);
  // Protected ranges move with their cells (whole-sheet ones stay); one whose cells all went goes too.
  const prot = sheet.protected && sheet.protected.flatMap((p) => { if (!p.range) return [p]; const range = adjustRange(p.range, change); return range ? [{ ...p, range }] : []; });
  const out = { ...sheet, cells, colWidths, ...(sheet.formats && { formats }), ...(sheet.notes && { notes }), ...(sheet.charts && { charts }), ...(sheet.rules && { rules }), ...(sheet.validations && { validations }), ...(sheet.merges && { merges }) };
  if (hide) out.hide = hide; else delete out.hide;
  const groups = adjustGroups(sheet.groups, change);
  if (groups) out.groups = groups; else delete out.groups;
  if (names && Object.keys(names).length) out.names = names; else delete out.names;
  if (prot?.length) out.protected = prot; else delete out.protected;
  if (bands) out.bands = bands; else delete out.bands;
  return out;
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
 * { cells, formats, notes } for the whole sheet.
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
  const cells = { ...(sheet.cells || {}) }, formats = { ...(sheet.formats || {}) }, notes = { ...(sheet.notes || {}) };
  const old = sheet.cells || {}, oldF = sheet.formats || {}, oldN = sheet.notes || {};
  rows.forEach((from, i) => {
    const to = r1 + i;
    for (let c = range.c1; c <= range.c2; c++) {
      const k = cellKey(c, to), src = cellKey(c, from);
      if (old[src] === undefined || old[src] === '') delete cells[k]; else cells[k] = shiftFormula(old[src], 0, to - from);
      if (oldF[src]) formats[k] = oldF[src]; else delete formats[k];
      if (oldN[src]) notes[k] = oldN[src]; else delete notes[k];
    }
  });
  return { cells, formats, ...(sheet.notes && { notes }) };
}

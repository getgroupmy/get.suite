// Data tools: removing duplicate rows and splitting text into columns. Pure functions on the sheet's
// JSON, like sorting (structure.js): formulas that move are shifted, formats move with their cells.
import { cellKey, shiftFormula } from './formula.js';

const same = (v) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v).trim().toLowerCase());

/**
 * Remove rows of a range that repeat an earlier row (comparing what the cells show, ignoring case
 * and spaces at the ends, across the range's columns). Kept rows close up; the range's last rows
 * are left empty. Returns { cells, formats, removed, kept }.
 */
export function removeDuplicates(sheet, range, { header = false, value }) {
  const r1 = header ? range.r1 + 1 : range.r1;
  const seen = new Set(), keep = [];
  let removed = 0;
  for (let r = r1; r <= range.r2; r++) {
    const vals = [];
    for (let c = range.c1; c <= range.c2; c++) vals.push(same(value(cellKey(c, r))));
    if (vals.every((v) => v === '')) { keep.push(r); continue; } // empty rows are never "duplicates"
    const key = vals.join('\u0000');
    if (seen.has(key)) { removed++; continue; }
    seen.add(key);
    keep.push(r);
  }
  const cells = { ...(sheet.cells || {}) }, formats = { ...(sheet.formats || {}) };
  const old = sheet.cells || {}, oldF = sheet.formats || {};
  for (let i = 0; i <= range.r2 - r1; i++) {
    const to = r1 + i, from = keep[i];
    for (let c = range.c1; c <= range.c2; c++) {
      const k = cellKey(c, to);
      if (from === undefined) { delete cells[k]; delete formats[k]; continue; }
      const src = cellKey(c, from);
      if (old[src] === undefined || old[src] === '') delete cells[k]; else cells[k] = shiftFormula(old[src], 0, to - from);
      if (oldF[src]) formats[k] = oldF[src]; else delete formats[k];
    }
  }
  return { cells, formats, removed, kept: keep.filter((r) => [...Array(range.c2 - range.c1 + 1)].some((_, j) => same(value(cellKey(range.c1 + j, r))) !== '')).length };
}

export const SEPARATORS = [['auto', 'Detect automatically'], [',', 'Comma'], [';', 'Semicolon'], ['\t', 'Tab'], [' ', 'Space'], ['|', 'Vertical bar']];

/** The separator a column's text seems to use: the first of tab, semicolon, comma, | or space found in most rows. */
export function detectSeparator(texts) {
  const list = texts.filter(Boolean);
  for (const sep of ['\t', ';', ',', '|', ' ']) if (list.length && list.filter((t) => t.includes(sep)).length >= Math.ceil(list.length / 2)) return sep;
  return ',';
}

/**
 * Split the text of one column (the range's first) into the columns to its right at `sep` (one
 * character or more; "auto" to detect). Formulas and numbers are left alone; pieces are trimmed.
 * Returns { cells, columns (the most pieces), overwritten (filled cells written over), sep }.
 */
export function splitColumn(sheet, range, sep = 'auto') {
  const c = range.c1;
  const old = sheet.cells || {};
  const texts = [];
  for (let r = range.r1; r <= range.r2; r++) {
    const v = old[cellKey(c, r)];
    texts.push(typeof v === 'string' && !v.startsWith('=') ? v : '');
  }
  const use = sep === 'auto' ? detectSeparator(texts) : sep;
  if (!use) throw new Error('Choose what to split at');
  const cells = { ...old };
  let columns = 1, overwritten = 0;
  texts.forEach((t, i) => {
    if (!t.includes(use)) return;
    const r = range.r1 + i;
    const parts = t.split(use).map((p) => p.trim());
    const pieces = use === ' ' ? parts.filter(Boolean) : parts;
    columns = Math.max(columns, pieces.length);
    pieces.forEach((p, j) => {
      const k = cellKey(c + j, r);
      if (j > 0 && old[k] !== undefined && old[k] !== '') overwritten++;
      if (p === '') delete cells[k]; else cells[k] = p;
    });
  });
  return { cells, columns, overwritten, sep: use };
}

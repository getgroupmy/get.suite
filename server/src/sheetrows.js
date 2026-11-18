// Add rows to the bottom of a spreadsheet's table (an assistant's "add these expenses to my budget sheet",
// through POST /api/files/:id/rows): after the last row with anything in it, starting at the table's first
// column, so the new rows line up with the ones above.
import { bad } from './util.js';

export const MAX_ROWS = 500, MAX_COLS = 50;
const colName = (n) => { let s = ''; for (n += 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
const colIndex = (s) => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
const KEY = /^([A-Z]{1,3})(\d{1,7})$/;

/** A cell's value as kept in the sheet: text as typed (numbers and true/false as they'd be typed), or null for empty. */
function cellText(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw bad('Numbers must be finite'); return String(v); }
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'string') return v.slice(0, 50000);
  throw bad('Each cell must be text, a number, true/false or empty');
}

/**
 * The content with `rows` added to sheet `sheet` (its name, any capitals; the first sheet when not given).
 * Returns { content, sheet: its name, range: "A5:C7", added }.
 */
export function appendRows(content, { sheet = null, rows }) {
  if (!Array.isArray(rows) || !rows.length) throw bad('Give the rows to add: a list of rows, each a list of cells');
  if (rows.length > MAX_ROWS) throw bad(`At most ${MAX_ROWS} rows at a time`);
  if (rows.some((r) => !Array.isArray(r) || r.length > MAX_COLS)) throw bad(`Each row is a list of at most ${MAX_COLS} cells`);
  const sheets = Array.isArray(content?.sheets) ? content.sheets : null;
  if (!sheets?.length) throw bad('That spreadsheet has no sheets');
  const i = sheet ? sheets.findIndex((s) => String(s.name || '').toLowerCase() === String(sheet).toLowerCase()) : 0;
  if (i < 0) throw bad(`No sheet called “${sheet}”: it has ${sheets.map((s) => `“${s.name}”`).join(', ')}`);
  const s = sheets[i];
  if (s.pivot) throw bad('That sheet is a pivot table: it’s filled from its data, so add the rows there');
  const cells = { ...(s.cells || {}) };
  let last = 0, first = null;
  for (const [k, v] of Object.entries(cells)) {
    const m = KEY.exec(k);
    if (!m || v === null || v === undefined || v === '') continue;
    last = Math.max(last, +m[2]);
    first = first === null ? colIndex(m[1]) : Math.min(first, colIndex(m[1]));
  }
  const c0 = first ?? 0, r0 = last + 1;
  let width = 0;
  rows.forEach((row, ri) => row.forEach((v, ci) => {
    const t = cellText(v);
    if (t !== null) { cells[`${colName(c0 + ci)}${r0 + ri}`] = t; width = Math.max(width, ci + 1); }
  }));
  const range = `${colName(c0)}${r0}:${colName(c0 + Math.max(width, 1) - 1)}${r0 + rows.length - 1}`;
  return { content: { ...content, sheets: sheets.map((x, j) => (j === i ? { ...x, cells } : x)) }, sheet: s.name, range, added: rows.length };
}

export const MAX_SET = 1000;
/**
 * The content with cells set on sheet `sheet` (its name; the first when not given): `cells` maps a cell ("B4")
 * to its new value (text, a number, true/false; null or "" empties it; text starting with = is a formula), or a
 * block of rows starting at `at`. Returns { content, sheet, changed: ["B4", …] }.
 */
export function setCells(content, { sheet = null, cells = null, at = null, rows = null }) {
  const sheets = Array.isArray(content?.sheets) ? content.sheets : null;
  if (!sheets?.length) throw bad('That spreadsheet has no sheets');
  const i = sheet ? sheets.findIndex((s) => String(s.name || '').toLowerCase() === String(sheet).toLowerCase()) : 0;
  if (i < 0) throw bad(`No sheet called “${sheet}”: it has ${sheets.map((s) => `“${s.name}”`).join(', ')}`);
  const s = sheets[i];
  if (s.pivot) throw bad('That sheet is a pivot table: it’s filled from its data, so change the data there');
  const changes = [];
  if (cells && typeof cells === 'object' && !Array.isArray(cells)) {
    for (const [k0, v] of Object.entries(cells)) {
      const k = String(k0).toUpperCase().replace(/\$/g, '');
      if (!KEY.test(k)) throw bad(`“${k0}” isn’t a cell: give cells like B4`);
      changes.push([k, cellText(v)]);
    }
  }
  if (rows !== null) {
    const m = KEY.exec(String(at || '').toUpperCase().replace(/\$/g, ''));
    if (!m) throw bad('Give where the rows start (at), as a cell like B4');
    if (!Array.isArray(rows) || rows.some((r) => !Array.isArray(r) || r.length > MAX_COLS)) throw bad(`Rows are a list of rows, each a list of at most ${MAX_COLS} cells`);
    rows.forEach((row, ri) => row.forEach((v, ci) => changes.push([`${colName(colIndex(m[1]) + ci)}${+m[2] + ri}`, cellText(v)])));
  }
  if (!changes.length) throw bad('Give the cells to change: cells (like {"B4": 120}) or rows with at');
  if (changes.length > MAX_SET) throw bad(`At most ${MAX_SET} cells at a time`);
  const next = { ...(s.cells || {}) };
  for (const [k, t] of changes) { if (t === null) delete next[k]; else next[k] = t; }
  return { content: { ...content, sheets: sheets.map((x, j) => (j === i ? { ...x, cells: next } : x)) }, sheet: s.name, changed: [...new Set(changes.map(([k]) => k))] };
}

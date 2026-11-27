// A CSV or TSV file read as a table for its preview: quoted fields (with commas, quotes and line breaks inside)
// handled as spreadsheets write them; the separator is a tab for .tsv, otherwise whichever of , ; or tab the first
// line uses most (Excel in much of Europe writes ;).

/** The separator for a file: '\t' for .tsv, else the commonest of , ; \t in its first line (outside quotes). */
export function separatorFor(name, text) {
  if (/\.tsv$/i.test(name)) return '\t';
  const first = String(text).split(/\r?\n/, 1)[0].replace(/"[^"]*"/g, '');
  const count = (c) => first.split(c).length - 1;
  return [',', ';', '\t'].reduce((best, c) => (count(c) > count(best) ? c : best), ',');
}

/** Rows of cells, at most maxRows; { rows, more } where more says rows were left out. A BOM is dropped. */
export function parseTable(text, sep = ',', maxRows = 1000) {
  const s = String(text).replace(/^﻿/, '');
  const rows = [];
  let row = [], cell = '', quoted = false, i = 0;
  const endRow = () => { row.push(cell); rows.push(row); row = []; cell = ''; };
  while (i < s.length) {
    const c = s[i];
    if (quoted) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i += 2; continue; } quoted = false; i++; continue; }
      cell += c; i++; continue;
    }
    if (c === '"' && cell === '') { quoted = true; i++; continue; }
    if (c === sep) { row.push(cell); cell = ''; i++; continue; }
    if (c === '\r' && s[i + 1] === '\n') { i++; continue; }
    if (c === '\n') { endRow(); i++; if (rows.length > maxRows) break; continue; }
    cell += c; i++;
  }
  if (rows.length <= maxRows && (cell !== '' || row.length)) endRow();
  const more = rows.length > maxRows || i < s.length;
  return { rows: rows.slice(0, maxRows), more };
}

const NUM = /^\s*[-+]?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?\s*%?\s*$/;
/** A cell as a number when it reads as one (1,234.5, -3, 12%), else null. */
export function numberOf(cell) {
  return NUM.test(String(cell ?? '')) ? Number(String(cell).replace(/[,%\s]/g, '')) : null;
}

/** Rows sorted by column col, up (1) or down (-1): numbers as numbers, words as words (ignoring case and accents,
 *  with digits in them in order: "Item 9" before "Item 10"); empty cells last either way; ties keep the file's order. */
export function sortRows(rows, col, dir = 1) {
  const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  return rows.map((r, i) => ({ r, i })).sort((a, b) => {
    const x = a.r[col] ?? '', y = b.r[col] ?? '';
    if (x === '' || y === '') return x === y ? a.i - b.i : x === '' ? 1 : -1;
    const nx = numberOf(x), ny = numberOf(y);
    const c = nx !== null && ny !== null ? nx - ny : coll.compare(x, y);
    return c ? c * dir : a.i - b.i;
  }).map((x) => x.r);
}

/** Rows with a cell containing q (ignoring case). */
export function filterRows(rows, q) {
  const needle = String(q || '').trim().toLowerCase();
  return needle ? rows.filter((r) => r.some((c) => String(c).toLowerCase().includes(needle))) : rows;
}

/** Rows as CSV text (comma-separated, CRLF lines as spreadsheets write them): a cell with a comma, quote or line break
 *  is quoted, its quotes doubled; one starting = + - @ gets a leading ' so a spreadsheet doesn't run it as a formula. */
export function toCsv(rows) {
  const cell = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@]/.test(s) && !/^-?\d/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

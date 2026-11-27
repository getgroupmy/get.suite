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

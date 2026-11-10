// A copy of web/src/apps/sheets/tablerefs.js (Excel downloads write tables' structured references as ranges);
// only its import differs. test/tablerefs-copy.test.js keeps them the same.
// Tables (Sheets): alternating colours given a name ("Sales") make a table whose columns are named by
// its heading row, and formulas can use structured references, as in Excel: Sales[Amount] (that column's
// data), Sales[[#Totals],[Amount]], Sales[@Amount] or [@Amount] inside the table (the cell on this row),
// Sales[#All] / [#Data] / [#Headers] / [#Totals], Sales[[A]:[B]] (several columns), and Sales alone (its data).
// They're written as ranges just before a formula is worked out, so the formula keeps its names and the
// table's rows are whatever is there now: rows typed straight under a table belong to it.
import { colName, sheetPrefix } from './sheetnames.js';

export const TABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.]{0,39}$/;
export const looksLikeCell = (n) => /^[A-Za-z]{1,3}\d+$/.test(n);
const parseBox = (range) => {
  const m = /^([A-Z]{1,3})(\d+):([A-Z]{1,3})(\d+)$/.exec(String(range || '').toUpperCase().replace(/\$/g, ''));
  if (!m) return null;
  const col = (s) => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  return { c1: col(m[1]), r1: +m[2], c2: col(m[3]), r2: +m[4] };
};
const has = (v) => v !== undefined && v !== null && v !== '';

/**
 * The spreadsheet's tables: every named band, on every sheet: { name, sheet, c1, c2, r1, r2 (1-based rows),
 * header, totals, columns }. Without a total row, a table goes on down while the row under it has something
 * in its columns.
 */
export function tablesOf(sheets) {
  const out = [];
  for (const s of sheets || []) {
    for (const b of s.bands || []) {
      if (!b?.name || !TABLE_NAME_RE.test(b.name)) continue;
      const box = parseBox(b.range);
      if (!box) continue;
      const cells = s.cells || {};
      let { r2 } = box;
      if (!b.footer) {
        const filled = (r) => { for (let c = box.c1; c <= box.c2; c++) if (has(cells[`${colName(c)}${r}`])) return true; return false; };
        while (r2 < 100000 && filled(r2 + 1)) r2++;
      }
      const header = b.header !== false;
      const columns = [];
      for (let c = box.c1; c <= box.c2; c++) columns.push(header ? String(cells[`${colName(c)}${box.r1}`] ?? '').trim() || `Column${c - box.c1 + 1}` : `Column${c - box.c1 + 1}`);
      out.push({ name: b.name, sheet: s.name, ...box, r2, header, totals: !!b.footer, columns });
    }
  }
  return out;
}

/**
 * A formula with its structured references written as ranges (on another sheet: with its name). `row` is
 * the cell's row (1-based), `col` its column (0-based), `sheet` the sheet it's on. Anything else is left alone.
 */
export function plainTableRefs(formula, tables, row, col, sheet = null) {
  if (!tables?.length || !String(formula).includes('[') && !tables.some((t) => new RegExp(`(?<![A-Za-z0-9_.])${esc(t.name)}(?![A-Za-z0-9_.\\[(])`, 'i').test(formula))) return formula;
  const unq = (n) => String(n).replace(/^\[|\]$/g, '').replace(/'(.)/g, '$1').trim().toLowerCase();
  const range = (t, a, b, ra, rb) => {
    const at = sheet !== null && t.sheet !== undefined && String(t.sheet).toLowerCase() !== String(sheet).toLowerCase() ? `${sheetPrefix(t.sheet)}!` : '';
    return a === b && ra === rb ? `${at}${colName(a)}${ra}` : `${at}${colName(a)}${ra}:${colName(b)}${rb}`;
  };
  const resolve = (t, spec) => {
    const dataTop = t.r1 + (t.header ? 1 : 0), dataBottom = t.r2 - (t.totals ? 1 : 0);
    let rows = [dataTop, dataBottom], c1 = t.c1, c2 = t.c2;
    const parts = spec.trim() === '' ? [] : (/^\[/.test(spec.trim()) ? [...spec.matchAll(/\[((?:[^[\]']|'.)*)\]/g)].map((m) => m[1]) : [spec]);
    const cols = [];
    for (let p of parts) {
      p = p.trim();
      const low = p.toLowerCase();
      if (low === '#all') rows = [t.r1, t.r2];
      else if (low === '#data') rows = [dataTop, dataBottom];
      else if (low === '#headers') rows = [t.r1, t.r1];
      else if (low === '#totals') rows = [t.r2, t.r2];
      else if (low === '#this row' || p === '@') rows = [row, row];
      else if (p.startsWith('@')) { rows = [row, row]; cols.push(unq(p.slice(1))); }
      else cols.push(unq(p));
    }
    if (cols.length) {
      const idx = cols.map((n) => t.columns.findIndex((x) => x.toLowerCase() === n));
      if (idx.some((i) => i < 0)) return null;
      c1 = t.c1 + Math.min(...idx); c2 = t.c1 + Math.max(...idx);
    }
    if (rows[1] < rows[0]) rows = [rows[0], rows[0]]; // a table with no data rows yet
    return range(t, c1, c2, rows[0], rows[1]);
  };
  // The table this cell is in (or, for a column of formulas just beside one, on the same rows).
  const mine = tables.filter((t) => (sheet === null || t.sheet === undefined || String(t.sheet).toLowerCase() === String(sheet).toLowerCase()) && row >= t.r1 && row <= t.r2);
  const here = mine.find((t) => col >= t.c1 && col <= t.c2) || (mine.length === 1 ? mine[0] : null);
  let out = String(formula);
  for (const t of tables) {
    // Table[...] (the brackets may nest one level: Table[[#Totals],[Amount]], Table[[A]:[B]]).
    const re = new RegExp(`("(?:[^"]|"")*")|(?<![A-Za-z0-9_.])${esc(t.name)}\\[((?:[^\\[\\]]|\\[[^\\]]*\\])*)\\]`, 'gi');
    out = out.replace(re, (m, str, spec) => { if (str) return str; const r = resolve(t, spec.replace(/\]\s*:\s*\[/g, '],[')); return r ?? m; });
    // The table's name alone: its data.
    out = out.replace(new RegExp(`("(?:[^"]|"")*")|(?<![A-Za-z0-9_.!'])${esc(t.name)}(?![A-Za-z0-9_.\\[(!])`, 'gi'), (m, str) => (str || resolve(t, '')));
  }
  // Inside a table: [@Amount], [@[Unit price]], [Amount] on their own.
  if (here) {
    out = out.replace(/("(?:[^"]|"")*")|(?<![A-Za-z0-9_\]])\[(@?(?:\[[^\]]*\]|[^[\]]+))\]/g, (m, str, spec) => {
      if (str) return str;
      const r = resolve(here, spec.startsWith('@') ? `[@${unq(spec.slice(1))}]` : `[${spec}]`);
      return r ?? m;
    });
  }
  return out;
}
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

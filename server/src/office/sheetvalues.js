// Formula results for downloads: each sheet's formula cells worked out with the Sheets engine (sheetcalc/),
// so a file opened somewhere that doesn't calculate (a phone's preview, Quick Look, a mail app) still shows
// them. Plain values only: a number, text, TRUE/FALSE or an error code; null when there's nothing sure to give.
import { bookEvaluator } from '../sheetcalc/formula.js';
import { formulaHiddenRows } from '../sheetcalc/hiddenrows.js';

/** For sheet `index` of `data`: key → { number } | { text } | { bool } | { error } | null. */
export function formulaResults(data, index) {
  let ev = null;
  try { ev = bookEvaluator(data?.sheets || [], index, null, data?.functions, formulaHiddenRows); } catch { ev = null; } // (SUBTOTAL 109 leaves out filtered rows, as on screen)
  return (key) => {
    if (!ev) return null;
    let v;
    try { v = ev(key); } catch { return null; }
    if (Array.isArray(v)) v = v[0]?.[0] ?? v[0]; // (an array's first value: what its own cell shows)
    if (v === null || v === undefined) return { text: '' };
    if (typeof v === 'number') return Number.isFinite(v) ? { number: v } : null;
    if (typeof v === 'boolean') return { bool: v };
    if (typeof v === 'string') return { text: v };
    if (typeof v === 'object' && typeof v.error === 'string') return { error: v.error };
    return null;
  };
}

/**
 * Sheet `index` of `data`'s cells, with each formula that reads one of `read` (sheets of `data`, by name: Plan!B2,
 * 'Old plan'!A1, Plan!Total) given as the value it works out to (#REF! when there's none to give). Others stay
 * formulas: a sheet's own names are its own, so a bare name never reads another sheet.
 */
export function cellsWithValuesFrom(data, index, read) {
  const s = data?.sheets?.[index];
  const cells = s?.cells || {};
  if (!read.length) return cells;
  const esc = (t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const bare = read.filter((x) => /^[A-Za-z_][A-Za-z0-9_.]*$/.test(x.name)).map((x) => esc(x.name));
  const parts = [
    `'(?:${read.map((x) => esc(x.name.replace(/'/g, "''"))).join('|')})'!`,
    ...(bare.length ? [`(?<![A-Za-z0-9_.'])(?:${bare.join('|')})!`] : []),
  ];
  const reads = new RegExp(parts.join('|'), 'i');
  let result = null;
  return Object.fromEntries(Object.entries(cells).map(([k, v]) => {
    if (typeof v !== 'string' || !v.startsWith('=') || !reads.test(v)) return [k, v];
    result ??= formulaResults(data, index);
    const r = result(k);
    return [k, !r ? '#REF!' : 'number' in r ? String(r.number) : 'bool' in r ? (r.bool ? 'TRUE' : 'FALSE') : 'error' in r ? r.error : r.text.startsWith('=') ? ` ${r.text}` : r.text];
  }));
}

/**
 * A spreadsheet as published: its shown sheets only (a hidden one's cells aren't given out), with each formula that
 * reads a hidden sheet (Hidden!A1, Hidden!Total) given as the value it works out to, so the page shows
 * what the spreadsheet does.
 */
export function publishedBook(data) {
  const all = data?.sheets || [];
  const hidden = all.filter((s) => s.hidden);
  const sheets = [];
  all.forEach((s, i) => {
    if (s.hidden && all.some((o) => !o.hidden)) return;
    sheets.push({ ...s, cells: cellsWithValuesFrom(data, i, hidden) });
  });
  return sheets;
}

/** One sheet's cells as CSV (or TSV with sep '\t'): the values the page shows (number formats too), row by row. */
export async function delimitedFromSheet(data, index = 0, sep = ',') {
  const { bookEvaluator: be, display, parseRef } = await import('../sheetcalc/formula.js');
  const { formatNumber } = await import('../sheetcalc/cellformat.js');
  const s = data?.sheets?.[index] || { cells: {} };
  let ev;
  try { ev = be(data?.sheets || [], index, null, data?.functions, formulaHiddenRows); } catch { ev = () => ''; }
  let maxR = -1, maxC = -1;
  for (const k of [...Object.keys(s.cells || {}), ...(ev.spilledKeys?.() || [])]) { const p = parseRef(k); if (p) { maxR = Math.max(maxR, p.r); maxC = Math.max(maxC, p.c); } }
  const { colName } = await import('../sheetcalc/formula.js');
  const out = [];
  for (let r = 0; r <= Math.min(maxR, 100000); r++) {
    const row = [];
    for (let c = 0; c <= Math.min(maxC, 1000); c++) {
      const k = `${colName(c)}${r + 1}`;
      let v; try { v = ev(k); } catch { v = { error: '#ERROR!' }; }
      const t = String(formatNumber(v, s.formats?.[k]) ?? display(v));
      row.push(sep === '\t' ? t.replace(/[\t\r\n]+/g, ' ') : /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t);
    }
    out.push(row.join(sep));
  }
  return out.join('\r\n') + (out.length ? '\r\n' : '');
}

/**
 * A spreadsheet as text for reading (an assistant's fetch): each sheet under its name, its used cells as a
 * tab-separated table of the values shown (row numbers and column letters given), then its formulas with what
 * they give. Hidden sheets are marked as such.
 */
export async function sheetReadingText(data, { maxCells = 20000 } = {}) {
  const { colName, parseRef } = await import('../sheetcalc/formula.js');
  const out = [];
  let budget = maxCells;
  for (const [i, s] of (data?.sheets || []).entries()) {
    const tsv = (await delimitedFromSheet(data, i, '\t')).replace(/\r\n$/, '').split('\r\n');
    const width = Math.max(0, ...tsv.map((l) => l.split('\t').length));
    out.push(`## Sheet: ${s.name}${s.hidden ? ' (hidden)' : ''}`);
    if (!tsv[0] && tsv.length <= 1) { out.push('(empty)'); continue; }
    out.push(['', ...Array.from({ length: width }, (_, c) => colName(c))].join('\t'));
    for (const [r, line] of tsv.entries()) {
      if (budget <= 0) { out.push('… (more rows left out)'); break; }
      budget -= width;
      if (line.replace(/\t/g, '')) out.push(`${r + 1}\t${line}`);
    }
    const results = formulaResults(data, i);
    const formulas = Object.entries(s.cells || {}).filter(([k, v]) => typeof v === 'string' && v.startsWith('=') && parseRef(k)).slice(0, 500);
    if (formulas.length) {
      out.push('', 'Formulas:');
      for (const [k, v] of formulas) { const r = results(k); const shown = !r ? '' : 'number' in r ? r.number : 'bool' in r ? (r.bool ? 'TRUE' : 'FALSE') : 'error' in r ? r.error : r.text; out.push(`${k}: ${v} → ${shown}`); }
    }
    out.push('');
  }
  return out.join('\n').trim();
}

export const TABLE_CELLS = 2000;
/**
 * A sheet's cells as a table to put in a document (Docs → Insert table from a spreadsheet): the values the sheet shows
 * (worked-out formulas, number formats), each with whether it's bold, from `range` ("B2:D9") or the cells in use;
 * hidden rows and columns left out. { range, rows: [[{ text, bold }]] }, or an error message for a range too big (over
 * TABLE_CELLS, or maxRows / maxCols, as a slide's table allows) or not understood.
 */
export async function sheetTable(data, index = 0, range = '', { maxRows = Infinity, maxCols = Infinity } = {}) {
  const { bookEvaluator: be, display, parseRef, colName } = await import('../sheetcalc/formula.js');
  const { formatNumber } = await import('../sheetcalc/cellformat.js');
  const s = data?.sheets?.[index];
  if (!s) return { error: 'That sheet isn’t there' };
  let ev;
  try { ev = be(data.sheets, index, null, data.functions, formulaHiddenRows); } catch { ev = () => ''; }
  let area;
  if (String(range || '').trim()) {
    const m = /^\s*\$?([A-Z]+)\$?(\d+)\s*(?::\s*\$?([A-Z]+)\$?(\d+))?\s*$/i.exec(range);
    const a = m && parseRef(`${m[1].toUpperCase()}${m[2]}`), b = m && parseRef(`${(m[3] || m[1]).toUpperCase()}${m[4] || m[2]}`);
    if (!a || !b) return { error: 'Give the cells as a range, like A1:D10' };
    area = { c1: Math.min(a.c, b.c), r1: Math.min(a.r, b.r), c2: Math.max(a.c, b.c), r2: Math.max(a.r, b.r) };
  } else {
    for (const k of [...Object.keys(s.cells || {}).filter((k) => s.cells[k] !== '' && s.cells[k] != null), ...(ev.spilledKeys?.() || [])]) {
      const p = parseRef(k);
      if (p) area = area ? { c1: Math.min(area.c1, p.c), r1: Math.min(area.r1, p.r), c2: Math.max(area.c2, p.c), r2: Math.max(area.r2, p.r) } : { c1: p.c, r1: p.r, c2: p.c, r2: p.r };
    }
    if (!area) return { error: 'That sheet is empty' };
  }
  const hiddenRows = new Set((s.hide?.rows || []).map(Number)), hiddenCols = new Set((s.hide?.cols || []).map(Number));
  const cols = [];
  for (let c = area.c1; c <= area.c2; c++) if (!hiddenCols.has(c)) cols.push(c);
  const rowsWanted = [];
  for (let r = area.r1; r <= area.r2; r++) if (!hiddenRows.has(r)) rowsWanted.push(r);
  if (rowsWanted.length > maxRows || cols.length > maxCols) return { error: `That’s ${rowsWanted.length} rows and ${cols.length} columns: a table here takes up to ${maxRows} rows and ${maxCols} columns, so give a smaller range` };
  if (cols.length * rowsWanted.length > TABLE_CELLS) return { error: `That’s too many cells for a table (up to ${TABLE_CELLS.toLocaleString('en')}): give a smaller range` };
  const rows = rowsWanted.map((r) => cols.map((c) => {
    const k = `${colName(c)}${r + 1}`;
    let v; try { v = ev(k); } catch { v = { error: '#ERROR!' }; }
    return { text: String(formatNumber(v, s.formats?.[k]) ?? display(v)), bold: !!s.formats?.[k]?.b };
  }));
  return { range: `${colName(area.c1)}${area.r1 + 1}:${colName(area.c2)}${area.r2 + 1}`, rows };
}

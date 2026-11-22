// A document's table as a spreadsheet (Docs → Table → Open in Sheets): its cells' text, read as Sheets reads what's typed
// ("$1,200.00" a number shown as currency, "12%" a percent, "1,234" a number), the header row bold and kept in view, columns
// wide enough for what's in them.
import { typedNumber } from '../sheetcalc/cellformat.js';
import { colName } from '../sheetcalc/formula.js';

export const MAX_ROWS = 1000, MAX_COLS = 100;

/** The spreadsheet's content from rows of cell texts; header: the first row is the table's header row. */
export function sheetFromRows(rows, { header = false, name = 'Sheet1' } = {}) {
  const cells = {}, formats = {}, colWidths = {};
  rows.forEach((row, r) => row.forEach((raw, c) => {
    const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
    if (!text) return;
    const k = `${colName(c)}${r + 1}`;
    const typed = !(header && r === 0) && typedNumber(text);
    // (a formula's "=" kept as text: a document's words aren't run as formulas)
    // (and "007" kept as written, not the number 7)
    cells[k] = typed ? String(typed.value) : (/^[=+@-]/.test(text) && !/^-?\d/.test(text)) || /^0\d/.test(text) ? `'${text}` : text;
    const fmt = { ...(typed && typed.fmt), ...(header && r === 0 && { b: true }) };
    if (Object.keys(fmt).length) formats[k] = fmt;
    colWidths[c] = Math.max(colWidths[c] || 100, Math.min(320, 16 + text.length * 7));
  }));
  return { sheets: [{ name, cells, formats, colWidths, ...(header && rows.length > 1 && { frozen: { rows: 1, cols: 0 } }) }] };
}

/** The tables of figures in a document (TipTap JSON), each as rows of cell texts and whether its first row is headings. */
export function tablesIn(doc) {
  const out = [];
  const text = (n) => (n.type === 'text' ? n.text || '' : n.type === 'hardBreak' ? ' ' : (n.content || []).map(text).join(n.type === 'tableCell' || n.type === 'tableHeader' ? ' ' : ''));
  (function walk(list) {
    for (const n of list || []) {
      // (a table holding tables is a page's layout, as in many emails: the tables inside it count instead; and a
      // table of one row or one column isn't figures)
      const nested = n.type === 'table' && JSON.stringify(n.content || []).includes('"type":"table"');
      if (n.type === 'table' && !nested) {
        const rows = (n.content || []).map((r) => (r.content || []).map((c) => text(c).replace(/\s+/g, ' ').trim()));
        if (rows.length >= 2 && Math.max(...rows.map((r) => r.length)) >= 2 && rows.some((r) => r.some(Boolean))) out.push({ rows, header: (n.content?.[0]?.content || []).every((c) => c.type === 'tableHeader') });
      } else walk(n.content);
    }
  })(doc?.content);
  return out;
}

/** A spreadsheet with a sheet for each table ("Table 1", "Table 2"…), or the single one as "Sheet1". */
export function sheetFromTables(tables) {
  return { sheets: tables.map((t, i) => sheetFromRows(t.rows.slice(0, MAX_ROWS).map((r) => r.slice(0, MAX_COLS)), { header: t.header, name: tables.length > 1 ? `Table ${i + 1}` : 'Sheet1' }).sheets[0]) };
}

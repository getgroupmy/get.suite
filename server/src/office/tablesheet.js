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

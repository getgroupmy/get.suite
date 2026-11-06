// Excel files <-> Sheets: every worksheet, with values and formulas, bold/italic/underline, text and
// fill colours, alignment, number formats (number, currency, percent, decimals) and column widths.
import ExcelJS from 'exceljs';

const colName = (i) => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
const hex = (argb) => (argb && /^[0-9A-F]{8}$/i.test(argb) ? `#${argb.slice(2).toLowerCase()}` : null);
const argb = (h) => `FF${h.replace('#', '').toUpperCase()}`;
const CURRENCY_SIGNS = [['RM', 'MYR'], ['$', 'USD'], ['€', 'EUR'], ['£', 'GBP'], ['S$', 'SGD'], ['¥', 'JPY'], ['₹', 'INR']];

/** Excel number format -> Sheets format bits ({ num, dp, cur }) or {}. */
export function numFromExcel(fmt) {
  if (!fmt || fmt === 'General' || fmt === '@') return {};
  const main = fmt.split(';')[0];
  const dp = (/\.(0+)/.exec(main) || [, ''])[1].length;
  if (main.includes('%')) return { num: 'percent', dp };
  const iso = /\[\$([A-Z]{3})\]/.exec(main) || /"([A-Z]{3})"/.exec(main);
  const sign = CURRENCY_SIGNS.find(([s]) => main.includes(s) || main.includes(`[$${s}`));
  if (iso || sign) return { num: 'currency', cur: iso ? iso[1] : sign[1], dp };
  if (/#,##0|0\.0|^0$/.test(main)) return { num: 'number', dp };
  return {};
}
const numToExcel = (f) => {
  const dec = f.dp === 0 ? '' : `.${'0'.repeat(f.dp ?? 2)}`;
  if (f.num === 'percent') return `0${f.dp ? `.${'0'.repeat(f.dp)}` : ''}%`;
  if (f.num === 'currency') return `[$${f.cur || 'MYR'}] #,##0${f.dp === undefined ? '.00' : dec}`;
  if (f.num === 'number') return `#,##0${f.dp === undefined ? '.00' : dec}`;
  return undefined;
};

function cellText(cell) {
  const v = cell.value;
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') {
    if ('formula' in v || 'sharedFormula' in v) return `=${v.formula || cell.formula}`;
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (v.richText) return v.richText.map((r) => r.text).join('');
    if ('text' in v) return String(v.text); // hyperlink
    if ('error' in v) return String(v.error);
    if ('result' in v) return String(v.result);
    return null;
  }
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v);
}

/** An Excel workbook (Buffer) as a Sheets spreadsheet. */
export async function sheetFromExcel(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const sheets = [];
  wb.eachSheet((ws) => {
    const cells = {}, formats = {}, colWidths = {};
    ws.eachRow({ includeEmpty: false }, (row, r) => {
      row.eachCell({ includeEmpty: false }, (cell, c) => {
        const key = `${colName(c - 1)}${r}`;
        const t = cellText(cell);
        if (t !== null && t !== '') cells[key] = t;
        const f = {};
        if (cell.font?.bold) f.b = 1;
        if (cell.font?.italic) f.i = 1;
        if (cell.font?.underline) f.u = 1;
        const color = hex(cell.font?.color?.argb);
        if (color && color !== '#000000') f.color = color;
        const fill = cell.fill?.type === 'pattern' && cell.fill.pattern === 'solid' ? hex(cell.fill.fgColor?.argb) : null;
        if (fill && fill !== '#ffffff') f.fill = fill;
        if (['left', 'center', 'right'].includes(cell.alignment?.horizontal)) f.align = cell.alignment.horizontal;
        Object.assign(f, numFromExcel(cell.numFmt));
        if (Object.keys(f).length) formats[key] = f;
      });
    });
    ws.columns?.forEach((col, i) => { if (col?.width && Math.abs(col.width - 8.43) > 0.5) colWidths[colName(i)] = Math.round(col.width * 7 + 5); });
    sheets.push({ name: ws.name.slice(0, 30), cells, colWidths, ...(Object.keys(formats).length && { formats }) });
  });
  return { sheets: sheets.length ? sheets : [{ name: 'Sheet1', cells: {}, colWidths: {} }] };
}

/** A Sheets spreadsheet as an Excel workbook (Buffer). Formulas are written as formulas. */
export async function excelFromSheet(data) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Workspace';
  for (const s of data.sheets || []) {
    const ws = wb.addWorksheet((s.name || 'Sheet').replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Sheet');
    for (const [key, raw] of Object.entries(s.cells || {})) {
      const cell = ws.getCell(key);
      const v = String(raw);
      if (v.startsWith('=')) cell.value = { formula: v.slice(1) };
      else if (v !== '' && !Number.isNaN(Number(v)) && /^[-+]?(\d|\.\d)/.test(v.trim())) cell.value = Number(v);
      else if (/^(TRUE|FALSE)$/i.test(v)) cell.value = /^TRUE$/i.test(v);
      else cell.value = v;
    }
    for (const [key, f] of Object.entries(s.formats || {})) {
      const cell = ws.getCell(key);
      if (f.b || f.i || f.u || f.color) cell.font = { bold: !!f.b, italic: !!f.i, underline: !!f.u, ...(f.color && { color: { argb: argb(f.color) } }) };
      if (f.fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(f.fill) } };
      if (f.align) cell.alignment = { horizontal: f.align };
      const nf = numToExcel(f);
      if (nf) cell.numFmt = nf;
    }
    for (const [col, px] of Object.entries(s.colWidths || {})) ws.getColumn(col).width = Math.max(2, Math.round((px - 5) / 7));
  }
  if (!wb.worksheets.length) wb.addWorksheet('Sheet1');
  return Buffer.from(await wb.xlsx.writeBuffer());
}

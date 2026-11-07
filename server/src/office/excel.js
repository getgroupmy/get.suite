// Excel files <-> Sheets: every worksheet, with values and formulas, bold/italic/underline, text and
// fill colours, alignment, number formats (number, currency, percent, decimals) and column widths.
import ExcelJS from 'exceljs';

const colName = (i) => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
const colIndex = (s) => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
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
    // Frozen panes: the rows above and the columns left of the split stay in view.
    const view = (ws.views || []).find((v) => v.state === 'frozen');
    const frozen = view && { rows: Math.min(50, Math.max(0, view.ySplit || 0)), cols: Math.min(26, Math.max(0, view.xSplit || 0)) };
    const rules = [];
    for (const cf of ws.conditionalFormattings || []) {
      for (const xr of cf.rules || []) {
        const r = ruleFromExcel(xr);
        if (!r || !/^[A-Z]+\d+(:[A-Z]+\d+)?$/i.test(String(cf.ref || '').split(' ')[0])) continue;
        const range = String(cf.ref).split(' ')[0].toUpperCase();
        const fill = xr.style?.fill?.bgColor?.argb || xr.style?.fill?.fgColor?.argb;
        const color = xr.style?.font?.color?.argb;
        rules.push({ id: `x${rules.length + 1}`, range: range.includes(':') ? range : `${range}:${range}`, ...r, ...(fill && { fill: hex(fill) }), ...(color && { color: hex(color) }), ...(xr.style?.font?.bold && { bold: true }), _p: xr.priority ?? 99 });
      }
    }
    rules.sort((a, b) => a._p - b._p).forEach((r) => delete r._p);
    const validations = validationsFromExcel(ws.dataValidations?.model || {}, cells);
    // An AutoFilter comes in as the sheet's filter (which values were hidden isn't kept).
    const af = typeof ws.autoFilter === 'string' ? ws.autoFilter : ws.autoFilter?.from && ws.autoFilter?.to ? `${ws.autoFilter.from}:${ws.autoFilter.to}` : null;
    const filter = af && /^[A-Z]+\d+:[A-Z]+\d+$/i.test(af) ? { range: af.toUpperCase(), hidden: {} } : null;
    sheets.push({ name: ws.name.slice(0, 30), cells, colWidths, ...(rules.length && { rules }), ...(validations.length && { validations }), ...(filter && { filter }), ...(Object.keys(formats).length && { formats }), ...(frozen && (frozen.rows || frozen.cols) && { frozen }) });
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
    if (s.frozen?.rows || s.frozen?.cols) ws.views = [{ state: 'frozen', xSplit: s.frozen.cols || 0, ySplit: s.frozen.rows || 0 }];
    // Conditional formatting, in the order Sheets tries the rules (Excel's priority).
    (s.rules || []).forEach((r, i) => {
      const rule = ruleToExcel(r);
      if (rule) ws.addConditionalFormatting({ ref: r.range, rules: [{ ...rule, priority: i + 1, style: {
        ...(r.fill && { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: argb(r.fill) } } }),
        ...((r.color || r.bold) && { font: { ...(r.color && { color: { argb: argb(r.color) } }), ...(r.bold && { bold: true }) } }),
      } }] });
    });
    // The filter: an AutoFilter over its range, with the rows it hides hidden (by their stored values;
    // a formula's result isn't known here, so those rows stay shown).
    if (s.filter?.range && /^[A-Z]+\d+:[A-Z]+\d+$/.test(s.filter.range)) {
      ws.autoFilter = s.filter.range;
      const [, c1, r1, c2, r2] = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(s.filter.range);
      const lists = Object.entries(s.filter.hidden || {}).filter(([col, l]) => l?.length && colIndex(col) >= colIndex(c1) && colIndex(col) <= colIndex(c2));
      let last = Number(r2);
      for (const k of Object.keys(s.cells || {})) { const m = /^([A-Z]+)(\d+)$/.exec(k); if (m && colIndex(m[1]) >= colIndex(c1) && colIndex(m[1]) <= colIndex(c2)) last = Math.max(last, Number(m[2])); }
      for (let r = Number(r1) + 1; r <= last && lists.length; r++) {
        const hide = lists.some(([col, l]) => { const raw = s.cells?.[`${col}${r}`]; if (typeof raw === 'string' && raw.startsWith('=')) return false; return l.includes(raw === undefined ? '' : String(raw).trim()); });
        if (hide) ws.getRow(r).hidden = true;
      }
    }
    // Dropdowns as Excel list validations; tick boxes as a TRUE/FALSE list (Excel has no tick box to write).
    for (const v of s.validations || []) {
      const values = v.type === 'checkbox' ? ['TRUE', 'FALSE'] : (v.values || []).filter((x) => !/[,"]/.test(x));
      const list = values.join(',');
      if (!values.length || list.length > 255) continue; // Excel's limit for a written-out list
      ws.dataValidations.add(v.range, { type: 'list', allowBlank: true, formulae: [`"${list}"`], ...((v.strict || v.type === 'checkbox') && { showErrorMessage: true, errorStyle: 'stop' }) });
    }
  }
  if (!wb.worksheets.length) wb.addWorksheet('Sheet1');
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ---- data validation from Excel: list validations become dropdowns (a TRUE/FALSE list, a tick box).
// Excel gives them cell by cell; cells with the same list in a column are joined back into ranges.
export function validationsFromExcel(model, cells) {
  const byKind = new Map();
  for (const [addr, x] of Object.entries(model)) {
    const p = /^([A-Z]+)(\d+)$/.exec(String(addr).toUpperCase());
    if (!p || x?.type !== 'list' || !x.formulae?.[0]) continue;
    const f = String(x.formulae[0]).trim();
    let values;
    if (/^".*"$/.test(f)) values = f.slice(1, -1).split(',').map((t) => t.trim()).filter(Boolean);
    else {
      // A range of cells on this sheet holding the choices, like $D$1:$D$5.
      const m = /^\$?([A-Z]+)\$?(\d+):\$?([A-Z]+)\$?(\d+)$/i.exec(f);
      if (!m) continue;
      values = [];
      for (let c = colIndex(m[1].toUpperCase()); c <= colIndex(m[3].toUpperCase()); c++) for (let r = Number(m[2]); r <= Math.min(Number(m[4]), Number(m[2]) + 500); r++) {
        const raw = cells[`${colName(c)}${r}`];
        if (raw !== undefined && raw !== '' && !String(raw).startsWith('=')) values.push(String(raw).trim());
      }
    }
    values = [...new Set(values)].slice(0, 200);
    if (!values.length) continue;
    const checkbox = values.length === 2 && values.every((v) => /^(TRUE|FALSE)$/i.test(v)) && new Set(values.map((v) => v.toUpperCase())).size === 2;
    const def = checkbox ? { type: 'checkbox' } : { type: 'list', values, strict: !!x.showErrorMessage && x.errorStyle !== 'information' && x.errorStyle !== 'warning' };
    const key = `${p[1]}|${JSON.stringify(def)}`;
    if (!byKind.has(key)) byKind.set(key, { col: p[1], def, rows: [] });
    byKind.get(key).rows.push(Number(p[2]));
  }
  const out = [];
  for (const { col, def, rows } of byKind.values()) {
    rows.sort((a, b) => a - b);
    let start = rows[0], prev = rows[0];
    const flush = () => out.push({ id: `v${out.length + 1}`, range: `${col}${start}:${col}${prev}`, ...def });
    for (const r of rows.slice(1)) { if (r === prev + 1) prev = r; else { flush(); start = prev = r; } }
    flush();
  }
  return out.slice(0, 500);
}

// ---- conditional formatting, both ways
const OPS = { gt: 'greaterThan', gte: 'greaterThanOrEqual', lt: 'lessThan', lte: 'lessThanOrEqual', between: 'between', eq: 'equal', ne: 'notEqual' };
const formula = (v) => (v !== '' && v !== null && v !== undefined && !Number.isNaN(Number(v)) ? String(Number(v)) : `"${String(v ?? '').replace(/"/g, '""')}"`);
// Text rules are written as formula rules ("expression"), which Excel reads natively and which
// keep their text (the library loses it for its text rule types).
const quoted = (t) => `"${String(t ?? '').replace(/"/g, '""')}"`;
function ruleToExcel(r) {
  if (OPS[r.when]) return { type: 'cellIs', operator: OPS[r.when], formulae: r.when === 'between' ? [formula(r.value), formula(r.value2)] : [formula(r.value)] };
  const cell = String(r.range).split(':')[0].replace(/\$/g, '');
  const f = {
    contains: `NOT(ISERROR(SEARCH(${quoted(r.value)},${cell})))`,
    notContains: `ISERROR(SEARCH(${quoted(r.value)},${cell}))`,
    starts: `LEFT(${cell},LEN(${quoted(r.value)}))=${quoted(r.value)}`,
    empty: `LEN(TRIM(${cell}))=0`,
    notEmpty: `LEN(TRIM(${cell}))>0`,
    error: `ISERROR(${cell})`,
  }[r.when];
  return f ? { type: 'expression', formulae: [f] } : null;
}
const unformula = (f) => { const t = String(f ?? '').trim(); return /^".*"$/.test(t) ? t.slice(1, -1).replace(/""/g, '"') : t; };
/** A rule Sheets can show, from Excel's: value comparisons, and the usual text, blank and error tests. */
function ruleFromExcel(x) {
  if (x.type === 'cellIs') {
    const when = Object.keys(OPS).find((k) => OPS[k] === x.operator);
    if (!when) return null;
    return { when, value: unformula(x.formulae?.[0]), ...(when === 'between' && { value2: unformula(x.formulae?.[1]) }) };
  }
  const f = String(x.formulae?.[0] || '').trim().replace(/\$(?=[A-Z0-9])/g, '');
  const str = '"((?:[^"]|"")*)"';
  const un = (t) => t.replace(/""/g, '"');
  let m;
  if ((m = new RegExp(`^NOT\\(ISERROR\\(SEARCH\\(${str},[A-Z]+\\d+\\)\\)\\)$`, 'i').exec(f))) return { when: 'contains', value: un(m[1]) };
  if ((m = new RegExp(`^ISERROR\\(SEARCH\\(${str},[A-Z]+\\d+\\)\\)$`, 'i').exec(f))) return { when: 'notContains', value: un(m[1]) };
  if ((m = new RegExp(`^LEFT\\([A-Z]+\\d+,LEN\\(${str}\\)\\)=${str}$`, 'i').exec(f))) return { when: 'starts', value: un(m[1]) };
  if (/^LEN\(TRIM\([A-Z]+\d+\)\)=0$/i.test(f)) return { when: 'empty' };
  if (/^LEN\(TRIM\([A-Z]+\d+\)\)>0$/i.test(f)) return { when: 'notEmpty' };
  if (/^ISERROR\([A-Z]+\d+\)$/i.test(f)) return { when: 'error' };
  if (x.type === 'containsText' && x.text !== undefined) return { when: { notContains: 'notContains', beginsWith: 'starts' }[x.operator] || 'contains', value: String(x.text) };
  return null;
}

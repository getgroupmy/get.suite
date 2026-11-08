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
  // Dates: d, m and y parts (without digit placeholders); the closest of our styles.
  const bare = main.replace(/"[^"]*"|\[[^\]]*\]/g, '').toLowerCase();
  if (/[dy]/.test(bare) && /m/.test(bare) && !/[0#]/.test(bare)) {
    const ds = /dddd|mmmm/.test(bare) ? 'long' : !/d/.test(bare) ? 'month' : /^y/.test(bare) ? 'iso' : /mmm/.test(bare) ? 'medium' : 'short';
    return { num: 'date', ...(ds !== 'medium' && { ds }) };
  }
  if (main.includes('%')) return { num: 'percent', dp };
  const iso = /\[\$([A-Z]{3})\]/.exec(main) || /"([A-Z]{3})"/.exec(main);
  const sign = CURRENCY_SIGNS.find(([s]) => main.includes(s) || main.includes(`[$${s}`));
  if (iso || sign) return { num: 'currency', cur: iso ? iso[1] : sign[1], dp };
  if (/#,##0|0\.0|^0$/.test(main)) return { num: 'number', dp };
  return {};
}
const numToExcel = (f) => {
  const dec = f.dp === 0 ? '' : `.${'0'.repeat(f.dp ?? 2)}`;
  if (f.num === 'date') return { long: 'dddd, d mmmm yyyy', short: 'dd/mm/yyyy', iso: 'yyyy-mm-dd', month: 'mmm yyyy' }[f.ds] || 'd mmm yyyy';
  if (f.num === 'percent') return `0${f.dp ? `.${'0'.repeat(f.dp)}` : ''}%`;
  if (f.num === 'currency') return `[$${f.cur || 'MYR'}] #,##0${f.dp === undefined ? '.00' : dec}`;
  if (f.num === 'number') return `#,##0${f.dp === undefined ? '.00' : dec}`;
  return undefined;
};

// Excel writes functions newer than 2007 with a prefix ("_xlfn.XLOOKUP("); we keep plain names.
const NEW_FUNCS = ['XLOOKUP', 'STDEV.S', 'STDEV.P', 'VAR.S', 'VAR.P', 'RANK.EQ', 'IFS', 'SWITCH', 'IFNA', 'TEXTJOIN', 'CONCAT', 'MAXIFS', 'MINIFS', 'DAYS', 'XMATCH', 'VSTACK', 'HSTACK', 'TAKE', 'DROP', 'ISOWEEKNUM'];
const NEW_RE = new RegExp(`("(?:[^"]|"")*")|(?<![A-Z0-9_.])(${NEW_FUNCS.map((n) => n.replace('.', '\\.')).join('|')})(?=\\()`, 'gi');
export const formulaFromExcel = (f) => String(f).replace(/("(?:[^"]|"")*")|_xl(?:fn|ws)\./gi, (m, s) => s || '');
// The dynamic-array functions; FILTER and SORT also carry "_xlws." in the file.
const ARRAY_FUNCS = { FILTER: '_xlfn._xlws.', SORT: '_xlfn._xlws.', UNIQUE: '_xlfn.', SEQUENCE: '_xlfn.' };
const ARRAY_RE = new RegExp(`("(?:[^"]|"")*")|(?<![A-Z0-9_.])(${Object.keys(ARRAY_FUNCS).join('|')})(?=\\()`, 'gi');
export const formulaToExcel = (f) => String(f).replace(NEW_RE, (m, s, name) => s || `_xlfn.${name.toUpperCase()}`)
  .replace(ARRAY_RE, (m, s, name) => s || `${ARRAY_FUNCS[name.toUpperCase()]}${name.toUpperCase()}`);

function cellText(cell) {
  const v = cell.value;
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') {
    if ('formula' in v || 'sharedFormula' in v) return `=${formulaFromExcel(v.formula || cell.formula)}`;
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
    const hideRows = [], hideCols = [];
    const outRows = new Map(), outCols = new Map(); // outlined (grouped) rows/columns → hidden?
    ws.eachRow({ includeEmpty: true }, (row, r) => {
      if (row.outlineLevel > 0 && r <= 10000) outRows.set(r - 1, !!row.hidden);
      else if (row.hidden && r <= 10000) hideRows.push(r - 1);
      row.eachCell({ includeEmpty: true }, (cell, c) => {
        const key = `${colName(c - 1)}${r}`;
        const t = cellText(cell);
        if (t !== null && t !== '') cells[key] = t;
        const f = {};
        if (cell.font?.bold) f.b = 1;
        if (cell.font?.italic) f.i = 1;
        if (cell.font?.underline) f.u = 1;
        if (cell.font?.strike) f.s = 1;
        if (cell.alignment?.wrapText) f.wrap = 1;
        const bd = ['top', 'bottom', 'left', 'right'].filter((side) => cell.border?.[side]?.style).map((side) => side[0]).join('');
        if (bd) f.bd = bd;
        const color = hex(cell.font?.color?.argb);
        if (color && color !== '#000000') f.color = color;
        const fill = cell.fill?.type === 'pattern' && cell.fill.pattern === 'solid' ? hex(cell.fill.fgColor?.argb) : null;
        if (fill && fill !== '#ffffff') f.fill = fill;
        if (['left', 'center', 'right'].includes(cell.alignment?.horizontal)) f.align = cell.alignment.horizontal;
        Object.assign(f, numFromExcel(cell.numFmt));
        if (Object.keys(f).length) formats[key] = f;
      });
    });
    ws.columns?.forEach((col, i) => { if (i >= 702) return; if (col?.outlineLevel > 0) outCols.set(i, !!col.hidden); else if (col?.hidden) hideCols.push(i); });
    // Outlined rows and columns become groups (collapsed when hidden), one per run.
    const groups = [];
    for (const [axis, m] of [['row', outRows], ['col', outCols]]) {
      for (const i of [...m.keys()].sort((a, b) => a - b)) {
        const last = groups[groups.length - 1];
        if (last && last.axis === axis && last.to === i - 1) { last.to = i; last.collapsed = last.collapsed && m.get(i); } else groups.push({ axis, from: i, to: i, collapsed: m.get(i) });
      }
    }
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
    // Hidden rows and columns; rows inside the AutoFilter were hidden by it, not by hand.
    const [fr1, fr2] = filter ? filter.range.match(/\d+/g).map((n) => Number(n) - 1) : [-1, -1];
    const keptRows = hideRows.filter((r) => r <= fr1 || r > fr2);
    const hide = keptRows.length || hideCols.length ? { ...(keptRows.length && { rows: keptRows }), ...(hideCols.length && { cols: hideCols }) } : null;
    // Merged cells, as ranges ("A1:C1"); the covered cells' values (Excel keeps only the top-left) are dropped.
    const merges = (ws.model.merges || []).map((m) => String(m).toUpperCase()).filter((m) => /^[A-Z]+\d+:[A-Z]+\d+$/.test(m));
    for (const m of merges) {
      const [a, b] = m.split(':').map((x) => ({ c: x.match(/[A-Z]+/)[0], r: Number(x.match(/\d+/)[0]) }));
      const ci = (l) => [...l].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
      for (let r = a.r; r <= b.r; r++) for (let c = ci(a.c); c <= ci(b.c); c++) if (r !== a.r || c !== ci(a.c)) delete cells[`${colName(c)}${r}`];
    }
    sheets.push({ _ws: ws.name, name: ws.name.slice(0, 30), cells, colWidths, ...(merges.length && { merges }), ...(rules.length && { rules }), ...(validations.length && { validations }), ...(filter && { filter }), ...(Object.keys(formats).length && { formats }), ...(frozen && (frozen.rows || frozen.cols) && { frozen }), ...(hide && { hide }), ...(groups.length && { groups }) });
  });
  // Named ranges ("Sales" = 'Sheet1'!$A$2:$A$10): on the sheet they point into.
  for (const d of wb.definedNames?.model || []) {
    const m = /^(?:'((?:[^']|'')+)'|([^'!]+))!\$?([A-Z]+)\$?(\d+)(?::\$?([A-Z]+)\$?(\d+))?$/i.exec(String(d.ranges?.[0] || ''));
    if (!m || !/^[A-Za-z_][A-Za-z0-9_]{0,49}$/.test(d.name || '') || /^[A-Za-z]{1,3}\d+$/.test(d.name)) continue;
    const s = sheets.find((x) => x._ws === (m[1] ? m[1].replace(/''/g, "'") : m[2]));
    if (!s) continue;
    const a = `${m[3]}${m[4]}`.toUpperCase(), b = m[5] ? `${m[5]}${m[6]}`.toUpperCase() : a;
    (s.names ||= {})[d.name] = a === b ? a : `${a}:${b}`;
  }
  for (const s of sheets) delete s._ws;
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
      if (v.startsWith('=')) cell.value = { formula: formulaToExcel(v.slice(1)) };
      else if (v !== '' && !Number.isNaN(Number(v)) && /^[-+]?(\d|\.\d)/.test(v.trim())) cell.value = Number(v);
      else if (/^(TRUE|FALSE)$/i.test(v)) cell.value = /^TRUE$/i.test(v);
      else if (/^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))) { cell.value = new Date(`${v}T00:00:00Z`); cell.numFmt = 'yyyy-mm-dd'; } // a real date in Excel
      else cell.value = v;
    }
    for (const r of s.hide?.rows || []) {
      const row = ws.getRow(r + 1);
      row.hidden = true;
      if (!row.cellCount) row.getCell(1).numFmt = 'General'; // a row with nothing in it isn't written at all otherwise
    }
    for (const c of s.hide?.cols || []) ws.getColumn(c + 1).hidden = true;
    // Grouped rows and columns: an outline level, hidden when collapsed.
    for (const g of s.groups || []) {
      for (let i = g.from; i <= g.to; i++) {
        const line = g.axis === 'row' ? ws.getRow(i + 1) : ws.getColumn(i + 1);
        line.outlineLevel = 1;
        if (g.collapsed) line.hidden = true;
        if (g.axis === 'row' && !line.cellCount) line.getCell(1).numFmt = 'General';
      }
    }
    for (const m of s.merges || []) { try { ws.mergeCells(m); } catch { /* an overlapping or bad range is skipped */ } }
    for (const [key, f] of Object.entries(s.formats || {})) {
      const cell = ws.getCell(key);
      if (f.b || f.i || f.u || f.s || f.color) cell.font = { bold: !!f.b, italic: !!f.i, underline: !!f.u, strike: !!f.s, ...(f.color && { color: { argb: argb(f.color) } }) };
      if (f.fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(f.fill) } };
      if (f.align || f.wrap) cell.alignment = { ...(f.align && { horizontal: f.align }), ...(f.wrap && { wrapText: true }) };
      if (f.bd) cell.border = Object.fromEntries([['t', 'top'], ['b', 'bottom'], ['l', 'left'], ['r', 'right']].filter(([k]) => f.bd.includes(k)).map(([, side]) => [side, { style: 'thin', color: { argb: 'FF000000' } }]));
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
  // Named ranges, as Excel defined names.
  wb.worksheets.forEach((ws, i) => {
    const s = (data.sheets || [])[i];
    for (const [name, target] of Object.entries(s?.names || {})) {
      const abs = String(target).toUpperCase().split(':').map((x) => x.replace(/^([A-Z]+)(\d+)$/, '$$$1$$$2')).join(':');
      try { wb.definedNames.add(`'${ws.name.replace(/'/g, "''")}'!${abs}`, name); } catch { /* not a name Excel takes */ }
    }
  });
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

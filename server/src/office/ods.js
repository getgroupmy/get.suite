// OpenDocument spreadsheets (.ods, LibreOffice Calc's own format), both ways: every sheet, values and
// formulas (OpenFormula: [.A1:.B2], [$Other.C3], ";" between arguments), bold/italic/underline/strike,
// text and fill colour, alignment, wrapping, borders, number formats (number, percent, currency, date),
// column widths and row heights, merged cells, hidden rows and columns, notes and frozen rows/columns.
import JSZip from 'jszip';
import { parseDocument } from 'htmlparser2';
import { tablesOf, plainTableRefs as rangesForTables } from './tablerefs.js';
import { colName } from './sheetnames.js';
import { CALCEXT_NS, rulesToCalcext, rulesFromCalcext } from './odscf.js';
import { filterToOds, filterFromOds } from './odsfilter.js';
import { chartObject, chartFrame, chartFromObject } from './odschart.js';
import { threadFromNote, threadFromComment } from './excel.js';
import { formulaResults } from './sheetvalues.js';

export const ODS_MIME = 'application/vnd.oasis.opendocument.spreadsheet';
const x = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// ---- dropdowns (Sheets' list validations) as OpenDocument content validations, both ways
const MULTI = 'Several choices', MULTI_STRICT = 'Several choices (only these)'; // as in excel.js: marks a several-choices dropdown
const odsQuote = (name) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `'${String(name).replace(/'/g, "''")}'`);
/** A dropdown as a content validation's condition: its choices written out, or the cells they come from. */
export function validationCondition(v, sheetName) {
  if (v.type === 'checkbox') return 'of:cell-content-is-in-list("TRUE";"FALSE")';
  const src = /^(?:('(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_]*)!)?([A-Z]{1,3})(\d+):([A-Z]{1,3})(\d+)$/i.exec(String(v.source || '').trim());
  if (src) return `of:cell-content-is-in-list([$${src[1] || odsQuote(sheetName)}.$${src[2].toUpperCase()}$${src[3]}:.$${src[4].toUpperCase()}$${src[5]}])`;
  const values = (v.values || []).map(String).filter(Boolean);
  return values.length ? `of:cell-content-is-in-list(${values.map((t) => `"${t.replace(/"/g, '""')}"`).join(';')})` : null;
}
/** A content validation's condition (with whether only the choices are allowed, and its help title) as a dropdown, or null. */
export function validationFromCondition(cond, { strict = false, title = '' } = {}, sheetName = '') {
  const m = /^(?:of:|oooc:)?cell-content-is-in-list\(([\s\S]*)\)$/.exec(String(cond || '').trim());
  if (!m) return null;
  const arg = m[1].trim();
  const multi = title === MULTI || title === MULTI_STRICT;
  const only = multi ? title === MULTI_STRICT : strict;
  const r = /^\[?\$?('(?:[^']|'')+'|[^.[\]'$]+)?\.\$?([A-Z]{1,3})\$?(\d+):(?:\$?(?:'(?:[^']|'')+'|[^.[\]'$]+))?\.\$?([A-Z]{1,3})\$?(\d+)\]?$/i.exec(arg);
  if (r) {
    const sheet = r[1] ? r[1].replace(/^'|'$/g, '').replace(/''/g, "'") : '';
    const prefix = sheet && sheet !== sheetName ? `${odsQuote(sheet)}!` : '';
    return { type: 'list', source: `${prefix}${r[2].toUpperCase()}${r[3]}:${r[4].toUpperCase()}${r[5]}`, strict: only, ...(multi && { multi: true }) };
  }
  const values = [];
  const re = /"((?:[^"]|"")*)"/g;
  let q;
  while ((q = re.exec(arg))) values.push(q[1].replace(/""/g, '"').trim());
  const list = [...new Set(values.filter(Boolean))].slice(0, 200);
  if (!list.length) return null;
  if (list.length === 2 && list.every((t) => /^(TRUE|FALSE)$/i.test(t)) && new Set(list.map((t) => t.toUpperCase())).size === 2) return { type: 'checkbox' };
  return { type: 'list', values: list, strict: only, ...(multi && { multi: true }) };
}

const colIndex = (s) => [...s.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
const COLOR = /^#[0-9a-f]{6}$/i;
const CELL = /^([A-Z]{1,3})(\d+)$/;

// ---- formulas ----
const REF = String.raw`\$?[A-Za-z]{1,3}\$?\d+`;
const SHEET = String.raw`(?:'(?:[^']|'')+'|[A-Za-z_][\w.]*)`;
/** A Sheets formula ("=SUM(A1:B2, Other!C3)") as OpenFormula ("of:=SUM([.A1:.B2];[$Other.C3])"). */
export function formulaToOds(f) {
  const body = String(f).replace(/^=/, '');
  const re = new RegExp(`("(?:[^"]|"")*")|(?:(${SHEET})!)?(${REF})(?::(${REF}))?(?![\\w(])|([{}])|(,)|(;)`, 'g');
  let depth = 0; // inside an array {1,2;3,4}: columns ";", rows "|"
  const out = body.replace(re, (m, str, sheet, a, b, brace, comma, semi) => {
    if (str) return str;
    if (brace) { depth += brace === '{' ? 1 : -1; return brace; }
    if (comma) return ';';
    if (semi) return depth ? '|' : ';';
    const sh = sheet ? `$${sheet}` : '';
    return b ? `[${sh}.${a}:${sh ? sh : ''}.${b}]` : `[${sh}.${a}]`;
  });
  return `of:=${out}`;
}
/** An OpenFormula ("of:=SUM([.A1:.B2];[$'My sheet'.C3])") as a Sheets formula ("=SUM(A1:B2,'My sheet'!C3)"). */
export function formulaFromOds(f) {
  const body = String(f).replace(/^(?:of|oooc|msoxl):/i, '').replace(/^=/, '');
  let depth = 0;
  const out = body.replace(/("(?:[^"]|"")*")|\[([^\]]*)\]|([{}])|(;)|(\|)/g, (m, str, ref, brace, semi, bar) => {
    if (str) return str;
    if (brace) { depth += brace === '{' ? 1 : -1; return brace; }
    if (semi) return depth ? ',' : ',';
    if (bar) return ';';
    // [.A1], [.A1:.B2], [$Sheet2.A1:.B2], [$'My sheet'.A1], [.A:.A]
    const parts = ref.split(':').map((p) => {
      const mm = /^\$?((?:'(?:[^']|'')+'|[^.]*))?\.(\$?[A-Za-z]*\$?\d*)$/.exec(p.trim());
      return mm ? { sheet: mm[1] || '', at: mm[2] } : null;
    });
    if (parts.some((p) => !p)) return m;
    const sheet = parts[0].sheet;
    const pre = sheet ? `${sheet}!` : '';
    return pre + parts.map((p) => p.at).join(':');
  });
  return `=${out}`;
}

// ---- sheet → .ods ----
const DATA_STYLES = {
  number: (f) => `<number:number-style style:name="N_${f.key}"><number:number number:decimal-places="${f.dp ?? 2}" number:min-decimal-places="${f.dp ?? 2}" number:min-integer-digits="1" number:grouping="true"/></number:number-style>`,
  percent: (f) => `<number:percentage-style style:name="N_${f.key}"><number:number number:decimal-places="${f.dp ?? 0}" number:min-decimal-places="${f.dp ?? 0}" number:min-integer-digits="1"/><number:text>%</number:text></number:percentage-style>`,
  currency: (f) => `<number:currency-style style:name="N_${f.key}"><number:currency-symbol>${x(f.cur || 'MYR')}</number:currency-symbol><number:text> </number:text><number:number number:decimal-places="${f.dp ?? 2}" number:min-decimal-places="${f.dp ?? 2}" number:min-integer-digits="1" number:grouping="true"/></number:currency-style>`,
  date: (f) => `<number:date-style style:name="N_${f.key}">${{
    iso: '<number:year number:style="long"/><number:text>-</number:text><number:month number:style="long"/><number:text>-</number:text><number:day number:style="long"/>',
    short: '<number:day number:style="long"/><number:text>/</number:text><number:month number:style="long"/><number:text>/</number:text><number:year number:style="long"/>',
    month: '<number:month number:textual="true"/><number:text> </number:text><number:year number:style="long"/>',
    long: '<number:day-of-week number:style="long"/><number:text>, </number:text><number:day/><number:text> </number:text><number:month number:textual="true" number:style="long"/><number:text> </number:text><number:year number:style="long"/>',
  }[f.ds] || '<number:day/><number:text> </number:text><number:month number:textual="true"/><number:text> </number:text><number:year number:style="long"/>'}</number:date-style>`,
};
const isNum = (v) => v !== '' && !Number.isNaN(Number(v)) && /^[-+]?(\d|\.\d)/.test(String(v).trim());
const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

// ---- comment threads on cells: Calc keeps one comment a cell, by whoever wrote it; a thread's replies go in it the way
// Excel writes them for older programs ("Reply (name):" and the reply, indented), so they come back as replies.
const odsComments = new WeakMap(); // book → [{ sheet, cell, author, at, text, replies }]
/** The comment threads a spreadsheet read from an .ods file had (see sheetFromOds). */
export const commentsOfOds = (book) => odsComments.get(book) || [];
function threadAnnotation(t) {
  const lines = [...String(t.text).split('\n'), ...(t.replies || []).flatMap((r) => [`Reply${r.author ? ` (${String(r.author).replace(/[()\n]/g, '')})` : ''}:`, ...String(r.text || '').split('\n').map((l) => `    ${l}`)])];
  return `<office:annotation><dc:creator>${x(t.author || 'Workspace')}</dc:creator><dc:date>${new Date(Number.isFinite(t.at) ? t.at : Date.now()).toISOString().slice(0, 19)}</dc:date>${lines.map((l) => `<text:p>${x(l)}</text:p>`).join('')}</office:annotation>`;
}
export async function odsFromSheet(data, { comments = [] } = {}) {
  const sheets = data?.sheets?.length ? data.sheets : [{ name: 'Sheet1', cells: {} }];
  const tables = tablesOf(sheets);
  const cellStyles = new Map(), dataStyles = new Map(), colStyles = new Map(), rowStyles = new Map();
  const dataStyle = (f) => {
    if (!DATA_STYLES[f.num]) return null;
    const key = `${f.num}_${f.dp ?? ''}_${f.cur || ''}_${f.ds || ''}`.replace(/[^\w]/g, '');
    if (!dataStyles.has(key)) dataStyles.set(key, DATA_STYLES[f.num]({ ...f, key }));
    return `N_${key}`;
  };
  const cellStyle = (f) => {
    const key = JSON.stringify(f);
    if (cellStyles.has(key)) return cellStyles.get(key).name;
    const ds = dataStyle(f);
    const tp = [f.b && 'fo:font-weight="bold"', f.i && 'fo:font-style="italic"', f.u && 'style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"', f.s && 'style:text-line-through-style="solid"', COLOR.test(f.color || '') && `fo:color="${f.color}"`].filter(Boolean).join(' ');
    const border = (side) => (String(f.bd || '').includes(side[0]) ? `fo:border-${side}="0.5pt solid #000000"` : '');
    const cp = [COLOR.test(f.fill || '') && `fo:background-color="${f.fill}"`, f.wrap && 'fo:wrap-option="wrap"', f.va && `style:vertical-align="${f.va === 'middle' ? 'middle' : f.va}"`, ...['top', 'bottom', 'left', 'right'].map(border), f.align && 'style:text-align-source="fix"',
      f.rot && `style:rotation-angle="${{ up: 90, down: 270, tiltup: 45, tiltdown: 315 }[f.rot] ?? 0}"`].filter(Boolean).join(' ');
    const pp = f.align ? `<style:paragraph-properties fo:text-align="${{ left: 'start', center: 'center', right: 'end' }[f.align] || 'start'}"/>` : '';
    const name = `ce${cellStyles.size + 1}`;
    cellStyles.set(key, { name, xml: `<style:style style:name="${name}" style:family="table-cell" style:parent-style-name="Default"${ds ? ` style:data-style-name="${ds}"` : ''}>${cp ? `<style:table-cell-properties ${cp}/>` : ''}${pp}${tp ? `<style:text-properties ${tp}/>` : ''}</style:style>` });
    return name;
  };
  const sized = (map, prefix, family, prop, len) => {
    const key = `${len}`;
    if (!map.has(key)) map.set(key, { name: `${prefix}${map.size + 1}`, xml: `<style:style style:name="${prefix}${map.size + 1}" style:family="${family}"><style:${family}-properties ${prop}="${len}"/></style:style>` });
    return map.get(key).name;
  };
  const pxToCm = (px) => `${(Number(px) * 2.54 / 96).toFixed(3)}cm`;
  let tablesXml = '';
  const settings = [];
  const validations = []; // content validations (dropdowns), for every sheet
  const cfStyles = []; // the cell styles conditional formatting applies (named styles)
  const databaseRanges = []; // the sheets' filters
  const chartObjects = []; // the charts' objects (Object 1, Object 2…)
  for (const [si, s] of sheets.entries()) {
    const resultOf = formulaResults({ sheets }, si);
    const threadAt = new Map((comments || []).filter((t) => (t.sheet || 0) === si && /^[A-Z]{1,3}\d{1,7}$/.test(t.cell || '') && t.text).map((t) => [t.cell, t]));
    const cells = s.cells || {}, formats = s.formats || {};
    // Alternating colours: each cell's fill (its own fill wins), the heading row bold.
    const fmt = (key) => formats[key];
    const banded = {};
    for (const band of s.bands || []) {
      const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(String(band.range || ''));
      if (!m) continue;
      const [c1, r1, c2, r2] = [colIndex(m[1]), +m[2], colIndex(m[3]), +m[4]];
      if (r2 - r1 > 5000 || c2 - c1 > 200) continue;
      for (let r = r1; r <= r2; r++) {
        const kind = band.header !== false && r === r1 ? 'head' : band.footer && r === r2 && r2 > r1 ? 'foot' : (r - r1 - (band.header !== false ? 1 : 0)) % 2 === 0 ? 'odd' : 'even';
        if (!COLOR.test(band[kind] || '')) continue;
        for (let c = c1; c <= c2; c++) banded[`${colName(c)}${r}`] = { fill: band[kind], ...(kind === 'head' && { b: 1 }) };
      }
    }
    // The used area: every cell with something in it, a format, a note or a merge.
    let maxR = 0, maxC = 0;
    const touch = (key) => { const m = CELL.exec(key); if (!m) return; maxR = Math.max(maxR, +m[2]); maxC = Math.max(maxC, colIndex(m[1])); };
    [cells, formats, s.notes || {}, banded, Object.fromEntries(threadAt)].forEach((o) => Object.keys(o).forEach(touch));
    for (const mg of s.merges || []) String(mg).split(':').forEach(touch);
    for (const r of s.hide?.rows || []) maxR = Math.max(maxR, r + 1);
    for (const c of s.hide?.cols || []) maxC = Math.max(maxC, c);
    maxR = Math.min(Math.max(maxR, 1), 100000); maxC = Math.min(maxC, 1023);
    // Merges: the top-left cell spans, the rest are covered.
    const spans = new Map(), covered = new Set();
    for (const mg of s.merges || []) {
      const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(String(mg));
      if (!m) continue;
      const [c1, r1, c2, r2] = [colIndex(m[1]), +m[2], colIndex(m[3]), +m[4]];
      spans.set(`${colName(c1)}${r1}`, { cols: c2 - c1 + 1, rows: r2 - r1 + 1 });
      for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) if (r !== r1 || c !== c1) covered.add(`${colName(c)}${r}`);
    }
    // Dropdowns: each a content validation, named on every cell of its range (up to 2000 rows).
    const validationOf = new Map();
    for (const v of s.validations || []) {
      if (v.type !== 'list' && v.type !== 'checkbox') continue; // (rules aren't written)
      const m = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(String(v.range || ''));
      const sheetName = String(s.name || 'Sheet').slice(0, 100);
      const cond = m && validationCondition(v, sheetName);
      if (!cond) continue;
      const [c1, r1] = [colIndex(m[1]), +m[2]];
      const [c2, r2] = m[3] ? [Math.min(colIndex(m[3]), 1023), Math.min(+m[4], r1 + 1999)] : [c1, r1];
      const vname = `val${validations.length + 1}`;
      const help = v.multi ? `<table:help-message table:title="${v.strict ? MULTI_STRICT : MULTI}" table:display="true"><text:p>Pick one or more of the choices, separated by commas</text:p></table:help-message>` : '';
      validations.push(`<table:content-validation table:name="${vname}" table:condition="${x(cond)}" table:allow-empty-cell="true" table:base-cell-address="${x(`${odsQuote(sheetName)}.${m[1]}${m[2]}`)}" table:display-list="unsorted">${help}<table:error-message table:display="${(v.strict && !v.multi) || v.type === 'checkbox'}" table:message-type="stop"/></table:content-validation>`);
      for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) { validationOf.set(`${colName(c)}${r}`, vname); maxR = Math.max(maxR, r); maxC = Math.max(maxC, c); }
    }
    const hiddenRows = new Set(s.hide?.rows || []), hiddenCols = new Set(s.hide?.cols || []);
    // The filter: LibreOffice's AutoFilter over its range, and the rows it hides marked as filtered out.
    const fx = filterToOds(s.filter, cells, String(s.name || 'Sheet').slice(0, 100));
    if (fx) { databaseRanges.push(fx.xml); for (const r of fx.hiddenRows) maxR = Math.max(maxR, r); }
    const filteredRows = fx?.hiddenRows || new Set();
    let cols = '';
    for (let c = 0; c <= maxC; c++) {
      const w = s.colWidths?.[colName(c)];
      cols += `<table:table-column table:style-name="${sized(colStyles, 'co', 'table-column', 'style:column-width', pxToCm(w || 100))}"${hiddenCols.has(c) ? ' table:visibility="collapse"' : ''} table:default-cell-style-name="Default"/>`;
    }
    let rows = '';
    for (let r = 1; r <= maxR; r++) {
      const h = s.rowHeights?.[String(r)];
      let row = `<table:table-row${h ? ` table:style-name="${sized(rowStyles, 'ro', 'table-row', 'style:row-height', pxToCm(h))}"` : ''}${hiddenRows.has(r - 1) ? ' table:visibility="collapse"' : filteredRows.has(r) ? ' table:visibility="filter"' : ''}>`;
      for (let c = 0; c <= maxC; c++) {
        const key = `${colName(c)}${r}`;
        if (covered.has(key)) { row += '<table:covered-table-cell/>'; continue; }
        const raw0 = cells[key];
        const f = { ...(banded[key] || {}), ...(fmt(key) || {}) };
        const attrs = [];
        if (Object.keys(f).length) attrs.push(`table:style-name="${cellStyle(f)}"`);
        if (validationOf.has(key)) attrs.push(`table:content-validation-name="${validationOf.get(key)}"`);
        const sp = spans.get(key);
        if (sp) attrs.push(`table:number-columns-spanned="${sp.cols}" table:number-rows-spanned="${sp.rows}"`);
        let inner = '';
        if (raw0 !== undefined && raw0 !== null && raw0 !== '') {
          let v = String(raw0);
          if (v.startsWith('=')) {
            if (tables.length) v = `=${rangesForTables(v.slice(1), tables, r, c, s.name)}`;
            attrs.push(`table:formula="${x(formulaToOds(v))}"`);
            const res = f.num === 'date' ? null : resultOf(key); // (its result too, for programs that show without working out)
            if (f.num === 'date') attrs.push('office:value-type="date"');
            else if (res && 'number' in res) { attrs.push(`office:value-type="${f.num === 'percent' ? 'percentage' : f.num === 'currency' ? 'currency' : 'float'}" office:value="${res.number}"${f.num === 'currency' ? ` office:currency="${x(f.cur || 'MYR')}"` : ''}`); inner = `<text:p>${x(String(res.number))}</text:p>`; }
            else if (res && 'bool' in res) { attrs.push(`office:value-type="boolean" office:boolean-value="${res.bool}"`); inner = `<text:p>${res.bool ? 'TRUE' : 'FALSE'}</text:p>`; }
            else if (res && 'text' in res && res.text !== '') { attrs.push('office:value-type="string"'); inner = `<text:p>${x(res.text)}</text:p>`; }
            else if (res && 'error' in res) { attrs.push('office:value-type="string"'); inner = `<text:p>${x(res.error)}</text:p>`; }
            else if (f.num === 'percent') attrs.push('office:value-type="percentage"');
          } else if (isNum(v)) {
            const type = f.num === 'percent' ? 'percentage' : f.num === 'currency' ? 'currency' : 'float';
            attrs.push(`office:value-type="${type}" office:value="${Number(v)}"${type === 'currency' ? ` office:currency="${x(f.cur || 'MYR')}"` : ''}`);
            inner = `<text:p>${x(v)}</text:p>`;
          } else if (/^(TRUE|FALSE)$/i.test(v)) {
            attrs.push(`office:value-type="boolean" office:boolean-value="${/^TRUE$/i.test(v)}"`);
            inner = `<text:p>${v.toUpperCase()}</text:p>`;
          } else if (isDay(v)) {
            if (!f.num) { // shown as a date, not a number of days
              const st = `table:style-name="${cellStyle({ ...f, num: 'date', ds: 'iso' })}"`;
              if (attrs[0]?.startsWith('table:style-name=')) attrs[0] = st; else attrs.unshift(st);
            }
            attrs.push(`office:value-type="date" office:date-value="${v}"`);
            inner = `<text:p>${v}</text:p>`;
          } else {
            attrs.push('office:value-type="string"');
            inner = v.split('\n').map((l) => `<text:p>${x(l)}</text:p>`).join('');
          }
        }
        const note = s.notes?.[key];
        if (note) inner = `<office:annotation><text:p>${String(note).split('\n').map(x).join('</text:p><text:p>')}</text:p></office:annotation>${inner}`;
        else if (threadAt.has(key)) inner = threadAnnotation(threadAt.get(key)) + inner; // (a cell's own note wins, as in Excel)
        row += attrs.length || inner ? `<table:table-cell ${attrs.join(' ')}>${inner}</table:table-cell>` : '<table:table-cell/>';
      }
      rows += `${row}</table:table-row>`;
    }
    const name = String(s.name || 'Sheet').slice(0, 100);
    // Conditional formatting, as LibreOffice keeps it (its cell styles named for this sheet: CF1x1…).
    const cf = rulesToCalcext(s.rules, name, formulaToOds, `CF${sheets.indexOf(s) + 1}x`); // (letters and digits only: LibreOffice renames others)
    cfStyles.push(...cf.styles);
    // Charts: each an embedded chart object drawing from these cells, in a frame where it sits.
    let frames = '';
    for (const ch of Object.values(s.charts || {})) {
      const obj = chartObject(ch, name, cells);
      if (!obj) continue;
      frames += chartFrame(ch, chartObjects.length, name);
      chartObjects.push(obj);
    }
    tablesXml += `<table:table table:name="${x(name)}">${frames ? `<table:shapes>${frames}</table:shapes>` : ''}${cols}${rows}${cf.xml}</table:table>`;
    if (s.frozen?.rows || s.frozen?.cols) settings.push({ name, rows: s.frozen.rows || 0, cols: s.frozen.cols || 0 });
  }
  const NS = `${CALCEXT_NS} xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" ` + 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:number="urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0" xmlns:of="urn:oasis:names:tc:opendocument:xmlns:of:1.2" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0" office:version="1.3"';
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content ${NS}><office:automatic-styles>${[...dataStyles.values()].join('')}${[...colStyles.values(), ...rowStyles.values(), ...cellStyles.values()].map((s) => s.xml).join('')}</office:automatic-styles><office:body><office:spreadsheet>${validations.length ? `<table:content-validations>${validations.join('')}</table:content-validations>` : ''}${tablesXml}${databaseRanges.length ? `<table:database-ranges>${databaseRanges.join('')}</table:database-ranges>` : ''}</office:spreadsheet></office:body></office:document-content>`;
  const styles = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles ${NS}><office:styles><style:default-style style:family="table-cell"><style:text-properties fo:font-size="10pt"/></style:default-style><style:style style:name="Default" style:family="table-cell"/>${cfStyles.join('')}</office:styles></office:document-styles>`;
  // Frozen rows and columns live in the view settings.
  const item = (n, t, v) => `<config:config-item config:name="${n}" config:type="${t}">${v}</config:config-item>`;
  const settingsXml = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-settings ${NS}><office:settings><config:config-item-set config:name="ooo:view-settings"><config:config-item-map-indexed config:name="Views"><config:config-item-map-entry>${item('ViewId', 'string', 'view1')}<config:config-item-map-named config:name="Tables">${settings.map((t) => `<config:config-item-map-entry config:name="${x(t.name)}">${item('HorizontalSplitMode', 'short', t.cols ? 2 : 0)}${item('VerticalSplitMode', 'short', t.rows ? 2 : 0)}${item('HorizontalSplitPosition', 'int', t.cols)}${item('VerticalSplitPosition', 'int', t.rows)}${item('ActiveSplitRange', 'short', 2)}${item('PositionLeft', 'int', 0)}${item('PositionRight', 'int', t.cols)}${item('PositionTop', 'int', 0)}${item('PositionBottom', 'int', t.rows)}</config:config-item-map-entry>`).join('')}</config:config-item-map-named></config:config-item-map-entry></config:config-item-map-indexed></config:config-item-set></office:settings></office:document-settings>`;
  const meta = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-meta ${NS}><office:meta><meta:generator>Workspace</meta:generator></office:meta></office:document-meta>`;
  const manifest = `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">
<manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="${ODS_MIME}"/>
${['content.xml', 'styles.xml', 'meta.xml', 'settings.xml'].map((f) => `<manifest:file-entry manifest:full-path="${f}" manifest:media-type="text/xml"/>`).join('\n')}
${chartObjects.map((o, k) => `<manifest:file-entry manifest:full-path="Object ${k + 1}/" manifest:version="1.3" manifest:media-type="application/vnd.oasis.opendocument.chart"/><manifest:file-entry manifest:full-path="Object ${k + 1}/content.xml" manifest:media-type="text/xml"/>`).join('\n')}
</manifest:manifest>`;
  const zip = new JSZip();
  zip.file('mimetype', ODS_MIME, { compression: 'STORE' });
  zip.file('content.xml', content);
  zip.file('styles.xml', styles);
  zip.file('meta.xml', meta);
  zip.file('settings.xml', settingsXml);
  chartObjects.forEach((o, k) => zip.file(`Object ${k + 1}/content.xml`, o));
  zip.file('META-INF/manifest.xml', manifest);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', mimeType: ODS_MIME });
}

// ---- .ods → sheet ----
const kids = (el) => el?.children || [];
const tags = (el, name) => kids(el).filter((k) => k.type === 'tag' && (!name || k.name === name));
const textOf = (el) => (el.type === 'text' ? el.data : el.name === 'text:s' ? ' '.repeat(Number(el.attribs['text:c']) || 1) : el.name === 'text:tab' ? '\t' : el.name === 'text:line-break' ? '\n' : el.name === 'office:annotation' ? '' : kids(el).map(textOf).join(''));
const lengthPx = (v) => { const m = /^([\d.]+)(cm|mm|in|pt|px)$/.exec(String(v || '')); if (!m) return null; const n = Number(m[1]); return Math.round({ cm: n * 96 / 2.54, mm: n * 96 / 25.4, in: n * 96, pt: n * 4 / 3, px: n }[m[2]]); };

/** Read an .ods file as a spreadsheet's content: { sheets }. */
export async function sheetFromOds(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const contentXml = await zip.file('content.xml')?.async('string');
  if (!contentXml) throw new Error('Not an OpenDocument spreadsheet');
  const parse = (s) => parseDocument(s || '', { xmlMode: true, decodeEntities: true });
  const root = parse(contentXml), stylesRoot = parse(await zip.file('styles.xml')?.async('string'));
  const styles = new Map(), dataStyles = new Map();
  const readStyles = (node) => {
    for (const el of tags(node)) {
      if (el.name === 'style:style') {
        const get = (n) => tags(el, n)[0]?.attribs || {};
        const def = { parent: el.attribs['style:parent-style-name'], data: el.attribs['style:data-style-name'], tp: get('style:text-properties'), cp: get('style:table-cell-properties'), pp: get('style:paragraph-properties'), colp: get('style:table-column-properties'), rowp: get('style:table-row-properties') };
        styles.set(el.attribs['style:name'], def);
        // (also by the name it's shown under: what LibreOffice's conditional formats refer to, for a style it renamed)
        const shown = el.attribs['style:display-name'];
        if (shown && !styles.has(shown)) styles.set(shown, def);
      } else if (/^number:(number|percentage|currency|date|time)-style$/.test(el.name)) {
        const n = tags(el, 'number:number')[0]?.attribs || {};
        const kind = el.name.slice(7, -6);
        const parts = tags(el).map((k) => k.name);
        const sym = textOf(tags(el, 'number:currency-symbol')[0] || { children: [] }).trim();
        const dp = n['number:decimal-places'] !== undefined ? Math.min(10, Number(n['number:decimal-places'])) : undefined;
        const ds = kind !== 'date' ? undefined : parts.includes('number:day-of-week') ? 'long' : parts[0] === 'number:year' ? 'iso' : parts.includes('number:day') ? (tags(el, 'number:month')[0]?.attribs['number:textual'] === 'true' ? undefined : 'short') : 'month';
        dataStyles.set(el.attribs['style:name'], kind === 'number' ? { num: 'number', ...(dp !== undefined && { dp }) } : kind === 'percentage' ? { num: 'percent', ...(dp !== undefined && { dp }) } : kind === 'currency' ? { num: 'currency', cur: { '€': 'EUR', $: 'USD', '£': 'GBP', '¥': 'JPY', RM: 'MYR' }[sym] || sym || 'MYR', ...(dp !== undefined && { dp }) } : kind === 'date' ? { num: 'date', ...(ds && { ds }) } : {});
      }
      readStyles(el);
    }
  };
  readStyles(stylesRoot); readStyles(root);
  const formatOf = (name) => {
    const f = {};
    const chain = [];
    for (let s = styles.get(name), i = 0; s && i < 10; s = styles.get(s.parent), i++) chain.unshift(s);
    let data = null;
    const tp = {}, cp = {}, pp = {};
    for (const s of chain) { Object.assign(tp, s.tp); Object.assign(cp, s.cp); Object.assign(pp, s.pp); if (s.data) data = s.data; }
    if (/bold|[6-9]00/.test(tp['fo:font-weight'] || '')) f.b = 1;
    if (tp['fo:font-style'] === 'italic') f.i = 1;
    if (tp['style:text-underline-style'] && tp['style:text-underline-style'] !== 'none') f.u = 1;
    if (tp['style:text-line-through-style'] && tp['style:text-line-through-style'] !== 'none') f.s = 1;
    if (COLOR.test(tp['fo:color'] || '') && tp['fo:color'].toLowerCase() !== '#000000') f.color = tp['fo:color'].toLowerCase();
    if (COLOR.test(cp['fo:background-color'] || '') && cp['fo:background-color'].toLowerCase() !== '#ffffff') f.fill = cp['fo:background-color'].toLowerCase();
    if (cp['fo:wrap-option'] === 'wrap') f.wrap = 1;
    if (['top', 'middle', 'bottom'].includes(cp['style:vertical-align'])) f.va = cp['style:vertical-align'];
    const side = (s) => { const v = cp[`fo:border-${s}`] || cp['fo:border']; return v && v !== 'none' && !/^0+(\.0+)?(pt|cm|mm|in|px)?(\s|$)/.test(v); };
    const bd = ['top', 'bottom', 'left', 'right'].filter(side).map((s) => s[0]).join('');
    if (bd) f.bd = bd;
    const al = { start: 'left', left: 'left', center: 'center', end: 'right', right: 'right' }[pp['fo:text-align']];
    if (al) f.align = al;
    const rot = { 90: 'up', 270: 'down', 45: 'tiltup', 315: 'tiltdown' }[Number(cp['style:rotation-angle'])];
    if (rot) f.rot = rot;
    if (data && dataStyles.has(data)) Object.assign(f, dataStyles.get(data));
    return f;
  };
  // Frozen rows and columns, from the view settings.
  const frozenOf = new Map();
  const settings = parse(await zip.file('settings.xml')?.async('string'));
  (function find(n) {
    for (const el of tags(n)) {
      if (el.name === 'config:config-item-map-named' && el.attribs['config:name'] === 'Tables') {
        for (const t of tags(el, 'config:config-item-map-entry')) {
          const v = (k) => Number(textOf(tags(t, 'config:config-item').find((i) => i.attribs['config:name'] === k) || { children: [] })) || 0;
          const rows = v('VerticalSplitMode') === 2 ? v('VerticalSplitPosition') : 0, cols = v('HorizontalSplitMode') === 2 ? v('HorizontalSplitPosition') : 0;
          if (rows || cols) frozenOf.set(t.attribs['config:name'], { rows: Math.min(50, rows), cols: Math.min(26, cols) });
        }
      } else find(el);
    }
  })(settings);

  const out = [], threads = [];
  const body = (function find(n) { for (const k of tags(n)) { if (k.name === 'office:spreadsheet') return k; const f = find(k); if (f) return f; } return null; })(root);
  // Dropdowns: the content validations, by name (read for each sheet, as a reference to its own cells is relative to it).
  const validationDefs = new Map();
  for (const v of tags(tags(body, 'table:content-validations')[0] || { children: [] }, 'table:content-validation')) {
    const err = tags(v, 'table:error-message')[0], help = tags(v, 'table:help-message')[0];
    validationDefs.set(v.attribs['table:name'], { cond: v.attribs['table:condition'], strict: err?.attribs['table:display'] === 'true' && (err.attribs['table:message-type'] || 'stop') === 'stop', title: help?.attribs['table:title'] || '' });
  }
  for (const t of tags(body, 'table:table')) {
    const name = String(t.attribs['table:name'] || `Sheet${out.length + 1}`).slice(0, 30);
    const cells = {}, formats = {}, notes = {}, colWidths = {}, rowHeights = {}, merges = [], hideRows = [], hideCols = [];
    const validated = new Map(); // content validation name → the cells naming it ([col, row])
    // Columns: widths, hidden ones, and each one's default cell style.
    const colDefault = [];
    let c0 = 0;
    const columns = [];
    (function cols(n) { for (const k of tags(n)) { if (k.name === 'table:table-column') columns.push(k); else if (/^table:table-(header-)?columns$|^table:table-column-group$/.test(k.name)) cols(k); } })(t);
    for (const col of columns) {
      const rep = Math.min(Number(col.attribs['table:number-columns-repeated']) || 1, 1024 - c0);
      const st = styles.get(col.attribs['table:style-name']);
      const px = lengthPx(st?.colp?.['style:column-width']);
      for (let i = 0; i < rep && c0 < 702; i++, c0++) {
        if (px && Math.abs(px - 85) > 4 && Math.abs(px - 100) > 2 && rep < 100) colWidths[colName(c0)] = Math.max(20, Math.min(1000, px));
        if (col.attribs['table:visibility'] === 'collapse' && rep < 100) hideCols.push(c0);
        colDefault[c0] = col.attribs['table:default-cell-style-name'];
      }
    }
    // Rows (in groups and header-rows too).
    const rowEls = [];
    (function rws(n) { for (const k of tags(n)) { if (k.name === 'table:table-row') rowEls.push(k); else if (/^table:table-(header-)?rows$|^table:table-row-group$/.test(k.name)) rws(k); } })(t);
    let r = 1;
    for (const row of rowEls) {
      const rep = Number(row.attribs['table:number-rows-repeated']) || 1;
      const cellsIn = tags(row).filter((k) => k.name === 'table:table-cell' || k.name === 'table:covered-table-cell');
      const empty = cellsIn.every((k) => !kids(k).length && !k.attribs['table:formula'] && k.attribs['office:value-type'] === undefined);
      if (empty && rep > 1) { r += rep; if (r > 100000) break; continue; } // the rest of the sheet, empty
      const rst = styles.get(row.attribs['table:style-name']);
      for (let i = 0; i < Math.min(rep, 1000) && r <= 100000; i++, r++) {
        const h = lengthPx(rst?.rowp?.['style:row-height']);
        if (h && rst?.rowp?.['style:use-optimal-row-height'] !== 'true' && Math.abs(h - 17) > 3) rowHeights[String(r)] = Math.max(16, Math.min(600, h));
        if (row.attribs['table:visibility'] === 'collapse') hideRows.push(r - 1);
        let c = 0;
        for (const cell of cellsIn) {
          const crep = Number(cell.attribs['table:number-columns-repeated']) || 1;
          const has = kids(cell).length || cell.attribs['table:formula'] || cell.attribs['office:value-type'];
          const vname = cell.attribs['table:content-validation-name'];
          if (vname && validationDefs.has(vname)) for (let j = 0; j < Math.min(crep, 1024) && c + j < 702; j++) { if (!validated.has(vname)) validated.set(vname, []); validated.get(vname).push([c + j, r]); }
          if (!has && cell.attribs['table:style-name'] === undefined) { c += crep; continue; }
          for (let j = 0; j < Math.min(crep, has ? 1000 : 50) && c < 702; j++, c++) {
            if (cell.name === 'table:covered-table-cell') continue;
            const key = `${colName(c)}${r}`;
            const type = cell.attribs['office:value-type'];
            const formula = cell.attribs['table:formula'];
            let v = null;
            if (formula) v = formulaFromOds(formula);
            else if (type === 'float' || type === 'percentage' || type === 'currency') v = String(Number(cell.attribs['office:value']));
            else if (type === 'boolean') v = cell.attribs['office:boolean-value'] === 'true' ? 'TRUE' : 'FALSE';
            else if (type === 'date') v = String(cell.attribs['office:date-value'] || '').slice(0, 10);
            else if (type === 'time') v = textOf({ children: tags(cell, 'text:p') });
            else { const ps = tags(cell, 'text:p'); if (ps.length) v = ps.map(textOf).join('\n'); }
            if (v !== null && v !== '') cells[key] = v;
            const f = formatOf(cell.attribs['table:style-name'] || colDefault[c]);
            if (Object.keys(f).length && (has || f.fill || f.bd)) formats[key] = f;
            const note = tags(cell, 'office:annotation')[0];
            if (note) {
              const text = tags(note, 'text:p').map(textOf).join('\n').trim();
              const who = textOf({ children: tags(note, 'dc:creator') }).trim();
              const when = textOf({ children: tags(note, 'dc:date') }).trim();
              // By someone (not Calc's "Unknown Author" for a note from Excel): a comment thread; Excel's old-style copy of
              // a thread too. Otherwise a note.
              const xl = threadFromNote(text);
              const thread = xl || (who && who !== 'Unknown Author' ? threadFromComment(text, who, Date.parse(when + (/(Z|[+-]\d\d:?\d\d)$/.test(when) ? '' : 'Z')) || null) : null);
              if (thread && threads.length < 1000) threads.push({ sheet: out.length, cell: key, ...thread });
              else if (text) notes[key] = text.slice(0, 2000);
            }
            const sc = Number(cell.attribs['table:number-columns-spanned']) || 1, sr = Number(cell.attribs['table:number-rows-spanned']) || 1;
            if (sc > 1 || sr > 1) merges.push(`${key}:${colName(c + sc - 1)}${r + sr - 1}`);
          }
        }
      }
    }
    // Dropdowns: each validation's cells as ranges (one rectangle when they make one, else a run down each column).
    const validations = [];
    for (const [vname, at] of validated) {
      const d = validationDefs.get(vname);
      const def = validationFromCondition(d.cond, d, t.attribs['table:name']);
      if (!def) continue;
      const cs = at.map(([c]) => c), rs = at.map(([, r]) => r);
      const [cmin, cmax, rmin, rmax] = [Math.min(...cs), Math.max(...cs), Math.min(...rs), Math.max(...rs)];
      const ranges = [];
      if (new Set(at.map(([c, r]) => `${c}:${r}`)).size === (cmax - cmin + 1) * (rmax - rmin + 1)) ranges.push(`${colName(cmin)}${rmin}:${colName(cmax)}${rmax}`);
      else for (const c of [...new Set(cs)].sort((a, b) => a - b)) {
        const rows = [...new Set(at.filter(([cc]) => cc === c).map(([, r]) => r))].sort((a, b) => a - b);
        let start = rows[0], prev = rows[0];
        for (const r of [...rows.slice(1), null]) { if (r === prev + 1) { prev = r; continue; } ranges.push(`${colName(c)}${start}:${colName(c)}${prev}`); start = prev = r; }
      }
      for (const range of ranges) if (validations.length < 500) validations.push({ id: `v${validations.length + 1}`, range, ...def });
    }
    // Conditional formatting LibreOffice keeps (calcext:conditional-formats), with the looks its styles give.
    const cfEl = tags(t, 'calcext:conditional-formats')[0];
    const rules = cfEl ? rulesFromCalcext(cfEl, { tags, formulaFromOds, look: (st) => { const f = formatOf(st); return { fill: f.fill, color: f.color, bold: !!f.b }; } }) : [];
    // The filter LibreOffice keeps for this sheet (an AutoFilter), with the values each column hides.
    const filter = filterFromOds(tags(tags(body, 'table:database-ranges')[0] || { children: [] }, 'table:database-range'), t.attribs['table:name'], cells, tags);
    // Charts: the chart objects in frames on this sheet (in its shapes, or anchored in a cell), drawing from its cells.
    const charts = {};
    const framesIn = (n, acc = []) => { for (const k of tags(n)) { if (k.name === 'draw:frame' && tags(k, 'draw:object').length) acc.push(k); else if (k.name !== 'draw:frame') framesIn(k, acc); } return acc; };
    for (const fr of framesIn(t).slice(0, 20)) {
      const href = String(tags(fr, 'draw:object')[0].attribs['xlink:href'] || '').replace(/^\.\//, '').replace(/\/$/, '');
      const objXml = href && await zip.file(`${href}/content.xml`)?.async('string');
      if (!objXml) continue;
      const find = (n, name) => { for (const k of tags(n)) { if (k.name === name) return k; const f = find(k, name); if (f) return f; } return null; };
      const ch = chartFromObject(parse(objXml), fr, t.attribs['table:name'], { tags, textOf, find });
      if (ch) charts[`o${Object.keys(charts).length + 1}`] = ch;
    }
    const frozen = frozenOf.get(t.attribs['table:name']);
    const hide = hideRows.length || hideCols.length ? { ...(hideRows.length && { rows: hideRows }), ...(hideCols.length && { cols: hideCols }) } : null;
    out.push({ ...(Object.keys(charts).length && { charts }), ...(filter && { filter }), ...(validations.length && { validations }), ...(rules.length && { rules }), name, cells, colWidths, ...(Object.keys(rowHeights).length && { rowHeights }), ...(merges.length && { merges }), ...(Object.keys(formats).length && { formats }), ...(frozen && { frozen }), ...(hide && { hide }), ...(Object.keys(notes).length && { notes }) });
  }
  // The hidden sheet of dropdown choices our Excel download writes (here when such a file was saved as .ods):
  // its choices back in the dropdowns, and the sheet left out.
  const hidden = out.find((x) => x.name === '_choices');
  if (hidden && out.length > 1) {
    out.splice(out.indexOf(hidden), 1);
    for (const sh of out) {
      sh.validations = sh.validations?.map((v) => {
        const m = /^_choices!([A-Z]+)(\d+):([A-Z]+)(\d+)$/i.exec(v.source || '');
        if (!m) return v;
        const values = [];
        for (let r = Number(m[2]); r <= Number(m[4]); r++) { const t = hidden.cells[`${m[1].toUpperCase()}${r}`]; if (t !== undefined && t !== '') values.push(String(t)); }
        const { source, ...rest } = v;
        return { ...rest, values: [...new Set(values)].slice(0, 200) };
      });
    }
  }
  if (!out.length) out.push({ name: 'Sheet1', cells: {}, colWidths: {} });
  const book = { sheets: out };
  odsComments.set(book, threads);
  return book;
}

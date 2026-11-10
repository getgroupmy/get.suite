// Excel files <-> Sheets: every worksheet, with values and formulas, bold/italic/underline, text and
// fill colours, alignment, number formats (number, currency, percent, decimals) and column widths.
import ExcelJS from 'exceljs';
import { tablesOf, plainTableRefs as rangesForTables } from './tablerefs.js';
import JSZip from 'jszip';
import crypto from 'node:crypto';
import { withCharts, chartsOfXlsx, placeOf } from './xlsxcharts.js';
import path from 'node:path';
import { meetsCondition, cleanCondition } from './filtercond.js';

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
  if (/^(#,##0|0)(\.0+)?$/.test(main.trim()) && !fmt.includes(';')) return { num: 'number', dp };
  // Anything else (sections, colours, text, scaling…) is kept as the code itself.
  return { num: 'custom', code: String(fmt).slice(0, 120) };
}
const numToExcel = (f) => {
  const dec = f.dp === 0 ? '' : `.${'0'.repeat(f.dp ?? 2)}`;
  if (f.num === 'date') return { long: 'dddd, d mmmm yyyy', short: 'dd/mm/yyyy', iso: 'yyyy-mm-dd', month: 'mmm yyyy' }[f.ds] || 'd mmm yyyy';
  if (f.num === 'percent') return `0${f.dp ? `.${'0'.repeat(f.dp)}` : ''}%`;
  if (f.num === 'currency') return `[$${f.cur || 'MYR'}] #,##0${f.dp === undefined ? '.00' : dec}`;
  if (f.num === 'number') return `#,##0${f.dp === undefined ? '.00' : dec}`;
  if (f.num === 'custom' && typeof f.code === 'string' && f.code.trim()) return f.code.slice(0, 120); // a custom code, as written
  return undefined;
};

// Excel writes functions newer than 2007 with a prefix ("_xlfn.XLOOKUP("); we keep plain names.
const NEW_FUNCS = ['XLOOKUP', 'STDEV.S', 'STDEV.P', 'VAR.S', 'VAR.P', 'RANK.EQ', 'IFS', 'SWITCH', 'IFNA', 'TEXTJOIN', 'CONCAT', 'MAXIFS', 'MINIFS', 'DAYS', 'XMATCH', 'VSTACK', 'HSTACK', 'TAKE', 'DROP', 'ISOWEEKNUM', 'MODE.SNGL', 'PERCENTILE.INC', 'QUARTILE.INC', 'FORECAST.LINEAR', 'LET', 'LAMBDA', 'MAP', 'REDUCE', 'SCAN', 'BYROW', 'BYCOL', 'MAKEARRAY', 'TEXTBEFORE', 'TEXTAFTER', 'TEXTSPLIT', 'CHOOSECOLS', 'CHOOSEROWS', 'WRAPROWS', 'WRAPCOLS', 'TOCOL', 'TOROW', 'EXPAND', 'SORTBY', 'RANDARRAY', 'UNICODE', 'UNICHAR', 'BASE',
  'NORM.DIST', 'NORM.S.DIST', 'NORM.INV', 'NORM.S.INV', 'T.DIST', 'T.DIST.RT', 'T.DIST.2T', 'T.INV', 'T.INV.2T', 'T.TEST', 'CHISQ.DIST', 'CHISQ.DIST.RT',
  'CHISQ.TEST', 'CONFIDENCE.NORM', 'CONFIDENCE.T', 'Z.TEST', 'COVARIANCE.P', 'COVARIANCE.S', 'BINOM.DIST', 'POISSON.DIST', 'EXPON.DIST', 'PERCENTRANK.INC',
  'ARABIC', 'DECIMAL', 'ENCODEURL', 'ISFORMULA', 'FORMULATEXT'];
const NEW_RE = new RegExp(`("(?:[^"]|"")*")|(?<![A-Z0-9_.])(${NEW_FUNCS.map((n) => n.replaceAll('.', '\\.')).join('|')})(?=\\()`, 'gi');
export const formulaFromExcel = (f) => String(f).replace(/("(?:[^"]|"")*")|_xl(?:fn|ws|pm)\./gi, (m, s) => s || '');
// The dynamic-array functions; FILTER and SORT also carry "_xlws." in the file.
const ARRAY_FUNCS = { FILTER: '_xlfn._xlws.', SORT: '_xlfn._xlws.', UNIQUE: '_xlfn.', SEQUENCE: '_xlfn.' };
const ARRAY_RE = new RegExp(`("(?:[^"]|"")*")|(?<![A-Z0-9_.])(${Object.keys(ARRAY_FUNCS).join('|')})(?=\\()`, 'gi');
/**
 * The names a formula gives with LET and LAMBDA (LET(x, 1, x+1), LAMBDA(row, SUM(row))), which Excel
 * writes as _xlpm.x: every argument of LET at an odd place but the last, every LAMBDA argument but the last.
 */
function letNames(f) {
  const names = new Set();
  const re = /("(?:[^"]|"")*")|(?<![A-Z0-9_.])(LET|LAMBDA)\s*\(/gi;
  let m;
  while ((m = re.exec(f))) {
    if (m[1]) continue;
    const args = [];
    let depth = 0, start = re.lastIndex, i = start;
    for (; i < f.length; i++) {
      const ch = f[i];
      if (ch === '"') { i = f.indexOf('"', i + 1); while (f[i + 1] === '"') i = f.indexOf('"', i + 2); if (i < 0) break; continue; }
      if (ch === '(' || ch === '{') depth++;
      else if ((ch === ')' || ch === '}') && depth) depth--;
      else if (ch === ')' || (ch === ',' && !depth)) { args.push(f.slice(start, i).trim()); start = i + 1; if (ch === ')') break; }
    }
    const isLet = m[2].toUpperCase() === 'LET';
    args.slice(0, -1).forEach((a, k) => { if ((!isLet || k % 2 === 0) && /^[A-Z_][A-Z0-9_]*$/i.test(a)) names.add(a.toUpperCase()); });
  }
  return names;
}
const withParamPrefix = (f) => {
  const names = letNames(f);
  if (!names.size) return f;
  return f.replace(/("(?:[^"]|"")*")|(?<![A-Z0-9_.!$'])([A-Z_][A-Z0-9_]*)(?![A-Z0-9_.(!])/gi, (m, s, name) => s || (names.has(name.toUpperCase()) ? `_xlpm.${name}` : name));
};
export const formulaToExcel = (f) => withParamPrefix(String(f)).replace(NEW_RE, (m, s, name) => s || `_xlfn.${name.toUpperCase()}`)
  .replace(ARRAY_RE, (m, s, name) => s || `${ARRAY_FUNCS[name.toUpperCase()]}${name.toUpperCase()}`);

/**
 * A cell with a link in Excel (not a formula): kept as =HYPERLINK("address", "text") when it goes to a
 * web page or an email address, so it opens as a link in Sheets and goes back to Excel as one. Links
 * to places inside the workbook, and anything else, keep just their text.
 */
export function linkCell(v) {
  const text = typeof v.text === 'object' && v.text?.richText ? v.text.richText.map((r) => r.text).join('') : String(v.text ?? '');
  const href = String(v.hyperlink || '').trim();
  if (!/^(https?:\/\/|mailto:)[^\s"]+$/i.test(href) || href.length > 2000) return text;
  const q = (t) => `"${t.replace(/"/g, '""')}"`;
  return !text || text === href ? `=HYPERLINK(${q(href)})` : `=HYPERLINK(${q(href)}, ${q(text)})`;
}

function cellText(cell) {
  const v = cell.value;
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') {
    if ('formula' in v || 'sharedFormula' in v) return `=${formulaFromExcel(v.formula || cell.formula)}`;
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (v.richText) return v.richText.map((r) => r.text).join('');
    if ('text' in v) return linkCell(v); // a link in the cell
    if ('error' in v) return String(v.error);
    if ('result' in v) return String(v.result);
    return null;
  }
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v);
}

// ---- Excel's threaded comments (Microsoft 365): a conversation on a cell, with replies and a resolved state.
// Excel also writes each as an old-style note for older versions ("[Threaded comment] Your version of Excel…");
// those notes are left out, and the conversations come in as Sheets comment threads.
const sheetComments = new WeakMap(); // spreadsheet → [{ sheet (index), cell, author, text, at, resolved, replies }]
/** The comment threads an Excel file had (see sheetFromExcel). */
export const commentsOfBook = (book) => sheetComments.get(book) || [];
export async function threadedCommentsOfXlsx(buffer) {
  const out = new Map(); // sheet name → threads
  try {
    const zip = await JSZip.loadAsync(buffer);
    const read = async (f) => (zip.file(f) ? zip.file(f).async('string') : '');
    const rels = async (f) => {
      const dir = f.slice(0, f.lastIndexOf('/'));
      const x = await read(`${dir}/_rels/${f.slice(f.lastIndexOf('/') + 1)}.rels`);
      return [...x.matchAll(/<Relationship\b[^>]*>/g)].map((m) => ({ id: attrOf(m[0], 'Id'), type: attrOf(m[0], 'Type') || '', target: attrOf(m[0], 'Target') || '' }))
        .map((r) => ({ ...r, path: r.target.startsWith('/') ? r.target.slice(1) : path.posix.normalize(`${dir}/${r.target}`) }));
    };
    const book = await rels('xl/workbook.xml');
    const people = new Map();
    for (const r of book.filter((x) => /\/person$/.test(x.type))) {
      for (const m of (await read(r.path)).matchAll(/<person\b([^>]*)\/?>/g)) people.set(attrOf(m[0], 'id'), unxml(attrOf(m[0], 'displayName') || ''));
    }
    for (const m of (await read('xl/workbook.xml')).matchAll(/<sheet\b[^>]*>/g)) {
      const name = unxml(attrOf(m[0], 'name') || ''), rid = attrOf(m[0], 'r:id');
      const sheetPath = book.find((r) => r.id === rid)?.path;
      if (!sheetPath) continue;
      const tc = (await rels(sheetPath)).find((r) => /\/threadedComment$/.test(r.type))?.path;
      if (!tc) continue;
      const all = [...(await read(tc)).matchAll(/<threadedComment\b([^>]*)>([\s\S]*?)<\/threadedComment>/g)].map((c) => ({
        id: attrOf(`<x ${c[1]}>`, 'id'), parent: attrOf(`<x ${c[1]}>`, 'parentId'), cell: (attrOf(`<x ${c[1]}>`, 'ref') || '').toUpperCase(),
        author: (people.get(attrOf(`<x ${c[1]}>`, 'personId')) || '').slice(0, 100), at: Date.parse(attrOf(`<x ${c[1]}>`, 'dT') || '') || null,
        resolved: attrOf(`<x ${c[1]}>`, 'done') === '1', text: unxml((/<text>([\s\S]*?)<\/text>/.exec(c[2]) || [])[1] || '').trim().slice(0, 4000),
      })).filter((c) => /^[A-Z]{1,3}\d+$/.test(c.cell) && c.text);
      const threads = all.filter((c) => !c.parent).map((c) => ({ cell: c.cell, author: c.author, text: c.text, at: c.at, resolved: c.resolved,
        replies: all.filter((r) => r.parent === c.id).map((r) => ({ author: r.author, text: r.text, at: r.at })) }));
      if (threads.length) out.set(name, threads.slice(0, 1000));
    }
  } catch { /* none */ }
  return out;
}

/** The thread in the old-style note Excel writes for a threaded comment ("[Threaded comment] … Comment: … Reply: …"), or null. */
export function threadFromNote(text) {
  const m = /^\[Threaded comment\][\s\S]*?\n\s*Comment:\s*\n([\s\S]*)$/.exec(String(text || ''));
  if (!m) return null;
  const parts = m[1].split(/\n(?=Reply(?: \([^)\n]*\))?:\s*\n)/);
  const body = (t) => t.split('\n').map((l) => l.replace(/^ {4}/, '')).join('\n').trim();
  const first = body(parts[0]);
  if (!first) return null;
  const replies = parts.slice(1).map((p) => { const r = /^Reply(?: \(([^)\n]*)\))?:\s*\n([\s\S]*)$/.exec(p); return r ? { author: (r[1] || '').slice(0, 100), text: body(r[2]), at: null } : null; }).filter((r) => r?.text);
  return { author: '', text: first.slice(0, 4000), at: null, resolved: false, replies };
}

/** An Excel workbook (Buffer) as a Sheets spreadsheet. */
/** A cell note's text (Excel keeps either plain text or rich-text runs), or ''. */
export function noteText(note) {
  const t = typeof note === 'string' ? note : Array.isArray(note?.texts) ? note.texts.map((x) => x?.text || '').join('') : '';
  return t.replace(/\r\n?/g, '\n').trim().slice(0, MAX_NOTE);
}
export const MAX_NOTE = 2000;

const unxml = (t) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');
const attrOf = (tag, name) => (new RegExp(`\\b${name}="([^"]*)"`).exec(tag) || [])[1];

/** Each sheet's cell notes ({ name → { A1: text } }), read from the workbook's comments parts. */
export async function notesOfXlsx(buffer) {
  const out = new Map();
  try {
    const zip = await JSZip.loadAsync(buffer);
    const read = async (f) => (zip.file(f) ? zip.file(f).async('string') : '');
    const rels = async (f) => {
      const dir = f.slice(0, f.lastIndexOf('/'));
      const xml = await read(`${dir}/_rels/${f.slice(f.lastIndexOf('/') + 1)}.rels`);
      return [...xml.matchAll(/<Relationship\b[^>]*>/g)].map((m) => ({ id: attrOf(m[0], 'Id'), type: attrOf(m[0], 'Type') || '', target: attrOf(m[0], 'Target') || '' }))
        .map((r) => ({ ...r, path: r.target.startsWith('/') ? r.target.slice(1) : path.posix.normalize(`${dir}/${r.target}`) }));
    };
    const book = await rels('xl/workbook.xml');
    for (const m of (await read('xl/workbook.xml')).matchAll(/<sheet\b[^>]*>/g)) {
      const name = unxml(attrOf(m[0], 'name') || ''), rid = attrOf(m[0], 'r:id');
      const sheetPath = book.find((r) => r.id === rid)?.path;
      if (!sheetPath) continue;
      const commentsPath = (await rels(sheetPath)).find((r) => /\/comments$/.test(r.type))?.path;
      if (!commentsPath) continue;
      const notes = {};
      for (const c of (await read(commentsPath)).matchAll(/<comment\b([^>]*)>([\s\S]*?)<\/comment>/g)) {
        const ref = (attrOf(c[1], 'ref') || '').toUpperCase();
        const text = noteText([...c[2].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => unxml(t[1])).join(''));
        if (/^[A-Z]{1,3}\d{1,7}$/.test(ref) && text) notes[ref] = text;
      }
      if (Object.keys(notes).length) out.set(name, notes);
    }
  } catch { /* unreadable: no notes */ }
  return out;
}

export async function sheetFromExcel(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const noteSheets = await notesOfXlsx(buffer);
  const threadSheets = await threadedCommentsOfXlsx(buffer);
  const sheets = [];
  wb.eachSheet((ws) => {
    const cells = {}, formats = {}, colWidths = {};
    const notes = { ...(noteSheets.get(ws.name) || {}) }; // read from the file itself: ExcelJS loses notes on empty cells
    for (const t of threadSheets.get(ws.name) || []) delete notes[t.cell]; // the old-style copy of a comment thread
    // An old-style copy whose thread is gone (a file saved again by a program that keeps only notes): the thread, from its text.
    for (const [cell, text] of Object.entries(notes)) {
      const t = threadFromNote(text);
      if (!t) continue;
      delete notes[cell];
      if (!threadSheets.has(ws.name)) threadSheets.set(ws.name, []);
      threadSheets.get(ws.name).push({ cell, ...t });
    }
    const hideRows = [], hideCols = [];
    const outRows = new Map(), outCols = new Map(); // outlined (grouped) rows/columns → hidden?
    // Tables' structured references (Sales[Amount], [@Amount]) become plain ranges Sheets reads.
    const tableRefs = Object.values(ws.tables || {}).map((t) => tableShape(t.table || t)).filter(Boolean);
    ws.eachRow({ includeEmpty: true }, (row, r) => {
      if (row.outlineLevel > 0 && r <= 10000) outRows.set(r - 1, !!row.hidden);
      else if (row.hidden && r <= 10000) hideRows.push(r - 1);
      row.eachCell({ includeEmpty: true }, (cell, c) => {
        const key = `${colName(c - 1)}${r}`;
        let t = cellText(cell);
        // Kept as written when every reference resolves to a table that keeps its name here (so they go on
        // following the table as it grows); otherwise written as plain ranges.
        if (tableRefs.length && typeof t === 'string' && t.startsWith('=') && t.includes('[')) { const plain = `=${plainTableRefs(t.slice(1), tableRefs, r, c - 1)}`; if (plain.includes('[') || !tableRefs.every((x) => usableTableName(x.name))) t = plain; }
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
        if (['top', 'middle', 'bottom'].includes(cell.alignment?.vertical)) f.va = cell.alignment.vertical; // only when set in the file
        const tr = cell.alignment?.textRotation; // degrees (-90…90; 91–180 as written by some programs: below the line), or 'vertical'
        const rot = tr === 'vertical' || tr === 255 ? 'stack' : tr === 90 ? 'up' : tr === -90 || tr === 180 ? 'down' : (tr > 0 && tr < 90) ? 'tiltup' : ((tr < 0 && tr > -90) || (tr > 90 && tr < 180)) ? 'tiltdown' : null;
        if (rot) f.rot = rot;
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
    // Rows set taller or shorter than Excel's standard 15 points (pixels here: points ÷ 0.75).
    const rowHeights = {};
    ws.eachRow({ includeEmpty: true }, (row, n) => {
      if (n > 10000 || !row.height || Math.abs(row.height - 15) < 0.5) return;
      rowHeights[String(n)] = Math.max(16, Math.min(600, Math.round(row.height / 0.75)));
    });
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
    const bands = Object.values(ws.tables || {}).map((t, i) => bandFromTable(t.table || t, i + 1)).filter(Boolean).slice(0, 50);
    // Cells painted in their table's own stripe colours (as Sheets' downloads do) are the table's: not formats of their own.
    for (const b of bands) {
      const [a, z] = b.range.split(':');
      const [c1, r1, c2, r2] = [colIndex(/[A-Z]+/.exec(a)[0]), +/\d+/.exec(a)[0], colIndex(/[A-Z]+/.exec(z)[0]), +/\d+/.exec(z)[0]];
      const painted = new Set(Object.values(BAND_COLOURS).flatMap((c) => [c.head, c.odd, c.even, c.foot]));
      // A table whose style was lost (LibreOffice keeps tables but not their style) takes its colours from its painted heading.
      const headFill = formats[`${colName(c1)}${r1}`]?.fill;
      const byHead = Object.values(BAND_COLOURS).find((c) => c.head === headFill);
      if (byHead && b.head !== byHead.head && b._unstyled) Object.assign(b, byHead, b.even === b.odd ? { even: byHead.odd } : {});
      for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) {
        const k = `${colName(c)}${r}`, f = formats[k];
        if (!f?.fill || !painted.has(f.fill)) continue;
        delete f.fill;
        if (r === r1 && f.b) delete f.b; // the heading's bold comes with the table
        if (!Object.keys(f).length) delete formats[k];
      }
    }
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
    sheets.push({ _ws: ws.name, name: ws.name.slice(0, 30), cells, colWidths, ...(Object.keys(rowHeights).length && { rowHeights }), ...(merges.length && { merges }), ...(rules.length && { rules }), ...(validations.length && { validations }), ...(bands.length && { bands }), ...(filter && { filter }), ...(Object.keys(formats).length && { formats }), ...(frozen && (frozen.rows || frozen.cols) && { frozen }), ...(hide && { hide }), ...(groups.length && { groups }), ...(Object.keys(notes).length && { notes }) });
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
  // Charts on the sheets: kept as Sheets charts of their cells, placed where they were.
  const chartSheets = await chartsOfXlsx(buffer);
  for (const s of sheets) {
    const list = chartSheets.get(s._ws);
    if (!list) continue;
    s.charts = Object.fromEntries(list.map((c, i) => [`x${i + 1}`, { type: c.type, range: c.range, title: c.title || '', ...placeOf(c.at, s.colWidths, s.rowHeights) }]));
  }
  const threads = sheets.flatMap((s, i) => (threadSheets.get(s._ws) || []).map((t) => ({ sheet: i, ...t })));
  for (const s of sheets) delete s._ws;
  const functions = await functionsOfXlsx(buffer);
  const book = { sheets: sheets.length ? sheets : [{ name: 'Sheet1', cells: {}, colWidths: {} }], ...(functions.length && { functions }) };
  if (threads.length) sheetComments.set(book, threads);
  return book;
}

/** A Sheets spreadsheet as an Excel workbook (Buffer). Formulas are written as formulas. */
/**
 * The date format for a formula that clearly gives a date (Excel would otherwise show its day number):
 * DATE, TODAY, EDATE, EOMONTH, WORKDAY or DATEVALUE, or a date cell, plus or minus some days. NOW and
 * fractions of a day give a time too. Null for anything else (a cell's own format still wins).
 */
export function dateFormulaFormat(raw, cells = {}) {
  const f = String(raw).replace(/^=/, '').trim();
  const m = /^(.+?)(?:\s*([+-])\s*(\d+(?:\.\d+)?))?$/.exec(f);
  if (!m) return null;
  const base = m[1].trim(), frac = m[3] && !Number.isInteger(Number(m[3]));
  let date = /^(TODAY|DATE|EDATE|EOMONTH|WORKDAY|WORKDAY\.INTL|DATEVALUE)\(.*\)$/i.test(base) && !/\)\s*[-+*/&]/.test(base.replace(/\([^()]*\)/g, '()'));
  let time = /^NOW\(\s*\)$/i.test(base);
  const ref = /^\$?([A-Z]{1,3})\$?(\d+)$/i.exec(base);
  if (ref && m[2]) { const v = String(cells[`${ref[1].toUpperCase()}${ref[2]}`] ?? ''); if (/^\d{4}-\d{2}-\d{2}$/.test(v)) date = true; if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(v)) time = true; }
  if (time) return 'yyyy-mm-dd hh:mm';
  if (date) return frac ? 'yyyy-mm-dd hh:mm' : 'yyyy-mm-dd';
  return null;
}

/**
 * `comments`: the spreadsheet's open comment threads, [{ sheet (index), cell, author, at, text, replies }];
 * each goes on its cell as an Excel (Microsoft 365) comment thread, with the old-style note Excel
 * writes beside it for older versions and other programs.
 */
export async function excelFromSheet(data, { comments = [] } = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Workspace';
  const tables = tablesOf(data.sheets); // structured references (Sales[Amount]) go to Excel as plain ranges
  for (const s of data.sheets || []) {
    const ws = wb.addWorksheet((s.name || 'Sheet').replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Sheet');
    for (const [key, raw0] of Object.entries(s.cells || {})) {
      const at = tables.length && typeof raw0 === 'string' && raw0.startsWith('=') && /^([A-Z]+)(\d+)$/.exec(key);
      const raw = at ? `=${rangesForTables(raw0.slice(1), tables, +at[2], colIndex(at[1]), s.name)}` : raw0;
      const cell = ws.getCell(key);
      const v = String(raw);
      if (v.startsWith('=')) { cell.value = { formula: formulaToExcel(v.slice(1)) }; const df = dateFormulaFormat(v, s.cells); if (df) cell.numFmt = df; }
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
      const textRotation = { up: 90, down: -90, tiltup: 45, tiltdown: -45, stack: 'vertical' }[f.rot];
      if (f.align || f.wrap || f.va || textRotation !== undefined) cell.alignment = { ...(f.align && { horizontal: f.align }), ...(f.va && { vertical: f.va }), ...(f.wrap && { wrapText: true }), ...(textRotation !== undefined && { textRotation }) };
      if (f.bd) cell.border = Object.fromEntries([['t', 'top'], ['b', 'bottom'], ['l', 'left'], ['r', 'right']].filter(([k]) => f.bd.includes(k)).map(([, side]) => [side, { style: 'thin', color: { argb: 'FF000000' } }]));
      const nf = numToExcel(f);
      if (nf) cell.numFmt = nf;
    }
    // Alternating colours become each cell's fill (a cell's own fill wins), the heading row in bold.
    for (const band of s.bands || []) {
      // Also painted when it goes out as an Excel table (withTables): Excel shows the same colours either
      // way, and programs that don't draw table styles (LibreOffice, Numbers) still show them.
      const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(String(band.range || ''));
      if (!m) continue;
      const [c1, r1, c2, r2] = [colIndex(m[1]), Number(m[2]), colIndex(m[3]), Number(m[4])];
      if (r2 - r1 > 5000 || c2 - c1 > 200) continue;
      const hex = (v) => (/^#[0-9a-f]{6}$/i.test(v || '') ? v : null);
      for (let r = r1; r <= r2; r++) {
        const kind = band.header !== false && r === r1 ? 'head' : band.footer && r === r2 && r2 > r1 ? 'foot' : (r - r1 - (band.header !== false ? 1 : 0)) % 2 === 0 ? 'odd' : 'even';
        const fill = hex(band[kind]);
        if (!fill) continue;
        for (let c = c1; c <= c2; c++) {
          const key = `${colName(c)}${r}`;
          if (s.formats?.[key]?.fill) continue;
          const cell = ws.getCell(key);
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(fill) } };
          if (kind === 'head') cell.font = { ...(cell.font || {}), bold: true };
        }
      }
    }
    for (const [key, text] of Object.entries(s.notes || {})) if (/^[A-Z]+\d+$/.test(key) && text) ws.getCell(key).note = String(text);
    // Comment threads: the old-style copy for older Excel (and LibreOffice), on cells without a note of their own.
    for (const t of threadsFor(comments, wb.worksheets.length - 1, s)) {
      if (s.notes?.[t.cell]) continue;
      const lines = [t.text, ...t.replies.map((r) => `Reply${r.author ? ` (${r.author})` : ''}:\n    ${r.text}`)];
      ws.getCell(t.cell).note = `[Threaded comment]\n\nYour version of Excel allows you to read this threaded comment; however, any edits to it will get removed if the file is opened in a newer version of Excel. Learn more: https://go.microsoft.com/fwlink/?linkid=870924\n\nComment:\n    ${lines.join('\n')}`;
    }
    for (const [col, px] of Object.entries(s.colWidths || {})) ws.getColumn(col).width = Math.max(2, Math.round((px - 5) / 7));
    for (const [n, px] of Object.entries(s.rowHeights || {})) if (/^\d+$/.test(n) && Number(n) >= 1 && Number(n) <= 10000 && Number(px) > 0) ws.getRow(Number(n)).height = Math.round(Number(px) * 0.75 * 10) / 10; // pixels → points
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
      const inside = (col) => colIndex(col) >= colIndex(c1) && colIndex(col) <= colIndex(c2);
      const lists = Object.entries(s.filter.hidden || {}).filter(([col, l]) => l?.length && inside(col));
      const conds = Object.entries(s.filter.cond || {}).filter(([col, c]) => inside(col) && cleanCondition(c));
      let last = Number(r2);
      for (const k of Object.keys(s.cells || {})) { const m = /^([A-Z]+)(\d+)$/.exec(k); if (m && colIndex(m[1]) >= colIndex(c1) && colIndex(m[1]) <= colIndex(c2)) last = Math.max(last, Number(m[2])); }
      const stored = (col, r) => { const raw = s.cells?.[`${col}${r}`]; return typeof raw === 'string' && raw.startsWith('=') ? undefined : raw === undefined ? '' : String(raw).trim(); };
      for (let r = Number(r1) + 1; r <= last && (lists.length || conds.length); r++) {
        const hide = lists.some(([col, l]) => { const v = stored(col, r); return v !== undefined && l.includes(v); })
          || conds.some(([col, c]) => { const v = stored(col, r); return v !== undefined && !meetsCondition(c, v); });
        if (hide) ws.getRow(r).hidden = true;
      }
    }
    // Slicers: Excel's need a table or pivot table behind them, so the rows they hide go hidden (by
    // their stored values, as for the filter) and the slicer itself stays in Workspace.
    for (const sl of Object.values(s.slicers || {})) {
      const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(sl?.range || '');
      if (!m || !sl.hidden?.length || !/^[A-Z]+$/.test(sl.col || '') || colIndex(sl.col) < colIndex(m[1]) || colIndex(sl.col) > colIndex(m[3])) continue;
      let last = Number(m[4]);
      for (const k of Object.keys(s.cells || {})) { const x = /^([A-Z]+)(\d+)$/.exec(k); if (x && x[1] === sl.col) last = Math.max(last, Math.min(Number(x[2]), last + 1000)); }
      for (let r = Number(m[2]) + 1; r <= last; r++) {
        const raw = s.cells?.[`${sl.col}${r}`];
        if (typeof raw === 'string' && raw.startsWith('=')) continue;
        if (sl.hidden.includes(raw === undefined ? '' : String(raw).trim())) ws.getRow(r).hidden = true;
      }
    }
    // Dropdowns as Excel list validations; tick boxes as a TRUE/FALSE list (Excel has no tick box to write).
    for (const v of s.validations || []) {
      if (v.type === 'rule') { const x = ruleValidationToExcel(v); if (x) ws.dataValidations.add(v.range, x); continue; }
      // Choices taken from cells: written as that range, so Excel's dropdown follows them too.
      const src = v.type === 'list' && sourceFormula(v.source);
      if (src) { ws.dataValidations.add(v.range, { type: 'list', allowBlank: true, formulae: [src], ...(v.strict && { showErrorMessage: true, errorStyle: 'stop' }) }); continue; }
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
  // Charts: added to the finished file (the library has none), with each sheet's name as written.
  const named = (data.sheets || []).map((s, i) => ({ ...s, xlName: wb.worksheets[i]?.name || s.name }));
  return withThreads(await withCharts(await withTables(await withFunctions(Buffer.from(await wb.xlsx.writeBuffer()), data.functions), named), named), (data.sheets || []).map((s, i) => threadsFor(comments, i, s)));
}

// ---- named functions (⋮ → Named functions): Excel keeps them as defined names holding a LAMBDA,
// <definedName name="WITHTAX">_xlfn.LAMBDA(_xlpm.amount,_xlpm.amount*1.2)</definedName>. ExcelJS only
// knows names of cells, so these are written into and read from the workbook part directly.
const xmlText = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fromXml = (t) => String(t).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const OWN_NAME = /^[A-Z][A-Z0-9_.]{0,39}$/i, OWN_PARAM = /^[A-Z_][A-Z0-9_]{0,29}$/i;

/** The workbook's file with its named functions added as Excel defined names. */
export async function withFunctions(buffer, functions) {
  const list = (Array.isArray(functions) ? functions : []).filter((f) => OWN_NAME.test(f?.name || '') && (f.params || []).every((p) => OWN_PARAM.test(p)) && f.body);
  if (!list.length) return buffer;
  const zip = await JSZip.loadAsync(buffer);
  let xml = await zip.file('xl/workbook.xml').async('string');
  const defs = list.map((f) => {
    const body = String(f.body).replace(/^=/, '');
    const lambda = formulaToExcel(`LAMBDA(${[...f.params, body].join(', ')})`);
    return `<definedName name="${xmlText(f.name.toUpperCase())}"${f.description ? ` comment="${xmlText(String(f.description).slice(0, 255))}"` : ''}>${xmlText(lambda)}</definedName>`;
  }).join('');
  xml = /<definedNames>/.test(xml) ? xml.replace('</definedNames>', `${defs}</definedNames>`)
    : xml.replace(/(<\/sheets>)/, `$1<definedNames>${defs}</definedNames>`);
  zip.file('xl/workbook.xml', xml);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** Named functions in an Excel file: defined names whose formula is a LAMBDA. */
export async function functionsOfXlsx(buffer) {
  let xml;
  try { xml = await (await JSZip.loadAsync(buffer)).file('xl/workbook.xml')?.async('string'); } catch { return []; }
  const out = [];
  for (const m of String(xml || '').matchAll(/<definedName\b([^>]*)>([^<]*)<\/definedName>/g)) {
    const name = /\bname="([^"]*)"/.exec(m[1])?.[1] || '';
    const comment = /\bcomment="([^"]*)"/.exec(m[1])?.[1];
    const f = formulaFromExcel(fromXml(m[2])).trim().replace(/^=/, '');
    const lm = /^LAMBDA\(([\s\S]*)\)$/i.exec(f);
    if (!lm || !OWN_NAME.test(name) || /^_xl/i.test(name)) continue;
    // Its arguments: the LAMBDA's names before the last comma at the top level.
    const parts = [];
    let depth = 0, start = 0, inText = false;
    const t = lm[1];
    for (let i = 0; i < t.length; i++) {
      const ch = t[i];
      if (ch === '"') inText = !inText;
      else if (inText) continue;
      else if (ch === '(' || ch === '{') depth++;
      else if (ch === ')' || ch === '}') depth--;
      else if (ch === ',' && !depth) { parts.push(t.slice(start, i).trim()); start = i + 1; }
    }
    parts.push(t.slice(start).trim());
    const params = parts.slice(0, -1);
    if (!params.every((p) => OWN_PARAM.test(p)) || out.length >= 100) continue;
    out.push({ name: name.toUpperCase(), params, body: parts[parts.length - 1], ...(comment && { description: fromXml(comment) }) });
  }
  return out;
}

/** A dropdown's source ("Lists!A2:A9", "D2:D9") as an Excel range formula: Lists!$A$2:$A$9. */
export function sourceFormula(source) {
  const m = /^(?:('(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_]*)!)?([A-Z]{1,3})(\d+):([A-Z]{1,3})(\d+)$/i.exec(String(source || '').trim());
  return m ? `${m[1] ? `${m[1]}!` : ''}$${m[2].toUpperCase()}$${m[3]}:$${m[4].toUpperCase()}$${m[5]}` : null;
}

// ---- rule validations (numbers, dates, text length, email and web addresses, custom formulas), both ways
const XL_OPS = { between: 'between', notBetween: 'notBetween', gt: 'greaterThan', gte: 'greaterThanOrEqual', lt: 'lessThan', lte: 'lessThanOrEqual', eq: 'equal', ne: 'notEqual' };
// Excel's library writes date limits from Date objects (as day numbers in the file).
const xlDate = (t) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(t || '').trim()); return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null; };
const xlNum = (t) => (String(t ?? '').trim() !== '' && !Number.isNaN(Number(t)) ? String(Number(t)) : null);
function ruleValidationToExcel(v) {
  const c = v.check || {};
  const first = String(v.range).split(':')[0];
  const base = { allowBlank: true, showErrorMessage: true, errorStyle: v.strict ? 'stop' : 'warning', ...(v.message && { error: String(v.message).slice(0, 255), errorTitle: 'Not valid' }) };
  const custom = (f) => ({ type: 'custom', formulae: [f], ...base });
  if (c.kind === 'email') return custom(`ISNUMBER(MATCH("*@?*.?*",${first},0))`);
  if (c.kind === 'url') return custom(`OR(LEFT(${first},7)="http://",LEFT(${first},8)="https://",ISNUMBER(SEARCH(".",${first})))`);
  if (c.kind === 'formula') { const f = String(c.a || '').trim().replace(/^=/, ''); return f ? custom(formulaToExcel(f)) : null; }
  const conv = c.kind === 'date' ? xlDate : xlNum;
  const a = conv(c.a), b = conv(c.b);
  const between = /between/i.test(c.op);
  if (!XL_OPS[c.op] || a === null || (between && b === null)) return null;
  return { type: { number: 'decimal', whole: 'whole', date: 'date', length: 'textLength' }[c.kind] || 'decimal', operator: XL_OPS[c.op], formulae: between ? [a, b] : [a], ...base };
}
function ruleValidationFromExcel(x) {
  const kind = { decimal: 'number', whole: 'whole', date: 'date', textLength: 'length' }[x.type];
  const strict = x.errorStyle !== 'warning' && x.errorStyle !== 'information';
  const extra = { strict, ...(x.error && { message: String(x.error).slice(0, 200) }) };
  const un = (f) => {
    const t = String(f ?? '').trim();
    const d = /^DATE\((\d+),(\d+),(\d+)\)$/i.exec(t);
    if (d) return `${d[1]}-${d[2].padStart(2, '0')}-${d[3].padStart(2, '0')}`;
    if (f instanceof Date) return f.toISOString().slice(0, 10);
    if (kind === 'date' && /^\d+(\.\d+)?$/.test(t)) return new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(t)) * 864e5).toISOString().slice(0, 10);
    return t;
  };
  if (kind) {
    const op = Object.keys(XL_OPS).find((k) => XL_OPS[k] === (x.operator || 'between'));
    if (!op) return null;
    return { type: 'rule', check: { kind, op, a: un(x.formulae?.[0]), ...(/between/i.test(op) && { b: un(x.formulae?.[1]) }) }, ...extra };
  }
  if (x.type === 'custom' && x.formulae?.[0]) {
    const f = String(x.formulae[0]).trim();
    if (/^ISNUMBER\(MATCH\("\*@\?\*\.\?\*",[A-Z]+\d+,0\)\)$/i.test(f)) return { type: 'rule', check: { kind: 'email' }, ...extra };
    if (/^OR\(LEFT\([A-Z]+\d+,7\)="http:\/\/",LEFT/i.test(f)) return { type: 'rule', check: { kind: 'url' }, ...extra };
    return { type: 'rule', check: { kind: 'formula', a: `=${formulaFromExcel(f)}` }, strict: false };
  }
  return null;
}

// ---- data validation from Excel: list validations become dropdowns (a TRUE/FALSE list, a tick box).
// Excel gives them cell by cell; cells with the same list in a column are joined back into ranges.
export function validationsFromExcel(model, cells) {
  const byKind = new Map();
  for (const [addr, x] of Object.entries(model)) {
    const p = /^([A-Z]+)(\d+)$/.exec(String(addr).toUpperCase());
    if (!p || !x?.formulae?.length || x.formulae[0] === null || x.formulae[0] === undefined || x.formulae[0] === "") continue;
    if (x.type !== 'list') {
      const def = ruleValidationFromExcel(x);
      if (!def) continue;
      const key = `${p[1]}|${JSON.stringify(def)}`;
      if (!byKind.has(key)) byKind.set(key, { col: p[1], def, rows: [] });
      byKind.get(key).rows.push(Number(p[2]));
      continue;
    }
    const f = String(x.formulae[0]).trim();
    let values, source = null;
    if (/^".*"$/.test(f)) values = f.slice(1, -1).split(',').map((t) => t.trim()).filter(Boolean);
    else {
      // A range of cells holding the choices, like $D$1:$D$5 or Lists!$A$2:$A$9: the dropdown keeps
      // following it. Ones on this sheet are read now as well, to tell a TRUE/FALSE tick box.
      const s = /^(?:('(?:[^']|'')+'|[A-Z_][A-Z0-9_]*)!)?\$?([A-Z]+)\$?(\d+):\$?([A-Z]+)\$?(\d+)$/i.exec(f);
      if (!s) continue;
      source = `${s[1] ? `${s[1]}!` : ''}${s[2].toUpperCase()}${s[3]}:${s[4].toUpperCase()}${s[5]}`; // as Sheets writes it: D1:D5
      const [, sheet, c1, r1, c2, r2] = s;
      values = sheet ? null : [];
      if (!sheet) for (let c = colIndex(c1.toUpperCase()); c <= colIndex(c2.toUpperCase()); c++) for (let r = Number(r1); r <= Math.min(Number(r2), Number(r1) + 500); r++) {
        const raw = cells[`${colName(c)}${r}`];
        if (raw !== undefined && raw !== '' && !String(raw).startsWith('=')) values.push(String(raw).trim());
      }
    }
    values = values && [...new Set(values)].slice(0, 200);
    if (values && !values.length && !source) continue;
    const checkbox = !!values && values.length === 2 && values.every((v) => /^(TRUE|FALSE)$/i.test(v)) && new Set(values.map((v) => v.toUpperCase())).size === 2;
    const def = checkbox ? { type: 'checkbox' } : { type: 'list', ...(source ? { source } : { values }), strict: !!x.showErrorMessage && x.errorStyle !== 'information' && x.errorStyle !== 'warning' };
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

// ---- Excel tables (Insert → Table) as Sheets' alternating colours. Excel's built-in table styles go
// round seven theme colours (Light1–21, Medium1–28, Dark1–11); each is matched to the nearest band colours.
const BAND_COLOURS = {
  grey: { head: '#5f6368', odd: '#ffffff', even: '#f1f3f4', foot: '#dadce0' },
  blue: { head: '#4a86e8', odd: '#ffffff', even: '#e8f0fe', foot: '#c6dafc' },
  orange: { head: '#f6911e', odd: '#ffffff', even: '#feefe3', foot: '#fcd5b2' },
  teal: { head: '#16a2b8', odd: '#ffffff', even: '#e4f7fb', foot: '#b9e6ee' },
  green: { head: '#34a853', odd: '#ffffff', even: '#e6f4ea', foot: '#bfe3c8' },
};
const THEME_CYCLE = ['grey', 'blue', 'orange', 'grey', 'orange', 'teal', 'green']; // dark 1, accents 1–6
const STYLE_OF_HEAD = { '#5f6368': 'TableStyleMedium1', '#4a86e8': 'TableStyleMedium2', '#f6911e': 'TableStyleMedium3', '#16a2b8': 'TableStyleMedium6', '#34a853': 'TableStyleMedium7' };
/**
 * Whether a band goes to Excel as a table, and how: when it has a heading row of different,
 * non-empty text (Excel names a table's columns by them, so no formulas), at least one row under
 * it, one of the usual colours, and no merged cells. { name, ref, columns, style, totals, stripes } or null.
 */
export function tableOfBand(band, sheet, n = 1) {
  const m = /^([A-Z]{1,3})(\d+):([A-Z]{1,3})(\d+)$/.exec(String(band?.range || ''));
  const style = STYLE_OF_HEAD[String(band?.head || '').toLowerCase()];
  if (!m || !style || band.header === false) return null;
  const c1 = colIndex(m[1]), r1 = +m[2], c2 = colIndex(m[3]), r2 = +m[4];
  if (r2 <= r1 + (band.footer ? 1 : 0) || c2 - c1 > 200 || r2 - r1 > 100000) return null;
  const columns = [];
  for (let c = c1; c <= c2; c++) {
    const v = String(sheet.cells?.[`${colName(c)}${r1}`] ?? '').trim();
    if (!v || v.startsWith('=') || v.length > 255 || columns.some((x) => x.toLowerCase() === v.toLowerCase())) return null;
    columns.push(v);
  }
  const inside = (ref) => { const k = /^([A-Z]+)(\d+)/.exec(ref); return k && colIndex(k[1]) >= c1 && colIndex(k[1]) <= c2 && +k[2] >= r1 && +k[2] <= r2; };
  if ((sheet.merges || []).some((mg) => String(mg).split(':').some(inside))) return null;
  return { name: band.name || `Table${n}`, ref: band.range, columns, style, totals: !!band.footer, stripes: String(band.even || '').toLowerCase() !== String(band.odd || '').toLowerCase() };
}
/** The workbook with each sheet's bands that can be tables written as Excel tables (tables can't overlap). */
async function withTables(buffer, sheets) {
  let n = 0;
  const plan = (sheets || []).map((s) => {
    const taken = [];
    return (s.bands || []).map((b) => tableOfBand(b, s, n + 1)).filter((t) => {
      if (!t) return false;
      const [a, b] = t.ref.split(':');
      const box = [colIndex(/[A-Z]+/.exec(a)[0]), +/\d+/.exec(a)[0], colIndex(/[A-Z]+/.exec(b)[0]), +/\d+/.exec(b)[0]];
      if (taken.some((x) => !(box[2] < x[0] || box[0] > x[2] || box[3] < x[1] || box[1] > x[3]))) return false;
      taken.push(box);
      ++n; if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(t.name) || /^Table\d+$/.test(t.name)) t.name = `Table${n}`; // its own name when it has one
      return true;
    });
  });
  if (!n) return buffer;
  const zip = await JSZip.loadAsync(buffer);
  let types = await zip.file('[Content_Types].xml').async('string');
  let no = 0;
  for (let i = 0; i < plan.length; i++) {
    if (!plan[i].length) continue;
    const sheetPath = `xl/worksheets/sheet${i + 1}.xml`;
    if (!zip.file(sheetPath)) continue;
    const relsPath = `xl/worksheets/_rels/sheet${i + 1}.xml.rels`;
    let rels = zip.file(relsPath) ? await zip.file(relsPath).async('string') : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
    const parts = [];
    for (const t of plan[i]) {
      no += 1;
      const [a, b] = t.ref.split(':');
      const filterTo = t.totals ? `${/[A-Z]+/.exec(b)[0]}${+/\d+/.exec(b)[0] - 1}` : b;
      zip.file(`xl/tables/table${no}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="${no}" name="${t.name}" displayName="${t.name}" ref="${t.ref}" headerRowCount="1"${t.totals ? ' totalsRowCount="1"' : ''}><autoFilter ref="${a}:${filterTo}"/><tableColumns count="${t.columns.length}">${t.columns.map((c, k) => `<tableColumn id="${k + 1}" name="${xmlText(c)}"/>`).join('')}</tableColumns><tableStyleInfo name="${t.style}" showFirstColumn="0" showLastColumn="0" showRowStripes="${t.stripes ? 1 : 0}" showColumnStripes="0"/></table>`);
      types = types.replace('</Types>', `<Override PartName="/xl/tables/table${no}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/></Types>`);
      const rid = `rIdTable${no}`;
      rels = rels.replace('</Relationships>', `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table${no}.xml"/></Relationships>`);
      parts.push(`<tablePart r:id="${rid}"/>`);
    }
    zip.file(relsPath, rels);
    let x = await zip.file(sheetPath).async('string');
    if (!/xmlns:r=/.test(x.slice(0, 800))) x = x.replace(/<worksheet\b/, '<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"');
    // A sheet filter over the same cells would clash with the table's own: the table's wins.
    const boxOf = (ref) => { const [p, q] = String(ref).split(':'); const k = (t) => [colIndex(/[A-Z]+/.exec(t)[0]), +/\d+/.exec(t)[0]]; const [c1, r1] = k(p), [c2, r2] = k(q || p); return [c1, r1, c2, r2]; };
    const overlaps = (ref) => plan[i].some((t) => { const a = boxOf(t.ref), b = boxOf(ref); return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]); });
    x = x.replace(/<autoFilter\b[^>]*ref="([^"]+)"[^>]*\/>|<autoFilter\b[^>]*ref="([^"]+)"[\s\S]*?<\/autoFilter>/, (f, r1, r2) => (overlaps(r1 || r2) ? '' : f));
    const tag = `<tableParts count="${parts.length}">${parts.join('')}</tableParts>`;
    x = /<extLst\b/.test(x) ? x.replace(/<extLst\b/, `${tag}<extLst`) : x.replace('</worksheet>', `${tag}</worksheet>`);
    zip.file(sheetPath, x);
  }
  zip.file('[Content_Types].xml', types);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** The open threads on one sheet's cells (sheet `i`), cleaned. */
function threadsFor(comments, i, sheet) {
  return (comments || []).filter((t) => (t.sheet || 0) === i && /^[A-Z]{1,3}\d{1,7}$/.test(t.cell || '') && t.text).slice(0, 1000)
    .map((t) => ({ cell: t.cell, author: String(t.author || ''), at: t.at, text: String(t.text).slice(0, 4000), replies: (t.replies || []).slice(0, 100).map((r) => ({ author: String(r.author || ''), at: r.at, text: String(r.text || '').slice(0, 4000) })) }));
}
const guid = () => `{${crypto.randomUUID().toUpperCase()}}`;
/** The workbook with Microsoft 365 comment threads (xl/threadedComments, xl/persons) for each sheet's threads. */
async function withThreads(buffer, perSheet) {
  if (!perSheet.some((l) => l.length)) return buffer;
  const zip = await JSZip.loadAsync(buffer);
  let types = await zip.file('[Content_Types].xml').async('string');
  const people = new Map(); // name → id
  const personId = (name) => { const n = name || 'Workspace'; if (!people.has(n)) people.set(n, guid()); return people.get(n); };
  const stamp = (ms) => new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString().replace(/Z$/, '').replace(/(\.\d{2})\d$/, '$1');
  let no = 0;
  const pending = []; // [sheet's relationships file, the relationship to add]
  perSheet.forEach((list, i) => {
    if (!list.length) return;
    no += 1;
    const items = [];
    for (const t of list) {
      const id = guid();
      items.push(`<threadedComment ref="${t.cell}" dT="${stamp(t.at)}" personId="${personId(t.author)}" id="${id}"><text>${xmlText(t.text)}</text></threadedComment>`);
      for (const r of t.replies) items.push(`<threadedComment ref="${t.cell}" dT="${stamp(r.at)}" personId="${personId(r.author)}" id="${guid()}" parentId="${id}"><text>${xmlText(r.text)}</text></threadedComment>`);
    }
    zip.file(`xl/threadedComments/threadedComment${no}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<ThreadedComments xmlns="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments" xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${items.join('')}</ThreadedComments>`);
    types = types.replace('</Types>', `<Override PartName="/xl/threadedComments/threadedComment${no}.xml" ContentType="application/vnd.ms-excel.threadedcomments+xml"/></Types>`);
    const relsPath = `xl/worksheets/_rels/sheet${i + 1}.xml.rels`;
    pending.push([relsPath, `<Relationship Id="rIdThreads${no}" Type="http://schemas.microsoft.com/office/2017/10/relationships/threadedComment" Target="../threadedComments/threadedComment${no}.xml"/>`]);
  });
  for (const [relsPath, rel] of pending) {
    const old = zip.file(relsPath) ? await zip.file(relsPath).async('string') : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
    zip.file(relsPath, old.replace('</Relationships>', `${rel}</Relationships>`));
  }
  zip.file('xl/persons/person.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<personList xmlns="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments" xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${[...people].map(([name, id]) => `<person displayName="${xmlText(name)}" id="${id}" userId="${xmlText(name)}" providerId="None"/>`).join('')}</personList>`);
  types = types.replace('</Types>', '<Override PartName="/xl/persons/person.xml" ContentType="application/vnd.ms-excel.person+xml"/></Types>');
  zip.file('[Content_Types].xml', types);
  const wbRels = 'xl/_rels/workbook.xml.rels';
  zip.file(wbRels, (await zip.file(wbRels).async('string')).replace('</Relationships>', '<Relationship Id="rIdPersons" Type="http://schemas.microsoft.com/office/2017/10/relationships/person" Target="persons/person.xml"/></Relationships>'));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** An Excel table's name as a table name here (letters, digits, _ and ., not like a cell). */
const usableTableName = (n) => typeof n === 'string' && /^[A-Za-z_][A-Za-z0-9_.]{0,39}$/.test(n) && !/^[A-Za-z]{1,3}\d+$/.test(n);
/** Whether a table has a heading row. Excel leaves headerRowCount out when there is one (the default), which the
 *  library reads as none; a table with a heading row has a filter on it, one without doesn't. */
const hasHeader = (t) => t.headerRow === true || !!t.autoFilterRef || (t.headerRow !== false && t.headerRowCount !== 0);
/** A table's name, columns (names in order) and box, from Excel's table model: for its structured references. */
export function tableShape(t) {
  const m = /^([A-Z]{1,3})(\d+):([A-Z]{1,3})(\d+)$/.exec(String(t?.tableRef || t?.ref || '').toUpperCase());
  if (!m || !t.name) return null;
  const c1 = colIndex(m[1]), c2 = colIndex(m[3]), r1 = +m[2], r2 = +m[4];
  const columns = (t.columns || []).map((c) => String(c.name ?? ''));
  return { name: String(t.name), columns, c1, c2, r1, r2, header: hasHeader(t), totals: !!t.totalsRow };
}
/**
 * A formula's structured references to tables written as ranges: Sales[Amount] is that column's
 * data, Sales[[#Totals],[Amount]] its total, Sales[@Amount] (or [@Amount] inside the table) the
 * cell on this row, Sales[#All] / [#Data] / [#Headers] / [#Totals] the parts, Sales[[A]:[B]] several columns.
 * `row` is the cell's row (1-based), `col` its column (0-based). Anything else is left as it was.
 */
export function plainTableRefs(formula, tables, row, col) {
  const unq = (n) => String(n).replace(/^\[|\]$/g, '').replace(/'(.)/g, '$1').trim().toLowerCase();
  const range = (t, a, b, ra, rb) => (a === b && ra === rb ? `${colName(a)}${ra}` : `${colName(a)}${ra}:${colName(b)}${rb}`);
  const resolve = (t, spec) => {
    const dataTop = t.r1 + (t.header ? 1 : 0), dataBottom = t.r2 - (t.totals ? 1 : 0);
    let rows = [dataTop, dataBottom], c1 = t.c1, c2 = t.c2;
    const parts = spec.trim() === '' ? [] : (/^\[/.test(spec.trim()) ? [...spec.matchAll(/\[((?:[^\[\]']|'.)*)\]/g)].map((m) => m[1]) : [spec]);
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
    // [[A]:[B]] comes as parts "A" and ":" joined in the text: handled by the caller passing both names.
    if (cols.length) {
      const idx = cols.map((n) => t.columns.findIndex((x) => x.toLowerCase() === n));
      if (idx.some((i) => i < 0)) return null;
      c1 = t.c1 + Math.min(...idx); c2 = t.c1 + Math.max(...idx);
    }
    return range(t, c1, c2, rows[0], rows[1]);
  };
  const here = tables.find((t) => row >= t.r1 && row <= t.r2 && col >= t.c1 && col <= t.c2);
  let out = String(formula);
  // Table[...] (the brackets may nest one level: Table[[#Totals],[Amount]], Table[[A]:[B]]).
  for (const t of tables) {
    const re = new RegExp(`("(?:[^"]|"")*")|(?<![A-Za-z0-9_.])${t.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\[((?:[^\\[\\]]|\\[[^\\]]*\\])*)\\]`, 'gi');
    out = out.replace(re, (m, str, spec) => { if (str) return str; const r = resolve(t, spec.replace(/\]\s*:\s*\[/g, '],[')); return r ?? m; });
  }
  // Inside a table: [@Amount], [@[Unit price]], [Amount] on their own.
  if (here) {
    out = out.replace(/("(?:[^"]|"")*")|(?<![A-Za-z0-9_\]])\[(@?(?:\[[^\]]*\]|[^\[\]]+))\]/g, (m, str, spec) => {
      if (str) return str;
      const r = resolve(here, spec.startsWith('@') ? `[@${unq(spec.slice(1))}]` : `[${spec}]`);
      return r ?? m;
    });
  }
  return out;
}

/** A table's band (range, heading and total rows, colours), from Excel's table model. */
export function bandFromTable(t, n = 1) {
  const ref = String(t?.tableRef || t?.ref || '').toUpperCase();
  if (!/^[A-Z]{1,3}\d+:[A-Z]{1,3}\d+$/.test(ref)) return null;
  const m = /^TableStyle(Light|Medium|Dark)(\d+)$/i.exec(t.style?.theme || '');
  const colours = BAND_COLOURS[m ? THEME_CYCLE[(Number(m[2]) - 1) % 7] : 'blue'];
  const stripes = t.style?.showRowStripes !== false;
  const band = { id: `t${n}`, range: ref, header: hasHeader(t), footer: !!t.totalsRow, ...colours, ...(!stripes && { even: colours.odd }), ...(usableTableName(t.name) && { name: String(t.name) }) };
  if (!m) Object.defineProperty(band, '_unstyled', { value: true }); // no known style: colours may come from its cells
  return band;
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
  if (r.when === 'bars') return { type: 'dataBar', cfvo: [{ type: 'min' }, { type: 'max' }], color: { argb: argb(/^#[0-9a-f]{6}$/i.test(r.bar || '') ? r.bar : '#638ec6') } };
  if (r.when === 'scale') {
    const colours = Array.isArray(r.scale) && r.scale.length >= 2 && r.scale.length <= 3 && r.scale.every((c) => /^#[0-9a-f]{6}$/i.test(c)) ? r.scale : ['#f8696b', '#ffeb84', '#63be7b'];
    return { type: 'colorScale', cfvo: colours.length === 3 ? [{ type: 'min' }, { type: 'percentile', value: 50 }, { type: 'max' }] : [{ type: 'min' }, { type: 'max' }], color: colours.map((c) => ({ argb: argb(c) })) };
  }
  // Dates: Excel's own "a date occurring" rules where it has one, formula rules otherwise.
  const period = { dateToday: 'today', datePast7: 'last7Days', dateThisMonth: 'thisMonth' }[r.when];
  if (period) return { type: 'timePeriod', timePeriod: period };
  if (r.when === 'datePast') return { type: 'expression', formulae: [`AND(ISNUMBER(${cell}),${cell}<TODAY())`] };
  if (r.when === 'dateNext7') return { type: 'expression', formulae: [`AND(ISNUMBER(${cell}),${cell}>=TODAY(),${cell}<=TODAY()+7)`] };
  if (r.when === 'dateBefore' || r.when === 'dateAfter') {
    const v = String(r.value ?? '').trim().toLowerCase();
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    const when = v === 'today' ? 'TODAY()' : m ? `DATE(${+m[1]},${+m[2]},${+m[3]})` : null;
    return when ? { type: 'expression', formulae: [`AND(ISNUMBER(${cell}),${cell}${r.when === 'dateBefore' ? '<' : '>'}${when})`] } : null;
  }
  // Rules over the whole range; duplicates and unique values as the formula Excel itself would use.
  if (r.when === 'top' || r.when === 'bottom') return { type: 'top10', rank: Math.max(1, Math.min(1000, Math.trunc(Number(r.value)) || 10)), ...(r.when === 'bottom' && { bottom: true }) };
  if (r.when === 'aboveAvg' || r.when === 'belowAvg') return { type: 'aboveAverage', ...(r.when === 'belowAvg' && { aboveAverage: false }) };
  if (r.when === 'duplicate' || r.when === 'unique') {
    const abs = String(r.range).replace(/\$/g, '').split(':').map((x) => x.replace(/^([A-Z]+)(\d+)$/i, '$$$1$$$2')).join(':');
    return { type: 'expression', formulae: [`AND(${cell}<>"",COUNTIF(${abs},${cell})${r.when === 'duplicate' ? '>1' : '=1'})`] };
  }
  if (r.when === 'formula') { const f = String(r.value ?? '').trim().replace(/^=/, ''); return f ? { type: 'expression', formulae: [formulaToExcel(f)] } : null; }
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
  if (x.type === 'dataBar') { const c = hex((Array.isArray(x.color) ? x.color[0] : x.color)?.argb); return { when: 'bars', bar: c || '#638ec6' }; }
  if (x.type === 'colorScale') {
    const colours = (x.color || []).map((c) => hex(c?.argb)).filter(Boolean);
    return colours.length >= 2 && colours.length <= 3 ? { when: 'scale', scale: colours } : null;
  }
  if (x.type === 'timePeriod') return { today: { when: 'dateToday' }, last7Days: { when: 'datePast7' }, thisMonth: { when: 'dateThisMonth' } }[x.timePeriod] || null;
  if (x.type === 'top10') return { when: x.bottom ? 'bottom' : 'top', value: String(x.percent ? 10 : (x.rank || 10)) };
  if (x.type === 'aboveAverage') return { when: x.aboveAverage === false ? 'belowAvg' : 'aboveAvg' };
  const raw = String(x.formulae?.[0] || '').trim();
  const f = raw.replace(/\$(?=[A-Z0-9])/g, '');
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
  if ((m = /^AND\(ISNUMBER\([A-Z]+\d+\),[A-Z]+\d+<TODAY\(\)\)$/i.exec(f))) return { when: 'datePast' };
  if ((m = /^AND\(ISNUMBER\([A-Z]+\d+\),[A-Z]+\d+>=TODAY\(\),[A-Z]+\d+<=TODAY\(\)\+7\)$/i.exec(f))) return { when: 'dateNext7' };
  if ((m = /^AND\(ISNUMBER\([A-Z]+\d+\),[A-Z]+\d+([<>])(?:TODAY\(\)|DATE\((\d+),(\d+),(\d+)\))\)$/i.exec(f))) {
    return { when: m[1] === '<' ? 'dateBefore' : 'dateAfter', value: m[2] ? `${m[2]}-${m[3].padStart(2, '0')}-${m[4].padStart(2, '0')}` : 'today' };
  }
  if ((m = /^AND\([A-Z]+\d+<>"",COUNTIF\([A-Z]+\d+:[A-Z]+\d+,[A-Z]+\d+\)(>1|=1)\)$/i.exec(f))) return { when: m[1] === '>1' ? 'duplicate' : 'unique' };
  if ((m = /^COUNTIF\([A-Z]+\d+:[A-Z]+\d+,[A-Z]+\d+\)(>1|=1)$/i.exec(f))) return { when: m[1] === '>1' ? 'duplicate' : 'unique' };
  // Any other formula rule: kept as a custom formula (with its $ signs).
  if (x.type === 'expression' && raw) return { when: 'formula', value: `=${formulaFromExcel(raw)}` };
  return null;
}

/**
 * A table (a heading row, then rows) as an Excel workbook (Buffer), for downloads: every value as it
 * is, so text starting with "=" stays text (never a formula); numbers and YYYY-MM-DD dates as such,
 * the heading row bold, frozen and filterable, columns as wide as their contents (within reason).
 */
export async function excelFromTable(sheetName, table) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Workspace';
  const ws = wb.addWorksheet(String(sheetName || 'Sheet').replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Sheet', { views: [{ state: 'frozen', ySplit: 1 }] });
  const widths = [];
  table.forEach((row, r) => row.forEach((raw, c) => {
    const cell = ws.getCell(r + 1, c + 1);
    if (typeof raw === 'number' && Number.isFinite(raw)) cell.value = raw;
    else {
      const v = String(raw ?? '');
      if (r > 0 && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))) { cell.value = new Date(`${v}T00:00:00Z`); cell.numFmt = 'yyyy-mm-dd'; }
      else if (r > 0 && /^-?\d+(\.\d+)?$/.test(v) && v.length < 15) cell.value = Number(v);
      else cell.value = v; // text, written as text
      if (v.includes('\n')) cell.alignment = { wrapText: true, vertical: 'top' };
    }
    widths[c] = Math.max(widths[c] || 8, Math.min(60, Math.max(...String(raw ?? '').split('\n').map((l) => l.length)) + 2));
  }));
  widths.forEach((w, c) => { ws.getColumn(c + 1).width = w; });
  if (table.length) {
    ws.getRow(1).font = { bold: true };
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: Math.max(1, table[0].length) } };
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Send a workbook as a download. */
export function sendXlsx(res, filename, buf) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.send(buf);
}

// Printing a sheet (or the selected cells), or saving it as PDF: a plain page with the cells as
// they look (values as shown, formatting, merged cells) and the pictures and charts over them, hidden and
// filtered-out rows and columns left out, on A4 or Letter in portrait or landscape, with or without gridlines.
import { cellKey, parseRef } from './formula.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const SAFE_CSS = /^[#\w\s.,%()'"-]+$/; // colours, sizes, keywords: nothing that could reach out or break out

/** A style object (as given to React) as safe inline CSS. */
export function cssOf(style = {}) {
  return Object.entries(style)
    .filter(([, v]) => v !== undefined && v !== null && v !== '' && SAFE_CSS.test(String(v)))
    .map(([k, v]) => `${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}:${typeof v === 'number' && !/^(fontWeight|opacity|zIndex|lineHeight)$/.test(k) ? `${v}px` : v}`)
    .join(';');
}

/** The cells that have something in them: { c1, r1, c2, r2 }, or null for an empty sheet. */
export function usedArea(keys) {
  let a = null;
  for (const k of keys) {
    const p = parseRef(k);
    if (!p) continue;
    a = a ? { c1: Math.min(a.c1, p.c), r1: Math.min(a.r1, p.r), c2: Math.max(a.c2, p.c), r2: Math.max(a.r2, p.r) } : { c1: p.c, r1: p.r, c2: p.c, r2: p.r };
  }
  return a;
}

/**
 * The page: { title, area, text(k), style(k), layout: { spans, covered }, hiddenRows, hiddenCols,
 * width(c), gridlines, landscape, paper: 'A4' | 'Letter' }.
 */
export function sheetPrintHtml({ title, area, text, style = () => ({}), layout = { spans: new Map(), covered: new Map() }, hiddenRows = new Set(), hiddenCols = new Set(), width = () => 100, gridlines = true, landscape = false, paper = 'A4', overlays = [] }) {
  // Pictures and charts over the cells: each in the cell its corner is over, as far in (`html` is made here or taken from
  // the page's own chart, never from what's typed in a cell).
  const over = new Map();
  for (const o of overlays) over.set(o.key, [...(over.get(o.key) || []), o]);
  const cols = [];
  for (let c = area.c1; c <= area.c2; c++) if (!hiddenCols.has(c)) cols.push(c);
  const rows = [];
  for (let r = area.r1; r <= area.r2; r++) {
    if (hiddenRows.has(r)) continue;
    const tds = [];
    for (const c of cols) {
      const k = cellKey(c, r);
      if (layout.covered.has(k)) continue;
      const span = layout.spans.get(k);
      // A merge cut by the printed area or by hidden rows/columns spans what's left of it.
      let attrs = '';
      if (span) {
        const b = span.box;
        const cs = cols.filter((x) => x >= b.c1 && x <= Math.min(b.c2, area.c2)).length;
        let rs = 0;
        for (let y = b.r1; y <= Math.min(b.r2, area.r2); y++) if (!hiddenRows.has(y)) rs++;
        if (cs > 1) attrs += ` colspan="${cs}"`;
        if (rs > 1) attrs += ` rowspan="${rs}"`;
      }
      const css = cssOf(style(k));
      const extra = (over.get(k) || []).map((o) => `<div class="over${o.chart ? ' chart' : ''}" style="left:${Math.round(o.ox)}px;top:${Math.round(o.oy)}px;width:${Math.round(o.w)}px;height:${Math.round(o.h)}px">${o.html}</div>`).join('');
      tds.push(`<td${attrs}${extra ? ' class="has-over"' : ''}${css ? ` style="${esc(css)}"` : ''}>${esc(text(k))}${extra}</td>`);
    }
    rows.push(`<tr>${tds.join('')}</tr>`);
  }
  const colgroup = cols.map((c) => `<col style="width:${Math.round(width(c))}px">`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self'"><title>${esc(title)}</title>
<style>@page{size:${paper === 'Letter' ? 'letter' : 'A4'} ${landscape ? 'landscape' : 'portrait'};margin:12mm}
body{margin:0;font:11px/1.3 system-ui,sans-serif;color:#000;background:#fff}
table{border-collapse:collapse;table-layout:fixed}td{padding:2px 4px;vertical-align:bottom;overflow:hidden;white-space:nowrap${gridlines ? ';border:1px solid #c8c8c8' : ''}}
tr{break-inside:avoid}td.has-over{position:relative;overflow:visible}.over{position:absolute;z-index:1}.over img{width:100%;height:100%;display:block}.over.chart{background:#fff;box-shadow:0 0 0 1px #ddd;border-radius:6px;padding:4px 8px;box-sizing:border-box;white-space:normal;overflow:hidden}.over.chart p{margin:0 0 4px;font-weight:600;font-size:13px}</style></head>
<body><table><colgroup>${colgroup}</colgroup><tbody>${rows.join('')}</tbody></table></body></html>`;
}

/**
 * The cells as a table for an email (Sheets → Send as email): values as shown, merged cells kept, hidden rows and columns
 * left out, and each cell's look as Mail's editor keeps it, on its text (bold, italic, underline, strikethrough, its
 * colour and fill as the text's colour and highlight) and its paragraph (left, centre or right). The first row is the
 * header when `header` (bold, as most tables have it).
 */
export function sheetEmailHtml({ area, text, style = () => ({}), layout = { spans: new Map(), covered: new Map() }, hiddenRows = new Set(), hiddenCols = new Set(), header = false }) {
  const cols = [];
  for (let c = area.c1; c <= area.c2; c++) if (!hiddenCols.has(c)) cols.push(c);
  const COLOR = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|[a-z]+)$/i;
  const rows = [];
  let first = true;
  for (let r = area.r1; r <= area.r2; r++) {
    if (hiddenRows.has(r)) continue;
    const tds = [];
    for (const c of cols) {
      const k = cellKey(c, r);
      if (layout.covered.has(k)) continue;
      let attrs = '';
      const span = layout.spans.get(k);
      if (span) {
        const b = span.box;
        const cs = cols.filter((x) => x >= b.c1 && x <= Math.min(b.c2, area.c2)).length;
        let rs = 0;
        for (let y = b.r1; y <= Math.min(b.r2, area.r2); y++) if (!hiddenRows.has(y)) rs++;
        if (cs > 1) attrs += ` colspan="${cs}"`;
        if (rs > 1) attrs += ` rowspan="${rs}"`;
      }
      const s = style(k) || {};
      let t = esc(text(k));
      if (t) {
        const span2 = [COLOR.test(String(s.color || '')) && `color: ${s.color}`, COLOR.test(String(s.background || '')) && `background-color: ${s.background}`].filter(Boolean).join('; ');
        if (span2) t = `<span style="${span2}">${t}</span>`;
        if (/line-through/.test(s.textDecoration || '')) t = `<s>${t}</s>`;
        if (/underline/.test(s.textDecoration || '')) t = `<u>${t}</u>`;
        if (s.fontStyle === 'italic') t = `<em>${t}</em>`;
        if (Number(s.fontWeight) >= 600 || s.fontWeight === 'bold' || (header && first)) t = `<strong>${t}</strong>`;
      }
      const align = ['center', 'right'].includes(s.textAlign) ? ` style="text-align: ${s.textAlign}"` : '';
      const tag = header && first ? 'th' : 'td';
      tds.push(`<${tag}${attrs}><p${align}>${t}</p></${tag}>`);
    }
    rows.push(`<tr>${tds.join('')}</tr>`);
    first = false;
  }
  return `<table>${rows.join('')}</table>`;
}

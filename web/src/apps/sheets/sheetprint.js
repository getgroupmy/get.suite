// Printing a sheet (or the selected cells), or saving it as PDF: a plain page with the cells as
// they look (values as shown, formatting, merged cells), hidden and filtered-out rows and columns
// left out, on A4 or Letter in portrait or landscape, with or without gridlines.
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
export function sheetPrintHtml({ title, area, text, style = () => ({}), layout = { spans: new Map(), covered: new Map() }, hiddenRows = new Set(), hiddenCols = new Set(), width = () => 100, gridlines = true, landscape = false, paper = 'A4' }) {
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
      tds.push(`<td${attrs}${css ? ` style="${esc(css)}"` : ''}>${esc(text(k))}</td>`);
    }
    rows.push(`<tr>${tds.join('')}</tr>`);
  }
  const colgroup = cols.map((c) => `<col style="width:${Math.round(width(c))}px">`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${esc(title)}</title>
<style>@page{size:${paper === 'Letter' ? 'letter' : 'A4'} ${landscape ? 'landscape' : 'portrait'};margin:12mm}
body{margin:0;font:11px/1.3 system-ui,sans-serif;color:#000;background:#fff}
table{border-collapse:collapse;table-layout:fixed}td{padding:2px 4px;vertical-align:bottom;overflow:hidden;white-space:nowrap${gridlines ? ';border:1px solid #c8c8c8' : ''}}
tr{break-inside:avoid}</style></head>
<body><table><colgroup>${colgroup}</colgroup><tbody>${rows.join('')}</tbody></table></body></html>`;
}

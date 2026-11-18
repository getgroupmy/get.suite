// Sheets' charts in OpenDocument spreadsheets: each an embedded chart object (Object N/content.xml) in a frame
// on its sheet, drawing from the sheet's cells, as LibreOffice Calc keeps them; and back again from the
// object's kind, cell range and title. The series follow how Sheets reads a chart's cells (chartLayout:
// series names in the first row, category names in the first column, when they hold text).
import { chartLayout } from './xlsxcharts.js';

const x = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const colIndex = (t) => [...t].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
const colName = (i) => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
const sheetRef = (name) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `'${String(name).replace(/'/g, "''")}'`);
const cm = (px) => `${(Math.max(1, Number(px) || 0) * 2.54 / 96).toFixed(3)}cm`;
const GRID_LEFT = 46, GRID_TOP = 24; // as the Excel download: the row numbers and column letters in front of the cells
// Sheets' kinds as ODF chart classes (and how they're drawn): histograms and waterfalls go as columns of their cells.
const CLASS = { column: ['bar'], stackedColumn: ['bar', { stacked: true }], bar: ['bar', { vertical: true }], stackedBar: ['bar', { vertical: true, stacked: true }],
  line: ['line'], area: ['area'], scatter: ['scatter'], pie: ['circle'], doughnut: ['ring'], histogram: ['bar'], waterfall: ['bar'] };

/** A chart as an ODF chart object's content.xml, or null when its range isn't usable. */
export function chartObject(chart, sheetName, cells) {
  const L = chartLayout(chart.range, cells || {});
  if (!L || !L.series.length) return null;
  const [cls, opts = {}] = CLASS[chart.type] || CLASS.column;
  const sh = sheetRef(sheetName);
  const { g } = L;
  const cell = (c, r) => `${sh}.${colName(c)}${r + 1}`;
  const range = `${cell(g.c1, g.r1)}:${cell(g.c2, g.r2)}`;
  const cats = L.labelCol ? `${cell(g.c1, L.r0)}:${cell(g.c1, g.r2)}` : null;
  const pie = cls === 'circle' || cls === 'ring';
  // (a doughnut's series as LibreOffice writes them: as circles, in a chart of rings)
  const series = L.series.map((s) => `<chart:series chart:class="chart:${cls === 'ring' ? 'circle' : cls}" chart:values-cell-range-address="${x(`${cell(s.col, L.r0)}:${cell(s.col, g.r2)}`)}"${L.headRow ? ` chart:label-cell-address="${x(cell(s.col, g.r1))}"` : ''}>${cls === 'scatter' && cats ? `<chart:domain table:cell-range-address="${x(cats)}"/>` : ''}</chart:series>`).join('');
  const w = chart.w || 400, h = chart.h || 250;
  return `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:chart="urn:oasis:names:tc:opendocument:xmlns:chart:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" office:version="1.3"><office:automatic-styles><style:style style:name="pa1" style:family="chart"><style:chart-properties chart:stacked="${!!opts.stacked}" chart:vertical="${!!opts.vertical}"/></style:style></office:automatic-styles><office:body><office:chart><chart:chart chart:class="chart:${cls}" svg:width="${cm(w)}" svg:height="${cm(h)}">${chart.title ? `<chart:title><text:p>${x(chart.title)}</text:p></chart:title>` : ''}<chart:legend chart:legend-position="end"/><chart:plot-area chart:style-name="pa1" table:cell-range-address="${x(range)}" chart:data-source-has-labels="${L.headRow && L.labelCol ? 'both' : L.headRow ? 'row' : L.labelCol ? 'column' : 'none'}"><chart:axis chart:dimension="x" chart:name="primary-x">${cats && cls !== 'scatter' ? `<chart:categories table:cell-range-address="${x(cats)}"/>` : ''}</chart:axis>${pie ? '' : '<chart:axis chart:dimension="y" chart:name="primary-y"><chart:grid chart:class="major"/></chart:axis>'}${series}</chart:plot-area></chart:chart></office:chart></office:body></office:document-content>`;
}

/** The frame on the sheet holding a chart object (placed where the chart is, in front of the cells). */
export function chartFrame(chart, n, sheetName) {
  const range = String(chart.range || '').replace(/^([A-Z]+\d+):([A-Z]+\d+)$/, (m, a, b) => `${sheetRef(sheetName)}.${a}:${sheetRef(sheetName)}.${b}`);
  return `<draw:frame draw:z-index="${n}" draw:name="Chart ${n + 1}" svg:width="${cm(chart.w || 400)}" svg:height="${cm(chart.h || 250)}" svg:x="${cm(Math.max(0, (chart.x ?? 300) - GRID_LEFT))}" svg:y="${cm(Math.max(0, (chart.y ?? 40) - GRID_TOP))}"><draw:object draw:notify-on-update-of-ranges="${x(range)}" xlink:href="./Object ${n + 1}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/></draw:frame>`;
}

// ---- back
const KIND_OF = { 'chart:line': 'line', 'chart:area': 'area', 'chart:scatter': 'scatter', 'chart:circle': 'pie', 'chart:ring': 'doughnut' };
const lengthPx = (v) => { const m = /^(-?[\d.]+)(cm|mm|in|pt|px)?$/.exec(String(v || '')); return m ? Math.round(Number(m[1]) * { cm: 96 / 2.54, mm: 96 / 25.4, in: 96, pt: 4 / 3, px: 1 }[m[2] || 'px']) : null; };

/**
 * A chart from its object's content.xml (parsed: `tags`, `textOf` work on it) and its frame: { type, range, title, x, y, w, h },
 * or null when it doesn't draw from this sheet's cells.
 */
export function chartFromObject(root, frame, sheetName, { tags, textOf, find }) {
  const chart = find(root, 'chart:chart');
  if (!chart) return null;
  const plot = find(chart, 'chart:plot-area');
  // Its kind: the class, and for bars whether they lie down and stand on each other (the plot area's style).
  let type = KIND_OF[chart.attribs['chart:class']] || 'column';
  if (chart.attribs['chart:class'] === 'chart:bar') {
    const styleName = plot?.attribs['chart:style-name'];
    const st = styleName && (function look(n) { for (const k of tags(n)) { if (k.name === 'style:style' && k.attribs['style:name'] === styleName) return k; const f = look(k); if (f) return f; } return null; })(root);
    const p = st ? tags(st, 'style:chart-properties')[0]?.attribs || {} : {};
    const stacked = p['chart:stacked'] === 'true', vertical = p['chart:vertical'] === 'true';
    type = vertical ? (stacked ? 'stackedBar' : 'bar') : stacked ? 'stackedColumn' : 'column';
  }
  // Its cells: the plot area's range (or the frame's), on this sheet.
  // Its cells: every range it names (the plot area's, its series' values and names, the categories, the frame's;
  // LibreOffice splits the plot area's into pieces, and leaves it out for some kinds), taken together, on this sheet.
  const addrs = [plot?.attribs['table:cell-range-address'], frame?.attribs?.['draw:notify-on-update-of-ranges']];
  (function all(n) { for (const k of tags(n)) { for (const a of ['chart:values-cell-range-address', 'chart:label-cell-address', 'table:cell-range-address']) if (k.attribs?.[a]) addrs.push(k.attribs[a]); all(k); } })(plot || { children: [] });
  const parts = [];
  for (const one of addrs.filter(Boolean)) {
    for (const piece of String(one).match(/(?:'(?:[^']|'')*'|[^ '])+/g) || []) {
      const m = /^(?:'((?:[^']|'')*)'|([^.:]*))\.\$?([A-Z]+)\$?(\d+)(?::(?:'(?:[^']|'')*'|[^.]*)?\.\$?([A-Z]+)\$?(\d+))?$/.exec(piece);
      if (!m) continue;
      const sheet = m[1] !== undefined ? m[1].replace(/''/g, "'") : m[2];
      if (sheet && sheet !== sheetName) continue;
      const c1 = colIndex(m[3]), r1 = Number(m[4]), c2 = m[5] ? colIndex(m[5]) : c1, r2 = m[6] ? Number(m[6]) : r1;
      parts.push([Math.min(c1, c2), Math.min(r1, r2), Math.max(c1, c2), Math.max(r1, r2)]);
    }
  }
  if (!parts.length) return null;
  const box = [Math.min(...parts.map((q) => q[0])), Math.min(...parts.map((q) => q[1])), Math.max(...parts.map((q) => q[2])), Math.max(...parts.map((q) => q[3]))];
  const title = textOf(find(chart, 'chart:title') || { children: [] }).trim();
  const fx = frame?.attribs || {};
  return { type, range: `${colName(box[0])}${box[1]}:${colName(box[2])}${box[3]}`, title,
    x: (lengthPx(fx['svg:x']) ?? 254) + GRID_LEFT, y: (lengthPx(fx['svg:y']) ?? 16) + GRID_TOP, w: lengthPx(fx['svg:width']) || 400, h: lengthPx(fx['svg:height']) || 250 };
}

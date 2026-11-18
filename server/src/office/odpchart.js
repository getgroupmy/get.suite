// A slide's chart in OpenDocument presentations: a chart object carrying its own figures (in the object's own
// table, "local-table", as LibreOffice Impress keeps a chart that draws from no spreadsheet), in a frame on the
// slide; and back again. A slide chart is { chartType, title, data: { categories, series: [{ name, values }] } }.

const x = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const colName = (i) => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
// Sheets' and Slides' kinds as ODF chart classes (as odschart.js): histograms and waterfalls as columns.
const CLASS = { column: ['bar'], stackedColumn: ['bar', { stacked: true }], bar: ['bar', { vertical: true }], stackedBar: ['bar', { vertical: true, stacked: true }],
  line: ['line'], area: ['area'], scatter: ['scatter'], pie: ['circle'], doughnut: ['ring'], histogram: ['bar'], waterfall: ['bar'] };
const KIND_OF = { 'chart:line': 'line', 'chart:area': 'area', 'chart:scatter': 'scatter', 'chart:circle': 'pie', 'chart:ring': 'doughnut' };
const T = 'local-table';

/** A slide chart as a chart object's content.xml (sized in cm), or null when it has no figures. */
export function dataChartObject(item, wCm, hCm) {
  const series = (item.data?.series || []).slice(0, 8);
  const cats = (item.data?.categories || []).slice(0, 200);
  const n = Math.max(cats.length, ...series.map((s) => (s.values || []).length), 0);
  if (!series.length || !n) return null;
  const [cls, opts = {}] = CLASS[item.chartType] || CLASS.column;
  const pie = cls === 'circle' || cls === 'ring';
  const col = (c, r1, r2) => `${T}.$${colName(c)}$${r1}${r2 ? `:.$${colName(c)}$${r2}` : ''}`;
  const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? '<table:table-cell><text:p/></table:table-cell>'
    : `<table:table-cell office:value-type="float" office:value="${Number(v)}"><text:p>${Number(v)}</text:p></table:table-cell>`);
  const str = (t) => `<table:table-cell office:value-type="string"><text:p>${x(t)}</text:p></table:table-cell>`;
  const table = `<table:table table:name="${T}"><table:table-header-columns><table:table-column/></table:table-header-columns><table:table-columns><table:table-column table:number-columns-repeated="${series.length}"/></table:table-columns>`
    + `<table:table-header-rows><table:table-row>${str('')}${series.map((s) => str(s.name ?? '')).join('')}</table:table-row></table:table-header-rows>`
    + `<table:table-rows>${Array.from({ length: n }, (_, i) => `<table:table-row>${str(cats[i] ?? '')}${series.map((s) => num(s.values?.[i])).join('')}</table:table-row>`).join('')}</table:table-rows></table:table>`;
  // (a doughnut's series as LibreOffice writes them: circles, in a chart of rings)
  const ser = series.map((s, k) => `<chart:series chart:class="chart:${cls === 'ring' ? 'circle' : cls}" chart:values-cell-range-address="${col(k + 1, 2, n + 1)}" chart:label-cell-address="${col(k + 1, 1)}">${cls === 'scatter' ? `<chart:domain table:cell-range-address="${col(0, 2, n + 1)}"/>` : ''}</chart:series>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:chart="urn:oasis:names:tc:opendocument:xmlns:chart:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" office:version="1.3">`
    + `<office:automatic-styles><style:style style:name="pa1" style:family="chart"><style:chart-properties chart:stacked="${!!opts.stacked}" chart:vertical="${!!opts.vertical}"/></style:style></office:automatic-styles>`
    + `<office:body><office:chart><chart:chart chart:class="chart:${cls}" svg:width="${wCm.toFixed(3)}cm" svg:height="${hCm.toFixed(3)}cm">${item.title ? `<chart:title><text:p>${x(item.title)}</text:p></chart:title>` : ''}<chart:legend chart:legend-position="end"/>`
    + `<chart:plot-area chart:style-name="pa1" table:cell-range-address="${T}.$A$1:.$${colName(series.length)}$${n + 1}" chart:data-source-has-labels="both"><chart:axis chart:dimension="x" chart:name="primary-x">${cls !== 'scatter' ? `<chart:categories table:cell-range-address="${col(0, 2, n + 1)}"/>` : ''}</chart:axis>${pie ? '' : '<chart:axis chart:dimension="y" chart:name="primary-y"><chart:grid chart:class="major"/></chart:axis>'}${ser}</chart:plot-area>`
    + `${table}</chart:chart></office:chart></office:body></office:document-content>`;
}

/** A slide chart from a chart object carrying its figures: { chartType, title, data }, or null. */
export function dataChartFromObject(root, { tags, textOf, find }) {
  const chart = find(root, 'chart:chart');
  const table = chart && find(chart, 'table:table');
  if (!table) return null;
  let chartType = KIND_OF[chart.attribs['chart:class']] || 'column';
  if (chart.attribs['chart:class'] === 'chart:bar') {
    const styleName = find(chart, 'chart:plot-area')?.attribs['chart:style-name'];
    const st = styleName && (function look(n) { for (const k of tags(n)) { if (k.name === 'style:style' && k.attribs['style:name'] === styleName) return k; const f = look(k); if (f) return f; } return null; })(root);
    const p = st ? tags(st, 'style:chart-properties')[0]?.attribs || {} : {};
    const stacked = p['chart:stacked'] === 'true', vertical = p['chart:vertical'] === 'true';
    chartType = vertical ? (stacked ? 'stackedBar' : 'bar') : stacked ? 'stackedColumn' : 'column';
  }
  const rows = [];
  (function all(n) {
    for (const k of tags(n)) {
      if (k.name !== 'table:table-row') { all(k); continue; }
      const row = [];
      for (const c of tags(k).filter((t) => t.name === 'table:table-cell')) {
        const v = c.attribs['office:value-type'] === 'float' ? Number(c.attribs['office:value']) : textOf(c).trim();
        for (let i = 0; i < Math.min(50, Number(c.attribs['table:number-columns-repeated']) || 1); i++) row.push(v);
      }
      rows.push(row);
    }
  })(table);
  if (rows.length < 2) return null;
  const [head, ...body] = rows;
  const series = head.slice(1).map((name, k) => ({ name: String(name ?? ''), values: body.map((r) => (typeof r[k + 1] === 'number' ? r[k + 1] : r[k + 1] === '' || r[k + 1] === undefined || Number.isNaN(Number(r[k + 1])) ? null : Number(r[k + 1]))) })).slice(0, 8);
  if (!series.length) return null;
  return { chartType, title: textOf(find(chart, 'chart:title') || { children: [] }).trim(), data: { categories: body.map((r) => String(r[0] ?? '')), series } };
}

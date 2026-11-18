// A document's charts from Sheets in Word: real Word charts (word/charts/chartN.xml), drawn from the figures the
// document keeps, each with a workbook of those figures embedded so "Edit data" works in Word; and back again
// from Word's charts (a document's, or Word's own) as document charts. The chart's drawing is named after the
// spreadsheet and chart it comes from (sheetchart:<file>:<chart>), so it's linked again when it comes back.
import JSZip from 'jszip';
import { chartXml, chartDataFromXml } from './xlsxcharts.js';
import { excelFromSheet } from './excel.js';

const xml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const colName = (i) => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
export const CHART_MARK = ['', '']; // around a chart's placeholder in the document, until it's made a chart
const EMU = 9525;

/** A chart's figures laid out as a sheet: series names along the first row, categories down the first column. */
function figuresSheet(data) {
  const series = (data?.series || []).slice(0, 8);
  const cats = data?.categories || [];
  const n = Math.max(cats.length, ...series.map((s) => (s.values || []).length), 0);
  const cells = { A1: '' };
  series.forEach((s, k) => { cells[`${colName(k + 1)}1`] = String(s.name ?? `Series ${k + 1}`); });
  for (let i = 0; i < n; i++) {
    cells[`A${i + 2}`] = String(cats[i] ?? '');
    series.forEach((s, k) => { const v = s.values?.[i]; if (v !== null && v !== undefined && v !== '') cells[`${colName(k + 1)}${i + 2}`] = String(v); });
  }
  return { cells, range: `A1:${colName(series.length)}${n + 1}`, n };
}

/** The placeholder a chart is written as in the document (its details encoded), until withWordCharts makes it a chart. */
export const chartPlaceholder = (attrs) => `${CHART_MARK[0]}${encodeURIComponent(JSON.stringify(attrs))}${CHART_MARK[1]}`;

/** The Word file with each chart placeholder made a Word chart (parts, relationships, content types, workbooks). */
export async function withWordCharts(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  let doc = await zip.file('word/document.xml').async('string');
  if (!doc.includes(CHART_MARK[0])) return buffer;
  let rels = await zip.file('word/_rels/document.xml.rels').async('string');
  let types = await zip.file('[Content_Types].xml').async('string');
  const found = [...doc.matchAll(new RegExp(`<w:p\\b(?:(?!</w:p>)[\\s\\S])*?${CHART_MARK[0]}([^${CHART_MARK[1]}]*)${CHART_MARK[1]}(?:(?!</w:p>)[\\s\\S])*?</w:p>`, 'g'))];
  let n = 0;
  for (const m of found) {
    let a = null;
    try { a = JSON.parse(decodeURIComponent(m[1])); } catch { a = null; }
    const sheet = a && figuresSheet(a.data);
    const chart = sheet && chartXml({ type: a.chartType || 'column', range: sheet.range, title: a.title || '' }, 'Sheet1', sheet.cells);
    if (!chart) { doc = doc.replace(m[0], m[0].replace(new RegExp(`${CHART_MARK[0]}[^${CHART_MARK[1]}]*${CHART_MARK[1]}`), '')); continue; }
    n += 1;
    // Its workbook: the figures, so Word's "Edit data" opens them.
    const book = await excelFromSheet({ sheets: [{ name: 'Sheet1', cells: sheet.cells, colWidths: {} }] });
    zip.file(`word/embeddings/Microsoft_Excel_Worksheet${n}.xlsx`, book);
    zip.file(`word/charts/chart${n}.xml`, chart.replace('</c:chartSpace>', '<c:externalData r:id="rId1"><c:autoUpdate val="0"/></c:externalData></c:chartSpace>'));
    zip.file(`word/charts/_rels/chart${n}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/package" Target="../embeddings/Microsoft_Excel_Worksheet${n}.xlsx"/></Relationships>`);
    rels = rels.replace('</Relationships>', `<Relationship Id="rIdWsChart${n}" Type="${REL}/chart" Target="charts/chart${n}.xml"/></Relationships>`);
    types = types.replace('</Types>', `<Override PartName="/word/charts/chart${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>`);
    const cx = 5486400, cy = Math.round(Math.max(120, Math.min(900, Number(a.height) || 320)) * EMU); // 6 inches across
    const name = a.fileId && a.chartId ? `sheetchart:${a.fileId}:${a.chartId}` : `Chart ${n}`;
    doc = doc.replace(m[0], `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${4000 + n}" name="${xml(name)}" descr="${xml(a.title || 'Chart')}"/><wp:cNvGraphicFramePr/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="${REL}" r:id="rIdWsChart${n}"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`);
  }
  if (n && !/Extension="xlsx"/.test(types)) types = types.replace('<Default ', '<Default Extension="xlsx" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"/><Default ');
  zip.file('word/document.xml', doc);
  zip.file('word/_rels/document.xml.rels', rels);
  zip.file('[Content_Types].xml', types);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/**
 * document.xml with each chart drawing (Word's own or the download's) replaced by a marker run carrying the chart
 * ({ title, chartType, data, fileId, chartId, height }), for the import to make a document chart of.
 * `marker(text)` makes the marker's text; `zip` is the Word file's.
 */
export async function markWordCharts(docXml, zip, marker) {
  if (!/<c:chart\b/.test(docXml)) return docXml;
  const relsXml = (await zip.file('word/_rels/document.xml.rels')?.async('string')) || '';
  const target = (id) => { const m = new RegExp(`<Relationship [^>]*Id="${id}"[^>]*Target="([^"]+)"`).exec(relsXml) || new RegExp(`<Relationship [^>]*Target="([^"]+)"[^>]*Id="${id}"`).exec(relsXml); return m ? `word/${m[1].replace(/^\.?\//, '').replace(/^word\//, '')}` : null; };
  let out = '', at = 0;
  const re = /<w:drawing>((?:(?!<\/w:drawing>)[\s\S])*?)<\/w:drawing>/g;
  let m;
  while ((m = re.exec(docXml))) {
    const id = /<c:chart\b[^>]*r:id="([^"]+)"/.exec(m[1])?.[1];
    const part = id && target(id);
    const chart = part && chartDataFromXml((await zip.file(part)?.async('string')) || '');
    if (!chart) continue;
    const name = /<wp:docPr\b[^>]*name="([^"]*)"/.exec(m[1])?.[1] || '';
    const link = /^sheetchart:([^:]+):(.+)$/.exec(name);
    const cy = Number(/<wp:extent\b[^>]*cy="(\d+)"/.exec(m[1])?.[1]);
    const info = { title: chart.title || '', chartType: chart.type, data: chart.data, ...(link && { fileId: link[1], chartId: link[2] }), ...(cy && { height: Math.round(cy / EMU) }) };
    out += docXml.slice(at, m.index) + `<w:t xml:space="preserve">${marker(`ch:${encodeURIComponent(JSON.stringify(info))}`)}</w:t>`;
    at = re.lastIndex;
  }
  return out + docXml.slice(at);
}

/** The HTML for a chart marker's details: a document chart. */
export function chartFigureHtml(enc) {
  let a = null;
  try { a = JSON.parse(decodeURIComponent(enc)); } catch { return ''; }
  const h = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return `<figure data-sheet-chart=""${a.fileId ? ` data-file="${h(a.fileId)}" data-chart="${h(a.chartId)}"` : ''} data-title="${h(a.title)}" data-type="${h(a.chartType)}" data-figures="${h(JSON.stringify(a.data))}"${a.height ? ` data-height="${a.height}"` : ''}></figure>`;
}

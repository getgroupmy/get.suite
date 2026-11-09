// Charts in Excel downloads: each chart on a sheet becomes a real Excel chart, placed where it sits
// on the sheet, whose series point at the sheet's cells (so Excel redraws it when the numbers change).
// The library that writes the workbook has no charts, so they're added to the finished file here.
import JSZip from 'jszip';
const colName = (i) => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
const colIndex = (s) => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

const EMU = 9525; // per pixel
const GRID_LEFT = 46, GRID_TOP = 24; // the row numbers and column letters in front of the cells on screen
const xml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const PALETTE = ['1A73E8', 'E8710A', '1E8E3E', 'D93025', '9334E6', '12B5CB', 'F9AB00', '5F6368'];
const KINDS = new Set(['column', 'stackedColumn', 'bar', 'stackedBar', 'line', 'area', 'scatter', 'pie', 'doughnut']);

/** "A1:C5" → { c1, r1, c2, r2 } (0-based), or null. */
function box(range) {
  const m = /^\$?([A-Z]{1,3})\$?(\d+):\$?([A-Z]{1,3})\$?(\d+)$/i.exec(String(range || '').trim());
  if (!m) return null;
  const a = { c: colIndex(m[1].toUpperCase()), r: +m[2] - 1 }, b = { c: colIndex(m[3].toUpperCase()), r: +m[4] - 1 };
  return { c1: Math.min(a.c, b.c), r1: Math.min(a.r, b.r), c2: Math.max(a.c, b.c), r2: Math.max(a.r, b.r) };
}
const isNum = (v) => v !== undefined && v !== null && v !== '' && (String(v).startsWith('=') || !Number.isNaN(Number(v)));
const isText = (v) => v !== undefined && v !== null && v !== '' && !isNum(v);

/**
 * How a chart's cells divide up, as Sheets reads them: the first row holds series names when it has
 * text, the first column category names when it has text. { headRow, labelCol, r0, series: [{ col, name }] }.
 * Formulas count as numbers (their values aren't known here).
 */
export function chartLayout(range, cells) {
  const g = box(range);
  if (!g) return null;
  const at = (c, r) => cells[`${colName(c)}${r + 1}`];
  const cols = g.c2 - g.c1 + 1;
  const headRow = Array.from({ length: cols }, (_, i) => at(g.c1 + i, g.r1)).slice(cols > 1 ? 1 : 0).some(isText);
  const r0 = headRow ? g.r1 + 1 : g.r1;
  const labelCol = cols > 1 && Array.from({ length: g.r2 - r0 + 1 }, (_, i) => at(g.c1, r0 + i)).some(isText);
  const series = [];
  for (let c = labelCol ? g.c1 + 1 : g.c1; c <= g.c2 && series.length < 8; c++) {
    if (!Array.from({ length: g.r2 - r0 + 1 }, (_, i) => at(c, r0 + i)).some(isNum)) continue;
    series.push({ col: c, name: headRow ? String(at(c, g.r1) ?? '') : `Series ${series.length + 1}` });
  }
  return { g, headRow, labelCol, r0, series };
}

const ref = (sheet, c1, r1, c2, r2) => `'${sheet.replace(/'/g, "''")}'!$${colName(c1)}$${r1 + 1}:$${colName(c2)}$${r2 + 1}`;
const cellRef = (sheet, c, r) => `'${sheet.replace(/'/g, "''")}'!$${colName(c)}$${r + 1}`;
function numCache(cells, col, r0, r2) {
  const pts = [];
  for (let r = r0; r <= r2; r++) { const v = cells[`${colName(col)}${r + 1}`]; if (v !== undefined && v !== '' && !String(v).startsWith('=') && !Number.isNaN(Number(v))) pts.push(`<c:pt idx="${r - r0}"><c:v>${Number(v)}</c:v></c:pt>`); }
  return `<c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${r2 - r0 + 1}"/>${pts.join('')}</c:numCache>`;
}
function strCache(cells, col, r0, r2) {
  const pts = [];
  for (let r = r0; r <= r2; r++) { const v = cells[`${colName(col)}${r + 1}`]; if (v !== undefined && v !== '') pts.push(`<c:pt idx="${r - r0}"><c:v>${xml(v)}</c:v></c:pt>`); }
  return `<c:strCache><c:ptCount val="${r2 - r0 + 1}"/>${pts.join('')}</c:strCache>`;
}
const fill = (i) => `<c:spPr><a:solidFill><a:srgbClr val="${PALETTE[i % PALETTE.length]}"/></a:solidFill></c:spPr>`;
const line = (i) => `<c:spPr><a:ln w="28575" cap="rnd"><a:solidFill><a:srgbClr val="${PALETTE[i % PALETTE.length]}"/></a:solidFill><a:round/></a:ln></c:spPr>`;
const AXES = '<c:axId val="500000001"/><c:axId val="500000002"/>';
const catAx = (pos) => `<c:catAx><c:axId val="500000001"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${pos}"/><c:numFmt formatCode="General" sourceLinked="1"/><c:tickLblPos val="low"/><c:crossAx val="500000002"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/></c:catAx>`;
const valAx = (id, cross, pos, grid = true) => `<c:valAx><c:axId val="${id}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${pos}"/>${grid ? '<c:majorGridlines><c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="E0E0E0"/></a:solidFill></a:ln></c:spPr></c:majorGridlines>' : ''}<c:numFmt formatCode="General" sourceLinked="1"/><c:tickLblPos val="nextTo"/><c:crossAx val="${cross}"/><c:crosses val="autoZero"/></c:valAx>`;

/** A chart's XML (a chartSpace), or null when it has nothing to draw. */
export function chartXml(chart, sheetName, cells) {
  const type = KINDS.has(chart.type) ? chart.type : 'column';
  const L = chartLayout(chart.range, cells);
  if (!L || !L.series.length) return null;
  const { g, labelCol, headRow, r0 } = L;
  const r2 = Math.max(r0, g.r2);
  const cat = labelCol ? `<c:cat><c:strRef><c:f>${xml(ref(sheetName, g.c1, r0, g.c1, r2))}</c:f>${strCache(cells, g.c1, r0, r2)}</c:strRef></c:cat>` : '';
  const tx = (s) => (headRow ? `<c:tx><c:strRef><c:f>${xml(cellRef(sheetName, s.col, g.r1))}</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${xml(s.name)}</c:v></c:pt></c:strCache></c:strRef></c:tx>` : `<c:tx><c:v>${xml(s.name)}</c:v></c:tx>`);
  const val = (s, tag = 'c:val') => `<${tag}><c:numRef><c:f>${xml(ref(sheetName, s.col, r0, s.col, r2))}</c:f>${numCache(cells, s.col, r0, r2)}</c:numRef></${tag}>`;
  const round = type === 'pie' || type === 'doughnut';
  const list = round ? L.series.slice(0, 1) : L.series;
  let plot;
  if (type === 'scatter') {
    // X: the first column of numbers when the rows have no names; else the row names (or 1, 2, 3…).
    const xs = !labelCol && list.length > 1 ? list[0] : null;
    const ys = xs ? list.slice(1) : list;
    const xVal = xs ? `<c:xVal><c:numRef><c:f>${xml(ref(sheetName, xs.col, r0, xs.col, r2))}</c:f>${numCache(cells, xs.col, r0, r2)}</c:numRef></c:xVal>` : labelCol ? `<c:xVal><c:strRef><c:f>${xml(ref(sheetName, g.c1, r0, g.c1, r2))}</c:f>${strCache(cells, g.c1, r0, r2)}</c:strRef></c:xVal>` : '';
    const sers = ys.map((s, i) => `<c:ser><c:idx val="${i}"/><c:order val="${i}"/>${tx(s)}<c:spPr><a:ln w="19050"><a:noFill/></a:ln></c:spPr><c:marker><c:symbol val="circle"/><c:size val="7"/>${fill(i)}</c:marker>${xVal}${val(s, 'c:yVal')}<c:smooth val="0"/></c:ser>`).join('');
    plot = `<c:scatterChart><c:scatterStyle val="lineMarker"/><c:varyColors val="0"/>${sers}${AXES}</c:scatterChart>${valAx(500000001, 500000002, 'b', false)}${valAx(500000002, 500000001, 'l')}`;
  } else if (round) {
    const s = list[0];
    const pts = Array.from({ length: r2 - r0 + 1 }, (_, i) => `<c:dPt><c:idx val="${i}"/><c:bubble3D val="0"/>${fill(i)}</c:dPt>`).join('');
    const ser = `<c:ser><c:idx val="0"/><c:order val="0"/>${tx(s)}${pts}${cat}${val(s)}</c:ser>`;
    plot = type === 'pie' ? `<c:pieChart><c:varyColors val="1"/>${ser}<c:firstSliceAng val="0"/></c:pieChart>` : `<c:doughnutChart><c:varyColors val="1"/>${ser}<c:firstSliceAng val="0"/><c:holeSize val="58"/></c:doughnutChart>`;
  } else if (type === 'line' || type === 'area') {
    const sers = list.map((s, i) => `<c:ser><c:idx val="${i}"/><c:order val="${i}"/>${tx(s)}${type === 'line' ? `${line(i)}<c:marker><c:symbol val="none"/></c:marker>` : `<c:spPr><a:solidFill><a:srgbClr val="${PALETTE[i % PALETTE.length]}"><a:alpha val="45000"/></a:srgbClr></a:solidFill></c:spPr>`}${cat}${val(s)}${type === 'line' ? '<c:smooth val="0"/>' : ''}</c:ser>`).join('');
    plot = type === 'line'
      ? `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${sers}<c:marker val="1"/>${AXES}</c:lineChart>${catAx('b')}${valAx(500000002, 500000001, 'l')}`
      : `<c:areaChart><c:grouping val="standard"/><c:varyColors val="0"/>${sers}${AXES}</c:areaChart>${catAx('b')}${valAx(500000002, 500000001, 'l')}`;
  } else {
    const horiz = type === 'bar' || type === 'stackedBar', stacked = type === 'stackedColumn' || type === 'stackedBar';
    const sers = list.map((s, i) => `<c:ser><c:idx val="${i}"/><c:order val="${i}"/>${tx(s)}${fill(i)}<c:invertIfNegative val="0"/>${cat}${val(s)}</c:ser>`).join('');
    plot = `<c:barChart><c:barDir val="${horiz ? 'bar' : 'col'}"/><c:grouping val="${stacked ? 'stacked' : 'clustered'}"/><c:varyColors val="0"/>${sers}<c:gapWidth val="${stacked ? 60 : 80}"/>${stacked ? '<c:overlap val="100"/>' : ''}${AXES}</c:barChart>${catAx(horiz ? 'l' : 'b')}${valAx(500000002, 500000001, horiz ? 'b' : 'l')}`;
  }
  const title = chart.title ? `<c:title><c:tx><c:rich><a:bodyPr/><a:p><a:pPr><a:defRPr sz="1400" b="1"/></a:pPr><a:r><a:rPr lang="en-US" sz="1400" b="1"/><a:t>${xml(chart.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>` : '<c:autoTitleDeleted val="1"/>';
  const legend = round || list.length > (type === 'scatter' && !labelCol && list.length > 1 ? 2 : 1) ? '<c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend>' : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><c:roundedCorners val="0"/><c:chart>${title}<c:plotArea><c:layout/>${plot}</c:plotArea>${legend}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>`;
}

const anchor = (chart, i) => {
  const x = Math.max(0, (Number(chart.x) || 0) - GRID_LEFT) * EMU, y = Math.max(0, (Number(chart.y) || 0) - GRID_TOP) * EMU;
  const w = Math.max(100, Number(chart.w) || 480) * EMU, h = Math.max(80, Number(chart.h) || 300) * EMU;
  return `<xdr:absoluteAnchor><xdr:pos x="${Math.round(x)}" y="${Math.round(y)}"/><xdr:ext cx="${Math.round(w)}" cy="${Math.round(h)}"/><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${i + 2}" name="${xml(chart.title || `Chart ${i + 1}`)}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId${i + 1}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:absoluteAnchor>`;
};
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/**
 * The workbook with each sheet's charts added. `sheets` are the spreadsheet's sheets in workbook
 * order, with the names the workbook gave them (`xlName`). Sheets that already have drawings are left alone.
 */
export async function withCharts(buffer, sheets) {
  if (!(sheets || []).some((s) => s && Object.keys(s.charts || {}).length)) return buffer;
  const zip = await JSZip.loadAsync(buffer);
  let types = await zip.file('[Content_Types].xml').async('string');
  let chartNo = 0, drawingNo = Object.keys(zip.files).filter((f) => /^xl\/drawings\/drawing\d+\.xml$/.test(f)).length;
  for (let i = 0; i < sheets.length; i++) {
    const s = sheets[i];
    const charts = Object.values(s?.charts || {});
    const sheetPath = `xl/worksheets/sheet${i + 1}.xml`;
    if (!charts.length || !zip.file(sheetPath)) continue;
    let sheetXml = await zip.file(sheetPath).async('string');
    if (/<drawing\b/.test(sheetXml)) continue;
    const parts = charts.map((c) => chartXml(c, s.xlName || s.name, s.cells || {})).map((x, k) => (x ? { x, chart: charts[k] } : null)).filter(Boolean);
    if (!parts.length) continue;
    drawingNo += 1;
    const anchors = [], drawRels = [];
    parts.forEach((p, k) => {
      chartNo += 1;
      zip.file(`xl/charts/chart${chartNo}.xml`, p.x);
      types = types.replace('</Types>', `<Override PartName="/xl/charts/chart${chartNo}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>`);
      anchors.push(anchor(p.chart, k));
      drawRels.push(`<Relationship Id="rId${k + 1}" Type="${REL}/chart" Target="../charts/chart${chartNo}.xml"/>`);
    });
    zip.file(`xl/drawings/drawing${drawingNo}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${REL}">${anchors.join('')}</xdr:wsDr>`);
    zip.file(`xl/drawings/_rels/drawing${drawingNo}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${drawRels.join('')}</Relationships>`);
    types = types.replace('</Types>', `<Override PartName="/xl/drawings/drawing${drawingNo}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>`);
    // The sheet's own relationships: kept, with one more for the drawing.
    const relsPath = `xl/worksheets/_rels/sheet${i + 1}.xml.rels`;
    let rels = zip.file(relsPath) ? await zip.file(relsPath).async('string') : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
    const used = new Set([...rels.matchAll(/Id="([^"]+)"/g)].map((m) => m[1]));
    let rid = 'rIdChart1';
    for (let n = 1; used.has(rid); n++) rid = `rIdChart${n + 1}`;
    rels = rels.replace('</Relationships>', `<Relationship Id="${rid}" Type="${REL}/drawing" Target="../drawings/drawing${drawingNo}.xml"/></Relationships>`);
    zip.file(relsPath, rels);
    // <drawing> goes before legacyDrawing (notes), tableParts and extLst, as the format orders them.
    const tag = `<drawing r:id="${rid}"/>`;
    if (!/xmlns:r=/.test(sheetXml.slice(0, 600))) sheetXml = sheetXml.replace(/<worksheet\b/, `<worksheet xmlns:r="${REL}"`);
    const before = /<(legacyDrawing|legacyDrawingHF|picture|oleObjects|controls|webPublishItems|tableParts|extLst)\b/.exec(sheetXml);
    sheetXml = before ? sheetXml.slice(0, before.index) + tag + sheetXml.slice(before.index) : sheetXml.replace('</worksheet>', `${tag}</worksheet>`);
    zip.file(sheetPath, sheetXml);
  }
  zip.file('[Content_Types].xml', types);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

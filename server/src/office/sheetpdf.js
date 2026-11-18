// A spreadsheet as a PDF, made here (pdf-lib, standard fonts): each sheet's used cells with their values worked out
// (the same formula engine as the page, copied in sheetcalc/), shown as the page shows them (number formats),
// bold, italic, underline, strike, text colour, fill, alignment and borders, column widths and hidden rows and
// columns as in the sheet, gridlines; landscape A4 pages, the sheet's frozen rows repeated at the top of each page,
// columns that don't fit on further pages. Characters the standard fonts lack show as "?".
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { bookEvaluator, display, colName, parseRef } from '../sheetcalc/formula.js';
import { formatNumber } from '../sheetcalc/cellformat.js';

const PW = 841.89, PH = 595.28, M = 28; // A4 landscape
const hexRgb = (hex) => { const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '')); if (!m) return null; const n = parseInt(m[1], 16); return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255); };

export async function pdfFromSheet(data, title = 'Spreadsheet', { author = '', lang = 'en' } = {}) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  pdf.setCreator('Workspace');
  if (author) pdf.setAuthor(author);
  pdf.setLanguage(lang);
  const F = { r: await pdf.embedFont(StandardFonts.Helvetica), b: await pdf.embedFont(StandardFonts.HelveticaBold), i: await pdf.embedFont(StandardFonts.HelveticaOblique), bi: await pdf.embedFont(StandardFonts.HelveticaBoldOblique) };
  const safe = (t) => [...String(t ?? '')].map((ch) => { try { F.r.encodeText(ch); return ch; } catch { return /\s/.test(ch) ? ' ' : '?'; } }).join('');
  const sheets = data?.sheets?.length ? data.sheets : [{ name: 'Sheet1', cells: {} }];
  const size = 9, rowH = 15;
  for (const [si, sheet] of sheets.entries()) {
    if (sheet.hidden) continue;
    const ev = bookEvaluator(sheets, si);
    const formats = sheet.formats || {};
    // The used range: cells with something in them (spilled results too).
    let maxR = -1, maxC = -1;
    for (const k of [...Object.keys(sheet.cells || {}), ...(ev.spilledKeys?.() || [])]) { const p = parseRef(k); if (p && sheet.cells?.[k] !== '' ) { maxR = Math.max(maxR, p.r); maxC = Math.max(maxC, p.c); } }
    maxR = Math.min(maxR, 5000); maxC = Math.min(maxC, 200);
    const hiddenRows = new Set((sheet.hide?.rows || []).map(Number)), hiddenCols = new Set((sheet.hide?.cols || []).map(Number));
    const rows = Array.from({ length: maxR + 1 }, (_, r) => r).filter((r) => !hiddenRows.has(r));
    const cols = Array.from({ length: maxC + 1 }, (_, c) => c).filter((c) => !hiddenCols.has(c));
    const width = (c) => Math.max(18, Math.min(PW - 2 * M, (Number(sheet.colWidths?.[colName(c)]) || 100) * 0.75));
    const text = (k) => { let v; try { v = ev(k); } catch { v = { error: '#ERROR!' }; } return safe(formatNumber(v, formats[k]) ?? display(v)); };
    const isNum = (k) => { try { return typeof ev(k) === 'number'; } catch { return false; } };
    // Columns in groups that fit across a page.
    const groups = [];
    let cur = [], used = 0;
    for (const c of cols) { if (cur.length && used + width(c) > PW - 2 * M) { groups.push(cur); cur = []; used = 0; } cur.push(c); used += width(c); }
    if (cur.length) groups.push(cur);
    if (!groups.length) groups.push([]);
    const frozen = Math.min(Number(sheet.frozen?.rows) || 0, rows.length);
    const head = rows.slice(0, frozen), body = rows.slice(frozen);
    const perPage = Math.max(1, Math.floor((PH - 2 * M - 22 - head.length * rowH) / rowH));
    for (const group of groups) {
      for (let start = 0; start < Math.max(1, body.length); start += perPage) {
        const page = pdf.addPage([PW, PH]);
        page.drawText(safe(sheets.length > 1 ? `${title} — ${sheet.name}` : title), { x: M, y: PH - M - 10, size: 11, font: F.b, color: rgb(0.2, 0.2, 0.2) });
        let y = PH - M - 22;
        for (const r of [...head, ...body.slice(start, start + perPage)]) {
          let x = M;
          for (const c of group) {
            const k = `${colName(c)}${r + 1}`, f = formats[k] || {}, w = width(c);
            if (f.fill && hexRgb(f.fill)) page.drawRectangle({ x, y: y - rowH, width: w, height: rowH, color: hexRgb(f.fill) });
            page.drawRectangle({ x, y: y - rowH, width: w, height: rowH, borderColor: rgb(0.85, 0.85, 0.85), borderWidth: 0.4 });
            for (const [side, line] of [['t', [[x, y], [x + w, y]]], ['b', [[x, y - rowH], [x + w, y - rowH]]], ['l', [[x, y], [x, y - rowH]]], ['r', [[x + w, y], [x + w, y - rowH]]]]) {
              if (f.bd?.includes(side)) page.drawLine({ start: { x: line[0][0], y: line[0][1] }, end: { x: line[1][0], y: line[1][1] }, thickness: 0.8, color: rgb(0.13, 0.13, 0.14) });
            }
            let t = text(k);
            if (t) {
              const font = f.b && f.i ? F.bi : f.b ? F.b : f.i ? F.i : F.r;
              while (t.length > 1 && font.widthOfTextAtSize(t, size) > w - 6) t = t.slice(0, -1);
              const tw = font.widthOfTextAtSize(t, size);
              const align = f.align || (isNum(k) ? 'right' : 'left');
              const tx = align === 'center' ? x + (w - tw) / 2 : align === 'right' ? x + w - 3 - tw : x + 3;
              const color = hexRgb(f.color) || rgb(0.1, 0.1, 0.1);
              page.drawText(t, { x: tx, y: y - rowH + 4.5, size, font, color });
              if (f.u) page.drawLine({ start: { x: tx, y: y - rowH + 3.5 }, end: { x: tx + tw, y: y - rowH + 3.5 }, thickness: 0.5, color });
              if (f.s) page.drawLine({ start: { x: tx, y: y - rowH + 7.5 }, end: { x: tx + tw, y: y - rowH + 7.5 }, thickness: 0.5, color });
            }
            x += w;
          }
          y -= rowH;
        }
        if (groups.length > 1 || body.length > perPage) page.drawText(`Rows ${(body[start] ?? 0) + 1}–${(body[Math.min(start + perPage, body.length) - 1] ?? 0) + 1}, columns ${colName(group[0] ?? 0)}–${colName(group[group.length - 1] ?? 0)}`, { x: M, y: M - 14, size: 8, font: F.r, color: rgb(0.45, 0.45, 0.45) });
      }
    }
  }
  if (!pdf.getPageCount()) pdf.addPage([PW, PH]);
  return Buffer.from(await pdf.save());
}

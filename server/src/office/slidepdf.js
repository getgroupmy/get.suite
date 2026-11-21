// A presentation as a PDF, made here (pdf-lib, standard fonts): a 16:9 page a slide (skipped slides left out),
// each with its background (colour or picture), text boxes (size, bold, italic, colour, alignment, fill, outline,
// line breaks and wrapping), shapes (rectangles, rounded ones, ellipses, triangles, diamonds, lines and arrows,
// others as rectangles) with their text, pictures (PNG and JPEG), tables and charts (as their figures), and the
// slide number when the deck shows numbers. Turned boxes are drawn straight. Characters the standard fonts lack: "?".
import { asDrawn, withFallbackFonts } from './pdffonts.js';
import { PDFDocument, StandardFonts, rgb, PDFName, PDFHexString } from 'pdf-lib';
import { themeOfDeck } from './powerpoint.js';
import { chartTable } from './sheetchart.js';
import { drawChart, plottable } from './sheetpdfchart.js';

const W = 960, H = 540;
const hexRgb = (hex) => { const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '')); if (!m) return null; const n = parseInt(m[1], 16); return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255); };

export async function pdfFromDeck(deck, title = 'Presentation', { pictureData, author = '', lang = 'en' } = {}) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  pdf.setCreator('Workspace');
  if (author) pdf.setAuthor(author);
  pdf.setLanguage(lang);
  const marks = []; // [{ title, page }]: the PDF's bookmarks, a slide each
  const S = { r: asDrawn(await pdf.embedFont(StandardFonts.Helvetica)), b: asDrawn(await pdf.embedFont(StandardFonts.HelveticaBold)), i: asDrawn(await pdf.embedFont(StandardFonts.HelveticaOblique)), bi: asDrawn(await pdf.embedFont(StandardFonts.HelveticaBoldOblique)) };
  // what Helvetica can't draw (Greek, Cyrillic, Chinese, Thai, Tamil…) from an installed font that has it (pdffonts.js)
  const fonts = await withFallbackFonts(pdf, JSON.stringify({ deck, title, author }), S.r);
  const F = { r: fonts.wrap(S.r), b: fonts.wrap(S.b, true), i: fonts.wrap(S.i), bi: fonts.wrap(S.bi, true) };
  const safe = (t) => [...String(t ?? '')].map((ch) => { if (ch === '\n') return ch; try { S.r.encodeText(ch); return ch; } catch { return /\s/.test(ch) ? ' ' : fonts.drawable(ch) ? ch : '?'; } }).join(''); // (line breaks kept)
  const theme = themeOfDeck(deck);
  const col = (v, fallback) => hexRgb(v === 'accent' ? theme.accent : v === 'text' ? theme.text : v === 'bg' ? theme.bg : v) || hexRgb(fallback) || rgb(0, 0, 0);
  const images = new Map();
  const image = async (id) => {
    if (!id) return null;
    if (!images.has(id)) {
      const got = await pictureData?.(id);
      let img = null;
      try { img = got && /png/.test(got.mime) ? await pdf.embedPng(new Uint8Array(got.data)) : got && /jpe?g/.test(got.mime) ? await pdf.embedJpg(new Uint8Array(got.data)) : null; } catch { img = null; }
      images.set(id, img);
    }
    return images.get(id);
  };
  // A box in points (pdf-lib measures from the bottom).
  const boxOf = (it) => { const x = (it.x || 0) / 100 * W, w = (it.w || 0) / 100 * W, h = (it.h || 0) / 100 * H; return { x, y: H - (it.y || 0) / 100 * H - h, w, h }; };
  /** Text wrapped into the box (centred vertically when asked), its lines `size` points. */
  const text = (page, str, b, { size, font, color, align = 'left', valign = 'top', pad = 4, underline = false }) => {
    const lines = [];
    for (const para of safe(str).split('\n')) {
      let line = '';
      for (const word of para.split(/(?<=\s)/)) {
        if (line && font.widthOfTextAtSize((line + word).trimEnd(), size) > b.w - 2 * pad) { lines.push(line.trimEnd()); line = ''; }
        line += word;
      }
      lines.push(line.trimEnd());
    }
    const lh = size * 1.2, total = lines.length * lh;
    let y = valign === 'middle' ? b.y + (b.h + total) / 2 - size : b.y + b.h - pad - size;
    for (const l of lines) {
      const tw = font.widthOfTextAtSize(l, size);
      const x = align === 'center' ? b.x + (b.w - tw) / 2 : align === 'right' ? b.x + b.w - pad - tw : b.x + pad;
      page.drawText(l, { x, y, size, font, color });
      if (underline && tw > 0) page.drawLine({ start: { x, y: y - size * 0.12 }, end: { x: x + tw, y: y - size * 0.12 }, thickness: Math.max(0.5, size / 16), color }); // (under the words, as the slide shows them)
      y -= lh;
    }
  };
  const fontOf = (it) => (it.bold && it.italic ? F.bi : it.bold ? F.b : it.italic ? F.i : F.r);
  const slides = (deck?.slides || []).map((s, i) => ({ s, i })).filter(({ s }) => !s.skip);
  for (const { s, i } of slides.length ? slides : [{ s: { items: [] }, i: 0 }]) {
    const page = fonts.page(pdf.addPage([W, H]));
    const titleBox = (s.items || []).find((it) => it.type === 'text' && it.role === 'title' && String(it.text || '').trim()) || (s.items || []).find((it) => it.type === 'text' && String(it.text || '').trim());
    marks.push({ title: `${i + 1}. ${String(titleBox?.text || '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Slide'}`, page }); // (bookmarks are Unicode: any characters)
    page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: col(s.bg, theme.bg) });
    const bgImg = await image(s.bgImage);
    if (bgImg) page.drawImage(bgImg, { x: 0, y: 0, width: W, height: H });
    for (const it of s.items || []) {
      const b = boxOf(it);
      if (b.w <= 0 || b.h <= 0) continue;
      const size = Math.max(4, (it.size || (it.type === 'text' ? 24 : 18)) * 0.001 * W);
      const border = it.outline ? { borderColor: col(it.outline, theme.text), borderWidth: Number(it.outlineW) || 1 } : {};
      if (it.type === 'text') {
        if (it.fill || it.outline) page.drawRectangle({ x: b.x, y: b.y, width: b.w, height: b.h, ...(it.fill && { color: col(it.fill, theme.accent) }), ...border });
        text(page, it.text || '', b, { size, font: fontOf(it), color: col(it.color, theme.text), align: it.align || 'left', underline: !!it.underline });
      } else if (it.type === 'shape') {
        const fill = col(it.fill || 'accent', theme.accent);
        const shape = it.shape || 'rect';
        if (shape === 'line' || shape === 'arrow') {
          const dir = it.dir || 'h';
          const [x1, y1, x2, y2] = dir === 'h' ? [b.x, b.y + b.h / 2, b.x + b.w, b.y + b.h / 2] : dir === 'hr' ? [b.x + b.w, b.y + b.h / 2, b.x, b.y + b.h / 2] : dir === 'v' ? [b.x + b.w / 2, b.y + b.h, b.x + b.w / 2, b.y] : dir === 'vr' ? [b.x + b.w / 2, b.y, b.x + b.w / 2, b.y + b.h] : dir === 'd' ? [b.x, b.y + b.h, b.x + b.w, b.y] : [b.x, b.y, b.x + b.w, b.y + b.h];
          page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 2.5, color: fill });
          if (shape === 'arrow') {
            const a = Math.atan2(y2 - y1, x2 - x1), L = 12;
            for (const d of [-0.45, 0.45]) page.drawLine({ start: { x: x2, y: y2 }, end: { x: x2 - L * Math.cos(a + d), y: y2 - L * Math.sin(a + d) }, thickness: 2.5, color: fill });
          }
          continue;
        }
        if (shape === 'ellipse') page.drawEllipse({ x: b.x + b.w / 2, y: b.y + b.h / 2, xScale: b.w / 2, yScale: b.h / 2, color: fill, ...border });
        else if (shape === 'triangle' || shape === 'diamond') {
          // (an SVG path is drawn from the top left, y going down)
          const p = shape === 'triangle' ? `M ${b.w / 2} 0 L ${b.w} ${b.h} L 0 ${b.h} Z` : `M ${b.w / 2} 0 L ${b.w} ${b.h / 2} L ${b.w / 2} ${b.h} L 0 ${b.h / 2} Z`;
          page.drawSvgPath(p, { x: b.x, y: b.y + b.h, color: fill, ...border });
        } else if (shape === 'round') {
          const r = Math.min(b.w, b.h) * 0.15;
          page.drawSvgPath(`M ${r} 0 H ${b.w - r} Q ${b.w} 0 ${b.w} ${r} V ${b.h - r} Q ${b.w} ${b.h} ${b.w - r} ${b.h} H ${r} Q 0 ${b.h} 0 ${b.h - r} V ${r} Q 0 0 ${r} 0 Z`, { x: b.x, y: b.y + b.h, color: fill, ...border });
        } else page.drawRectangle({ x: b.x, y: b.y, width: b.w, height: b.h, color: fill, ...border });
        if (it.text) text(page, it.text, b, { size, font: fontOf(it), color: col(it.color, theme.bg), align: it.align || 'center', valign: 'middle', underline: !!it.underline });
      } else if (it.type === 'image') {
        const img = await image(it.fileId);
        if (img) page.drawImage(img, { x: b.x, y: b.y, width: b.w, height: b.h });
        else if (it.alt) text(page, `[${it.alt}]`, b, { size: 12, font: F.i, color: col('text', theme.text) });
      } else if (it.type === 'chart' && plottable(it.data)) { // drawn as a chart (its figures as a table when it has none)
        drawChart(page, { type: it.chartType, title: it.title }, plottable(it.data), { x: b.x, y: b.y + b.h, w: b.w, h: b.h }, F.r, safe, { scale: Math.max(1, Math.min(2.5, b.w / 300)) });
      } else if (it.type === 'table' || it.type === 'chart') {
        let rows = it.type === 'table' ? (it.cells || []).map((r) => r.map((c) => String(c ?? ''))) : chartTable({ title: it.title, chartType: it.chartType, data: it.data }).rows;
        let tb = b;
        if (it.type === 'chart' && it.title) { text(page, it.title, { ...b, y: b.y + b.h - 24, h: 24 }, { size: 14, font: F.b, color: col('text', theme.text) }); tb = { ...b, h: b.h - 26 }; }
        rows = rows.slice(0, 30);
        const cols = Math.max(1, ...rows.map((r) => r.length));
        const cw = tb.w / cols, rh = Math.min(tb.h / Math.max(1, rows.length), (it.size || 16) * 0.001 * W * 2);
        const ts = Math.max(5, Math.min(rh * 0.55, (it.size || 16) * 0.001 * W));
        rows.forEach((r, ri) => {
          const head = (it.type === 'chart' || it.header) && ri === 0;
          for (let ci = 0; ci < cols; ci++) {
            const cb = { x: tb.x + ci * cw, y: tb.y + tb.h - (ri + 1) * rh, w: cw, h: rh };
            page.drawRectangle({ x: cb.x, y: cb.y, width: cb.w, height: cb.h, ...(head && { color: col('accent', theme.accent) }), borderColor: rgb(0.6, 0.6, 0.6), borderWidth: 0.5 });
            text(page, r[ci] ?? '', cb, { size: ts, font: head ? F.b : F.r, color: head ? col(theme.bg, theme.bg) : col('text', theme.text), valign: 'middle' });
          }
        });
      } else if (it.type === 'video' || it.type === 'audio') {
        page.drawRectangle({ x: b.x, y: b.y, width: b.w, height: b.h, color: rgb(0.95, 0.95, 0.95) });
        text(page, `${it.type === 'audio' ? 'Sound' : 'Video'}: ${it.name || ''}`, b, { size: 14, font: F.r, color: rgb(0.37, 0.39, 0.41), align: 'center', valign: 'middle' });
      }
    }
    if (deck?.numbers && !(deck.numbers === 'skip-first' && i === 0)) { const t = `${i + 1}`; page.drawText(t, { x: W - 30 - F.r.widthOfTextAtSize(t, 12), y: 16, size: 12, font: F.r, color: col('text', theme.text) }); }
  }
  // Bookmarks: a slide each, by its title.
  if (marks.length) {
    const outlines = pdf.context.nextRef();
    const refs = marks.map(() => pdf.context.nextRef());
    marks.forEach((m, k) => pdf.context.assign(refs[k], pdf.context.obj({ Title: PDFHexString.fromText(m.title), Parent: outlines, Dest: [m.page.ref, PDFName.of('Fit')], ...(k > 0 && { Prev: refs[k - 1] }), ...(k < refs.length - 1 && { Next: refs[k + 1] }) })));
    pdf.context.assign(outlines, pdf.context.obj({ Type: 'Outlines', First: refs[0], Last: refs[refs.length - 1], Count: refs.length }));
    pdf.catalog.set(PDFName.of('Outlines'), outlines);
  }
  fonts.finish();
  return Buffer.from(await pdf.save());
}

/**
 * The presentation with its speaker notes: an A4 page a slide (skipped ones left out), the slide as in the PDF
 * above at the top, framed, its notes under it (going on to further pages when long).
 */
export async function notesPdfFromDeck(deck, title = 'Presentation', opts = {}) {
  const slidesPdf = await PDFDocument.load(await pdfFromDeck(deck, title, opts));
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${title} (with notes)`);
  pdf.setCreator('Workspace');
  if (opts.author) pdf.setAuthor(opts.author);
  pdf.setLanguage(opts.lang || 'en');
  const S = { r: asDrawn(await pdf.embedFont(StandardFonts.Helvetica)), b: asDrawn(await pdf.embedFont(StandardFonts.HelveticaBold)) };
  const fonts = await withFallbackFonts(pdf, JSON.stringify({ deck, title }), S.r);
  const font = fonts.wrap(S.r), bold = fonts.wrap(S.b, true);
  const safe = (t) => [...String(t ?? '')].map((ch) => { if (ch === '\n') return ch; try { S.r.encodeText(ch); return ch; } catch { return /\s/.test(ch) ? ' ' : fonts.drawable(ch) ? ch : '?'; } }).join('');
  const PW = 595.28, PH = 841.89, M = 56, size = 11, lead = size * 1.45;
  const shown = (deck?.slides || []).map((s, i) => ({ s, i })).filter(({ s }) => !s.skip);
  const embedded = await pdf.embedPages(slidesPdf.getPages());
  for (const [k, ep] of embedded.entries()) {
    const { s, i } = shown[k] || { s: {}, i: k };
    let page = fonts.page(pdf.addPage([PW, PH]));
    const w = PW - 2 * M, h = w * (H / W);
    page.drawText(`Slide ${i + 1}`, { x: M, y: PH - M + 10, size: 9, font: bold, color: rgb(0.4, 0.4, 0.4) });
    page.drawPage(ep, { x: M, y: PH - M - h, width: w, height: h });
    page.drawRectangle({ x: M, y: PH - M - h, width: w, height: h, borderColor: rgb(0.7, 0.7, 0.7), borderWidth: 0.75 });
    let y = PH - M - h - 30;
    const notes = String(s.notes || '').trim();
    if (!notes) { page.drawText('No speaker notes', { x: M, y, size, font, color: rgb(0.55, 0.55, 0.55) }); continue; }
    for (const para of safe(notes).split('\n')) {
      let line = '';
      const flush = () => { if (y < M) { page = fonts.page(pdf.addPage([PW, PH])); y = PH - M; } page.drawText(line.trimEnd(), { x: M, y, size, font, color: rgb(0.1, 0.1, 0.1) }); y -= lead; line = ''; };
      for (const word of para.split(/(?<=\s)/)) {
        if (line && font.widthOfTextAtSize((line + word).trimEnd(), size) > w) flush();
        line += word;
      }
      flush();
    }
  }
  fonts.finish();
  return Buffer.from(await pdf.save());
}

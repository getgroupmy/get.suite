// A document as a PDF, made here (pdf-lib, standard fonts): the page setup's paper, orientation and margins,
// its header and footer and page numbers; headings, paragraphs and their alignment, bold, italic, underline,
// strike, links (blue, underlined, and clickable), lists and checklists, quotes, code, tables, pictures (PNG and
// JPEG), page breaks; footnotes at the end. Equations and chips as their text. The standard fonts hold Western
// European letters and the usual punctuation; other characters show as "?".
import { PDFDocument, StandardFonts, rgb, PDFName, PDFString, PDFHexString } from 'pdf-lib';
import { flattenTabs } from './doctabs.js';
import { chipText, dateText } from './chiptext.js';
import { inText, reference, sourcesOf } from './cite.js';
import { chartTable } from './sheetchart.js';
import { PAPER, MARGINS } from '../pagesetup.js';

const MM = 72 / 25.4;
const HEAD = { 1: 22, 2: 17, 3: 14, 4: 12.5, 5: 12, 6: 11 };

/**
 * Made twice: the first time to learn which page each heading lands on, the second with those pages in the
 * table of contents (it takes the same room both times). The PDF's bookmarks follow the headings.
 */
export async function pdfFromDoc(doc, title = 'Document', opts = {}) {
  const first = await layout(doc, title, opts, null);
  const { pdf } = await layout(doc, title, opts, first.heads.map((hd) => hd.page));
  return Buffer.from(await pdf.save());
}

async function layout(doc, title, { pictureData, setup = null, author = '', lang = 'en' } = {}, knownPages) {
  doc = flattenTabs(doc);
  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  pdf.setCreator('Workspace');
  if (author) pdf.setAuthor(author);
  pdf.setLanguage(lang);
  // The document's font (Page setup): Times for the serif ones, Courier for Courier New, Helvetica otherwise.
  const fam = /times|georgia/i.test(setup?.font || '') ? ['TimesRoman', 'TimesRomanBold', 'TimesRomanItalic', 'TimesRomanBoldItalic']
    : /courier/i.test(setup?.font || '') ? ['Courier', 'CourierBold', 'CourierOblique', 'CourierBoldOblique']
      : ['Helvetica', 'HelveticaBold', 'HelveticaOblique', 'HelveticaBoldOblique'];
  const F = {
    r: await pdf.embedFont(StandardFonts[fam[0]]), b: await pdf.embedFont(StandardFonts[fam[1]]),
    i: await pdf.embedFont(StandardFonts[fam[2]]), bi: await pdf.embedFont(StandardFonts[fam[3]]),
    m: await pdf.embedFont(StandardFonts.Courier),
  };
  const BASE = Number(setup?.fontSize) || 11;
  const hexRgb = (hex) => { const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim()); if (!m) { const r = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(String(hex || '')); return r ? rgb(r[1] / 255, r[2] / 255, r[3] / 255) : null; } const n = parseInt(m[1], 16); return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255); };
  const ptSize = (v) => { const m = /^([\d.]+)(pt|px)$/.exec(String(v || '').trim()); if (!m) return null; const pt = m[2] === 'px' ? Number(m[1]) * 0.75 : Number(m[1]); return pt >= 4 && pt <= 96 ? pt : null; };
  const fontOf = (s) => (s.code ? F.m : s.bold && s.italic ? F.bi : s.bold ? F.b : s.italic ? F.i : F.r);
  // Characters the standard fonts can't draw: "?".
  const safe = (t) => [...String(t)].map((ch) => { try { F.r.encodeText(ch); return ch; } catch { return /\s/.test(ch) ? ' ' : '?'; } }).join('');
  let [pw, ph] = (PAPER[setup?.size] || PAPER.a4).map((v) => v * MM);
  if (setup?.orientation === 'landscape') [pw, ph] = [ph, pw];
  const margin = (MARGINS[setup?.margin] || MARGINS.normal) * MM;
  const left = margin, right = pw - margin, top = ph - margin, bottom = margin;
  const width = right - left;
  let page, y;
  const pages = [];
  const newPage = () => {
    page = pdf.addPage([pw, ph]); pages.push(page); y = top;
    const bg = hexRgb(setup?.pageColor);
    if (bg) page.drawRectangle({ x: 0, y: 0, width: pw, height: ph, color: bg });
    if (setup?.watermark) { // (across the page, light, under the text)
      const wm = safe(setup.watermark), ws = Math.min(72, (Math.hypot(pw, ph) * 0.7) / Math.max(1, F.b.widthOfTextAtSize(wm, 1)));
      const tw = F.b.widthOfTextAtSize(wm, ws), a = Math.atan2(ph, pw);
      page.drawText(wm, { x: pw / 2 - (tw / 2) * Math.cos(a) + (ws / 3) * Math.sin(a), y: ph / 2 - (tw / 2) * Math.sin(a) - (ws / 3) * Math.cos(a), size: ws, font: F.b, color: rgb(0.85, 0.85, 0.85), rotate: { type: 'degrees', angle: (a * 180) / Math.PI } });
    }
  };
  newPage();
  const need = (h) => { if (y - h < bottom) newPage(); };

  // ---- runs → lines
  const notes = [];
  const heads = [], tocLinks = []; // headings (their page and place), contents lines to link
  const runsOf = (list = [], base = {}) => list.flatMap((n) => {
    if (n.type === 'hardBreak') return [{ br: true }];
    if (n.type === 'footnote') { notes.push(n.attrs?.note || ''); return [{ text: `[${notes.length}]`, ...base, size: base.size, sup: true }]; }
    if (n.type === 'image') return [{ text: n.attrs?.alt ? `[${n.attrs.alt}]` : '[picture]', ...base, italic: true }];
    const t = n.type === 'text' ? n.text || '' : n.type === 'mention' ? `@${n.attrs?.name || ''}` : n.type === 'datechip' ? dateText(n.attrs?.date) : n.type === 'filechip' ? n.attrs?.name || ''
      : n.type === 'dropchip' ? chipText(n.attrs) : n.type === 'math' ? n.attrs?.latex || '' : n.type === 'citation' ? inText(n.attrs) : null;
    if (t === null) return runsOf(n.content, base);
    const s = { ...base };
    for (const m of n.marks || []) {
      if (m.type === 'bold') s.bold = true; else if (m.type === 'italic') s.italic = true; else if (m.type === 'underline') s.underline = true;
      else if (m.type === 'strike') s.strike = true; else if (m.type === 'code') s.code = true;
      else if (m.type === 'link' && /^(https?:|mailto:)/i.test(m.attrs?.href || '')) s.link = m.attrs.href;
      else if (m.type === 'textStyle') { if (hexRgb(m.attrs?.color)) s.color = hexRgb(m.attrs.color); if (hexRgb(m.attrs?.backgroundColor)) s.bg = hexRgb(m.attrs.backgroundColor); if (ptSize(m.attrs?.fontSize)) s.size = ptSize(m.attrs.fontSize); }
      else if (m.type === 'highlight') s.bg = hexRgb(m.attrs?.color) || rgb(1, 0.95, 0.4);
    }
    return [{ text: safe(t), ...s }];
  });
  /** Lays runs out in lines across `w` points from `x`, drawing them (aligned as asked). */
  const paragraph = (runs, { size = 11, x = left, w = width, align = 'left', gapBefore = 0, gapAfter = 6, lead = 1.35, firstPrefix = null } = {}) => {
    // words (with their style), kept with the spaces after them
    const words = [];
    for (const r of runs) {
      if (r.br) { words.push({ br: true }); continue; }
      for (const part of r.text.split(/(?<=\s)/)) if (part) words.push({ ...r, text: part });
    }
    const lines = [[]];
    let lw = 0;
    const szOf = (wd) => (wd.size || size) * (wd.sup ? 0.7 : 1);
    const wOf = (wd) => fontOf(wd).widthOfTextAtSize(wd.text, szOf(wd));
    for (const wd of words) {
      if (wd.br) { lines.push([]); lw = 0; continue; }
      let ww = wOf(wd);
      if (lw + wOf({ ...wd, text: wd.text.trimEnd() }) > w && lines[lines.length - 1].length) { lines.push([]); lw = 0; }
      // a word longer than the line: cut it
      while (ww > w && wd.text.length > 1) {
        let k = wd.text.length;
        while (k > 1 && fontOf(wd).widthOfTextAtSize(wd.text.slice(0, k), size) > w - lw) k--;
        lines[lines.length - 1].push({ ...wd, text: wd.text.slice(0, k) });
        lines.push([]); lw = 0;
        wd.text = wd.text.slice(k); ww = wOf(wd);
      }
      lines[lines.length - 1].push(wd); lw += ww;
    }
    y -= gapBefore;
    lines.forEach((line, li) => {
      const big = Math.max(size, ...line.map((wd) => wd.size || 0)); // (the line is as tall as its biggest words)
      const h = big * lead;
      need(h);
      y -= big;
      const total = line.reduce((a, wd, k) => a + fontOf(wd).widthOfTextAtSize(k === line.length - 1 ? wd.text.trimEnd() : wd.text, szOf(wd)), 0);
      let cx = x + (align === 'center' ? (w - total) / 2 : align === 'right' ? w - total : 0);
      const spans = [];
      if (li === 0 && firstPrefix) page.drawText(firstPrefix, { x: x - 16, y, size, font: F.r, color: rgb(0.2, 0.2, 0.2) });
      for (const wd of line) {
        const sz = szOf(wd), font = fontOf(wd), tw = font.widthOfTextAtSize(wd.text, sz);
        const color = wd.link ? rgb(0.07, 0.33, 0.8) : wd.color || rgb(0.1, 0.1, 0.1);
        if (wd.bg) page.drawRectangle({ x: cx, y: y - sz * 0.22, width: tw, height: sz * 1.15, color: wd.bg });
        page.drawText(wd.text, { x: cx, y: wd.sup ? y + size * 0.35 : y, size: sz, font, color });
        const tv = font.widthOfTextAtSize(wd.text.trimEnd(), sz);
        if (wd.underline || wd.link) page.drawLine({ start: { x: cx, y: y - 1.5 }, end: { x: cx + tv, y: y - 1.5 }, thickness: 0.6, color });
        if (wd.strike) page.drawLine({ start: { x: cx, y: y + sz * 0.3 }, end: { x: cx + tv, y: y + sz * 0.3 }, thickness: 0.6, color });
        if (wd.link) { // clickable: one area for the words of a link next to each other
          const last = spans[spans.length - 1];
          if (last && last.url === wd.link && Math.abs(last.next - cx) < 0.5) Object.assign(last, { x2: cx + tv, next: cx + tw });
          else spans.push({ url: wd.link, x1: cx, x2: cx + tv, next: cx + tw, y, sz });
        }
        cx += tw;
      }
      for (const sp of spans) {
        const annot = pdf.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [sp.x1, sp.y - 2, sp.x2, sp.y + sp.sz], Border: [0, 0, 0], A: { Type: 'Action', S: 'URI', URI: PDFString.of(sp.url) } });
        const ref = pdf.context.register(annot);
        const annots = page.node.lookup(PDFName.of('Annots'));
        if (annots) annots.push(ref); else page.node.set(PDFName.of('Annots'), pdf.context.obj([ref]));
      }
      y -= h - big;
    });
    y -= gapAfter;
  };

  const pictures = new Map();
  const picture = async (n, x = left, w = width) => {
    const id = n.attrs?.fileId;
    if (!id) return false;
    if (!pictures.has(id)) {
      const got = await pictureData?.(id);
      let img = null;
      try { img = got && /png/.test(got.mime) ? await pdf.embedPng(got.data) : got && /jpe?g/.test(got.mime) ? await pdf.embedJpg(got.data) : null; } catch { img = null; }
      pictures.set(id, img);
    }
    const img = pictures.get(id);
    if (!img) return false;
    const want = Math.min(w, Number(n.attrs?.width) ? Number(n.attrs.width) * 0.75 : img.width * 0.75);
    let iw = want, ih = img.height * (want / img.width);
    const maxH = top - bottom;
    if (ih > maxH) { iw *= maxH / ih; ih = maxH; }
    need(ih + 6);
    y -= ih;
    const ix = n.attrs?.align === 'center' ? x + (w - iw) / 2 : n.attrs?.align === 'right' ? x + w - iw : x;
    page.drawImage(img, { x: ix, y, width: iw, height: ih });
    y -= 8;
    return true;
  };

  const table = (rows, x = left, w = width) => {
    const cols = Math.max(1, ...rows.map((r) => r.length));
    const cw = w / cols, pad = 4, size = 10;
    for (const [ri, r] of rows.entries()) {
      // the row's height: its tallest cell
      const cellLines = r.map((c) => {
        const text = c.text, font = c.head ? F.b : F.r;
        const out = [];
        for (const para of text.split('\n')) {
          let line = '';
          for (const word of para.split(/(?<=\s)/)) {
            if (font.widthOfTextAtSize((line + word).trimEnd(), size) > cw - 2 * pad && line) { out.push(line.trimEnd()); line = ''; }
            line += word;
          }
          out.push(line.trimEnd());
        }
        return { lines: out, font };
      });
      const h = Math.max(...cellLines.map((c) => c.lines.length)) * size * 1.3 + 2 * pad;
      need(h);
      cellLines.forEach((c, ci) => {
        const cx = x + ci * cw;
        if (r[ci]?.head) page.drawRectangle({ x: cx, y: y - h, width: cw, height: h, color: rgb(0.94, 0.95, 0.97) });
        page.drawRectangle({ x: cx, y: y - h, width: cw, height: h, borderColor: rgb(0.6, 0.6, 0.6), borderWidth: 0.5 });
        c.lines.forEach((l, k) => page.drawText(l, { x: cx + pad, y: y - pad - size - k * size * 1.3 + 2, size, font: c.font, color: rgb(0.1, 0.1, 0.1) }));
      });
      y -= h;
      if (ri === rows.length - 1) y -= 8;
    }
  };
  const cellText = (c) => (c.content || []).map((p) => runsOf(p.content || (p.type === 'paragraph' ? [] : [p])).map((r) => (r.br ? '\n' : r.text)).join('')).join('\n');

  const blocks = async (list = [], indent = 0) => {
    for (const n of list) {
      const x = left + indent, w = width - indent;
      const align = ['center', 'right'].includes(n.attrs?.textAlign) ? n.attrs.textAlign : 'left';
      // its own spacing and indent (in half-inch steps)
      const lh = Number(n.attrs?.lineHeight), sb = Number(n.attrs?.spaceBefore), sa = Number(n.attrs?.spaceAfter), ind = Math.min(8, Math.max(0, Number(n.attrs?.indent) || 0)) * 36;
      const look = { ...(lh >= 0.5 && lh <= 4 && { lead: lh * 1.2 }), ...(sb >= 0 && sb <= 200 && n.attrs?.spaceBefore != null && { gapBefore: sb }), ...(sa >= 0 && sa <= 200 && n.attrs?.spaceAfter != null && { gapAfter: sa }) };
      if (n.type === 'paragraph') paragraph(runsOf(n.content), { x: x + ind, w: w - ind, align, size: BASE, ...look });
      else if (n.type === 'heading') { const lv = Math.min(6, n.attrs?.level || 1); heads.push({ level: lv, text: (function words(l) { return (l || []).map((c) => (c.type === 'text' ? c.text || '' : words(c.content))).join(''); })(n.content).trim(), page: null, y: null }); const hd = heads[heads.length - 1]; need(HEAD[lv] * 1.25 + (lv <= 2 ? 10 : 6)); hd.page = pages.length - 1; hd.y = y; paragraph(runsOf(n.content, { bold: true }), { x: x + ind, w: w - ind, align, size: HEAD[lv], gapBefore: lv <= 2 ? 10 : 6, gapAfter: 6, lead: 1.25, ...look }); }
      else if (n.type === 'bulletList' || n.type === 'orderedList' || n.type === 'taskList') {
        for (const [k, li] of (n.content || []).entries()) {
          const mark = n.type === 'bulletList' ? '•' : n.type === 'taskList' ? (li.attrs?.checked ? '[x]' : '[ ]') : `${(n.attrs?.start || 1) + k}.`;
          const [first, ...more] = li.content || [];
          paragraph(runsOf(first?.content), { x: x + 18, w: w - 18, gapAfter: 3, firstPrefix: mark, size: BASE });
          await blocks(more, indent + 18);
        }
        y -= 3;
      } else if (n.type === 'blockquote') {
        const top0 = y, p0 = page;
        await blocks(n.content, indent + 16);
        if (page === p0) page.drawLine({ start: { x: x + 4, y: top0 - 2 }, end: { x: x + 4, y: y + 6 }, thickness: 2, color: rgb(0.75, 0.75, 0.75) });
      } else if (n.type === 'codeBlock') {
        for (const line of (n.content || []).map((c) => c.text).join('').split('\n')) paragraph([{ text: safe(line) || ' ', code: true }], { x: x + 6, w: w - 6, size: 9.5, gapAfter: 0, lead: 1.3 });
        y -= 6;
      } else if (n.type === 'horizontalRule') { need(12); y -= 6; page.drawLine({ start: { x, y }, end: { x: right, y }, thickness: 0.7, color: rgb(0.7, 0.7, 0.7) }); y -= 6; }
      else if (n.type === 'image') { if (!(await picture(n, x, w))) paragraph(runsOf([n]), { x, w }); }
      else if (n.type === 'table') table((n.content || []).map((r) => (r.content || []).map((c) => ({ text: cellText(c), head: c.type === 'tableHeader' }))), x, w);
      else if (n.type === 'sheetChart') { const { title: ct, rows } = chartTable(n.attrs); paragraph([{ text: safe(ct), bold: true }], { x, w }); if (rows.length) table(rows.map((r, i) => r.map((v) => ({ text: safe(v), head: i === 0 }))), x, w); }
      else if (n.type === 'references') { paragraph([{ text: 'References', bold: true }], { x, w, size: HEAD[2], gapBefore: 10 }); for (const s of sourcesOf(doc)) paragraph(reference(s).map((p) => ({ text: safe(p.text), italic: !!p.italic })), { x, w }); }
      else if (n.type === 'pageBreak') { if (y < top) newPage(); }
      else if (n.type === 'tableOfContents') {
        // Contents: each heading, indented by level, its page on the right, the line a link to it.
        const list = (function all(l, acc = []) { for (const m of l || []) { if (m.type === 'heading') acc.push(m); else if (m.content && m.type !== 'table') all(m.content, acc); } return acc; })(doc?.content);
        if (!list.length) continue;
        paragraph([{ text: 'Contents', bold: true }], { x, w, size: HEAD[3], gapAfter: 4 });
        list.forEach((hd, k) => {
          const lv = Math.min(6, hd.attrs?.level || 1), dx = (lv - 1) * 14, size = BASE;
          need(size * 1.5);
          y -= size;
          const num = knownPages?.[k] != null ? String(knownPages[k] + 1) : '';
          const nw = F.r.widthOfTextAtSize(num, size);
          let label = safe(runsOf(hd.content).map((r) => r.text || '').join('').trim());
          while (label.length > 1 && F.r.widthOfTextAtSize(`${label} …`, size) > w - dx - nw - 20) label = label.slice(0, -1);
          if (label !== safe(runsOf(hd.content).map((r) => r.text || '').join('').trim())) label += '…';
          page.drawText(label, { x: x + dx, y, size, font: F.r, color: rgb(0.1, 0.1, 0.1) });
          const lw = F.r.widthOfTextAtSize(label, size);
          const dots = '.'.repeat(Math.max(0, Math.floor((w - dx - lw - nw - 12) / F.r.widthOfTextAtSize('.', size))));
          page.drawText(dots, { x: x + dx + lw + 6, y, size, font: F.r, color: rgb(0.6, 0.6, 0.6) });
          page.drawText(num, { x: x + w - nw, y, size, font: F.r, color: rgb(0.1, 0.1, 0.1) });
          tocLinks.push({ page, rect: [x + dx, y - 2, x + w, y + size], k });
          y -= size * 0.5;
        });
        y -= 8;
      }
      else if (n.content) await blocks(n.content, indent);
    }
  };
  await blocks(doc?.content || []);
  // Contents lines: links to their headings' places.
  for (const t of tocLinks) {
    const hd = heads[t.k];
    if (!hd || hd.page == null) continue;
    const annot = pdf.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: t.rect, Border: [0, 0, 0], Dest: [pages[hd.page].ref, PDFName.of('XYZ'), left, hd.y, null] });
    const ref = pdf.context.register(annot);
    const annots = t.page.node.lookup(PDFName.of('Annots'));
    if (annots) annots.push(ref); else t.page.node.set(PDFName.of('Annots'), pdf.context.obj([ref]));
  }
  // Bookmarks: the headings, nested by level.
  const placed = heads.filter((hd) => hd.page != null && hd.text);
  if (placed.length) {
    const root = { kids: [], level: 0 }, stack = [root];
    for (const hd of placed) {
      while (stack.length > 1 && stack[stack.length - 1].level >= hd.level) stack.pop();
      const node = { ...hd, kids: [] };
      stack[stack.length - 1].kids.push(node);
      stack.push(node);
    }
    const outlinesRef = pdf.context.nextRef();
    const build = (node, parentRef) => {
      const refs = node.kids.map(() => pdf.context.nextRef());
      node.kids.forEach((kid, i) => {
        const dict = { Title: PDFHexString.fromText(kid.text.slice(0, 200)), Parent: parentRef, Dest: [pages[kid.page].ref, PDFName.of('XYZ'), left, kid.y, null] };
        if (i > 0) dict.Prev = refs[i - 1];
        if (i < refs.length - 1) dict.Next = refs[i + 1];
        const sub = build(kid, refs[i]);
        if (sub.count) Object.assign(dict, { First: sub.first, Last: sub.last, Count: sub.count });
        pdf.context.assign(refs[i], pdf.context.obj(dict));
      });
      return { first: refs[0], last: refs[refs.length - 1], count: node.kids.reduce((a, k) => a + 1 + countOf(k), 0) };
    };
    const countOf = (n) => n.kids.reduce((a, k) => a + 1 + countOf(k), 0);
    const top = build(root, outlinesRef);
    pdf.context.assign(outlinesRef, pdf.context.obj({ Type: 'Outlines', First: top.first, Last: top.last, Count: top.count }));
    pdf.catalog.set(PDFName.of('Outlines'), outlinesRef);
    pdf.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));
  }
  if (notes.length) {
    need(30); y -= 8; page.drawLine({ start: { x: left, y }, end: { x: left + 120, y }, thickness: 0.6, color: rgb(0.6, 0.6, 0.6) }); y -= 4;
    notes.forEach((t, k) => paragraph([{ text: `${k + 1}. ${safe(t)}` }], { size: 9, gapAfter: 2 }));
  }
  // Header, footer and page numbers on every page.
  const small = 9;
  pages.forEach((p, k) => {
    const c = rgb(0.4, 0.4, 0.4);
    if (setup?.header) p.drawText(safe(setup.header).slice(0, 200), { x: left, y: ph - margin / 2, size: small, font: F.r, color: c });
    if (setup?.footer) p.drawText(safe(setup.footer).slice(0, 200), { x: left, y: margin / 2, size: small, font: F.r, color: c });
    if (setup?.numbers) { const t = `${k + 1}`; p.drawText(t, { x: right - F.r.widthOfTextAtSize(t, small), y: margin / 2, size: small, font: F.r, color: c }); }
  });
  return { pdf, heads };
}

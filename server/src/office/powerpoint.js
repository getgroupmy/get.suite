// PowerPoint files <-> Slides: slide by slide, text boxes (with size, bold, italic, colour,
// alignment), rectangles, rounded rectangles and ellipses, pictures, and slide backgrounds, at their
// places on the slide. Boxes are kept in percent of the slide, as Slides does.
import JSZip from 'jszip';
import path from 'node:path';
import PptxGenJS from 'pptxgenjs';
import { parseXml, elements } from '../davxml.js';

const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const THEMES = { light: { bg: '#ffffff', text: '#202124', accent: '#1a73e8' }, dark: { bg: '#202124', text: '#f1f3f4', accent: '#8ab4f8' }, ocean: { bg: '#0b57d0', text: '#ffffff', accent: '#ffd666' }, sand: { bg: '#f7f1e3', text: '#3c2f1e', accent: '#b5651d' } };
const SHAPES = { rect: 'rect', roundRect: 'round', ellipse: 'ellipse' };

const kids = (el, ns, local) => elements(el).filter((e) => e.ns === ns && e.local === local);
const kid = (el, ns, local) => kids(el, ns, local)[0];
const deep = (el, ns, local) => { const out = []; const walk = (e) => { for (const c of elements(e)) { if (c.ns === ns && c.local === local) out.push(c); walk(c); } }; if (el) walk(el); return out; };
const attr = (el, name) => el?.attrs?.[`{}${name}`];
const rattr = (el, name) => el?.attrs?.[`{${R}}${name}`];
const id = () => Math.random().toString(36).slice(2, 10);
const relsOf = async (zip, file) => {
  const x = await zip.file(path.posix.join(path.posix.dirname(file), '_rels', `${path.posix.basename(file)}.rels`))?.async('string');
  const doc = x && parseXml(x);
  return new Map((doc ? kids(doc, RELS, 'Relationship') : []).map((r) => [attr(r, 'Id'), path.posix.normalize(path.posix.join(path.posix.dirname(file), attr(r, 'Target')))]));
};
const colorIn = (el) => { const c = deep(el, A, 'srgbClr')[0]; return c ? `#${attr(c, 'val').toLowerCase()}` : null; };

/** Seconds a slide stays before moving on by itself (1 to 3600), or null. */
export function advanceOf(v) {
  const n = Number(v);
  if (v === null || v === undefined || v === '' || !Number.isFinite(n) || n <= 0) return null;
  return Math.min(3600, Math.max(1, Math.round(n / 1000)));
}

const TRANSITION_XML = { fade: '<p:fade/>', push: '<p:push dir="u"/>', zoom: '<p:zoom/>' };

/**
 * What PowerPoint's file writer leaves out: each slide's transition and automatic advance
 * (<p:transition advTm="…">, after the slide's colour mapping), and looping (<p:showPr loop="1">).
 */
async function withShowSettings(buffer, deck) {
  const slides = deck.slides || [];
  if (!deck.loop && !slides.some((s) => s.transition || s.advance)) return buffer;
  const zip = await JSZip.loadAsync(buffer);
  for (let i = 0; i < slides.length; i++) {
    const s = slides[i];
    const secs = Number(s.advance) > 0 ? Math.min(3600, Math.round(Number(s.advance))) : 0;
    if (!s.transition && !secs) continue;
    const file = `ppt/slides/slide${i + 1}.xml`;
    const xml = await zip.file(file)?.async('string');
    if (!xml) continue;
    const el = `<p:transition spd="med"${secs ? ` advTm="${secs * 1000}"` : ''}>${TRANSITION_XML[s.transition] || ''}</p:transition>`;
    zip.file(file, xml.includes('</p:clrMapOvr>') ? xml.replace('</p:clrMapOvr>', `</p:clrMapOvr>${el}`) : xml.replace('</p:sld>', `${el}</p:sld>`));
  }
  if (deck.loop) {
    const props = await zip.file('ppt/presProps.xml')?.async('string');
    if (props) {
      const show = '<p:showPr loop="1" showNarration="1"><p:present/><p:sldAll/><p:penClr><a:prstClr val="red"/></p:penClr></p:showPr>';
      zip.file('ppt/presProps.xml', props.replace(/<p:presentationPr([^>]*)\/>/, `<p:presentationPr$1>${show}</p:presentationPr>`).replace(/<p:presentationPr([^>]*[^/])>(?!<p:showPr)/, `<p:presentationPr$1>${show}`));
    }
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/**
 * A PowerPoint file as a Slides presentation. `savePicture(name, buffer, mime)` stores a picture
 * (in Drive) and returns its file id.
 */
export async function deckFromPowerPoint(buffer, { savePicture }) {
  const zip = await JSZip.loadAsync(buffer);
  const pres = parseXml(await zip.file('ppt/presentation.xml').async('string'));
  const size = kid(pres, P, 'sldSz');
  const W = Number(attr(size, 'cx')) || 12192000, H = Number(attr(size, 'cy')) || 6858000;
  const widthIn = W / 914400;
  const presRels = await relsOf(zip, 'ppt/presentation.xml');
  const order = kids(kid(pres, P, 'sldIdLst'), P, 'sldId').map((s) => presRels.get(rattr(s, 'id'))).filter(Boolean);
  const slides = [];
  const numbered = new Set(); // slides with a slide number field
  for (const file of order) {
    const xml = parseXml(await zip.file(file)?.async('string') || '');
    if (!xml) continue;
    const rels = await relsOf(zip, file);
    // Placeholders without their own position take it from the slide's layout.
    const layoutFile = [...rels.values()].find((t) => t.includes('slideLayouts/'));
    const layout = layoutFile ? parseXml(await zip.file(layoutFile)?.async('string') || '') : null;
    const layoutBoxes = new Map(deep(layout, P, 'sp').map((sp) => { const ph = deep(sp, P, 'ph')[0]; return [ph ? `${attr(ph, 'type') || 'body'}:${attr(ph, 'idx') || ''}` : null, deep(sp, A, 'xfrm')[0]]; }).filter(([k, x]) => k && x));
    const boxOf = (el) => {
      let xf = deep(kid(el, P, 'spPr'), A, 'xfrm')[0];
      if (!xf) { const ph = deep(el, P, 'ph')[0]; if (ph) xf = layoutBoxes.get(`${attr(ph, 'type') || 'body'}:${attr(ph, 'idx') || ''}`) || [...layoutBoxes.entries()].find(([k]) => k.startsWith(`${attr(ph, 'type') || 'body'}:`))?.[1]; }
      const off = kid(xf, A, 'off'), ext = kid(xf, A, 'ext');
      if (!off || !ext) return null;
      return { x: (Number(attr(off, 'x')) / W) * 100, y: (Number(attr(off, 'y')) / H) * 100, w: (Number(attr(ext, 'cx')) / W) * 100, h: (Number(attr(ext, 'cy')) / H) * 100 };
    };
    const items = [];
    const tree = deep(xml, P, 'spTree')[0];
    for (const el of deep(tree, P, 'sp').concat(deep(tree, P, 'cxnSp'), deep(tree, P, 'pic'))) { // shapes, connectors (lines, arrows), pictures
      const box = boxOf(el);
      if (!box) continue;
      if (el.local === 'pic') {
        const embed = rattr(deep(el, A, 'blip')[0], 'embed');
        const target = embed && rels.get(embed);
        const data = target && await zip.file(target)?.async('nodebuffer');
        const ext = target ? path.posix.extname(target).slice(1).toLowerCase() : '';
        const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp' }[ext];
        // Its description for screen readers (PowerPoint's Alt Text), when it has one.
        // (Some programs write the picture's own data or file path there instead: not a description.)
        const raw = String(attr(deep(el, P, 'cNvPr')[0], 'descr') || '').replace(/\s+/g, ' ').trim();
        const descr = /^(data:|[a-z]:\\|\/|file:|preencoded\.\w+$)/i.test(raw) ? '' : raw.slice(0, 500);
        if (data && mime) items.push({ id: id(), type: 'image', fileId: await savePicture(path.posix.basename(target), data, mime), name: path.posix.basename(target), ...(descr && { alt: descr }), ...box });
        continue;
      }
      // A slide number field: the presentation numbers its slides (not a text box of its own).
      if (deep(el, A, 'fld').some((f) => attr(f, 'type') === 'slidenum')) { numbered.add(slides.length); continue; }
      const paras = deep(el, A, 'p');
      const texts = paras.map((p) => deep(p, A, 't').map((t) => t.text).join(''));
      const content = texts.join('\n').replace(/\n+$/, '');
      const geom = attr(deep(kid(el, P, 'spPr'), A, 'prstGeom')[0], 'prst');
      if (geom === 'line' || geom === 'straightConnector1') {
        const ln = deep(kid(el, P, 'spPr'), A, 'ln')[0];
        const xf = deep(kid(el, P, 'spPr'), A, 'xfrm')[0];
        const flipH = attr(xf, 'flipH') === '1', flipV = attr(xf, 'flipV') === '1';
        const arrow = !!deep(ln, A, 'tailEnd').find((t) => attr(t, 'type') && attr(t, 'type') !== 'none');
        const flat = box.h < 0.5, tall = box.w < 0.5;
        const dir = flat ? (flipH ? 'hr' : 'h') : tall ? (flipV ? 'vr' : 'v') : flipV !== flipH ? 'u' : 'd';
        const lineColor = colorIn(kid(ln, A, 'solidFill'));
        items.push({ id: id(), type: 'shape', shape: arrow ? 'arrow' : 'line', dir, fill: lineColor || 'text', ...box,
          ...(flat && { y: box.y - 4, h: 8 }), ...(tall && { x: box.x - 2, w: 4 }) });
        continue;
      }
      const fill = colorIn(kid(kid(el, P, 'spPr'), A, 'solidFill'));
      if (!content.trim()) {
        if (SHAPES[geom] && fill) items.push({ id: id(), type: 'shape', shape: SHAPES[geom], fill, ...box });
        continue;
      }
      const rPr = deep(el, A, 'rPr')[0] || deep(el, A, 'defRPr')[0];
      const pt = Number(attr(rPr, 'sz')) / 100 || 18;
      const algn = attr(deep(el, A, 'pPr')[0], 'algn');
      const ph = attr(deep(el, P, 'ph')[0], 'type');
      items.push({
        id: id(), type: 'text', role: ph === 'title' || ph === 'ctrTitle' ? 'title' : ph === 'subTitle' ? 'subtitle' : 'body', text: content, ...box,
        size: Math.max(8, Math.round((pt / 72) * 1000 / widthIn)),
        ...(attr(rPr, 'b') === '1' && { bold: true }), ...(attr(rPr, 'i') === '1' && { italic: true }),
        ...(colorIn(kid(rPr, A, 'solidFill')) && { color: colorIn(kid(rPr, A, 'solidFill')) }),
        ...({ ctr: { align: 'center' }, r: { align: 'right' } }[algn] || {}),
      });
    }
    // Tables: each cell's text (the first row as headings when PowerPoint marks it so).
    for (const gf of deep(tree, P, 'graphicFrame')) {
      const tbl = deep(gf, A, 'tbl')[0];
      const xf = kid(gf, P, 'xfrm'), off = kid(xf, A, 'off'), ext = kid(xf, A, 'ext');
      if (!tbl || !off || !ext) continue;
      const cells = kids(tbl, A, 'tr').map((tr) => kids(tr, A, 'tc').map((tc) => deep(tc, A, 'p').map((p) => deep(p, A, 't').map((t) => t.text).join('')).join('\n')));
      if (!cells.length || !cells[0].length) continue;
      const cols = Math.max(...cells.map((r) => r.length));
      const rPr = deep(tbl, A, 'rPr')[0];
      const pt = Number(attr(rPr, 'sz')) / 100 || 14;
      items.push({ id: id(), type: 'table', cells: cells.map((r) => [...r, ...Array(cols - r.length).fill('')]).slice(0, 20).map((r) => r.slice(0, 10)),
        header: attr(kid(tbl, A, 'tblPr'), 'firstRow') === '1' || kids(kids(tbl, A, 'tr')[0], A, 'tc').every((tc) => deep(tc, A, 'rPr').some((r) => attr(r, 'b') === '1')), size: Math.max(8, Math.round((pt / 72) * 1000 / widthIn)),
        x: (Number(attr(off, 'x')) / W) * 100, y: (Number(attr(off, 'y')) / H) * 100, w: (Number(attr(ext, 'cx')) / W) * 100, h: (Number(attr(ext, 'cy')) / H) * 100 });
    }
    const bg = colorIn(deep(xml, P, 'bg')[0]);
    // Speaker notes: the body text of the slide's notes page.
    const notesFile = [...rels.values()].find((t) => t.includes('notesSlides/'));
    const notesXml = notesFile && parseXml(await zip.file(notesFile)?.async('string') || '');
    const body = notesXml && deep(notesXml, P, 'sp').find((sp) => attr(deep(sp, P, 'ph')[0], 'type') === 'body');
    const notes = body ? deep(body, A, 'p').map((para) => deep(para, A, 't').map((t) => t.text).join('')).join('\n').replace(/\r\n?/g, '\n').trim().slice(0, 20000) : '';
    // Hidden slides (show="0") are skipped when presenting; transitions map to the nearest one Slides has.
    const skip = attr(xml, 'show') === '0';
    const trEl = deep(xml, P, 'transition')[0] || null;
    const tr = elements(trEl)[0]?.local;
    const advance = advanceOf(attr(trEl, 'advTm')); // moves on by itself after so many seconds
    const transition = tr && ({ fade: 'fade', dissolve: 'fade', push: 'push', wipe: 'push', cover: 'push', pull: 'push', split: 'push', zoom: 'zoom', newsflash: 'zoom' }[tr] || 'fade');
    slides.push({ id: id(), items, ...(bg && { bg }), ...(notes && { notes }), ...(transition && { transition }), ...(advance && { advance }), ...(skip && { skip: true }) });
  }
  // "Loop until Esc" in the file's slide show settings.
  const props = parseXml(await zip.file('ppt/presProps.xml')?.async('string') || '');
  const loop = !!props && ['1', 'true'].includes(attr(deep(props, P, 'showPr')[0] || null, 'loop'));
  // Numbered slides: all of them, or all but the first.
  const numbers = !numbered.size ? null : numbered.size >= slides.length ? true : numbered.size === slides.length - 1 && !numbered.has(0) ? 'skip-first' : true;
  return { theme: 'light', ...(numbers && { numbers }), ...(loop && { loop: true }), slides: slides.length ? slides : [{ id: id(), items: [] }] };
}

/**
 * A Slides presentation as a PowerPoint file (Buffer). `pictureData(fileId)` gives a picture's
 * bytes and type ({ data, mime }) or null.
 */
/** Does slide i show its number? deck.numbers: true (every slide) or 'skip-first' (all but the title slide). */
export const numberShown = (deck, i) => !!deck?.numbers && !(deck.numbers === 'skip-first' && i === 0);

export async function powerPointFromDeck(deck, { pictureData, title = 'Presentation' } = {}) {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE'; // 13.33 × 7.5 in, 16:9 like Slides
  pptx.title = title;
  const Win = 13.333, Hin = 7.5;
  const theme = THEMES[deck.theme] || THEMES.light;
  const color = (v, fallback) => (v === 'accent' ? theme.accent : v === 'text' ? theme.text : v || fallback).replace('#', '').toUpperCase();
  for (const s of deck.slides || []) {
    const slide = pptx.addSlide();
    slide.background = { color: color(s.bg, theme.bg) };
    if (s.notes) slide.addNotes(s.notes);
    if (numberShown(deck, (deck.slides || []).indexOf(s))) slide.slideNumber = { x: Win - 1.1, y: Hin - 0.55, w: 0.8, h: 0.35, fontSize: 12, color: color('text', theme.text), align: 'right', fontFace: 'Arial' };
    if (s.skip) slide.hidden = true; // (transitions and timings are added afterwards: withShowSettings)
    for (const it of s.items || []) {
      const pos = { x: (it.x / 100) * Win, y: (it.y / 100) * Hin, w: (it.w / 100) * Win, h: (it.h / 100) * Hin };
      if (it.type === 'text') {
        slide.addText(it.text || '', { ...pos, fontSize: Math.round((it.size || 24) * Win * 72 / 1000), bold: !!it.bold, italic: !!it.italic,
          color: color(it.color, theme.text), align: it.align || 'left', valign: 'top', margin: 0, fontFace: 'Arial' });
      } else if (it.type === 'shape' && (it.shape === 'line' || it.shape === 'arrow')) {
        // A line from one side (or corner) of its box to the other; arrows end in a triangle.
        const d = it.dir || 'h';
        const at = d === 'h' || d === 'hr' ? { ...pos, y: pos.y + pos.h / 2, h: 0 } : d === 'v' || d === 'vr' ? { ...pos, x: pos.x + pos.w / 2, w: 0 } : pos;
        slide.addShape(pptx.ShapeType.line, { ...at, flipH: d === 'hr', flipV: d === 'u' || d === 'vr',
          line: { color: color(it.fill || 'text', theme.text), width: 3, ...(it.shape === 'arrow' && { endArrowType: 'triangle' }) } });
      } else if (it.type === 'shape') {
        slide.addShape({ rect: pptx.ShapeType.rect, round: pptx.ShapeType.roundRect, ellipse: pptx.ShapeType.ellipse }[it.shape] || pptx.ShapeType.rect, { ...pos, fill: { color: color(it.fill || 'accent', theme.accent) }, line: { type: 'none' } });
      } else if (it.type === 'table' && it.cells?.length) {
        const fontSize = Math.round((it.size || 18) * Win * 72 / 1000);
        const rows = it.cells.map((r, ri) => r.map((text) => ({ text: String(text ?? ''), options: { fontSize, color: color(null, theme.text), fontFace: 'Arial',
          ...(it.header && ri === 0 && { bold: true, fill: { color: color('accent', theme.accent) }, color: color(theme.bg, theme.bg) }) } })));
        slide.addTable(rows, { ...pos, colW: Array(it.cells[0].length).fill(pos.w / it.cells[0].length), border: { type: 'solid', pt: 1, color: color(null, theme.text) }, valign: 'middle', autoPage: false });
      } else if (it.type === 'chart' && it.data?.series?.length) {
        // A chart from a spreadsheet: a real PowerPoint chart, with the figures the slide keeps.
        const kind = { column: pptx.ChartType.bar, bar: pptx.ChartType.bar, line: pptx.ChartType.line, pie: pptx.ChartType.pie }[it.chartType] || pptx.ChartType.bar;
        const labels = (it.data.categories || []).map(String);
        const series = (it.chartType === 'pie' ? it.data.series.slice(0, 1) : it.data.series).map((x) => ({ name: String(x.name || ''), labels, values: (x.values || []).map((v) => (typeof v === 'number' ? v : 0)) }));
        slide.addChart(kind, series, { ...pos, barDir: it.chartType === 'bar' ? 'bar' : 'col', showLegend: series.length > 1 || it.chartType === 'pie', legendPos: 'b',
          ...(it.title && { showTitle: true, title: String(it.title), titleFontSize: 14 }) });
      } else if (it.type === 'image') {
        const pic = await pictureData?.(it.fileId);
        // Alt Text: its description (a blank one when it has none: left empty, the library would write a made-up file name).
        if (pic) slide.addImage({ ...pos, data: `data:${pic.mime};base64,${pic.data.toString('base64')}`, altText: String(it.alt || ' ').slice(0, 500) });
      } else if (it.type === 'video') {
        // A video plays in PowerPoint too (up to 100 MB; a bigger one is named instead, so the file stays manageable).
        const vid = await pictureData?.(it.fileId);
        if (vid && /^video\//.test(vid.mime) && vid.data.length <= 100 * 1024 * 1024) {
          const extn = { 'video/quicktime': 'mov', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/ogg': 'ogv' }[vid.mime] || 'mp4';
          slide.addMedia({ ...pos, type: 'video', data: `${vid.mime};base64,${vid.data.toString('base64')}`, extn });
        } else slide.addText(`▶ ${it.name || 'Video'}`, { ...pos, fontSize: 18, align: 'center', valign: 'middle', color: '5F6368', fill: { color: 'F1F3F4' } });
      }
    }
  }
  return withShowSettings(Buffer.from(await pptx.write({ outputType: 'nodebuffer' })), deck);
}

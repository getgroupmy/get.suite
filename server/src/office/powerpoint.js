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
    for (const el of deep(tree, P, 'sp').concat(deep(tree, P, 'pic'))) {
      const box = boxOf(el);
      if (!box) continue;
      if (el.local === 'pic') {
        const embed = rattr(deep(el, A, 'blip')[0], 'embed');
        const target = embed && rels.get(embed);
        const data = target && await zip.file(target)?.async('nodebuffer');
        const ext = target ? path.posix.extname(target).slice(1).toLowerCase() : '';
        const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp' }[ext];
        if (data && mime) items.push({ id: id(), type: 'image', fileId: await savePicture(path.posix.basename(target), data, mime), name: path.posix.basename(target), ...box });
        continue;
      }
      const paras = deep(el, A, 'p');
      const texts = paras.map((p) => deep(p, A, 't').map((t) => t.text).join(''));
      const content = texts.join('\n').replace(/\n+$/, '');
      const geom = attr(deep(kid(el, P, 'spPr'), A, 'prstGeom')[0], 'prst');
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
    const bg = colorIn(deep(xml, P, 'bg')[0]);
    // Speaker notes: the body text of the slide's notes page.
    const notesFile = [...rels.values()].find((t) => t.includes('notesSlides/'));
    const notesXml = notesFile && parseXml(await zip.file(notesFile)?.async('string') || '');
    const body = notesXml && deep(notesXml, P, 'sp').find((sp) => attr(deep(sp, P, 'ph')[0], 'type') === 'body');
    const notes = body ? deep(body, A, 'p').map((para) => deep(para, A, 't').map((t) => t.text).join('')).join('\n').replace(/\r\n?/g, '\n').trim().slice(0, 20000) : '';
    slides.push({ id: id(), items, ...(bg && { bg }), ...(notes && { notes }) });
  }
  return { theme: 'light', slides: slides.length ? slides : [{ id: id(), items: [] }] };
}

/**
 * A Slides presentation as a PowerPoint file (Buffer). `pictureData(fileId)` gives a picture's
 * bytes and type ({ data, mime }) or null.
 */
export async function powerPointFromDeck(deck, { pictureData, title = 'Presentation' } = {}) {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE'; // 13.33 × 7.5 in, 16:9 like Slides
  pptx.title = title;
  const Win = 13.333, Hin = 7.5;
  const theme = THEMES[deck.theme] || THEMES.light;
  const color = (v, fallback) => (v === 'accent' ? theme.accent : v || fallback).replace('#', '').toUpperCase();
  for (const s of deck.slides || []) {
    const slide = pptx.addSlide();
    slide.background = { color: color(s.bg, theme.bg) };
    if (s.notes) slide.addNotes(s.notes);
    for (const it of s.items || []) {
      const pos = { x: (it.x / 100) * Win, y: (it.y / 100) * Hin, w: (it.w / 100) * Win, h: (it.h / 100) * Hin };
      if (it.type === 'text') {
        slide.addText(it.text || '', { ...pos, fontSize: Math.round((it.size || 24) * Win * 72 / 1000), bold: !!it.bold, italic: !!it.italic,
          color: color(it.color, theme.text), align: it.align || 'left', valign: 'top', margin: 0, fontFace: 'Arial' });
      } else if (it.type === 'shape') {
        slide.addShape({ rect: pptx.ShapeType.rect, round: pptx.ShapeType.roundRect, ellipse: pptx.ShapeType.ellipse }[it.shape] || pptx.ShapeType.rect, { ...pos, fill: { color: color(it.fill || 'accent', theme.accent) }, line: { type: 'none' } });
      } else if (it.type === 'image') {
        const pic = await pictureData?.(it.fileId);
        if (pic) slide.addImage({ ...pos, data: `data:${pic.mime};base64,${pic.data.toString('base64')}` });
      }
    }
  }
  return Buffer.from(await pptx.write({ outputType: 'nodebuffer' }));
}

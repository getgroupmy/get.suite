// OpenDocument presentations (.odp, LibreOffice Impress's own format), both ways: every slide with its
// background (colour or picture), text boxes (size, bold, italic, colour, alignment, fill, outline, a link),
// shapes (rectangles, rounded ones, ellipses, triangles, diamonds, block arrows, chevrons, stars, callouts,
// lines and arrows) with their text, tables, pictures (with alt text), turned boxes, speaker notes and hidden
// slides. Charts go out as a table of their figures; videos as their name.
import JSZip from 'jszip';
import { parseDocument } from 'htmlparser2';
import { themeOfDeck } from './powerpoint.js';

/** Boxes of the same group (two or more) wrapped in one <draw:g>, where the first of them was. */
export function groupedXml(xml, pieces) {
  const count = new Map();
  for (const p of pieces) if (p.it.group && p.end > p.start) count.set(p.it.group, (count.get(p.it.group) || 0) + 1);
  const done = new Set();
  let out = '';
  for (const p of pieces) {
    const g = p.it.group;
    if (!g || (count.get(g) || 0) < 2) { out += xml.slice(p.start, p.end); continue; }
    if (done.has(g)) continue;
    done.add(g);
    out += `<draw:g>${pieces.filter((q) => q.it.group === g).map((q) => xml.slice(q.start, q.end)).join('')}</draw:g>`;
  }
  return out;
}

export const ODP_MIME = 'application/vnd.oasis.opendocument.presentation';
const x = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const COLOR = /^#[0-9a-f]{6}$/i;
const W = 28, H = 15.75; // cm, 16:9 like Slides
const cm = (n) => `${Number(n).toFixed(3)}cm`;
const ODP_SHAPES = { rect: 'rectangle', round: 'round-rectangle', ellipse: 'ellipse', triangle: 'isosceles-triangle', diamond: 'diamond', arrowblock: 'right-arrow', chevron: 'chevron', star: 'star5', callout: 'round-rectangular-callout' };
const OUR_SHAPES = Object.fromEntries(Object.entries(ODP_SHAPES).map(([a, b]) => [b, a]));
const OUTLINES = [1, 2, 4, 6];
/** Font size in points for a box's size (Slides keeps it relative to the slide's width). */
const ptOf = (size) => (size * (W / 2.54) * 72) / 1000;
const sizeOf = (pt, widthCm = W) => Math.round(((pt * 1000) / ((widthCm / 2.54) * 72)) * 10) / 10;

// ---- deck → .odp ----
export async function odpFromDeck(deck, { pictureData, title = 'Presentation' } = {}) {
  const theme = themeOfDeck(deck);
  const color = (v, fallback) => { const c = v === 'accent' ? theme.accent : v === 'text' ? theme.text : v === 'bg' ? theme.bg : v; return COLOR.test(c || '') ? c.toLowerCase() : fallback; };
  const font = theme.font || 'Liberation Sans';
  const auto = [], pictures = [], fillImages = [];
  let n = 0;
  const style = (family, inner, attrs = '') => { const name = `${family[0]}${++n}`; auto.push(`<style:style style:name="${name}" style:family="${family}"${attrs}>${inner}</style:style>`); return name; };
  const picPath = new Map();
  const picture = async (id) => {
    if (!id) return null;
    if (picPath.has(id)) return picPath.get(id);
    const got = await pictureData?.(id);
    if (!got || !/^image\/(png|jpeg|gif|svg\+xml|webp)$/.test(got.mime)) { picPath.set(id, null); return null; }
    const path = `Pictures/${pictures.length + 1}.${got.mime.split('/')[1].replace('jpeg', 'jpg').replace('svg+xml', 'svg')}`;
    pictures.push({ path, data: got.data, mime: got.mime });
    picPath.set(id, path);
    return path;
  };
  // Where a box goes: its corner, or (turned) a transform turning it about its centre, as Impress writes it.
  const place = (it) => {
    const w = (it.w / 100) * W, h = (it.h / 100) * H, xx = (it.x / 100) * W, yy = (it.y / 100) * H;
    const deg = ((Number(it.rot) || 0) % 360 + 360) % 360;
    if (!deg) return `svg:x="${cm(xx)}" svg:y="${cm(yy)}" svg:width="${cm(w)}" svg:height="${cm(h)}"`;
    const t = (deg * Math.PI) / 180, cx = xx + w / 2, cy = yy + h / 2;
    const tx = cx - (w / 2 * Math.cos(t) - h / 2 * Math.sin(t)), ty = cy - (w / 2 * Math.sin(t) + h / 2 * Math.cos(t));
    return `svg:width="${cm(w)}" svg:height="${cm(h)}" draw:transform="rotate(${(-t).toFixed(6)}) translate(${cm(tx)} ${cm(ty)})"`;
  };
  const textStyle = (it, fallbackColor, defSize) => style('text', `<style:text-properties fo:font-size="${(Math.round(ptOf(it.size || defSize) * 10) / 10)}pt" style:font-name="${x(font)}" fo:font-family="'${x(font)}'"${it.bold ? ' fo:font-weight="bold"' : ''}${it.italic ? ' fo:font-style="italic"' : ''} fo:color="${color(it.color, fallbackColor)}"/>`);
  const paraStyle = (align) => style('paragraph', `<style:paragraph-properties fo:text-align="${{ center: 'center', right: 'end', justify: 'justify' }[align] || 'start'}"/>`);
  const paras = (text, ts, ps, href) => String(text ?? '').split('\n').map((l) => {
    const words = href ? `<text:a xlink:type="simple" xlink:href="${x(href)}">${x(l)}</text:a>` : x(l); // the link inside the span, as Impress writes it
    return `<text:p text:style-name="${ps}"><text:span text:style-name="${ts}">${words}</text:span></text:p>`;
  }).join('');
  const graphic = (it, { fill, stroke, valign } = {}) => {
    const f = fill ? `draw:fill="solid" draw:fill-color="${fill}"` : 'draw:fill="none"';
    const s = stroke ? `draw:stroke="solid" svg:stroke-color="${stroke.color}" svg:stroke-width="${(stroke.width * 0.0353).toFixed(3)}cm"` : 'draw:stroke="none"';
    return style('graphic', `<style:graphic-properties ${f} ${s}${valign ? ` draw:textarea-vertical-align="${valign}"` : ''} fo:padding="0cm" fo:min-height="0cm" draw:auto-grow-height="false" draw:auto-grow-width="false"${stroke?.arrow ? ' draw:marker-end="Arrow" draw:marker-end-width="0.4cm"' : ''}/>`);
  };
  const outline = (it) => (it.outline ? { color: color(it.outline, theme.text), width: OUTLINES.includes(it.outlineW) ? it.outlineW : 1 } : null);
  const linkOf = (it, slides) => {
    if (!it.link) return null;
    if (typeof it.link === 'string') return /^(https?:|mailto:)/i.test(it.link) ? it.link : null;
    if (it.link.url && /^(https?:|mailto:)/i.test(it.link.url)) return it.link.url;
    const i = slides.findIndex((s) => s.id === it.link.slide);
    return i >= 0 ? `#page${i + 1}` : null;
  };
  const slides = deck?.slides?.length ? deck.slides : [{ id: 's1', items: [] }];
  let pages = '';
  for (const [si, s] of slides.entries()) {
    const bgPath = await picture(s.bgImage);
    let dp;
    if (bgPath) { const name = `bg${fillImages.length + 1}`; fillImages.push(`<draw:fill-image draw:name="${name}" xlink:href="${bgPath}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/>`); dp = style('drawing-page', `<style:drawing-page-properties draw:fill="bitmap" draw:fill-image-name="${name}" style:repeat="stretch" presentation:visibility="${s.skip ? 'hidden' : 'visible'}"/>`); }
    else dp = style('drawing-page', `<style:drawing-page-properties draw:fill="solid" draw:fill-color="${color(s.bg, theme.bg)}" presentation:visibility="${s.skip ? 'hidden' : 'visible'}"/>`);
    let items = '';
    const pieces = []; // each box's own XML, so grouped ones can be wrapped in a <draw:g>
    for (const it of s.items || []) {
      if (pieces.length) pieces[pieces.length - 1].end = items.length;
      pieces.push({ it, start: items.length });
      const href = linkOf(it, slides);
      if (it.type === 'text') {
        const gs = graphic(it, { fill: it.fill ? color(it.fill, theme.accent) : null, stroke: outline(it), valign: 'top' });
        items += `<draw:frame draw:style-name="${gs}" ${place(it)}><draw:text-box>${paras(it.text, textStyle(it, theme.text, 24), paraStyle(it.align), href)}</draw:text-box></draw:frame>`;
      } else if (it.type === 'shape' && (it.shape === 'line' || it.shape === 'arrow')) {
        const xx = (it.x / 100) * W, yy = (it.y / 100) * H, w = (it.w / 100) * W, h = (it.h / 100) * H;
        const d = it.dir || 'h';
        const [x1, y1, x2, y2] = d === 'h' ? [xx, yy + h / 2, xx + w, yy + h / 2] : d === 'hr' ? [xx + w, yy + h / 2, xx, yy + h / 2] : d === 'v' ? [xx + w / 2, yy, xx + w / 2, yy + h] : d === 'vr' ? [xx + w / 2, yy + h, xx + w / 2, yy]
          : d === 'u' ? [xx, yy + h, xx + w, yy] : [xx, yy, xx + w, yy + h];
        const gs = graphic(it, { stroke: { color: color(it.fill || 'text', theme.text), width: 3, arrow: it.shape === 'arrow' } });
        items += `<draw:line draw:style-name="${gs}" svg:x1="${cm(x1)}" svg:y1="${cm(y1)}" svg:x2="${cm(x2)}" svg:y2="${cm(y2)}"><text:p/></draw:line>`;
      } else if (it.type === 'shape') {
        const gs = graphic(it, { fill: color(it.fill || 'accent', theme.accent), stroke: outline(it), valign: 'middle' });
        const text = it.text ? paras(it.text, textStyle(it, theme.bg, 20), paraStyle(it.align || 'center'), null) : '';
        const shape = `<draw:custom-shape draw:style-name="${gs}" ${place(it)}>${text}<draw:enhanced-geometry draw:type="${ODP_SHAPES[it.shape] || 'rectangle'}"/></draw:custom-shape>`;
        items += href ? `<draw:a xlink:type="simple" xlink:href="${x(href)}">${shape}</draw:a>` : shape;
      } else if ((it.type === 'table' && it.cells?.length) || (it.type === 'chart' && it.data?.series?.length)) {
        const rows = it.type === 'table' ? it.cells : [['', ...it.data.series.map((se) => String(se.name ?? ''))], ...(it.data.categories || []).map((c, i) => [String(c ?? ''), ...it.data.series.map((se) => String(se.values?.[i] ?? ''))])];
        const head = it.type === 'chart' || it.header;
        const ts = textStyle({ size: it.size || 18 }, theme.text, 18), hs = textStyle({ size: it.size || 18, bold: true, color: 'bg' }, theme.bg, 18), ps = paraStyle('left');
        const cell = style('table-cell', `<style:graphic-properties draw:fill="none"/><style:table-cell-properties fo:border="0.03cm solid ${theme.text}" fo:padding="0.1cm"/>`);
        const headCell = style('table-cell', `<style:graphic-properties draw:fill="solid" draw:fill-color="${theme.accent}"/><style:table-cell-properties fo:background-color="${theme.accent}" fo:border="0.03cm solid ${theme.text}" fo:padding="0.1cm"/>`);
        const cols = Math.max(...rows.map((r) => r.length));
        const plain = graphic(it, {});
        const caption = it.type === 'chart' && it.title ? `<draw:frame draw:style-name="${plain}" ${place({ ...it, h: Math.min(it.h, 8) })}><draw:text-box>${paras(`📊 ${it.title}`, textStyle({ size: 20, bold: true }, theme.text, 20), ps)}</draw:text-box></draw:frame>` : '';
        items += `${caption}<draw:frame draw:style-name="${plain}" ${place(it.type === 'chart' && it.title ? { ...it, y: it.y + 8, h: Math.max(4, it.h - 8) } : it)}><table:table${head ? ' table:use-first-row-styles="true"' : ''}><table:table-column table:number-columns-repeated="${cols}"/>${rows.map((r, ri) => `<table:table-row>${Array.from({ length: cols }, (_, ci) => `<table:table-cell table:style-name="${head && ri === 0 ? headCell : cell}" office:value-type="string">${paras(r[ci] ?? '', head && ri === 0 ? hs : ts, ps)}</table:table-cell>`).join('')}</table:table-row>`).join('')}</table:table></draw:frame>`;
      } else if (it.type === 'image') {
        const p = await picture(it.fileId);
        if (!p) continue;
        const img = `<draw:frame draw:style-name="${graphic(it, {})}" ${place(it)}><draw:image xlink:href="${p}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/>${it.alt ? `<svg:title>${x(it.alt)}</svg:title>` : ''}</draw:frame>`;
        items += href ? `<draw:a xlink:type="simple" xlink:href="${x(href)}">${img}</draw:a>` : img;
      } else if (it.type === 'video') {
        items += `<draw:frame draw:style-name="${graphic(it, { fill: '#f1f3f4', valign: 'middle' })}" ${place(it)}><draw:text-box>${paras(`▶ ${it.name || 'Video'}`, textStyle({ size: 18, color: '#5f6368' }, '#5f6368', 18), paraStyle('center'))}</draw:text-box></draw:frame>`;
      }
    }
    if (pieces.length) pieces[pieces.length - 1].end = items.length;
    items = groupedXml(items, pieces);
    const notes = s.notes ? `<presentation:notes><draw:page-thumbnail presentation:class="page" svg:x="2cm" svg:y="2cm" svg:width="17cm" svg:height="9.56cm" draw:page-number="${si + 1}"/><draw:frame presentation:class="notes" presentation:placeholder="false" svg:x="2cm" svg:y="12.5cm" svg:width="17cm" svg:height="13cm"><draw:text-box>${String(s.notes).split('\n').map((l) => `<text:p>${x(l)}</text:p>`).join('')}</draw:text-box></draw:frame></presentation:notes>` : '';
    pages += `<draw:page draw:name="page${si + 1}" draw:style-name="${dp}" draw:master-page-name="Default">${items}${notes}</draw:page>`;
  }
  const NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" office:version="1.3"';
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content ${NS}><office:automatic-styles>${auto.join('')}</office:automatic-styles><office:body><office:presentation>${pages}</office:presentation></office:body></office:document-content>`;
  const styles = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles ${NS}><office:styles>${fillImages.join('')}<draw:marker draw:name="Arrow" svg:viewBox="0 0 20 30" svg:d="M10 0l-10 30h20z"/>
<style:default-style style:family="graphic"><style:graphic-properties draw:fill="none" draw:stroke="none"/><style:text-properties fo:font-size="18pt" style:font-name="${x(font)}" fo:font-family="'${x(font)}'"/></style:default-style></office:styles>
<office:automatic-styles><style:page-layout style:name="PM1"><style:page-layout-properties fo:margin="0cm" fo:page-width="${W}cm" fo:page-height="${H}cm" style:print-orientation="landscape"/></style:page-layout>
<style:page-layout style:name="PMN"><style:page-layout-properties fo:margin="0cm" fo:page-width="21cm" fo:page-height="29.7cm" style:print-orientation="portrait"/></style:page-layout>
<style:style style:name="Mdp" style:family="drawing-page"><style:drawing-page-properties draw:fill="solid" draw:fill-color="${theme.bg}"/></style:style></office:automatic-styles>
<office:master-styles><style:master-page style:name="Default" style:page-layout-name="PM1" draw:style-name="Mdp"><presentation:notes style:page-layout-name="PMN"><draw:page-thumbnail presentation:class="page" svg:x="2cm" svg:y="2cm" svg:width="17cm" svg:height="9.56cm"/><draw:frame presentation:class="notes" presentation:placeholder="true" svg:x="2cm" svg:y="12.5cm" svg:width="17cm" svg:height="13cm"/></presentation:notes></style:master-page></office:master-styles></office:document-styles>`;
  const meta = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-meta ${NS}><office:meta><dc:title>${x(title)}</dc:title><meta:generator>Workspace</meta:generator></office:meta></office:document-meta>`;
  const manifest = `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">
<manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="${ODP_MIME}"/>
${['content.xml', 'styles.xml', 'meta.xml'].map((f) => `<manifest:file-entry manifest:full-path="${f}" manifest:media-type="text/xml"/>`).join('\n')}
${pictures.map((p) => `<manifest:file-entry manifest:full-path="${p.path}" manifest:media-type="${p.mime}"/>`).join('\n')}
</manifest:manifest>`;
  const zip = new JSZip();
  zip.file('mimetype', ODP_MIME, { compression: 'STORE' });
  zip.file('content.xml', content);
  zip.file('styles.xml', styles);
  zip.file('meta.xml', meta);
  zip.file('META-INF/manifest.xml', manifest);
  for (const p of pictures) zip.file(p.path, p.data);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', mimeType: ODP_MIME });
}

// ---- .odp → deck ----
const kids = (el) => el?.children || [];
const tags = (el, name) => kids(el).filter((k) => k.type === 'tag' && (!name || k.name === name));
const textOf = (el) => (el.type === 'text' ? el.data : el.name === 'text:s' ? ' '.repeat(Number(el.attribs['text:c']) || 1) : el.name === 'text:tab' ? '\t' : el.name === 'text:line-break' ? '\n' : kids(el).map(textOf).join(''));
const toCm = (v) => { const m = /^(-?[\d.]+)(cm|mm|in|pt|px)?$/.exec(String(v || '').trim()); if (!m) return null; const k = Number(m[1]); return { cm: k, mm: k / 10, in: k * 2.54, pt: k * 2.54 / 72, px: k * 2.54 / 96, undefined: k }[m[2]] ?? k; };
const round1 = (v) => Math.round(v * 10) / 10;

/** Read an .odp file as a presentation's content: { theme, slides }. Pictures saved with savePicture(name, data, mime) → file id. */
export async function deckFromOdp(buffer, { savePicture } = {}) {
  const zip = await JSZip.loadAsync(buffer);
  const contentXml = await zip.file('content.xml')?.async('string');
  if (!contentXml) throw new Error('Not an OpenDocument presentation');
  const parse = (s) => parseDocument(s || '', { xmlMode: true, decodeEntities: true });
  const root = parse(contentXml), stylesRoot = parse(await zip.file('styles.xml')?.async('string'));
  const styles = new Map(), fillImages = new Map(), layouts = new Map(), masters = new Map();
  const read = (node) => {
    for (const el of tags(node)) {
      if (el.name === 'style:style') {
        const get = (k) => tags(el, k)[0]?.attribs || {};
        styles.set(el.attribs['style:name'], { parent: el.attribs['style:parent-style-name'], g: get('style:graphic-properties'), t: get('style:text-properties'), p: get('style:paragraph-properties'), d: get('style:drawing-page-properties') });
      } else if (el.name === 'draw:fill-image') fillImages.set(el.attribs['draw:name'], el.attribs['xlink:href']);
      else if (el.name === 'style:page-layout') layouts.set(el.attribs['style:name'], tags(el, 'style:page-layout-properties')[0]?.attribs || {});
      else if (el.name === 'style:master-page') masters.set(el.attribs['style:name'], el.attribs);
      read(el);
    }
  };
  read(stylesRoot); read(root);
  const look = (name, part) => { const out = {}; const chain = []; for (let s = styles.get(name), i = 0; s && i < 10; s = styles.get(s.parent), i++) chain.unshift(s); for (const s of chain) Object.assign(out, s[part]); return out; };
  const master = masters.values().next().value;
  const pl = layouts.get(master?.['style:page-layout-name']) || {};
  const pw = toCm(pl['fo:page-width']) || W, ph = toCm(pl['fo:page-height']) || H;
  const pct = (v, of) => round1(((toCm(v) || 0) / of) * 100);
  const saved = new Map();
  let picNo = 0;
  const pictureFor = async (href) => {
    if (!savePicture || !href || /^https?:/i.test(href)) return null;
    if (saved.has(href)) return saved.get(href);
    const f = zip.file(href.replace(/^\.?\//, ''));
    const ext = (/\.([a-z]+)$/i.exec(href) || [])[1]?.toLowerCase();
    const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp' }[ext];
    const id = f && mime ? await savePicture(`Picture ${++picNo}.${ext === 'jpeg' ? 'jpg' : ext}`, await f.async('nodebuffer'), mime) : null;
    saved.set(href, id);
    return id;
  };
  const hex = (v) => (COLOR.test(v || '') ? v.toLowerCase() : null);
  // A box: from svg:x/y/width/height, or a transform (rotate, then translate) for a turned one.
  const boxOf = (el) => {
    const w = toCm(el.attribs['svg:width']) || 0, h = toCm(el.attribs['svg:height']) || 0;
    let xx = toCm(el.attribs['svg:x']) || 0, yy = toCm(el.attribs['svg:y']) || 0, rot = 0;
    const tf = el.attribs['draw:transform'];
    if (tf) {
      const r = /rotate\s*\(\s*(-?[\d.e-]+)\s*\)/.exec(tf), t = /translate\s*\(\s*(-?[\d.]+\w*)[\s,]+(-?[\d.]+\w*)\s*\)/.exec(tf);
      const th = r ? -Number(r[1]) : 0;
      const tx = t ? toCm(t[1]) : xx, ty = t ? toCm(t[2]) : yy;
      const cx = tx + (w / 2 * Math.cos(th) - h / 2 * Math.sin(th)), cy = ty + (w / 2 * Math.sin(th) + h / 2 * Math.cos(th));
      xx = cx - w / 2; yy = cy - h / 2;
      rot = Math.round((((th * 180) / Math.PI) % 360 + 360) % 360);
    }
    return { x: round1((xx / pw) * 100), y: round1((yy / ph) * 100), w: round1((w / pw) * 100), h: round1((h / ph) * 100), ...(rot && rot !== 360 && { rot }) };
  };
  // A text's look, from its first span (or paragraph): size, bold, italic, colour; its alignment.
  const textLook = (container, defPt) => {
    const p = tags(container, 'text:p')[0] || tags(container, 'text:h')[0];
    const span = p && (function first(n) { for (const k of tags(n)) { if (k.name === 'text:span') return k; const f = first(k); if (f) return f; } return null; })(p);
    const t = { ...look(container.attribs?.['draw:text-style-name'], 't'), ...look(p?.attribs['text:style-name'], 't'), ...look(span?.attribs['text:style-name'], 't') };
    const pt = Number(String(t['fo:font-size'] || '').replace('pt', '')) || defPt;
    const al = { center: 'center', end: 'right', right: 'right', justify: 'justify' }[look(p?.attribs['text:style-name'], 'p')['fo:text-align']];
    return { size: sizeOf(pt, pw), ...(/bold|[6-9]00/.test(t['fo:font-weight'] || '') && { bold: true }), ...(t['fo:font-style'] === 'italic' && { italic: true }), ...(hex(t['fo:color']) && { color: hex(t['fo:color']) }), ...(al && { align: al }) };
  };
  const linkIn = (el) => { const a = (function find(n) { for (const k of tags(n)) { if (k.name === 'text:a' || k.name === 'draw:a') return k; const f = find(k); if (f) return f; } return null; })(el); const h = a?.attribs['xlink:href']; return h && /^(https?:|mailto:)/i.test(h) ? { url: h } : null; };
  const paraText = (el) => tags(el).filter((k) => k.name === 'text:p' || k.name === 'text:h' || k.name === 'text:list').map((k) => (k.name === 'text:list' ? tags(k, 'text:list-item').map((li) => paraText(li)).join('\n') : textOf(k))).join('\n');
  const fillOf = (g) => (g['draw:fill'] === 'solid' || (g['draw:fill'] === undefined && g['draw:fill-color']) ? hex(g['draw:fill-color']) : null);
  const outlineOf = (g) => { if (g['draw:stroke'] !== 'solid' || !hex(g['svg:stroke-color'])) return {}; const pt = (toCm(g['svg:stroke-width']) || 0.0353) / 0.0353; return { outline: hex(g['svg:stroke-color']), outlineW: OUTLINES.reduce((a, b) => (Math.abs(b - pt) < Math.abs(a - pt) ? b : a)) }; };
  const slides = [];
  const fresh = () => Math.random().toString(36).slice(2, 10);
  const pres = (function find(n) { for (const k of tags(n)) { if (k.name === 'office:presentation') return k; const f = find(k); if (f) return f; } return null; })(root);
  const pageLinks = new Map();
  for (const page of tags(pres, 'draw:page')) {
    const d = look(page.attribs['draw:style-name'], 'd');
    const slide = { id: fresh(), items: [] };
    pageLinks.set(page.attribs['draw:name'], slide.id);
    if (d['draw:fill'] === 'bitmap' && d['draw:fill-image-name']) { const id = await pictureFor(fillImages.get(d['draw:fill-image-name'])); if (id) slide.bgImage = id; }
    else if (fillOf(d)) slide.bg = fillOf(d);
    if (d['presentation:visibility'] === 'hidden') slide.skip = true;
    const walk = async (nodes, link) => {
      for (const el of nodes) {
        if (el.name === 'draw:g') { // a group: its boxes keep a group id (the outermost group's; a group of one is just a box)
          const from = slide.items.length;
          await walk(tags(el), link);
          const added = slide.items.slice(from);
          const gid = fresh();
          if (added.length > 1) for (const it of added) if (!it.group) it.group = gid;
          continue;
        }
        if (el.name === 'draw:a') { await walk(tags(el), el.attribs['xlink:href']); continue; }
        if (el.attribs?.['presentation:placeholder'] === 'true' && !textOf(el).trim()) continue; // an empty placeholder (Impress marks some with text in them too)
        const g = look(el.attribs?.['draw:style-name'] || el.attribs?.['presentation:style-name'], 'g');
        const lk = link && /^(https?:|mailto:)/i.test(link) ? { link: { url: link } } : link?.startsWith('#') ? { link: { pageName: link.slice(1) } } : {};
        if (el.name === 'draw:frame') {
          const img = tags(el, 'draw:image')[0], box = tags(el, 'draw:text-box')[0], tbl = tags(el, 'table:table')[0];
          const alt = textOf(tags(el, 'svg:title')[0] || tags(el, 'svg:desc')[0] || { children: [] }).trim();
          if (tbl) { // (Impress adds a picture of the table as well: the table is what counts)
            const rows = [];
            (function rws(n) { for (const k of tags(n)) { if (k.name === 'table:table-row') rows.push(tags(k).filter((c) => c.name === 'table:table-cell').map((c) => paraText(c))); else if (/^table:table-(header-)?rows$/.test(k.name)) rws(k); } })(tbl);
            if (rows.length) slide.items.push({ id: fresh(), type: 'table', ...boxOf(el), cells: rows.slice(0, 30).map((r) => r.slice(0, 12)), ...(tbl.attribs['table:use-first-row-styles'] === 'true' && { header: true }), size: textLook(tags(tags(tbl, 'table:table-row')[0], 'table:table-cell')[0] || {}, 18).size });
          } else if (img) { const id = await pictureFor(img.attribs['xlink:href']); if (id) slide.items.push({ id: fresh(), type: 'image', ...boxOf(el), fileId: id, ...(alt && { alt }), ...lk }); }
          else if (box) {
            const text = paraText(box);
            if (!text.trim()) continue;
            const fill = fillOf(g);
            slide.items.push({ id: fresh(), type: 'text', ...boxOf(el), text, ...textLook(box, 18), ...(fill && { fill }), ...outlineOf(g), ...(linkIn(box) || lk.link ? { link: linkIn(box) || lk.link } : {}) });
          }
        } else if (el.name === 'draw:custom-shape' || el.name === 'draw:rect' || el.name === 'draw:ellipse') {
          const geo = tags(el, 'draw:enhanced-geometry')[0]?.attribs['draw:type'];
          const shape = el.name === 'draw:ellipse' ? 'ellipse' : el.name === 'draw:rect' ? (el.attribs['draw:corner-radius'] ? 'round' : 'rect') : OUR_SHAPES[geo] || (/ellipse|circle/.test(geo || '') ? 'ellipse' : 'rect');
          const text = paraText(el);
          slide.items.push({ id: fresh(), type: 'shape', shape, ...boxOf(el), fill: fillOf(g) || 'accent', ...outlineOf(g), ...(text.trim() && { text, ...textLook(el, 18) }), ...lk });
        } else if (el.name === 'draw:line') {
          const [x1, y1, x2, y2] = ['svg:x1', 'svg:y1', 'svg:x2', 'svg:y2'].map((k) => toCm(el.attribs[k]) || 0);
          const dx = x2 - x1, dy = y2 - y1;
          const dir = Math.abs(dy) < 0.01 ? (dx >= 0 ? 'h' : 'hr') : Math.abs(dx) < 0.01 ? (dy >= 0 ? 'v' : 'vr') : (dx > 0) === (dy > 0) ? 'd' : 'u';
          const left = Math.min(x1, x2), top = Math.min(y1, y2);
          const w = Math.max(Math.abs(dx), 0.5), h = Math.max(Math.abs(dy), 0.5);
          slide.items.push({ id: fresh(), type: 'shape', shape: g['draw:marker-end'] || g['draw:marker-start'] ? 'arrow' : 'line', dir,
            x: pct(`${left - (dir === 'v' || dir === 'vr' ? w / 2 : 0)}cm`, pw), y: pct(`${top - (dir === 'h' || dir === 'hr' ? h / 2 : 0)}cm`, ph), w: pct(`${w}cm`, pw), h: pct(`${h}cm`, ph),
            ...(hex(g['svg:stroke-color']) && { fill: hex(g['svg:stroke-color']) }) });
        }
      }
    };
    await walk(tags(page));
    const notes = tags(page, 'presentation:notes')[0];
    const nf = notes && (tags(notes, 'draw:frame').find((f) => f.attribs['presentation:class'] === 'notes') || tags(notes, 'draw:frame').find((f) => tags(f, 'draw:text-box').length));
    const nt = nf ? paraText(tags(nf, 'draw:text-box')[0] || nf).trim() : '';
    if (nt) slide.notes = nt.slice(0, 20000);
    slides.push(slide);
  }
  // Links to another slide, now that every slide has its id.
  for (const s of slides) for (const it of s.items) if (it.link?.pageName) { const id = pageLinks.get(it.link.pageName); if (id) it.link = { slide: id }; else delete it.link; }
  return { theme: 'light', slides: slides.length ? slides : [{ id: fresh(), items: [] }] };
}

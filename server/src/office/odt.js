// OpenDocument text (.odt, LibreOffice Writer's own format), both ways. Out: headings, paragraphs (aligned),
// bold/italic/underline/strike/code, sub- and superscript, colour and highlight, links, lists and checklists,
// quotes, code blocks, tables, pictures, footnotes, page breaks, and chips as their text. In: the same,
// read from the file's content.xml (its automatic styles say which text is bold, which list numbered…).
import JSZip from 'jszip';
import { parseDocument } from 'htmlparser2';
import { imageSize } from 'image-size';
import { flattenTabs } from './doctabs.js';
import { chipText, dateText, eventLines } from './chiptext.js';
import { inText, reference, sourcesOf } from './cite.js';
import { chartTable } from './sheetchart.js';
import { docFromHtml } from './word.js';

// The Docs toolbar's fonts (as written in files → the editor's CSS) and sizes (pt).
const ODT_FONTS = { arial: 'Arial, Helvetica, sans-serif', georgia: 'Georgia, serif', 'times new roman': '"Times New Roman", Times, serif', verdana: 'Verdana, Geneva, sans-serif', 'trebuchet ms': '"Trebuchet MS", sans-serif', 'courier new': '"Courier New", Courier, monospace' };
const ODT_SIZES = [8, 9, 10, 11, 12, 14, 18, 24, 30, 36];
export const ODT_MIME = 'application/vnd.oasis.opendocument.text';
const x = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Text as ODF wants it: runs of spaces as <text:s/>, tabs and line breaks as elements. */
const odfText = (s) => x(s).replace(/\t/g, '<text:tab/>').replace(/\n/g, '<text:line-break/>').replace(/ {2,}/g, (m) => ` <text:s text:c="${m.length - 1}"/>`);
const COLOR = /^#[0-9a-f]{6}$/i;

// ---- document → .odt ----
/** The page: paper size and orientation, margins and page colour from Page setup (A4 portrait, 2 cm, white without one). */
export function pageLayout(page) {
  const PAPER = { a4: [210, 297], letter: [215.9, 279.4], legal: [215.9, 355.6], a5: [148, 210] }, MARGINS = { normal: 25.4, narrow: 12.7, wide: 38.1 };
  let [w, h] = PAPER[page?.size] || PAPER.a4;
  const landscape = page?.orientation === 'landscape';
  if (landscape) [w, h] = [h, w];
  const m = page?.margin ? MARGINS[page.margin] || 20 : 20;
  const cm = (mm) => `${+(mm / 10).toFixed(3)}cm`;
  const bg = /^#[0-9a-f]{6}$/i.test(page?.pageColor || '') ? ` fo:background-color="${page.pageColor.toLowerCase()}"` : '';
  return `fo:page-width="${cm(w)}" fo:page-height="${cm(h)}" style:print-orientation="${landscape ? 'landscape' : 'portrait'}" fo:margin-top="${cm(m)}" fo:margin-bottom="${cm(m)}" fo:margin-left="${cm(m)}" fo:margin-right="${cm(m)}"${bg}`;
}

/** Text in 2 or 3 columns (Page setup), half a centimetre apart. */
export const columnsXml = (page) => (page?.columns >= 2 && page.columns <= 3 ? `<style:columns fo:column-count="${page.columns}" fo:column-gap="0.5cm"/>` : '');
/** Line numbers in the margin, every line, on through the document. */
export const lineNumbersXml = (page) => (page?.lineNumbers ? '<text:linenumbering-configuration text:number-lines="true" text:increment="1" text:restart-on-page="false" style:num-format="1" text:number-position="left" text:offset="0.5cm"/>' : '');
const xmlEsc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/**
 * The watermark (Page setup): faint grey text across the middle of every page, rising at 45°, as LibreOffice makes
 * its own (Format → Watermark): a text-path shape named PowerPlusWaterMarkObject, anchored in the header.
 */
export function watermarkXml(page) {
  const text = String(page?.watermark || '').trim();
  if (!text) return '';
  const w = Math.min(16, 1.6 * text.length + 2), h = w / 4; // cm: wider for longer words
  const pt = Math.round(Math.min(96, (w / (text.length * 0.6)) * 28.35)); // letters as tall as the shape allows
  return `<text:p><draw:custom-shape text:anchor-type="char" draw:z-index="0" draw:name="PowerPlusWaterMarkObject1" draw:style-name="Wm" draw:text-style-name="WmText${pt}" svg:width="${w.toFixed(2)}cm" svg:height="${h.toFixed(2)}cm" draw:transform="rotate (0.785398163397448) translate (${(-w / 2 * Math.SQRT1_2 + 0).toFixed(3)}cm ${(10 + w / 2 * Math.SQRT1_2).toFixed(3)}cm)"><text:p text:style-name="WmText${pt}">${xmlEsc(text)}</text:p><draw:enhanced-geometry svg:viewBox="0 0 21600 21600" draw:text-areas="0 0 21600 21600" draw:text-path="true" draw:text-path-mode="shape" draw:text-path-scale="shape" draw:text-path-same-letter-heights="false" draw:type="fontwork-plain-text" draw:enhanced-path="M 0 0 L 21600 0 N M 0 21600 L 21600 21600 N"/></draw:custom-shape></text:p>`;
}

/** The watermark's letters: large, light grey, in the size watermarkXml picked. */
export function watermarkTextStyle(page) {
  const text = String(page?.watermark || '').trim();
  if (!text) return '';
  const w = Math.min(16, 1.6 * text.length + 2), pt = Math.round(Math.min(96, (w / (text.length * 0.6)) * 28.35));
  return `<style:style style:name="WmText${pt}" style:family="paragraph"><style:text-properties fo:font-size="${pt}pt" style:font-name="Liberation Sans" fo:font-family="'Liberation Sans'" fo:color="#c0c0c0"/></style:style>`;
}

/** The master page: Page setup's header, and footer with the page number ("Private   3"), centred. */
export function masterPage(page) {
  const header = String(page?.header || '').trim(), footer = String(page?.footer || '').trim(), numbers = !!page?.numbers;
  const centred = (inner) => `<text:p text:style-name="HeaderFooter">${inner}</text:p>`;
  const mark = watermarkXml(page);
  return `<style:master-page style:name="Standard" style:page-layout-name="pm1">${header || mark ? `<style:header>${mark}${header ? centred(xmlEsc(header)) : ''}</style:header>` : ''}${footer || numbers ? `<style:footer>${centred(`${xmlEsc(footer)}${footer && numbers ? '<text:s text:c="3"/>' : ''}${numbers ? '<text:page-number text:select-page="current">1</text:page-number>' : ''}`)}</style:footer>` : ''}</style:master-page>`;
}

/** The paragraphs' default text: the document's Normal text (Page setup), else Liberation Sans 11 pt. */
export function normalText(page) {
  const font = page?.font ? `fo:font-family="'${String(page.font).replace(/[^A-Za-z ]/g, '')}'"` : 'style:font-name="Liberation Sans" fo:font-family="\'Liberation Sans\', Arial, sans-serif"';
  const size = Number.isInteger(page?.fontSize) ? page.fontSize : 11;
  return `${font} fo:font-size="${size}pt"`;
}

export async function odtFromDoc(doc, title = 'Document', { pictureData, page = null } = {}) {
  doc = flattenTabs(doc);
  const textStyles = new Map(); // key → name
  const textStyle = (props) => {
    const key = JSON.stringify(props);
    if (!textStyles.has(key)) textStyles.set(key, { name: `T${textStyles.size + 1}`, props });
    return textStyles.get(key).name;
  };
  const pictures = []; // { path, data, mime }
  let noteNo = 0;
  const inline = (nodes = []) => {
    let out = '';
    for (const n of nodes) {
      const t = n.type;
      if (t === 'hardBreak') { out += '<text:line-break/>'; continue; }
      if (t === 'footnote') { noteNo++; out += `<text:note text:id="ftn${noteNo}" text:note-class="footnote"><text:note-citation>${noteNo}</text:note-citation><text:note-body><text:p text:style-name="Footnote">${odfText(n.attrs?.note || '')}</text:p></text:note-body></text:note>`; continue; }
      let text = null;
      if (t === 'mention') text = `@${n.attrs?.name || ''}`;
      else if (t === 'datechip') text = dateText(n.attrs?.date);
      else if (t === 'filechip') text = n.attrs?.name || '';
      else if (t === 'dropchip') text = chipText(n.attrs);
      else if (t === 'math') text = String(n.attrs?.latex || '');
      else if (t === 'citation') text = inText(n.attrs);
      else if (t === 'image') { out += picture(n); continue; }
      else if (t !== 'text') { out += inline(n.content); continue; }
      else text = n.text || '';
      const marks = new Map((n.marks || []).map((m) => [m.type, m]));
      const props = {};
      if (marks.has('bold')) props.bold = 1;
      if (marks.has('italic')) props.italic = 1;
      if (marks.has('underline')) props.underline = 1;
      if (marks.has('strike')) props.strike = 1;
      if (marks.has('code')) props.code = 1;
      if (marks.has('superscript')) props.sup = 1;
      if (marks.has('subscript')) props.sub = 1;
      const ts = marks.get('textStyle')?.attrs || {};
      if (COLOR.test(ts.color || '')) props.color = ts.color;
      const fam = String(ts.fontFamily || '').split(',')[0].trim().replace(/^["']|["']$/g, '');
      if (fam && !/^(serif|sans-serif|monospace)$/i.test(fam)) props.font = fam.replace(/[^A-Za-z0-9 -]/g, '');
      const pt = /^([\d.]+)(pt|px)$/.exec(String(ts.fontSize || '').trim());
      if (pt) { const v = pt[2] === 'px' ? Number(pt[1]) * 0.75 : Number(pt[1]); if (v >= 4 && v <= 200) props.size = Math.round(v * 10) / 10; }
      const hl = marks.get('highlight')?.attrs?.color || ts.backgroundColor;
      if (COLOR.test(hl || '')) props.bg = hl;
      if (t === 'mention' || t === 'datechip' || t === 'filechip') props.color = '#1a73e8';
      if (t === 'dropchip') props.bold = 1;
      let run = odfText(text);
      if (Object.keys(props).length) run = `<text:span text:style-name="${textStyle(props)}">${run}</text:span>`;
      const href = marks.get('link')?.attrs?.href;
      if (href && !/^\s*javascript:/i.test(href)) run = `<text:a xlink:type="simple" xlink:href="${x(href)}">${run}</text:a>`;
      out += run;
    }
    return out;
  };
  const picture = (n) => {
    const id = n.attrs?.fileId;
    const p = id && picturesById.get(id);
    if (!p) return n.attrs?.alt ? odfText(`[${n.attrs.alt}]`) : '';
    // Its size: the width chosen in the document (pixels), or as it is, at most the page's width (17 cm).
    let w = 400, h = 300;
    try { const s = imageSize(p.data); w = s.width; h = s.height; } catch { /* unknown size */ }
    const want = Number(n.attrs?.width) || w;
    const cm = Math.min(17, want * 2.54 / 96), hcm = cm * (h / w || 0.75);
    return `<draw:frame draw:name="${x(p.path)}" text:anchor-type="as-char" svg:width="${cm.toFixed(2)}cm" svg:height="${hcm.toFixed(2)}cm"><draw:image xlink:href="${x(p.path)}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/>${n.attrs?.alt ? `<svg:desc>${x(n.attrs.alt)}</svg:desc>` : ''}</draw:frame>`;
  };
  // The pictures first (each once), so they can be placed as they're met.
  const picturesById = new Map();
  const ids = [];
  const findPics = (n) => { if (n?.type === 'image' && n.attrs?.fileId) ids.push(n.attrs.fileId); (n?.content || []).forEach(findPics); };
  findPics(doc);
  for (const id of [...new Set(ids)]) {
    const got = pictureData ? await pictureData(id) : null;
    if (!got || !/^image\/(png|jpeg|gif|svg\+xml|webp)$/.test(got.mime)) continue;
    const ext = got.mime.split('/')[1].replace('jpeg', 'jpg').replace('svg+xml', 'svg');
    const p = { path: `Pictures/${pictures.length + 1}.${ext}`, data: got.data, mime: got.mime };
    pictures.push(p); picturesById.set(id, p);
  }

  const ALIGNS = { center: 'center', right: 'end', justify: 'justify' };
  // A paragraph's style: its base, aligned (Standard_center…), or one of its own when it has line spacing or
  // space before or after (Standard_s1…, as LibreOffice's own direct formatting).
  const spaced = new Map(); // what a style says → its name
  const styleOf = (base, attrs = {}) => {
    const al = ALIGNS[attrs.textAlign];
    const lh = Number(attrs.lineHeight), sb = Number(attrs.spaceBefore), sa = Number(attrs.spaceAfter), ind = Math.min(8, Math.round(Number(attrs.indent) || 0));
    const props = [al && `fo:text-align="${al}"`, lh >= 0.5 && lh <= 4 && `fo:line-height="${Math.round(lh * 100)}%"`, sb > 0 && sb <= 72 && `fo:margin-top="${sb}pt"`, sa > 0 && sa <= 72 && `fo:margin-bottom="${sa}pt"`,
      ind > 0 && `fo:margin-left="${(ind * 1.27).toFixed(2)}cm"`].filter(Boolean); // (an indent step: half an inch)
    if (props.length <= (al ? 1 : 0)) return al ? `${base}_${al}` : base;
    const key = `${base}|${props.join(' ')}`;
    if (!spaced.has(key)) spaced.set(key, `${base}_s${spaced.size + 1}`);
    return spaced.get(key);
  };
  const spacedStyles = () => [...spaced].map(([key, name]) => { const [base, props] = key.split('|'); return `<style:style style:name="${name}" style:family="paragraph" style:parent-style-name="${base}"><style:paragraph-properties ${props}/></style:style>`; }).join('');
  const para = (n, style = 'Standard') => `<text:p text:style-name="${styleOf(style, n.attrs)}">${inline(n.content)}</text:p>`;
  const blocks = (nodes = [], ctx = {}) => {
    let out = '';
    for (const n of nodes) {
      const t = n.type;
      if (t === 'paragraph') out += para(n, ctx.style || 'Standard');
      else if (t === 'heading') { const lv = Math.min(6, n.attrs?.level || 1); out += `<text:h text:style-name="${styleOf(`Heading_20_${lv}`, n.attrs)}" text:outline-level="${lv}">${inline(n.content)}</text:h>`; }
      else if (t === 'bulletList' || t === 'orderedList') {
        out += `<text:list text:style-name="${t === 'orderedList' ? 'LNum' : 'LBul'}">${(n.content || []).map((li) => `<text:list-item>${blocks(li.content, ctx)}</text:list-item>`).join('')}</text:list>`;
      } else if (t === 'taskList') {
        for (const li of n.content || []) {
          const [first, ...rest] = li.content || [];
          out += `<text:p text:style-name="Standard">${li.attrs?.checked ? '☑' : '☐'} ${first?.type === 'paragraph' ? inline(first.content) : ''}</text:p>${blocks(first?.type === 'paragraph' ? rest : li.content, ctx)}`;
        }
      } else if (t === 'blockquote') out += blocks(n.content, { ...ctx, style: 'Quotations' });
      else if (t === 'codeBlock') out += `<text:p text:style-name="Preformatted_20_Text">${odfText((n.content || []).map((c) => c.text).join(''))}</text:p>`;
      else if (t === 'horizontalRule') out += '<text:p text:style-name="Horizontal_20_Line"/>';
      else if (t === 'pageBreak') out += '<text:p text:style-name="PageBreak"/>';
      else if (t === 'image') out += `<text:p text:style-name="Standard">${picture(n)}</text:p>`;
      else if (t === 'table') {
        const rows = n.content || [];
        const width = Math.max(1, ...rows.map((r) => (r.content || []).reduce((k, c) => k + (c.attrs?.colspan || 1), 0)));
        out += `<table:table table:name="Table${++tableNo}" table:style-name="Tbl"><table:table-column table:number-columns-repeated="${width}"/>`;
        const headed = rows.length > 1 && (rows[0].content || []).every((c) => c.type === 'tableHeader');
        rows.forEach((r, ri) => {
          if (headed && ri === 0) out += '<table:table-header-rows>';
          out += '<table:table-row>';
          for (const c of r.content || []) {
            const span = c.attrs?.colspan > 1 ? ` table:number-columns-spanned="${c.attrs.colspan}"` : '';
            out += `<table:table-cell table:style-name="Cell" office:value-type="string"${span}>${blocks(c.content, { style: c.type === 'tableHeader' ? 'Table_20_Heading' : 'Table_20_Contents' }) || '<text:p/>'}</table:table-cell>`;
            for (let k = 1; k < (c.attrs?.colspan || 1); k++) out += '<table:covered-table-cell/>';
          }
          out += '</table:table-row>';
          if (headed && ri === 0) out += '</table:table-header-rows>';
        });
        out += '</table:table>';
      } else if (t === 'sheetChart') {
        const { title: ct, rows } = chartTable(n.attrs);
        out += `<text:p text:style-name="Standard"><text:span text:style-name="${textStyle({ bold: 1 })}">${odfText(ct)}</text:span></text:p>`;
        if (rows.length) out += blocks([{ type: 'table', content: rows.map((r, i) => ({ type: 'tableRow', content: r.map((v) => ({ type: i ? 'tableCell' : 'tableHeader', content: [{ type: 'paragraph', content: v ? [{ type: 'text', text: v }] : [] }] })) })) }]);
      } else if (t === 'references') {
        out += `<text:h text:style-name="Heading_20_2" text:outline-level="2">References</text:h>`;
        for (const s of sourcesOf(doc)) out += `<text:p text:style-name="Reference">${reference(s).map((p) => (p.italic ? `<text:span text:style-name="${textStyle({ italic: 1 })}">${odfText(p.text)}</text:span>` : odfText(p.text))).join('')}</text:p>`;
      } else if (t === 'emailDraft' || t === 'eventDraft') {
        const a = n.attrs || {};
        const lines = t === 'eventDraft' ? eventLines(a) : [['To', a.to || ''], ['Cc', a.cc || ''], ['Subject', a.subject || '']].filter(([k, v]) => v || k !== 'Cc');
        for (const [k, v] of lines) out += `<text:p text:style-name="Standard"><text:span text:style-name="${textStyle({ bold: 1, color: '#5f6368' })}">${odfText(`${k}: `)}</text:span>${odfText(v)}</text:p>`;
        out += blocks(n.content, ctx);
      } else if (t !== 'tableOfContents' && n.content) out += blocks(n.content, ctx);
    }
    return out;
  };
  let tableNo = 0;
  const body = blocks(doc?.content) || '<text:p text:style-name="Standard"/>';

  const textProps = (p) => [
    p.bold && 'fo:font-weight="bold" style:font-weight-asian="bold" style:font-weight-complex="bold"',
    p.italic && 'fo:font-style="italic" style:font-style-asian="italic" style:font-style-complex="italic"',
    p.underline && 'style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"',
    p.strike && 'style:text-line-through-style="solid"',
    p.code && 'style:font-name="Liberation Mono" fo:font-family="\'Liberation Mono\'"',
    p.sup && 'style:text-position="super 58%"', p.sub && 'style:text-position="sub 58%"',
    p.color && `fo:color="${p.color}"`, p.bg && `fo:background-color="${p.bg}"`,
    p.font && `fo:font-family="'${p.font}'"`, p.size && `fo:font-size="${p.size}pt"`,
  ].filter(Boolean).join(' ');
  const auto = [...textStyles.values()].map((s) => `<style:style style:name="${s.name}" style:family="text"><style:text-properties ${textProps(s.props)}/></style:style>`).join('');
  const aligned = ['Standard', 'Quotations', 'Table_20_Contents', 'Table_20_Heading', ...[1, 2, 3, 4, 5, 6].map((l) => `Heading_20_${l}`)]
    .flatMap((base) => Object.values(ALIGNS).map((al) => `<style:style style:name="${base}_${al}" style:family="paragraph" style:parent-style-name="${base}"><style:paragraph-properties fo:text-align="${al}"/></style:style>`)).join('');
  const NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" office:version="1.3"';
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content ${NS}><office:font-face-decls><style:font-face style:name="Liberation Mono" svg:font-family="'Liberation Mono'" style:font-pitch="fixed"/></office:font-face-decls><office:automatic-styles>${auto}${aligned}${spacedStyles()}
<style:style style:name="PageBreak" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:break-before="page"/></style:style>
<style:style style:name="Tbl" style:family="table"><style:table-properties style:width="17cm" table:align="margins"/></style:style>
<style:style style:name="Cell" style:family="table-cell"><style:table-cell-properties fo:padding="0.1cm" fo:border="0.5pt solid #999999"/></style:style>
<text:list-style style:name="LBul">${[1, 2, 3, 4, 5, 6].map((l) => `<text:list-level-style-bullet text:level="${l}" text:bullet-char="${'•◦▪'[(l - 1) % 3]}"><style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" text:list-tab-stop-position="${0.63 * l}cm" fo:text-indent="-0.63cm" fo:margin-left="${0.63 * l}cm"/></style:list-level-properties></text:list-level-style-bullet>`).join('')}</text:list-style>
<text:list-style style:name="LNum">${[1, 2, 3, 4, 5, 6].map((l) => `<text:list-level-style-number text:level="${l}" style:num-suffix="." style:num-format="${['1', 'a', 'i'][(l - 1) % 3]}"><style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" text:list-tab-stop-position="${0.63 * l}cm" fo:text-indent="-0.63cm" fo:margin-left="${0.63 * l}cm"/></style:list-level-properties></text:list-level-style-number>`).join('')}</text:list-style>
</office:automatic-styles><office:body><office:text>${body}</office:text></office:body></office:document-content>`;
  const styles = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles ${NS}><office:styles>${lineNumbersXml(page)}
<style:default-style style:family="paragraph"><style:paragraph-properties fo:margin-bottom="0.2cm"/><style:text-properties ${normalText(page)}/></style:default-style>
<style:style style:name="Standard" style:family="paragraph" style:class="text"/>
<style:style style:name="HeaderFooter" style:family="paragraph" style:parent-style-name="Standard" style:class="extra"><style:paragraph-properties fo:text-align="center"/><style:text-properties fo:font-size="9pt" fo:color="#666666"/></style:style>
<style:style style:name="Heading" style:family="paragraph" style:parent-style-name="Standard" style:next-style-name="Standard" style:class="text"><style:paragraph-properties fo:margin-top="0.42cm" fo:margin-bottom="0.21cm" fo:keep-with-next="always"/><style:text-properties fo:font-weight="bold"/></style:style>
${[[1, 20], [2, 16], [3, 14], [4, 12], [5, 11], [6, 11]].map(([l, pt]) => `<style:style style:name="Heading_20_${l}" style:display-name="Heading ${l}" style:family="paragraph" style:parent-style-name="Heading" style:default-outline-level="${l}" style:class="text"><style:text-properties fo:font-size="${pt}pt"/></style:style>`).join('\n')}
<style:style style:name="Quotations" style:family="paragraph" style:parent-style-name="Standard" style:class="html"><style:paragraph-properties fo:margin-left="1cm" fo:padding-left="0.2cm" fo:border-left="1.5pt solid #bbbbbb"/></style:style>
<style:style style:name="Preformatted_20_Text" style:display-name="Preformatted Text" style:family="paragraph" style:parent-style-name="Standard" style:class="html"><style:text-properties style:font-name="Liberation Mono" fo:font-family="'Liberation Mono'" fo:font-size="10pt"/></style:style>
<style:style style:name="Horizontal_20_Line" style:display-name="Horizontal Line" style:family="paragraph" style:parent-style-name="Standard" style:class="html"><style:paragraph-properties fo:padding="0cm" fo:border-bottom="0.5pt solid #bbbbbb"/></style:style>
<style:style style:name="Table_20_Contents" style:display-name="Table Contents" style:family="paragraph" style:parent-style-name="Standard" style:class="extra"/>
<style:style style:name="Table_20_Heading" style:display-name="Table Heading" style:family="paragraph" style:parent-style-name="Table_20_Contents" style:class="extra"><style:text-properties fo:font-weight="bold"/></style:style>
<style:style style:name="Footnote" style:family="paragraph" style:parent-style-name="Standard" style:class="extra"><style:text-properties fo:font-size="9pt"/></style:style>
<style:style style:name="Reference" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:margin-left="1.27cm" fo:text-indent="-1.27cm"/></style:style>
</office:styles><office:automatic-styles><style:style style:name="Wm" style:family="graphic"><style:graphic-properties draw:stroke="none" draw:fill="solid" draw:fill-color="#c0c0c0" draw:opacity="50%" draw:textarea-horizontal-align="center" draw:textarea-vertical-align="middle" draw:fit-to-size="true" style:run-through="background" style:wrap="run-through" style:number-wrapped-paragraphs="no-limit" style:vertical-pos="center" style:vertical-rel="page-content" style:horizontal-pos="center" style:horizontal-rel="page-content"/></style:style>${watermarkTextStyle(page)}<style:page-layout style:name="pm1"><style:page-layout-properties ${pageLayout(page)}>${columnsXml(page)}</style:page-layout-properties></style:page-layout></office:automatic-styles>
<office:master-styles>${masterPage(page)}</office:master-styles></office:document-styles>`;
  const meta = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-meta ${NS}><office:meta><dc:title>${x(title)}</dc:title><meta:generator>Workspace</meta:generator></office:meta></office:document-meta>`;
  const manifest = `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">
<manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="${ODT_MIME}"/>
<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>
<manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>
${pictures.map((p) => `<manifest:file-entry manifest:full-path="${x(p.path)}" manifest:media-type="${p.mime}"/>`).join('\n')}
</manifest:manifest>`;
  const zip = new JSZip();
  zip.file('mimetype', ODT_MIME, { compression: 'STORE' }); // first, and not compressed: how apps recognise the file
  zip.file('content.xml', content);
  zip.file('styles.xml', styles);
  zip.file('meta.xml', meta);
  zip.file('META-INF/manifest.xml', manifest);
  for (const p of pictures) zip.file(p.path, p.data);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', mimeType: ODT_MIME });
}

// ---- .odt → document ----
const h = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const kids = (el) => el?.children || [];
const textOf = (el) => (el.type === 'text' ? el.data : kids(el).map(textOf).join(''));

/** Read an .odt file: { doc } (pictures saved with savePicture(name, data, mime) → file id, when given). */
/** { font, fontSize } of an OpenDocument text file's normal text (the Standard style, else the paragraphs' default),
 *  when they're ones Page setup offers. */
export async function pageOfOdt(buffer) {
  try {
    const { DOC_FONTS, DOC_FONT_SIZES } = await import('../pagesetup.js');
    const zip = await JSZip.loadAsync(buffer);
    const styles = (await zip.file('styles.xml')?.async('string')) || '';
    const props = (xml) => /<style:text-properties\b([^>]*)\/?>/.exec(xml || '')?.[1] || '';
    // The Standard style's own text properties (none when it's an empty <style:style …/>: don't read on into the next style).
    const std = /<style:style\b[^>]*style:name="Standard"[^>]*?(\/>|>([\s\S]*?)<\/style:style>)/.exec(styles);
    const standard = props(std?.[1] === '/>' ? '' : std?.[2]);
    const defaults = props(/<style:default-style\b[^>]*style:family="paragraph"[^>]*>([\s\S]*?)<\/style:default-style>/.exec(styles)?.[1]);
    const pick = (re) => re.exec(standard)?.[1] ?? re.exec(defaults)?.[1];
    const family = String(pick(/fo:font-family="([^"]+)"/) || pick(/style:font-name="([^"]+)"/) || '').split(',')[0].replace(/['"&;]|apos|quot/g, '').trim();
    const size = Number((/^([\d.]+)pt$/.exec(pick(/fo:font-size="([^"]+)"/) || '') || [])[1]);
    const out = {};
    // The page: the master page's layout (the first one), as Page setup knows it (nearest paper and margins).
    const layout = /<style:page-layout-properties\b([^>]*)\/?>/.exec(styles)?.[1] || '';
    const len = (name) => { const m = new RegExp(`${name}="([\\d.]+)(cm|mm|in|pt)"`).exec(layout); return m ? Number(m[1]) * { cm: 10, mm: 1, in: 25.4, pt: 25.4 / 72 }[m[2]] : null; };
    const w = len('fo:page-width'), h = len('fo:page-height');
    if (w && h) {
      const PAPER = { a4: [210, 297], letter: [215.9, 279.4], legal: [215.9, 355.6], a5: [148, 210] };
      out.orientation = w > h ? 'landscape' : 'portrait';
      const [a, b] = [Math.min(w, h), Math.max(w, h)];
      const best = Object.entries(PAPER).map(([k, [pw, ph]]) => [k, Math.abs(pw - a) + Math.abs(ph - b)]).sort((x, y) => x[1] - y[1])[0];
      if (best[1] < 12) out.size = best[0];
    }
    const left = len('fo:margin-left');
    if (left) out.margin = Object.entries({ normal: 25.4, narrow: 12.7, wide: 38.1 }).sort((x, y) => Math.abs(x[1] - left) - Math.abs(y[1] - left))[0][0];
    const cols = Number(/<style:columns\b[^>]*fo:column-count="(\d+)"/.exec(styles)?.[1]);
    if (cols >= 2 && cols <= 3) out.columns = cols;
    // Line numbering is on unless it says otherwise (ODF's default is true; LibreOffice leaves it out then, and writes "false" when off).
    const numbering = /<text:linenumbering-configuration\b[^>]*>/.exec(styles)?.[0];
    if (numbering && !/text:number-lines="false"/.test(numbering)) out.lineNumbers = true;
    // Header and footer: the first master page's text (a page-number field: page numbers on).
    const master = /<style:master-page\b[^>]*?(?:\/>|>[\s\S]*?<\/style:master-page>)/.exec(styles)?.[0] || '';
    const textIn = (xml) => (xml || '').replace(/<text:page-number\b[\s\S]*?<\/text:page-number>|<text:page-number\b[^>]*\/>/g, '').replace(/<text:s(?:\s[^>]*)?\/>/g, ' ').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim().slice(0, 200);
    const head = /<style:header\b[^>]*>([\s\S]*?)<\/style:header>/.exec(master)?.[1];
    const foot = /<style:footer\b[^>]*>([\s\S]*?)<\/style:footer>/.exec(master)?.[1];
    // A watermark (LibreOffice's or ours): the text of the PowerPlusWaterMarkObject shape; the header without it.
    const wm = /<draw:custom-shape\b[^>]*draw:name="PowerPlusWaterMarkObject[^"]*"[^>]*>([\s\S]*?)<\/draw:custom-shape>/.exec(head || '');
    if (wm) { const t = textIn(wm[1].replace(/<draw:enhanced-geometry\b[\s\S]*?(?:\/>|<\/draw:enhanced-geometry>)/, '')); if (t) out.watermark = t.slice(0, 40); }
    const headText = wm ? head.replace(wm[0], '') : head;
    if (head && textIn(headText)) out.header = textIn(headText);
    else if (head && !wm) out.header = '';
    if (foot) { out.footer = textIn(foot); out.numbers = /<text:page-number\b/.test(foot); }
    const bg = /fo:background-color="(#[0-9a-fA-F]{6})"/.exec(layout)?.[1]?.toLowerCase();
    if (bg && bg !== '#ffffff') out.pageColor = bg;
    const f = DOC_FONTS.find((n) => n.toLowerCase() === family.toLowerCase());
    if (f) out.font = f;
    if (DOC_FONT_SIZES.includes(size)) out.fontSize = size;
    return out;
  } catch { return {}; }
}

export async function docFromOdt(buffer, { savePicture } = {}) {
  const zip = await JSZip.loadAsync(buffer);
  const contentXml = await zip.file('content.xml')?.async('string');
  if (!contentXml) throw new Error('Not an OpenDocument text file');
  const stylesXml = (await zip.file('styles.xml')?.async('string')) || '';
  const parse = (s) => parseDocument(s, { xmlMode: true, decodeEntities: true });
  const root = parse(contentXml), stylesRoot = parse(stylesXml);
  // The styles: what each text style looks like, how each paragraph style is aligned, which lists are numbered.
  const styles = new Map(), numbered = new Map();
  const readStyles = (node) => {
    for (const el of kids(node)) {
      if (el.type !== 'tag') continue;
      if (el.name === 'style:style') {
        const name = el.attribs['style:name'];
        const tp = kids(el).find((c) => c.name === 'style:text-properties')?.attribs || {};
        const pp = kids(el).find((c) => c.name === 'style:paragraph-properties')?.attribs || {};
        styles.set(name, { parent: el.attribs['style:parent-style-name'], tp, pp, list: el.attribs['style:list-style-name'], level: Number(el.attribs['style:default-outline-level']) || 0 });
      } else if (el.name === 'text:list-style') {
        numbered.set(el.attribs['style:name'], kids(el).filter((c) => c.type === 'tag').map((c) => c.name === 'text:list-level-style-number'));
      }
      readStyles(el);
    }
  };
  readStyles(stylesRoot); readStyles(root);
  // The document's default paragraph look (what every paragraph has unless it says otherwise).
  const defaultPP = /<style:default-style\b[^>]*style:family="paragraph"[^>]*>[\s\S]*?<style:paragraph-properties\b([^>]*?)\/?>/.exec(stylesXml)?.[1]?.match(/[\w:-]+="[^"]*"/g)?.reduce((o, a) => { const [k, v] = a.split('='); o[k] = v.slice(1, -1); return o; }, {}) || {};
  const look = (name) => { // a style with what it inherits: its look, the names it comes from, and a heading level
    const out = { tp: {}, pp: {}, names: [], level: 0 };
    const chain = [];
    for (let n = name, s = styles.get(n), i = 0; i < 10 && n; n = s?.parent, s = styles.get(n), i++) { out.names.push(String(n).toLowerCase()); if (s) chain.unshift(s); }
    for (const s of chain) { Object.assign(out.tp, s.tp); Object.assign(out.pp, s.pp); if (s.level) out.level = s.level; }
    const m = out.names.map((n) => /^heading_20_(\d)$/.exec(n)).find(Boolean);
    if (!out.level && m) out.level = Number(m[1]);
    return out;
  };
  const pictureCache = new Map();
  let picNo = 0;
  const pictureFor = async (href) => {
    if (!savePicture || !href || /^https?:/i.test(href)) return null;
    if (pictureCache.has(href)) return pictureCache.get(href);
    const f = zip.file(href.replace(/^\.?\//, ''));
    const ext = (/\.([a-z]+)$/i.exec(href) || [])[1]?.toLowerCase();
    const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp' }[ext];
    if (!f || !mime) return null;
    const id = await savePicture(`Picture ${++picNo}.${ext === 'jpeg' ? 'jpg' : ext}`, await f.async('nodebuffer'), mime);
    pictureCache.set(href, id);
    return id;
  };
  const wrap = (html, tp, span = false) => {
    let out = html;
    if (/bold|[6-9]00/.test(tp['fo:font-weight'] || '')) out = `<strong>${out}</strong>`;
    if (tp['fo:font-style'] === 'italic') out = `<em>${out}</em>`;
    if (tp['style:text-underline-style'] && tp['style:text-underline-style'] !== 'none') out = `<u>${out}</u>`;
    if (tp['style:text-line-through-style'] && tp['style:text-line-through-style'] !== 'none') out = `<s>${out}</s>`;
    const pos = tp['style:text-position'] || '';
    if (/^super|^\d/.test(pos) && !/^0/.test(pos)) out = `<sup>${out}</sup>`; else if (/^sub|^-/.test(pos)) out = `<sub>${out}</sub>`;
    const css = [COLOR.test(tp['fo:color'] || '') && !/^#000000$/i.test(tp['fo:color']) && `color: ${tp['fo:color']}`, COLOR.test(tp['fo:background-color'] || '') && `background-color: ${tp['fo:background-color']}`].filter(Boolean);
    // A word's own font and size (a span's, not the paragraph's): those the Docs toolbar offers.
    const family = String(tp['fo:font-family'] || tp['style:font-name'] || '').split(',')[0].replace(/['"]|&apos;|&quot;/g, '').trim();
    const font = span && ODT_FONTS[family.toLowerCase()];
    const size = span && Number((/^([\d.]+)pt$/.exec(tp['fo:font-size'] || '') || [])[1]);
    if (font) css.push(`font-family: ${font}`);
    if (span && ODT_SIZES.includes(size)) css.push(`font-size: ${size}pt`);
    if (css.length) out = `<span style="${css.join('; ').replace(/"/g, '&quot;')}">${out}</span>`;
    if (!font && /mono|courier|consolas/i.test(`${tp['style:font-name'] || ''} ${tp['fo:font-family'] || ''}`)) out = `<code>${out}</code>`; // other fixed-width fonts: code
    return out;
  };
  const inline = async (el) => {
    let out = '';
    for (const c of kids(el)) {
      if (c.type === 'text') { out += h(c.data); continue; }
      if (c.type !== 'tag') continue;
      switch (c.name) {
        case 'text:s': out += '\u00a0'.repeat(Math.min(100, Number(c.attribs['text:c']) || 1)); break; // kept, not folded into one
        case 'text:tab': out += '\t'; break;
        case 'text:line-break': out += '<br>'; break;
        case 'text:span': out += wrap(await inline(c), look(c.attribs['text:style-name']).tp, true); break;
        case 'text:a': { const href = c.attribs['xlink:href'] || ''; out += /^\s*javascript:/i.test(href) ? await inline(c) : `<a href="${h(href)}">${await inline(c)}</a>`; break; }
        case 'text:note': { const body = kids(c).find((k) => k.name === 'text:note-body'); out += `<sup data-footnote="" data-note="${h(textOf(body || {}).trim())}"></sup>`; break; }
        case 'draw:frame': {
          const img = kids(c).find((k) => k.name === 'draw:image');
          const alt = textOf(kids(c).find((k) => k.name === 'svg:desc' || k.name === 'svg:title') || { children: [] }).trim();
          const id = img && await pictureFor(img.attribs['xlink:href']);
          if (id) out += `<img src="pic:${id}" alt="${h(alt)}">`;
          else if (kids(c).find((k) => k.name === 'draw:text-box')) out += await inline(kids(c).find((k) => k.name === 'draw:text-box'));
          else out += '<em>[picture]</em>';
          break;
        }
        case 'text:bookmark': case 'text:bookmark-start': case 'text:bookmark-end': case 'office:annotation': case 'office:annotation-end': case 'text:soft-page-break': break;
        default: out += await inline(c); // fields, changes, ruby…: their text
      }
    }
    return out;
  };
  const ALIGN = { center: 'center', end: 'right', right: 'right', justify: 'justify' };
  const ptOf = (v, max = 72) => { const m = /^(-?[\d.]+)(pt|cm|mm|in)$/.exec(String(v || '')); if (!m) return null; const n = Number(m[1]) * { pt: 1, cm: 72 / 2.54, mm: 72 / 25.4, in: 72 }[m[2]]; return n > 0.05 && n <= max ? Math.round(n * 10) / 10 : null; };
  // A paragraph's alignment (from its style, and those it comes from), and its own line spacing and space before
  // and after (its own direct formatting only: what a named style like "Text Body" says is that style's look).
  const alignAttr = (styleName) => {
    const a = ALIGN[look(styleName).pp['fo:text-align']];
    // (LibreOffice writes both margins when one changes: the other, as the style it comes from has it, is no change.)
    const inherited = { ...defaultPP, ...(styles.get(styleName)?.parent ? look(styles.get(styleName).parent).pp : {}) };
    const same = (k, v) => inherited[k] === v || (/^fo:margin/.test(k) && Math.abs((ptOf(v) || 0) - (ptOf(inherited[k]) || 0)) < 0.2);
    const own = Object.fromEntries(Object.entries(styles.get(styleName)?.pp || {}).filter(([k, v]) => !same(k, v)));
    const lh = /^(\d+(?:\.\d+)?)%$/.exec(own['fo:line-height'] || '')?.[1];
    const css = [a && `text-align: ${a}`, lh && Number(lh) >= 50 && Number(lh) <= 400 && `line-height: ${Math.round(Number(lh)) / 100}`,
      ptOf(own['fo:margin-top']) && `margin-top: ${ptOf(own['fo:margin-top'])}pt`, ptOf(own['fo:margin-bottom']) && `margin-bottom: ${ptOf(own['fo:margin-bottom'])}pt`].filter(Boolean);
    // An indent from the left of its own (not a hanging one), in half-inch steps (36pt).
    const quote = look(styleName).names.some((n) => /^(quotations|quote|intense_20_quote)$/.test(n)); // (a quote's indent is the quote's own)
    const steps = quote || (own['fo:text-indent'] && /^-/.test(own['fo:text-indent'])) ? 0 : Math.min(8, Math.round((ptOf(own['fo:margin-left'], 400) || 0) / 36));
    return (css.length ? ` style="${css.join('; ')}"` : '') + (steps > 0 ? ` data-indent="${steps}"` : '');
  };
  const blocks = async (el, depth = 0, listStyle = null) => {
    let out = '';
    for (const c of kids(el)) {
      if (c.type !== 'tag') continue;
      const sn = c.attribs['text:style-name'];
      if (c.name === 'text:p') {
        const st = look(sn), named = (re) => st.names.some((n) => re.test(n));
        const raw = await inline(c);
        if (st.pp['fo:break-before'] === 'page' && out) { out += '<div data-page-break=""></div>'; if (!raw.trim()) continue; }
        if (named(/^horizontal( |_20_|_)line$/) && !raw.replace(/<[^>]+>/g, '').trim()) { out += '<hr>'; continue; }
        if (named(/preformatted/)) { out += `<pre><code>${raw.replace(/<br>/g, '\n').replace(/<[^>]+>/g, '').replace(/\u00a0/g, ' ')}</code></pre>`; continue; }
        if (/^\s*(<img [^>]*>\s*)+$/.test(raw)) { out += raw; continue; } // a picture on its own line: no empty paragraph around it
        const lv = named(/^title$/) ? 1 : st.level;
        const { 'fo:font-weight': weight, ...look2 } = st.tp; // a whole paragraph in a colour, italic…: on its text (a heading's boldness is its own)
        const inner = raw ? wrap(raw, lv ? look2 : st.tp) : raw;
        if (lv) out += `<h${Math.min(6, lv)}${alignAttr(sn)}>${inner}</h${Math.min(6, lv)}>`;
        else if (named(/^quotations?$/)) out += `<blockquote><p>${inner}</p></blockquote>`;
        else out += `<p${alignAttr(sn)}>${inner}</p>`;
      } else if (c.name === 'text:h') {
        const lv = Math.min(6, Math.max(1, Number(c.attribs['text:outline-level']) || 1));
        const { 'fo:font-weight': w, ...hl } = look(sn).tp;
        const inner = await inline(c);
        out += `<h${lv}${alignAttr(sn)}>${inner ? wrap(inner, hl) : inner}</h${lv}>`;
      } else if (c.name === 'text:list') {
        const ls = sn || listStyle;
        const isNum = (numbered.get(ls) || [])[depth] ?? false;
        const items = [];
        for (const li of kids(c).filter((k) => k.name === 'text:list-item' || k.name === 'text:list-header')) items.push(`<li>${await blocks(li, depth + 1, ls) || '<p></p>'}</li>`);
        out += `<${isNum ? 'ol' : 'ul'}>${items.join('')}</${isNum ? 'ol' : 'ul'}>`;
      } else if (c.name === 'table:table') {
        const rows = [];
        const collect = (n) => { for (const k of kids(n)) { if (k.name === 'table:table-row') rows.push({ row: k, head: n.name === 'table:table-header-rows' }); else if (/^table:table-(header-)?rows$/.test(k.name)) collect(k); } };
        collect(c);
        let html = '<table><tbody>';
        for (const { row, head } of rows) {
          html += '<tr>';
          for (const cell of kids(row).filter((k) => k.name === 'table:table-cell')) {
            const span = Number(cell.attribs['table:number-columns-spanned']) > 1 ? ` colspan="${Number(cell.attribs['table:number-columns-spanned'])}"` : '';
            const tag = head ? 'th' : 'td';
            const rep = Math.min(50, Number(cell.attribs['table:number-columns-repeated']) || 1);
            const inner = await blocks(cell, depth) || '<p></p>';
            for (let i = 0; i < rep; i++) html += `<${tag}${span}>${inner}</${tag}>`;
          }
          html += '</tr>';
        }
        out += `${html}</tbody></table>`;
      } else if (c.name === 'text:section' || c.name === 'text:index-body' || c.name === 'text:soft-page-break') out += await blocks(c, depth, listStyle);
      else if (/^text:(table-of-content|alphabetical-index|illustration-index|bibliography)$/.test(c.name)) out += await blocks(kids(c).find((k) => k.name === 'text:index-body') || {}, depth);
    }
    return out;
  };
  const text = (function find(n) { for (const k of kids(n)) { if (k.name === 'office:text') return k; const f = find(k); if (f) return f; } return null; })(root);
  const html = text ? await blocks(text) : '';
  // Page breaks as the document's own (the importer's HTML doesn't know them): marked, then put back.
  const parts = html.split('<div data-page-break=""></div>');
  const docs = parts.map((p) => docFromHtml(p || '<p></p>'));
  const content = docs.flatMap((d, i) => [...(i ? [{ type: 'pageBreak' }] : []), ...(d.content || [])]);
  return { doc: { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] } };
}

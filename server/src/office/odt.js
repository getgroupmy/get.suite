// OpenDocument text (.odt, LibreOffice Writer's own format), both ways. Out: headings, paragraphs (aligned),
// bold/italic/underline/strike/code, sub- and superscript, colour and highlight, links, lists and checklists,
// quotes, code blocks, tables, pictures, footnotes, page breaks, and chips as their text. In: the same,
// read from the file's content.xml (its automatic styles say which text is bold, which list numbered…).
import JSZip from 'jszip';
import crypto from 'node:crypto';
import { parseDocument } from 'htmlparser2';
import { imageSize } from 'image-size';
import { flattenTabs } from './doctabs.js';
import { chipText, dateText, eventLines } from './chiptext.js';
import { inText, reference, sourcesOf } from './cite.js';
import { chartTable } from './sheetchart.js';
import { dataChartObject, dataChartFromObject } from './odpchart.js';
import { latexToMathml, mathmlToLatex } from './mathml.js';
import { docFromHtml, columnWidthsOf, widthOfPicture, joinReplacements } from './word.js';

// The Docs toolbar's fonts (as written in files → the editor's CSS) and sizes (pt).
const ODT_FONTS = { arial: 'Arial, Helvetica, sans-serif', georgia: 'Georgia, serif', 'times new roman': '"Times New Roman", Times, serif', verdana: 'Verdana, Geneva, sans-serif', 'trebuchet ms': '"Trebuchet MS", sans-serif', 'courier new': '"Courier New", Courier, monospace' };
const ODT_SIZES = [8, 9, 10, 11, 12, 14, 18, 24, 30, 36];
export const ODT_MIME = 'application/vnd.oasis.opendocument.text';
// (characters XML can't hold — control characters such as CHAR(1) gives, a lone surrogate — are left out: one would
// make the whole file unreadable)
const x = (s) => String(s ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Text as ODF wants it: runs of spaces as <text:s/>, tabs and line breaks as elements. */
const odfText = (s) => x(s).replace(/\t/g, '<text:tab/>').replace(/\n/g, '<text:line-break/>').replace(/ {2,}/g, (m) => ` <text:s text:c="${m.length - 1}"/>`);
const COLOR = /^#[0-9a-f]{6}$/i;
// <text:s/>, read: a character the HTML step keeps as it is (spaces it would fold), an ordinary space afterwards.
const SPACE = '\uE000';

// ---- document → .odt ----
/** The page: paper size and orientation, margins and page colour from Page setup (A4 portrait, 2 cm, white without one). */
const PAPER_MM = { a4: [210, 297], letter: [215.9, 279.4], legal: [215.9, 355.6], a5: [148, 210] }, MARGINS_MM = { normal: 25.4, narrow: 12.7, wide: 38.1 };
const paperOf = (page) => {
  let [w, h] = PAPER_MM[page?.size] || PAPER_MM.a4;
  const landscape = page?.orientation === 'landscape';
  if (landscape) [w, h] = [h, w];
  return { w, h, landscape, m: page?.margin ? MARGINS_MM[page.margin] || 20 : 20 };
};
/** The width between the margins, in cm (17 on A4 without Page setup). */
export const textWidthCm = (page) => { const { w, m } = paperOf(page); return (w - 2 * m) / 10; };
export function pageLayout(page) {
  const { w, h, landscape, m } = paperOf(page);
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

export async function odtFromDoc(doc, title = 'Document', { pictureData, page = null, comments = [] } = {}) {
  doc = flattenTabs(doc);
  // Comment threads: each an annotation where its words start (its replies after it, as LibreOffice writes them),
  // ended where its words end. The text nodes carrying each thread's mark, first and last.
  const threads = new Map((comments || []).map((c) => [c.id, c]));
  const firstOf = new Map(), lastOf = new Map();
  (function scan(n) { if (n.type === 'text') for (const m of n.marks || []) if (m.type === 'comment' && threads.has(m.attrs?.id)) { if (!firstOf.has(m.attrs.id)) firstOf.set(m.attrs.id, n); lastOf.set(m.attrs.id, n); } (n.content || []).forEach(scan); })(doc);
  const annoName = (id) => `c${String(id).replace(/[^A-Za-z0-9_-]/g, '')}`;
  // Pending suggestions: LibreOffice's tracked changes (each a changed region, by whoever suggested it and when).
  const changedRegions = [];
  const changeInfo = (sg) => `<office:change-info><dc:creator>${x(String(sg.name || 'Workspace').slice(0, 100))}</dc:creator><dc:date>${new Date(sg.at || Date.now()).toISOString().slice(0, 19)}</dc:date></office:change-info>`;
  const note = (c, attrs = '') => `<office:annotation${attrs}><dc:creator>${x(c.author || '')}</dc:creator><dc:date>${new Date(c.at || Date.now()).toISOString().slice(0, 19)}</dc:date>${String(c.text || '').split('\n').map((l) => `<text:p>${x(l)}</text:p>`).join('')}</office:annotation>`;
  const startOf = (id) => { const c = threads.get(id); return note(c, ` office:name="${annoName(id)}"`) + (c.replies || []).map((r, k) => note(r, ` office:name="${annoName(id)}r${k + 1}" loext:parent-name="${annoName(id)}"`)).join(''); };
  const textStyles = new Map(); // key → name
  const textStyle = (props) => {
    const key = JSON.stringify(props);
    if (!textStyles.has(key)) textStyles.set(key, { name: `T${textStyles.size + 1}`, props });
    return textStyles.get(key).name;
  };
  const pictures = []; // { path, data, mime }
  const chartObjects = []; // charts from spreadsheets, as chart objects (Object 1, Object 2…)
  const formulaObjects = []; // equations, as formula objects in MathML (Formula 1, Formula 2…)
  const sheetChartObject = (n, w = 17, h = 8) => { let d = n.attrs?.data; if (typeof d === 'string') { try { d = JSON.parse(d); } catch { d = null; } } return d?.series?.length ? dataChartObject({ chartType: n.attrs?.chartType || 'column', title: n.attrs?.title || '', data: d }, w, h) : null; };
  let noteNo = 0;
  const inline = (nodes = []) => {
    let out = '';
    for (const n of nodes) {
      const t = n.type;
      if (t === 'hardBreak') { out += '<text:line-break/>'; continue; }
      // A bookmark: one LibreOffice keeps (bm_…, as in the Word download), which links in the document go to.
      if (t === 'bookmark') { if (/^[a-z0-9]{6,16}$/.test(n.attrs?.id || '')) out += `<text:bookmark text:name="bm_${n.attrs.id}"/>`; continue; }
      if (t === 'footnote') { noteNo++; out += `<text:note text:id="ftn${noteNo}" text:note-class="footnote"><text:note-citation>${noteNo}</text:note-citation><text:note-body><text:p text:style-name="Footnote">${odfText(n.attrs?.note || '')}</text:p></text:note-body></text:note>`; continue; }
      let text = null;
      if (t === 'mention') text = `@${n.attrs?.name || ''}`;
      else if (t === 'datechip') text = dateText(n.attrs?.date);
      else if (t === 'filechip') text = n.attrs?.name || '';
      else if (t === 'dropchip') text = chipText(n.attrs);
      else if (t === 'math') {
        // An equation: a formula object (LibreOffice Math's), drawn in the line; its LaTeX kept in it.
        const l = String(n.attrs?.latex || '').trim();
        if (l) {
          formulaObjects.push(latexToMathml(l));
          const k = formulaObjects.length, wCm = Math.min(16, Math.max(0.6, [...l.replace(/\\[a-zA-Z]+|[{}^_]/g, 'x')].length * 0.22));
          out += `<draw:frame draw:name="Formula ${k}" text:anchor-type="as-char" svg:width="${wCm.toFixed(2)}cm" svg:height="0.60cm"><draw:object xlink:href="./Formula ${k}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/><svg:desc>${x(l)}</svg:desc></draw:frame>`;
          continue;
        }
        text = '';
      }
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
      if (href && !/^\s*javascript:/i.test(href)) run = `<text:a xlink:type="simple" xlink:href="${x(String(href).replace(/^#bm-([a-z0-9]{6,16})$/, '#bm_$1'))}">${run}</text:a>`; // (a link to a bookmark: to its name)
      const sg = marks.get('suggestInsert') || marks.get('suggestDelete');
      if (sg) { // an insertion between its start and end; a deletion kept in its region, a mark where it was
        const cid = `ct${changedRegions.length + 1}`;
        if (marks.has('suggestInsert')) { changedRegions.push(`<text:changed-region text:id="${cid}"><text:insertion>${changeInfo(sg.attrs || {})}</text:insertion></text:changed-region>`); run = `<text:change-start text:change-id="${cid}"/>${run}<text:change-end text:change-id="${cid}"/>`; }
        else { // (its words in a paragraph of their own: a space at either end written as one, or it would be dropped)
          const kept = run.replace(/^((?:<[^/][^>]*>)*) /, '$1<text:s/>').replace(/ ((?:<\/[^>]+>)*)$/, '<text:s/>$1');
          changedRegions.push(`<text:changed-region text:id="${cid}"><text:deletion>${changeInfo(sg.attrs || {})}<text:p>${kept}</text:p></text:deletion></text:changed-region>`);
          run = `<text:change text:change-id="${cid}"/>`;
        }
      }
      for (const [id, first] of firstOf) if (first === n) run = startOf(id) + run;
      for (const [id, last] of lastOf) if (last === n) run += `<office:annotation-end office:name="${annoName(id)}"/>`;
      out += run;
    }
    return out;
  };
  const picture = (n) => {
    const id = n.attrs?.fileId;
    const p = id && picturesById.get(id);
    if (!p) return n.attrs?.alt ? odfText(`[${n.attrs.alt}]`) : '';
    // Its size: the share of the page's width chosen in Docs (25%, 50%…), or as it is, at most the page's width.
    let w = 400, h = 300;
    try { const s = imageSize(p.data); w = s.width; h = s.height; } catch { /* unknown size */ }
    const share = /^(\d+(?:\.\d+)?)%$/.exec(String(n.attrs?.width || ''))?.[1];
    const textCm = textWidthCm(page);
    const cm = share ? Math.max(0.3, Math.min(textCm, (textCm * Number(share)) / 100)) : Math.min(textCm, (w * 2.54) / 96), hcm = cm * (h / w || 0.75);
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
  // A cell with a colour of its own: a cell style for each colour used (Cell_fef7e0…).
  const tableStyles = []; // tables with column widths of their own
  const cellColours = new Set();
  const cellStyle = (bg) => { const hex = /^#([0-9a-f]{6})$/i.exec(bg || '')?.[1]?.toLowerCase(); if (!hex) return 'Cell'; cellColours.add(hex); return `Cell_${hex}`; };
  const cellStyles = () => [...cellColours].map((hex) => `<style:style style:name="Cell_${hex}" style:family="table-cell"><style:table-cell-properties fo:padding="0.1cm" fo:border="0.5pt solid #999999" fo:background-color="#${hex}"/></style:style>`).join('');
  const spacedStyles = () => [...spaced].map(([key, name]) => { const [base, props] = key.split('|'); return `<style:style style:name="${name}" style:family="paragraph" style:parent-style-name="${base}"><style:paragraph-properties ${props}/></style:style>`; }).join('');
  const para = (n, style = 'Standard') => `<text:p text:style-name="${styleOf(style, n.attrs)}">${inline(n.content)}</text:p>`;
  // A table of contents: LibreOffice's own (it updates it, Tools → Update), its entries links to bookmarks on the
  // headings (toc_1…, as in the Word download).
  const plainOf = (n) => (n.text ?? (n.content || []).map(plainOf).join(''));
  const headings = [];
  (function gather(n) { if (n.type === 'heading') { const text = plainOf(n).trim(); if (text) headings.push({ node: n, level: Math.min(6, n.attrs?.level || 1), text }); return; } if (n.type !== 'paragraph') for (const c of n.content || []) gather(c); })(doc || {});
  const withContents = JSON.stringify(doc || {}).includes('"type":"tableOfContents"');
  const tocMark = (n) => { const k = withContents ? headings.findIndex((h) => h.node === n) : -1; return k >= 0 ? `<text:bookmark text:name="toc_${k + 1}"/>` : ''; };
  const contentsXml = () => {
    const levels = [1, 2, 3, 4, 5, 6].map((l) => `<text:table-of-content-entry-template text:outline-level="${l}" text:style-name="Contents_20_${l}"><text:index-entry-link-start text:style-name="Index_20_Link"/><text:index-entry-text/><text:index-entry-link-end/></text:table-of-content-entry-template>`).join('');
    const entries = headings.map((h, k) => `<text:p text:style-name="Contents_20_${h.level}"><text:a xlink:type="simple" xlink:href="#toc_${k + 1}" text:style-name="Index_20_Link" text:visited-style-name="Index_20_Link">${odfText(h.text)}</text:a></text:p>`).join('');
    return `<text:table-of-content text:protected="true" text:name="Table of Contents1"><text:table-of-content-source text:outline-level="6" text:use-index-marks="false"><text:index-title-template text:style-name="Contents_20_Heading">Contents</text:index-title-template>${levels}</text:table-of-content-source><text:index-body><text:index-title text:name="Table of Contents1_Head"><text:p text:style-name="Contents_20_Heading">Contents</text:p></text:index-title>${entries || '<text:p text:style-name="Contents_20_1"/>'}</text:index-body></text:table-of-content>`;
  };
  const blocks = (nodes = [], ctx = {}) => {
    let out = '';
    for (const n of nodes) {
      const t = n.type;
      if (t === 'paragraph') out += para(n, ctx.style || 'Standard');
      else if (t === 'tableOfContents') out += contentsXml();
      else if (t === 'heading') { const lv = Math.min(6, n.attrs?.level || 1); out += `<text:h text:style-name="${styleOf(`Heading_20_${lv}`, n.attrs)}" text:outline-level="${lv}">${tocMark(n)}${inline(n.content)}</text:h>`; }
      else if (t === 'bulletList' || t === 'orderedList') {
        const start = t === 'orderedList' ? Math.max(1, Math.min(9999, Math.round(Number(n.attrs?.start) || 1))) : 1; // (a numbered list's first number)
        out += `<text:list text:style-name="${t === 'orderedList' ? 'LNum' : 'LBul'}">${(n.content || []).map((li, i) => `<text:list-item${i === 0 && start > 1 ? ` text:start-value="${start}"` : ''}>${blocks(li.content, ctx)}</text:list-item>`).join('')}</text:list>`;
      } else if (t === 'taskList') {
        for (const li of n.content || []) {
          const [first, ...rest] = li.content || [];
          out += `<text:p text:style-name="Standard">${li.attrs?.checked ? '☑' : '☐'} ${first?.type === 'paragraph' ? inline(first.content) : ''}</text:p>${blocks(first?.type === 'paragraph' ? rest : li.content, ctx)}`;
        }
      } else if (t === 'blockquote') out += blocks(n.content, { ...ctx, style: 'Quotations' });
      else if (t === 'codeBlock') out += `<text:p text:style-name="Preformatted_20_Text">${odfText((n.content || []).map((c) => c.text).join(''))}</text:p>`;
      else if (t === 'horizontalRule') out += '<text:p text:style-name="Horizontal_20_Line"/>';
      else if (t === 'pageBreak') out += '<text:p text:style-name="PageBreak"/>';
      else if (t === 'image') out += `<text:p text:style-name="${styleOf('Standard', { textAlign: n.attrs?.align })}">${picture(n)}</text:p>`;
      else if (t === 'table') {
        const rows = n.content || [];
        const width = Math.max(1, ...rows.map((r) => (r.content || []).reduce((k, c) => k + (c.attrs?.colspan || 1), 0)));
        // Columns someone made wider or narrower: a column style each (fitted to the page's 17 cm), on a table as wide as they are.
        const px = columnWidthsOf(n);
        if (px && px.length === width) {
          const k = Math.min(1, 17 / (px.reduce((a, b) => a + b, 0) * 2.54 / 96)), no = ++tableNo;
          const cm = px.map((w) => Math.max(0.5, (w * 2.54 / 96) * k));
          tableStyles.push(`<style:style style:name="Tbl${no}" style:family="table"><style:table-properties style:width="${cm.reduce((a, b) => a + b, 0).toFixed(3)}cm" table:align="left"/></style:style>`,
            ...cm.map((w, i) => `<style:style style:name="Tbl${no}C${i + 1}" style:family="table-column"><style:table-column-properties style:column-width="${w.toFixed(3)}cm"/></style:style>`));
          out += `<table:table table:name="Table${no}" table:style-name="Tbl${no}">${cm.map((w, i) => `<table:table-column table:style-name="Tbl${no}C${i + 1}"/>`).join('')}`;
        } else out += `<table:table table:name="Table${++tableNo}" table:style-name="Tbl"><table:table-column table:number-columns-repeated="${width}"/>`;
        const headed = rows.length > 1 && (rows[0].content || []).every((c) => c.type === 'tableHeader');
        // Cells merged down over rows below: those rows get covered cells where they are (rowsLeft: per column, how many more rows).
        const rowsLeft = [];
        rows.forEach((r, ri) => {
          if (headed && ri === 0) out += '<table:table-header-rows>';
          out += '<table:table-row>';
          let col = 0;
          const coveredHere = () => { while (rowsLeft[col] > 0) { out += '<table:covered-table-cell/>'; rowsLeft[col]--; col++; } };
          for (const c of r.content || []) {
            coveredHere();
            const cs = Math.max(1, c.attrs?.colspan || 1), rs = Math.max(1, c.attrs?.rowspan || 1);
            const span = `${cs > 1 ? ` table:number-columns-spanned="${cs}"` : ''}${rs > 1 ? ` table:number-rows-spanned="${rs}"` : ''}`;
            out += `<table:table-cell table:style-name="${cellStyle(c.attrs?.background)}" office:value-type="string"${span}>${blocks(c.content, { style: c.type === 'tableHeader' ? 'Table_20_Heading' : 'Table_20_Contents' }) || '<text:p/>'}</table:table-cell>`;
            for (let k = 1; k < cs; k++) out += '<table:covered-table-cell/>';
            for (let k = 0; k < cs; k++) rowsLeft[col + k] = rs - 1;
            col += cs;
          }
          while (col < rowsLeft.length) { if (rowsLeft[col] > 0) { out += '<table:covered-table-cell/>'; rowsLeft[col]--; } col++; }
          out += '</table:table-row>';
          if (headed && ri === 0) out += '</table:table-header-rows>';
        });
        out += '</table:table>';
      } else if (t === 'sheetChart' && sheetChartObject(n)) {
        // A chart from a spreadsheet: a chart object carrying its figures (Writer draws it as a chart), named with the
        // spreadsheet and chart it comes from, so it stays linked when the file comes back.
        const a = n.attrs || {};
        const wCm = 17, hCm = Math.max(3, Math.min(20, (Number(a.height) || 320) * 2.54 / 96));
        chartObjects.push(sheetChartObject(n, wCm, hCm));
        const name = a.fileId && a.chartId ? `sheetchart:${a.fileId}:${a.chartId}` : `Chart ${chartObjects.length}`;
        out += `<text:p text:style-name="Standard"><draw:frame draw:name="${x(name)}" text:anchor-type="as-char" svg:width="${wCm}cm" svg:height="${hCm.toFixed(2)}cm"><draw:object xlink:href="./Object ${chartObjects.length}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/><svg:title>${x(a.title || 'Chart')}</svg:title></draw:frame></text:p>`;
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
      } else if (n.content) out += blocks(n.content, ctx);
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
  const NS = 'xmlns:loext="urn:org:documentfoundation:names:experimental:office:xmlns:loext:1.0" xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" office:version="1.3"';
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content ${NS}><office:font-face-decls><style:font-face style:name="Liberation Mono" svg:font-family="'Liberation Mono'" style:font-pitch="fixed"/></office:font-face-decls><office:automatic-styles>${auto}${aligned}${spacedStyles()}${cellStyles()}${tableStyles.join('')}
<style:style style:name="PageBreak" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:break-before="page"/></style:style>
<style:style style:name="Tbl" style:family="table"><style:table-properties style:width="17cm" table:align="margins"/></style:style>
<style:style style:name="Cell" style:family="table-cell"><style:table-cell-properties fo:padding="0.1cm" fo:border="0.5pt solid #999999"/></style:style>
<text:list-style style:name="LBul">${[1, 2, 3, 4, 5, 6].map((l) => `<text:list-level-style-bullet text:level="${l}" text:bullet-char="${'•◦▪'[(l - 1) % 3]}"><style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" text:list-tab-stop-position="${0.63 * l}cm" fo:text-indent="-0.63cm" fo:margin-left="${0.63 * l}cm"/></style:list-level-properties></text:list-level-style-bullet>`).join('')}</text:list-style>
<text:list-style style:name="LNum">${[1, 2, 3, 4, 5, 6].map((l) => `<text:list-level-style-number text:level="${l}" style:num-suffix="." style:num-format="${['1', 'a', 'i'][(l - 1) % 3]}"><style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" text:list-tab-stop-position="${0.63 * l}cm" fo:text-indent="-0.63cm" fo:margin-left="${0.63 * l}cm"/></style:list-level-properties></text:list-level-style-number>`).join('')}</text:list-style>
</office:automatic-styles><office:body><office:text>${changedRegions.length ? `<text:tracked-changes text:track-changes="false">${changedRegions.join('')}</text:tracked-changes>` : ''}${body}</office:text></office:body></office:document-content>`;
  const styles = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles ${NS}><office:styles>${lineNumbersXml(page)}
<style:default-style style:family="paragraph"><style:paragraph-properties fo:margin-bottom="0.2cm"/><style:text-properties ${normalText(page)}/></style:default-style>
<style:style style:name="Standard" style:family="paragraph" style:class="text"/>
<style:style style:name="HeaderFooter" style:family="paragraph" style:parent-style-name="Standard" style:class="extra"><style:paragraph-properties fo:text-align="center"/><style:text-properties fo:font-size="9pt" fo:color="#666666"/></style:style>
<style:style style:name="Heading" style:family="paragraph" style:parent-style-name="Standard" style:next-style-name="Standard" style:class="text"><style:paragraph-properties fo:margin-top="0.42cm" fo:margin-bottom="0.21cm" fo:keep-with-next="always"/><style:text-properties fo:font-weight="bold"/></style:style>
${[[1, 20], [2, 16], [3, 14], [4, 12], [5, 11], [6, 11]].map(([l, pt]) => `<style:style style:name="Heading_20_${l}" style:display-name="Heading ${l}" style:family="paragraph" style:parent-style-name="Heading" style:default-outline-level="${l}" style:class="text"><style:text-properties fo:font-size="${pt}pt"/></style:style>`).join('\n')}
<style:style style:name="Quotations" style:family="paragraph" style:parent-style-name="Standard" style:class="html"><style:paragraph-properties fo:margin-left="1cm" fo:padding-left="0.2cm" fo:border-left="1.5pt solid #bbbbbb"/></style:style>
<style:style style:name="Preformatted_20_Text" style:display-name="Preformatted Text" style:family="paragraph" style:parent-style-name="Standard" style:class="html"><style:text-properties style:font-name="Liberation Mono" fo:font-family="'Liberation Mono'" fo:font-size="10pt"/></style:style>
<style:style style:name="Contents_20_Heading" style:display-name="Contents Heading" style:family="paragraph" style:parent-style-name="Standard" style:class="index"><style:paragraph-properties fo:margin-top="0.2cm" fo:margin-bottom="0.2cm"/><style:text-properties fo:font-size="14pt" fo:font-weight="bold"/></style:style>${[1, 2, 3, 4, 5, 6].map((l) => `<style:style style:name="Contents_20_${l}" style:display-name="Contents ${l}" style:family="paragraph" style:parent-style-name="Standard" style:class="index"><style:paragraph-properties fo:margin-left="${((l - 1) * 0.5).toFixed(1)}cm" fo:margin-top="0cm" fo:margin-bottom="0.1cm"/></style:style>`).join('')}<style:style style:name="Index_20_Link" style:display-name="Index Link" style:family="text"/><style:style style:name="Horizontal_20_Line" style:display-name="Horizontal Line" style:family="paragraph" style:parent-style-name="Standard" style:class="html"><style:paragraph-properties fo:padding="0cm" fo:border-bottom="0.5pt solid #bbbbbb"/></style:style>
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
${chartObjects.map((o, k) => `<manifest:file-entry manifest:full-path="Object ${k + 1}/" manifest:version="1.3" manifest:media-type="application/vnd.oasis.opendocument.chart"/><manifest:file-entry manifest:full-path="Object ${k + 1}/content.xml" manifest:media-type="text/xml"/>`).join('\n')}
${formulaObjects.map((o, k) => `<manifest:file-entry manifest:full-path="Formula ${k + 1}/" manifest:version="1.3" manifest:media-type="application/vnd.oasis.opendocument.formula"/><manifest:file-entry manifest:full-path="Formula ${k + 1}/content.xml" manifest:media-type="text/xml"/>`).join('\n')}
</manifest:manifest>`;
  const zip = new JSZip();
  zip.file('mimetype', ODT_MIME, { compression: 'STORE' }); // first, and not compressed: how apps recognise the file
  zip.file('content.xml', content);
  zip.file('styles.xml', styles);
  zip.file('meta.xml', meta);
  zip.file('META-INF/manifest.xml', manifest);
  for (const p of pictures) zip.file(p.path, p.data);
  chartObjects.forEach((o, k) => zip.file(`Object ${k + 1}/content.xml`, o));
  formulaObjects.forEach((o, k) => zip.file(`Formula ${k + 1}/content.xml`, o));
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
    // (LibreOffice writes several layouts, an empty one first: take the one the first master page uses, else the first with a size.)
    const usedName = /<style:master-page\b[^>]*style:page-layout-name="([^"]+)"/.exec(styles)?.[1];
    const layoutOf = (name) => new RegExp(`<style:page-layout\\b[^>]*style:name="${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>\\s*<style:page-layout-properties\\b([^>]*)\\/?>`).exec(styles)?.[1];
    const layout = (usedName && layoutOf(usedName)) || [...styles.matchAll(/<style:page-layout-properties\b([^>]*)\/?>/g)].map((m) => m[1]).find((a) => /fo:page-width=/.test(a)) || '';
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
  const lengthCm = (v) => { const m = /^([\d.]+)(cm|mm|in|pt)$/.exec(String(v || '').trim()); return m ? Number(m[1]) * { cm: 1, mm: 0.1, in: 2.54, pt: 2.54 / 72 }[m[2]] : 0; };
  // The width between the page's margins (the first page layout with a size), for pictures' sizes.
  const pl = /<style:page-layout-properties\b([^>]*fo:page-width=[^>]*)>/.exec(stylesXml)?.[1] || '';
  const plv = (k) => lengthCm(new RegExp(`${k}="([^"]+)"`).exec(pl)?.[1]);
  const textCm = plv('fo:page-width') - plv('fo:margin-left') - plv('fo:margin-right');
  // Equations: each formula object's LaTeX (ours keep it; LibreOffice Math's are read from their MathML), by its folder.
  const formulas = new Map();
  for (const f of Object.keys(zip.files).filter((n) => /^[^/]+\/content\.xml$/.test(n)).slice(0, 500)) {
    const xml = await zip.file(f).async('string');
    if (!/<(?:\w+:)?math\b/.test(xml.slice(0, 2000))) continue;
    const l = mathmlToLatex(xml);
    if (l) formulas.set(f.replace(/\/content\.xml$/, ''), l.slice(0, 2000));
  }
  // The styles: what each text style looks like, how each paragraph style is aligned, which lists are numbered.
  const styles = new Map(), numbered = new Map();
  const numberedFrom = new Map(); // a list style's first number at each level
  let lastNumbered = 0; // the last number of the latest numbered list at the top (for a list that carries on from it)
  const readStyles = (node) => {
    for (const el of kids(node)) {
      if (el.type !== 'tag') continue;
      if (el.name === 'style:style') {
        const name = el.attribs['style:name'];
        const tp = kids(el).find((c) => c.name === 'style:text-properties')?.attribs || {};
        const pp = kids(el).find((c) => c.name === 'style:paragraph-properties')?.attribs || {};
        const cp = kids(el).find((c) => c.name === 'style:table-cell-properties')?.attribs || {};
        const colp = kids(el).find((c) => c.name === 'style:table-column-properties')?.attribs || {};
        styles.set(name, { parent: el.attribs['style:parent-style-name'], tp, pp, cp, colp, list: el.attribs['style:list-style-name'], level: Number(el.attribs['style:default-outline-level']) || 0 });
      } else if (el.name === 'text:list-style') {
        numbered.set(el.attribs['style:name'], kids(el).filter((c) => c.type === 'tag').map((c) => c.name === 'text:list-level-style-number'));
        numberedFrom.set(el.attribs['style:name'], kids(el).filter((c) => c.type === 'tag').map((c) => Number(c.attribs?.['text:start-value']) || 1));
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
  // Tracked changes (LibreOffice's): each region's kind, who and when, and a deletion's words; an insertion open now.
  const changes = new Map();
  let openInsertion = null, suggNo = 0;
  for (const r of (function all(n, acc = []) { for (const k of kids(n)) { if (k.type !== 'tag') continue; if (k.name === 'text:changed-region') acc.push(k); else all(k, acc); } return acc; })(root)) {
    const kind = kids(r).find((k) => k.name === 'text:insertion' || k.name === 'text:deletion');
    if (!kind) continue; // (a format change: not a suggestion here)
    const info = kids(kind).find((k) => k.name === 'office:change-info');
    const who = textOf(kids(info || {}).find((k) => k.name === 'dc:creator') || { children: [] }).trim();
    const when = Date.parse(`${textOf(kids(info || {}).find((k) => k.name === 'dc:date') || { children: [] }).trim().replace(/Z?$/, 'Z')}`) || 0;
    changes.set(r.attribs['text:id'] || r.attribs['xml:id'], { kind: kind.name === 'text:insertion' ? 'ins' : 'del', who, when, el: kind, no: ++suggNo });
  }
  const suggAttrs = (ch) => `data-sugg="o${ch.no}" data-name="${h(ch.who.slice(0, 100))}" data-at="${ch.when}"`;
  // A run of text: marked as inserted while an insertion is open, and as a comment's words while one is.
  const leaf = (html, raw = '') => {
    const open = openNotes.length && notes.get(openNotes[openNotes.length - 1]);
    if (open) { open.quote += raw; html = `<span data-comment="${open.id}">${html}</span>`; }
    return openInsertion ? `<ins ${suggAttrs(openInsertion)}>${html}</ins>` : html;
  };
  const inline = async (el) => {
    let out = '';
    for (const c of kids(el)) {
      if (c.type === 'text') { out += leaf(h(c.data), c.data); continue; }
      if (c.type !== 'tag') continue;
      switch (c.name) {
        case 'text:change-start': { const ch = changes.get(c.attribs['text:change-id']); if (ch?.kind === 'ins') openInsertion = ch; break; }
        case 'text:change-end': { if (openInsertion && changes.get(c.attribs['text:change-id']) === openInsertion) openInsertion = null; break; }
        case 'text:change': { // a deletion: its words, marked as deleted
          const ch = changes.get(c.attribs['text:change-id']);
          if (ch?.kind !== 'del') break;
          const was = openInsertion; openInsertion = null;
          const words = [];
          for (const p of kids(ch.el).filter((k) => k.name === 'text:p' || k.name === 'text:h')) words.push(await inline(p));
          openInsertion = was;
          if (words.join('')) out += `<del ${suggAttrs(ch)}>${words.join(' ')}</del>`;
          break;
        }
        case 'text:s': out += leaf(SPACE.repeat(Math.min(100, Number(c.attribs['text:c']) || 1))); break; // kept, not folded into one (an ordinary space in the end)
        case 'text:tab': out += '\t'; break;
        case 'text:line-break': out += '<br>'; break;
        case 'text:span': { const st = look(c.attribs['text:style-name']); out += wrap(await inline(c), st.names.some((n) => /^(visited_20_)?internet_20_link$/.test(n)) ? {} : st.tp, true); break; } // a link's own look (blue, underlined) is the link's, not formatting
        case 'text:a': { const href = bookmarkHref(c.attribs['xlink:href'] || ''); out += /^\s*javascript:/i.test(href) ? await inline(c) : `<a href="${h(href)}">${await inline(c)}</a>`; break; }
        case 'text:note': { const body = kids(c).find((k) => k.name === 'text:note-body'); out += `<sup data-footnote="" data-note="${h(textOf(body || {}).trim())}"></sup>`; break; }
        case 'draw:frame': {
          const fo = kids(c).find((k) => k.name === 'draw:object' || k.name === 'draw:object-ole'); // (LibreOffice without its Math part keeps ours as the latter)
          const fl = fo && formulas.get(String(fo.attribs['xlink:href'] || '').replace(/^\.\//, '').replace(/\/$/, ''));
          if (fl) { out += `<span data-math="" data-latex="${h(fl)}"></span>`; break; } // an equation
          const img = kids(c).find((k) => k.name === 'draw:image');
          const alt = textOf(kids(c).find((k) => k.name === 'svg:desc' || k.name === 'svg:title') || { children: [] }).trim();
          const id = img && await pictureFor(img.attribs['xlink:href']);
          if (id) {
            // Its size as a share of the page (none when it's at its own size), as Docs keeps it.
            const wcm = lengthCm(c.attribs['svg:width']);
            let width = null;
            if (wcm && textCm) { const f = zip.file(String(img.attribs['xlink:href']).replace(/^\.?\//, '')); width = widthOfPicture({ px: (wcm / 2.54) * 96, pagePx: (textCm / 2.54) * 96 }, f ? await f.async('nodebuffer') : null); }
            out += `<img src="pic:${id}" alt="${h(alt)}"${width ? ` width="${width}"` : ''}>`;
          }
          else if (kids(c).find((k) => k.name === 'draw:text-box')) out += await inline(kids(c).find((k) => k.name === 'draw:text-box'));
          else out += '<em>[picture]</em>';
          break;
        }
        case 'text:bookmark': case 'text:bookmark-start': { const id = bookmarkId(c.attribs['text:name']); if (id) out += `<span data-bookmark="${id}"></span>`; break; }
        case 'office:annotation': { // a comment: its thread (a reply when it names its parent), its words from here
          const parent = c.attribs['loext:parent-name'];
          const body = kids(c).filter((k) => k.name === 'text:p' || k.name === 'text:list').map(textOf).join('\n').trim();
          const info = { author: textOf(kids(c).find((k) => k.name === 'dc:creator') || { children: [] }).trim(), at: Date.parse(textOf(kids(c).find((k) => k.name === 'dc:date') || { children: [] }).trim()) || null, text: body };
          if (parent && notes.has(parent)) { notes.get(parent).replies.push(info); break; }
          const id = crypto.randomBytes(8).toString('hex');
          notes.set(c.attribs['office:name'] || id, { id, ...info, quote: '', replies: [], ...(c.attribs['loext:resolved'] === 'true' && { resolved: true }) }); // (resolved in LibreOffice)
          if (c.attribs['office:name']) openNotes.push(c.attribs['office:name']);
          break;
        }
        case 'office:annotation-end': { const i = openNotes.lastIndexOf(c.attribs['office:name']); if (i >= 0) openNotes.splice(i, 1); break; }
        case 'text:bookmark-end': case 'text:soft-page-break': break;
        default: out += await inline(c); // fields, changes, ruby…: their text
      }
    }
    return out;
  };
  /** A table cell's background colour (its style's, or what that comes from). */
  const cellBg = (name) => { for (let n = name, i = 0; n && i < 10; n = styles.get(n)?.parent, i++) { const v = styles.get(n)?.cp?.['fo:background-color']; if (v) return v; } return null; };
  // Bookmarks: ours (bm_…) keep their ids; others get one made from their name (LibreOffice's own __RefHeading…
  // and _Toc… are its housekeeping); links to them (#name) go to the bookmark.
  // A paragraph holding just a chart object (the download's, or Writer's own): a document chart, its figures in it,
  // linked again to the spreadsheet and chart its frame is named after (sheetchart:file:chart).
  const chartIn = async (p) => {
    const frames = (function all(n, acc = []) { for (const k of kids(n)) { if (k.type !== 'tag') continue; if (k.name === 'draw:frame') acc.push(k); else all(k, acc); } return acc; })(p);
    const outside = (function all(n) { return kids(n).map((k) => (k.type === 'text' ? k.data : k.type === 'tag' && k.name !== 'draw:frame' ? all(k) : '')).join(''); })(p);
    if (frames.length !== 1 || outside.trim()) return null; // (the frame's own title aside)
    const obj = kids(frames[0]).find((k) => k.name === 'draw:object');
    const href = String(obj?.attribs?.['xlink:href'] || '').replace(/^\.\//, '').replace(/\/$/, '');
    const xml = href && await zip.file(`${href}/content.xml`)?.async('string');
    if (!xml) return null;
    const tagsOf = (n, name) => kids(n).filter((k) => k.type === 'tag' && (!name || k.name === name));
    const find = (n, name) => { for (const k of tagsOf(n)) { if (k.name === name) return k; const f = find(k, name); if (f) return f; } return null; };
    const ch = dataChartFromObject(parseDocument(xml, { xmlMode: true, decodeEntities: true }), { tags: tagsOf, textOf, find });
    if (!ch) return null;
    const link = /^sheetchart:([^:]+):(.+)$/.exec(frames[0].attribs['draw:name'] || '');
    const hm = /^([\d.]+)(cm|mm|in|pt)$/.exec(String(frames[0].attribs['svg:height'] || ''));
    const hPx = hm ? Math.round(Number(hm[1]) * { cm: 96 / 2.54, mm: 96 / 25.4, in: 96, pt: 4 / 3 }[hm[2]]) : 320;
    return `<figure data-sheet-chart=""${link ? ` data-file="${h(link[1])}" data-chart="${h(link[2])}"` : ''} data-title="${h(ch.title)}" data-type="${h(ch.chartType)}" data-figures="${h(JSON.stringify(ch.data))}" data-height="${hPx}"></figure>`;
  };
  const notes = new Map(), openNotes = []; // comments (by their name), and those whose words we're in
  const bookmarkId = (name) => { const n = String(name || ''); if (!n || /^_/.test(n)) return null; const ours = /^bm_([a-z0-9]{6,16})$/.exec(n); return ours ? ours[1] : `o${crypto.createHash('sha1').update(n).digest('hex').slice(0, 9)}`; };
  const bookmarkHref = (href) => { const m = /^#(.+)$/.exec(href); if (!m) return href; let name = m[1]; try { name = decodeURIComponent(name); } catch { /* as is */ } const id = bookmarkId(name.replace(/\|.*$/, '')); return id && bookmarkNames.has(name.replace(/\|.*$/, '')) ? `#bm-${id}` : href; };
  const bookmarkNames = new Set([...String(contentXml).matchAll(/<text:bookmark(?:-start)? text:name="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')));
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
  // An empty paragraph with only a line under it: a horizontal line (how LibreOffice keeps Word's).
  const ruleOnly = (pp) => /solid|double|dotted|dashed/.test(pp['fo:border-bottom'] || '') && !['fo:border-top', 'fo:border-left', 'fo:border-right'].some((k) => pp[k] && pp[k] !== 'none') && !/solid|double/.test(pp['fo:border'] || '');
  const blocks = async (el, depth = 0, listStyle = null) => {
    let out = '';
    for (const c of kids(el)) {
      if (c.type !== 'tag') continue;
      const sn = c.attribs['text:style-name'];
      if (c.name === 'text:p') {
        const chartHtml = await chartIn(c);
        if (chartHtml) { out += chartHtml; continue; }
        const st = look(sn), named = (re) => st.names.some((n) => re.test(n));
        const raw = await inline(c);
        if (st.pp['fo:break-before'] === 'page' && out) { out += '<div data-page-break=""></div>'; if (!raw.trim()) continue; }
        if (!raw.replace(/<[^>]+>/g, '').trim() && !/<img |data-/.test(raw) && (named(/^horizontal( |_20_|_)line$/) || ruleOnly(st.pp))) { out += '<hr>'; continue; }
        // Code: LibreOffice's "Preformatted Text", or Word's "Code" kept from a .docx.
        if (named(/preformatted|^code$|^source(_20_| )text$|^html(_20_| )code$/)) { out += `<pre><code>${raw.replace(/<br>/g, '\n').replace(/<[^>]+>/g, '').replace(/\u00a0/g, ' ')}</code></pre>`; continue; } // (its spaces: SPACE, made ordinary below)
        if (/^\s*(<img [^>]*>\s*)+$/.test(raw)) { // a picture on its own line: no empty paragraph around it, aligned as its line
          const al = { center: 'center', end: 'right', right: 'right' }[st.pp['fo:text-align']];
          out += al ? raw.replace(/<img /g, `<img align="${al}" `) : raw;
          continue;
        }
        const lv = named(/^title$/) ? 1 : st.level;
        const { 'fo:font-weight': weight, ...look2 } = st.tp; // a whole paragraph in a colour, italic…: on its text (a heading's boldness is its own)
        const inner = raw ? wrap(raw, lv || named(/^table(_20_| )heading$/) ? look2 : st.tp) : raw; // (a header cell's too: it shows bold)
        if (lv) out += `<h${Math.min(6, lv)}${alignAttr(sn)}>${inner}</h${Math.min(6, lv)}>`;
        else if (named(/^(quotations?|quote|intense(_20_| )quote)$/)) out += `<blockquote><p>${inner}</p></blockquote>`; // (LibreOffice's, or Word's kept from a .docx)
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
        const lis = kids(c).filter((k) => k.name === 'text:list-item' || k.name === 'text:list-header');
        for (const li of lis) items.push(`<li>${await blocks(li, depth + 1, ls) || '<p></p>'}</li>`);
        // Its first number: the first item's own, or carrying on from the list before (continue-numbering), or its style's.
        const carries = c.attribs['text:continue-numbering'] === 'true' || !!c.attribs['text:continue-list'];
        const start = Number(lis[0]?.attribs?.['text:start-value']) || (carries && depth === 0 && lastNumbered ? lastNumbered + 1 : (numberedFrom.get(ls) || [])[depth] || 1);
        if (isNum && depth === 0) lastNumbered = start + lis.length - 1;
        out += isNum ? `<ol${start > 1 ? ` start="${start}"` : ''}>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`;
      } else if (c.name === 'table:table') {
        const rows = [];
        const collect = (n) => { for (const k of kids(n)) { if (k.name === 'table:table-row') rows.push({ row: k, head: n.name === 'table:table-header-rows' }); else if (/^table:table-(header-)?rows$/.test(k.name)) collect(k); } };
        collect(c);
        // The columns' widths (in pixels, 96 to the inch), when every column has one.
        const colPx = [];
        (function cols(n) { for (const k of kids(n)) { if (k.name === 'table:table-column') { const w = styles.get(k.attribs['table:style-name'])?.colp?.['style:column-width']; const cm = /^([\d.]+)(cm|mm|in)$/.exec(w || ''); const v = cm ? Math.round(Number(cm[1]) * { cm: 96 / 2.54, mm: 96 / 25.4, in: 96 }[cm[2]]) : 0; for (let i = 0; i < Math.min(64, Number(k.attribs['table:number-columns-repeated']) || 1); i++) colPx.push(v); } else if (/^table:table-(header-)?columns$/.test(k.name)) cols(k); } })(c);
        // (a table of equal columns is just a table)
        const widths = colPx.length > 1 && colPx.every((w) => w >= 20 && w <= 2000) && Math.max(...colPx) - Math.min(...colPx) > Math.max(...colPx) * 0.02 ? colPx : null;
        let html = '<table><tbody>';
        for (const { row, head } of rows) {
          html += '<tr>';
          let col = 0;
          for (const cell of kids(row).filter((k) => k.name === 'table:table-cell' || k.name === 'table:covered-table-cell')) {
            if (cell.name === 'table:covered-table-cell') { col += Math.min(50, Number(cell.attribs['table:number-columns-repeated']) || 1); continue; }
            const n = Number(cell.attribs['table:number-columns-spanned']) > 1 ? Number(cell.attribs['table:number-columns-spanned']) : 1;
            const down = Math.min(1000, Number(cell.attribs['table:number-rows-spanned']) || 1);
            const cw = widths && widths.slice(col, col + n).length === n ? ` colwidth="${widths.slice(col, col + n).join(',')}"` : '';
            col += Math.min(50, Number(cell.attribs['table:number-columns-repeated']) || 1); // (the columns it spans come next, as covered cells)
            const span = `${n > 1 ? ` colspan="${n}"` : ''}${down > 1 ? ` rowspan="${down}"` : ''}`;
            const tag = head ? 'th' : 'td';
            const rep = Math.min(50, Number(cell.attribs['table:number-columns-repeated']) || 1);
            const inner = await blocks(cell, depth) || '<p></p>';
            const bg = /^#[0-9a-f]{6}$/i.test(cellBg(cell.attribs['table:style-name']) || '') ? cellBg(cell.attribs['table:style-name']).toLowerCase() : '';
            const bgAttr = bg && bg !== '#ffffff' && bg !== '#f1f3f4' ? ` style="background-color:${bg}"` : ''; // (not white, nor the heading row's grey a Word download gives it)
            for (let i = 0; i < rep; i++) html += `<${tag}${span}${bgAttr}${rep === 1 ? cw : ''}>${inner}</${tag}>`;
          }
          html += '</tr>';
        }
        out += `${html}</tbody></table>`;
      } else if (c.name === 'text:section' || c.name === 'text:index-body' || c.name === 'text:soft-page-break') out += await blocks(c, depth, listStyle);
      else if (c.name === 'text:table-of-content') out += '<nav data-toc=""></nav>'; // Docs' own table of contents (its entries are the headings')
      else if (/^text:(alphabetical-index|illustration-index|bibliography)$/.test(c.name)) out += await blocks(kids(c).find((k) => k.name === 'text:index-body') || {}, depth);
    }
    return out;
  };
  const text = (function find(n) { for (const k of kids(n)) { if (k.name === 'office:text') return k; const f = find(k); if (f) return f; } return null; })(root);
  const html = text ? await blocks(text) : '';
  // Page breaks as the document's own (the importer's HTML doesn't know them): marked, then put back.
  const parts = html.split('<div data-page-break=""></div>');
  const docs = parts.map((p) => docFromHtml(p || '<p></p>'));
  const content = docs.flatMap((d, i) => [...(i ? [{ type: 'pageBreak' }] : []), ...(d.content || [])]);
  for (const n of content) joinReplacements(n); // (a deletion and the insertion after it, by one person at once: one suggestion)
  (function spaces(n) { if (n.type === 'text' && n.text?.includes(SPACE)) n.text = n.text.replaceAll(SPACE, ' '); (n.content || []).forEach(spaces); })({ content });
  const comments = [...notes.values()].map((c) => ({ id: c.id, author: c.author, text: c.text, at: c.at, quote: c.quote.slice(0, 500), ...(c.resolved && { resolved: true }), replies: c.replies }));
  return { doc: { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] }, comments };
}

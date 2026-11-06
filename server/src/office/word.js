// Word files <-> Docs. Opening: mammoth turns the .docx into clean HTML (headings, lists, bold,
// italic, underline, links, tables, pictures) and TipTap's own parser makes it a document, so it
// opens exactly like one typed in Docs. Saving: the document is written back as a .docx, with its
// tables, pictures and text colours.
import mammoth from 'mammoth';
import { imageSize } from 'image-size';
import { generateJSON } from '@tiptap/html/server';
import StarterKit from '@tiptap/starter-kit';
import TextAlign from '@tiptap/extension-text-align';
import Image from '@tiptap/extension-image';
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table';
import { TextStyle, Color, BackgroundColor } from '@tiptap/extension-text-style';
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, ExternalHyperlink, AlignmentType, LevelFormat, BorderStyle,
  Table as WordTable, TableRow as WordRow, TableCell as WordCell, WidthType, ShadingType, ImageRun,
} from 'docx';

// A picture is a Drive file, by id (as in web/src/apps/docs/DocEditor.jsx). Here it is read from
// the <img src="pic:ID"> that opening a Word file makes.
const DocImage = Image.extend({
  addAttributes: () => ({
    fileId: { default: null, parseHTML: (el) => el.getAttribute('data-file') || (el.getAttribute('src') || '').replace(/^pic:/, '') || null },
    alt: { default: '' },
    width: { default: null },
    align: { default: null },
  }),
  parseHTML: () => [{ tag: 'img' }],
});
// The same building blocks as the Docs editor.
const EXTENSIONS = [
  StarterKit.configure({ link: { openOnClick: false } }), TextAlign.configure({ types: ['heading', 'paragraph'] }),
  DocImage, Table, TableRow, TableHeader, TableCell, TextStyle, Color, BackgroundColor,
];

/**
 * A Word file's content as a Docs document (JSON), plus any warnings about what didn't carry over.
 * `savePicture(name, data, mime)` keeps a picture as a Drive file and gives its id; without it,
 * pictures are left out with a note.
 */
export async function docFromWord(buffer, { savePicture } = {}) {
  let n = 0;
  const { value: html, messages } = await mammoth.convertToHtml({ buffer }, {
    convertImage: mammoth.images.imgElement(async (image) => {
      const mime = image.contentType || '';
      if (!savePicture || !/^image\/(png|jpeg|gif|bmp|webp)$/.test(mime)) return { src: '', alt: '[picture]' };
      try {
        const id = await savePicture(`Picture ${++n}.${mime.split('/')[1].replace('jpeg', 'jpg')}`, await image.read(), mime);
        return { src: `pic:${id}`, alt: image.altText || '' };
      } catch { return { src: '', alt: '[picture]' }; }
    }),
    styleMap: ['p[style-name=\'Title\'] => h1:fresh', 'p[style-name=\'Subtitle\'] => h2:fresh', 'u => u'],
  });
  // A picture that couldn't be kept leaves a note instead of disappearing silently.
  const withNotes = html.replace(/<img [^>]*alt="\[picture\]"[^>]*>/g, '<em>[picture]</em>');
  const doc = generateJSON(withNotes || '<p></p>', EXTENSIONS);
  return { doc, warnings: messages.filter((m) => m.type === 'warning').map((m) => m.message) };
}

const ALIGN = { center: AlignmentType.CENTER, right: AlignmentType.RIGHT, justify: AlignmentType.JUSTIFIED };
const HEADINGS = { 1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3, 4: HeadingLevel.HEADING_4, 5: HeadingLevel.HEADING_5, 6: HeadingLevel.HEADING_6 };

function runs(nodes = [], extra = {}) {
  const out = [];
  for (const n of nodes) {
    if (n.type === 'hardBreak') { out.push(new TextRun({ break: 1 })); continue; }
    if (n.type !== 'text') continue;
    const marks = Object.fromEntries((n.marks || []).map((m) => [m.type, m.attrs || true]));
    const hex = (c) => (/^#[0-9a-f]{6}$/i.test(c || '') ? c.slice(1).toUpperCase() : null);
    const color = hex(marks.textStyle?.color), fill = hex(marks.textStyle?.backgroundColor);
    const run = {
      text: n.text, bold: !!marks.bold, italics: !!marks.italic, strike: !!marks.strike, ...(marks.underline && { underline: {} }), ...(marks.code && { font: 'Consolas' }),
      ...(color && { color }), ...(fill && { shading: { type: ShadingType.CLEAR, color: 'auto', fill } }), ...extra,
    };
    if (marks.link?.href) out.push(new ExternalHyperlink({ link: marks.link.href, children: [new TextRun({ ...run, style: 'Hyperlink' })] }));
    else out.push(new TextRun(run));
  }
  return out;
}

const PAGE_PX = 624; // the width between the margins of an A4/Letter page, at 96 to the inch
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/bmp': 'bmp' };

/**
 * A Docs document as a Word file (Buffer). `pictureData(fileId)` gives a picture's { data, mime }
 * (or null to leave it out).
 */
export async function wordFromDoc(doc, title = 'Document', { pictureData } = {}) {
  // Pictures first (reading them is asynchronous), then the document in one pass.
  const pictures = new Map();
  const collect = (n) => { if (n?.type === 'image' && n.attrs?.fileId) pictures.set(n.attrs.fileId, null); for (const c of n?.content || []) collect(c); };
  collect(doc);
  if (pictureData) for (const id of pictures.keys()) { try { pictures.set(id, await pictureData(id)); } catch { /* left out */ } }

  const block = (nodes, ctx = {}) => { const out = []; walkInto(out, nodes, ctx); return out; };
  const picture = (n) => {
    const p = pictures.get(n.attrs?.fileId);
    const type = p && IMAGE_TYPES[p.mime];
    if (!type) return new Paragraph({ children: [new TextRun({ text: '[picture]', italics: true })] });
    let size;
    try { size = imageSize(p.data); } catch { size = { width: 400, height: 300 }; }
    const share = /^(\d+)%$/.test(n.attrs.width || '') ? Number(n.attrs.width.slice(0, -1)) / 100 : 1;
    const w = Math.max(16, Math.min(size.width || 400, PAGE_PX * share));
    const h = Math.round(w * ((size.height || 300) / (size.width || 400)));
    return new Paragraph({
      alignment: ALIGN[n.attrs.align],
      children: [new ImageRun({ type, data: p.data, transformation: { width: Math.round(w), height: h }, altText: { name: n.attrs.alt || 'Picture', description: n.attrs.alt || '' } })],
    });
  };
  const table = (n) => {
    const rows = (n.content || []).filter((r) => r.type === 'tableRow');
    const cols = Math.max(1, ...rows.map((r) => (r.content || []).reduce((t, c) => t + (c.attrs?.colspan || 1), 0)));
    return new WordTable({
      width: { size: 100, type: WidthType.PERCENTAGE },
      columnWidths: Array.from({ length: cols }, () => Math.floor(9000 / cols)),
      rows: rows.map((r) => {
        const header = (r.content || []).every((c) => c.type === 'tableHeader');
        return new WordRow({
          tableHeader: header,
          children: (r.content || []).map((c) => {
            const inner = block(c.content);
            return new WordCell({
              columnSpan: c.attrs?.colspan > 1 ? c.attrs.colspan : undefined,
              rowSpan: c.attrs?.rowspan > 1 ? c.attrs.rowspan : undefined,
              ...(c.type === 'tableHeader' && { shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'F1F3F4' } }),
              children: inner.length ? inner : [new Paragraph('')],
            });
          }),
        });
      }),
    });
  };

  function walkInto(paras, nodes, ctx = {}) {
    const walk = (list, c) => walkInto(paras, list, c);
    for (const n of nodes || []) {
      const align = ALIGN[n.attrs?.textAlign];
      if (n.type === 'paragraph') paras.push(new Paragraph({ children: runs(n.content), alignment: align, ...ctx.para }));
      else if (n.type === 'heading') paras.push(new Paragraph({ children: runs(n.content), heading: HEADINGS[n.attrs?.level] || HeadingLevel.HEADING_1, alignment: align }));
      else if (n.type === 'bulletList' || n.type === 'orderedList') {
        const level = (ctx.level ?? -1) + 1;
        for (const li of n.content || []) walk(li.content, { level, para: n.type === 'bulletList' ? { bullet: { level } } : { numbering: { reference: 'numbers', level } } });
      } else if (n.type === 'blockquote') walk(n.content, { ...ctx, para: { indent: { left: 720 }, border: { left: { style: BorderStyle.SINGLE, size: 12, color: 'BBBBBB', space: 8 } } } });
      else if (n.type === 'codeBlock') for (const line of (n.content?.map((c) => c.text).join('') || '').split('\n')) paras.push(new Paragraph({ children: [new TextRun({ text: line, font: 'Consolas' })] }));
      else if (n.type === 'horizontalRule') paras.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'BBBBBB', space: 1 } } }));
      else if (n.type === 'image') paras.push(picture(n));
      else if (n.type === 'table') { paras.push(table(n)); paras.push(new Paragraph('')); }
      else if (n.content) walk(n.content, ctx);
    }
  }
  const paras = block(doc?.content);
  const file = new Document({
    title,
    numbering: { config: [{ reference: 'numbers', levels: [0, 1, 2, 3].map((level) => ({ level, format: LevelFormat.DECIMAL, text: `%${level + 1}.`, alignment: AlignmentType.START, style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } } })) }] },
    sections: [{ children: paras.length ? paras : [new Paragraph('')] }],
  });
  return Packer.toBuffer(file);
}

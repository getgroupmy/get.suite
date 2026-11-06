// Word files <-> Docs. Opening: mammoth turns the .docx into clean HTML (headings, lists, bold,
// italic, underline, links, tables, pictures) and TipTap's own parser makes it a document, so it
// opens exactly like one typed in Docs. Saving: the document is written back as a .docx.
import mammoth from 'mammoth';
import { generateJSON } from '@tiptap/html/server';
import StarterKit from '@tiptap/starter-kit';
import TextAlign from '@tiptap/extension-text-align';
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, ExternalHyperlink, AlignmentType, LevelFormat, BorderStyle,
} from 'docx';

// The same building blocks as the Docs editor (web/src/apps/docs/DocEditor.jsx).
const EXTENSIONS = [StarterKit.configure({ link: { openOnClick: false } }), TextAlign.configure({ types: ['heading', 'paragraph'] })];

/** A Word file's content as a Docs document (JSON), plus any warnings about what didn't carry over. */
export async function docFromWord(buffer) {
  const { value: html, messages } = await mammoth.convertToHtml({ buffer }, {
    // Pictures aren't part of Docs yet; leave a note where one was instead of dropping it silently.
    convertImage: mammoth.images.imgElement(() => ({ src: '', alt: '[picture]' })),
    styleMap: ['p[style-name=\'Title\'] => h1:fresh', 'p[style-name=\'Subtitle\'] => h2:fresh', 'u => u'],
  });
  const withNotes = html.replace(/<img [^>]*alt="\[picture\]"[^>]*>/g, '<em>[picture]</em>');
  // Tables become paragraphs per row (Docs has no tables yet), cells separated by " | ".
  const flat = withNotes.replace(/<table>([\s\S]*?)<\/table>/g, (_, t) => t.replace(/<tr>([\s\S]*?)<\/tr>/g, (__, row) => `<p>${row.replace(/<\/t[dh]>\s*<t[dh][^>]*>/g, ' | ').replace(/<\/?t[dh][^>]*>|<\/?p>/g, '')}</p>`).replace(/<\/?(thead|tbody)>/g, ''));
  const doc = generateJSON(flat || '<p></p>', EXTENSIONS);
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
    const run = { text: n.text, bold: !!marks.bold, italics: !!marks.italic, strike: !!marks.strike, ...(marks.underline && { underline: {} }), ...(marks.code && { font: 'Consolas' }), ...extra };
    if (marks.link?.href) out.push(new ExternalHyperlink({ link: marks.link.href, children: [new TextRun({ ...run, style: 'Hyperlink' })] }));
    else out.push(new TextRun(run));
  }
  return out;
}

/** A Docs document as a Word file (Buffer). */
export async function wordFromDoc(doc, title = 'Document') {
  const paras = [];
  const walk = (nodes, ctx = {}) => {
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
      else if (n.content) walk(n.content, ctx);
    }
  };
  walk(doc?.content);
  const file = new Document({
    title,
    numbering: { config: [{ reference: 'numbers', levels: [0, 1, 2, 3].map((level) => ({ level, format: LevelFormat.DECIMAL, text: `%${level + 1}.`, alignment: AlignmentType.START, style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } } })) }] },
    sections: [{ children: paras.length ? paras : [new Paragraph('')] }],
  });
  return Packer.toBuffer(file);
}

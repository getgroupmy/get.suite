// Word files <-> Docs. Opening: mammoth turns the .docx into clean HTML (headings, lists, bold,
// italic, underline, links, tables, pictures) and TipTap's own parser makes it a document, so it
// opens exactly like one typed in Docs. Saving: the document is written back as a .docx, with its
// tables, pictures and text colours.
import { flattenTabs } from './doctabs.js';
import crypto from 'node:crypto';
import mammoth from 'mammoth';
import { anchorsOf } from './anchors.js';
import JSZip from 'jszip';
import { chartTable } from './sheetchart.js';
import { chipText, dateText, eventLines } from './chiptext.js';
import { inText, reference, sourcesOf } from './cite.js';
import { imageSize } from 'image-size';
import { generateJSON } from '@tiptap/html/server';
import StarterKit from '@tiptap/starter-kit';
import TextAlign from '@tiptap/extension-text-align';
import Image from '@tiptap/extension-image';
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table';
import { TextStyle, Color, BackgroundColor } from '@tiptap/extension-text-style';
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, ExternalHyperlink, AlignmentType, LevelFormat, BorderStyle,
  Math as WordMath, MathRun, Table as WordTable, TableRow as WordRow, TableCell as WordCell, WidthType, ShadingType, ImageRun, Header, Footer, PageNumber, PageOrientation, LineRuleType,
  Bookmark, InternalHyperlink, PageBreak, FootnoteReferenceRun, CommentRangeStart, CommentRangeEnd, CommentReference, InsertedTextRun, DeletedTextRun,
} from 'docx';
import { Node, Mark } from '@tiptap/core';
import { pageMm, MARGINS, PAPER } from '../pagesetup.js';

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
// Superscript and subscript, as in web/src/apps/docs/scripts.js (a footnote marker is a <sup> too: not this).
const scriptMark = (name, tag, other) => Mark.create({ name, excludes: other, parseHTML: () => [{ tag, getAttrs: (el) => (el.hasAttribute?.('data-footnote') ? false : null) }], renderHTML: () => [tag, 0] });
const Superscript = scriptMark('superscript', 'sup', 'subscript');
const Subscript = scriptMark('subscript', 'sub', 'superscript');
// A footnote, as in web/src/apps/docs/footnote.js: a marker in the text carrying its note.
const Footnote = Node.create({
  name: 'footnote', group: 'inline', inline: true, atom: true,
  addAttributes: () => ({ note: { default: '', parseHTML: (el) => el.getAttribute('data-note') || '' } }),
  parseHTML: () => [{ tag: 'sup[data-footnote]' }],
  renderHTML: ({ HTMLAttributes }) => ['sup', { ...HTMLAttributes, 'data-footnote': '' }],
});
// A bookmark, as in web/src/apps/docs/bookmark.js: a marker a link can point to (#bm-<id>).
const BOOKMARK_ID = /^[a-z0-9]{6,16}$/;
const BookmarkNode = Node.create({
  name: 'bookmark', group: 'inline', inline: true, atom: true,
  addAttributes: () => ({ id: { default: null, parseHTML: (el) => (BOOKMARK_ID.test(el.getAttribute('data-bookmark') || '') ? el.getAttribute('data-bookmark') : null) } }),
  parseHTML: () => [{ tag: 'span[data-bookmark]' }],
  renderHTML: ({ node }) => ['span', { 'data-bookmark': node.attrs.id }],
});
/** Word's bookmarks (mammoth makes them <a id="…">) as Docs bookmarks, and links to them as #bm-… links.
 *  Ours come back with their own ids; Word's own get one made from their name (_Toc… and _GoBack are Word's housekeeping). */
function bookmarksFromWord(html) {
  const ids = new Map();
  const idOf = (name) => {
    if (!ids.has(name)) {
      const ours = /^bm_([a-z0-9]{6,16})$/.exec(name);
      ids.set(name, ours ? ours[1] : `w${crypto.createHash('sha1').update(name).digest('hex').slice(0, 9)}`);
    }
    return ids.get(name);
  };
  const wanted = (name) => !/^_/.test(name);
  return html
    .replace(/<a id="([^"]+)"><\/a>/g, (m, name) => (wanted(name) ? `<span data-bookmark="${idOf(name)}"></span>` : ''))
    .replace(/<a href="#([^"]+)">/g, (m, name) => (wanted(name) ? `<a href="#bm-${idOf(name)}">` : m));
}
// The same building blocks as the Docs editor.
// Suggestions (Docs' suggesting mode), as in web/src/apps/docs/suggest.js: Word's tracked changes.
const suggAttrs = () => ({
  id: { default: null, parseHTML: (el) => el.getAttribute('data-sugg') }, by: { default: null, parseHTML: (el) => el.getAttribute('data-by') },
  name: { default: '', parseHTML: (el) => el.getAttribute('data-name') || '' }, at: { default: 0, parseHTML: (el) => Number(el.getAttribute('data-at')) || 0 },
});
const SuggestInsert = Mark.create({ name: 'suggestInsert', inclusive: false, addAttributes: suggAttrs, parseHTML: () => [{ tag: 'ins[data-sugg]', priority: 100 }], renderHTML: ({ HTMLAttributes }) => ['ins', HTMLAttributes, 0] });
const SuggestDelete = Mark.create({ name: 'suggestDelete', inclusive: false, addAttributes: suggAttrs, parseHTML: () => [{ tag: 'del[data-sugg]', priority: 100 }], renderHTML: ({ HTMLAttributes }) => ['del', HTMLAttributes, 0] });
// The text a comment is about, as in web/src/apps/docs/DocEditor.jsx (the thread's id).
const CommentMark = Mark.create({
  name: 'comment', inclusive: false, excludes: '',
  addAttributes: () => ({ id: { default: null, parseHTML: (el) => el.getAttribute('data-comment'), renderHTML: (a) => ({ 'data-comment': a.id }) } }),
  parseHTML: () => [{ tag: 'span[data-comment]' }],
  renderHTML: ({ HTMLAttributes }) => ['span', HTMLAttributes, 0],
});
const EXTENSIONS = [
  StarterKit.configure({ link: { openOnClick: false } }), TextAlign.configure({ types: ['heading', 'paragraph'] }),
  DocImage, Table, TableRow, TableHeader, TableCell, TextStyle, Color, BackgroundColor, Footnote, Superscript, Subscript, BookmarkNode, CommentMark, SuggestInsert, SuggestDelete,
];
const attr = (t) => t.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const plain = (html) => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/** Word's footnotes (mammoth lists them at the end, linked from [n] markers) as Docs footnote markers. */
function footnotesFromWord(html) {
  const notes = new Map();
  const rest = html.replace(/<ol>((?:<li id="footnote-\d+">[\s\S]*?<\/li>)+)<\/ol>\s*$/, (m, items) => {
    for (const [, id, body] of items.matchAll(/<li id="footnote-(\d+)">([\s\S]*?)<\/li>/g)) notes.set(id, plain(body.replace(/<a href="#footnote-ref-\d+">[^<]*<\/a>/g, '')));
    return '';
  });
  if (!notes.size) return html;
  return rest.replace(/<sup><a href="#footnote-(\d+)" id="footnote-ref-\d+">\[\d+\]<\/a><\/sup>/g, (m, id) => `<sup data-footnote="" data-note="${attr(notes.get(id) ?? '')}"></sup>`);
}

// ---- alignment and colours: mammoth leaves them out of its HTML (and doesn't read text colour), so
// they're marked in the file's XML first, with invisible markers it passes through as text, and
// turned into styles the Docs editor reads afterwards.
const MK = '\uE000', MK_END = '\uE001';
const HIGHLIGHTS = { yellow: 'ffff00', green: '00ff00', cyan: '00ffff', magenta: 'ff00ff', blue: '0000ff', red: 'ff0000', darkBlue: '000080', darkCyan: '008080', darkGreen: '008000', darkMagenta: '800080', darkRed: '800000', darkYellow: '808000', darkGray: '808080', lightGray: 'c0c0c0', black: '000000', white: 'ffffff' };
const WORD_ALIGN = { center: 'center', right: 'right', end: 'right', both: 'justify', distribute: 'justify' };
const marker = (text) => `<w:r><w:t xml:space="preserve">${MK}${text}${MK_END}</w:t></w:r>`;
/** document.xml with markers before aligned paragraphs' text and around coloured or highlighted runs. */
export function markWordXml(xml) {
  // Tracked changes (not the self-closing ones Word puts on paragraph marks): who and when, kept as markers;
  // deleted text (w:delText, which the converter leaves out) made ordinary text inside them.
  const who = (attrs) => encodeURIComponent(JSON.stringify({ id: /w:id="(\d+)"/.exec(attrs)?.[1] || '', name: /w:author="([^"]*)"/.exec(attrs)?.[1] || '', at: /w:date="([^"]*)"/.exec(attrs)?.[1] || '' }));
  return String(xml)
    .replace(/<w:ins\b([^>]*[^/])>([\s\S]*?)<\/w:ins>/g, (m, attrs, inner) => `${marker(`i:${who(attrs)}`)}${inner}${marker('/i')}`)
    .replace(/<w:del\b([^>]*[^/])>([\s\S]*?)<\/w:del>/g, (m, attrs, inner) => `${marker(`d:${who(attrs)}`)}${inner.replace(/<w:delText\b/g, '<w:t').replace(/<\/w:delText>/g, '</w:t>')}${marker('/d')}`)
    // Comments: where each one's text starts and ends (its id kept, to find its words afterwards).
    .replace(/<w:commentRangeStart w:id="(\d+)"\/>/g, (m, id) => `${m}${marker(`k:${id}`)}`)
    .replace(/<w:commentRangeEnd w:id="(\d+)"\/>/g, (m, id) => `${marker(`/k:${id}`)}${m}`)
    .replace(/(<w:pPr>[\s\S]*?<\/w:pPr>)/g, (m, ppr) => {
      const jc = /<w:jc w:val="([a-zA-Z]+)"\/>/.exec(ppr.replace(/<w:rPr>[\s\S]*?<\/w:rPr>/g, ''))?.[1];
      return WORD_ALIGN[jc] ? `${ppr}${marker(`a:${WORD_ALIGN[jc]}`)}` : ppr;
    })
    .replace(/<w:r(?=[\s>])([^>]*)>((?:(?!<\/w:r>)[\s\S])*?)<\/w:r>/g, (m, attrs, inner) => {
      const rpr = /^\s*<w:rPr>([\s\S]*?)<\/w:rPr>/.exec(inner)?.[1];
      if (!rpr) return m;
      const color = /<w:color\b[^>]*w:val="([0-9A-Fa-f]{6})"/.exec(rpr)?.[1]?.toLowerCase();
      const hl = HIGHLIGHTS[/<w:highlight w:val="([a-zA-Z]+)"\/>/.exec(rpr)?.[1]] || /<w:shd\b[^>]*w:fill="([0-9A-Fa-f]{6})"/.exec(rpr)?.[1]?.toLowerCase();
      const style = [color && color !== '000000' && `c:${color}`, hl && hl !== 'ffffff' && `h:${hl}`].filter(Boolean).join(';');
      return style ? `${marker(`s:${style}`)}${m}${marker('/')}` : m;
    });
}
/** The HTML mammoth made, with the markers turned into alignment and colour styles (and any left over removed). */
export function unmarkWordHtml(html, commentId = null) {
  const re = (s) => new RegExp(s.replace(/MK/g, MK).replace(/END/g, MK_END), 'g');
  const sugg = (tag) => (m, k, payload) => {
    let w = {};
    try { w = JSON.parse(decodeURIComponent(payload)); } catch { /* none */ }
    const name = String(w.name || '').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').slice(0, 100);
    const at = Date.parse(w.at || '') || 0;
    return `<${tag} data-sugg="w${String(w.id).replace(/\D/g, '')}-${k}" data-name="${attr(name)}" data-at="${at}">`;
  };
  let n = 0;
  return String(html)
    .replace(re('MKi:([^END]*)END'), (m, p) => sugg('ins')(m, ++n, p))
    .replace(re('MK/iEND'), '</ins>')
    .replace(re('MKd:([^END]*)END'), (m, p) => sugg('del')(m, ++n, p))
    .replace(re('MK/dEND'), '</del>')
    .replace(re('MKk:(\\d+)END'), (m, id) => { if (!commentId) return ''; const c = commentId(id); return c ? `<span data-comment="${c}">` : '<span>'; })
    .replace(re('MK/k:(\\d+)END'), () => (commentId ? '</span>' : ''))
    .replace(re('<(p|h[1-6])>MKa:(center|right|justify)END'), (m, tag, a) => `<${tag} style="text-align:${a}">`)
    .replace(re('MKs:([^END]*)END'), (m, spec) => {
      const css = spec.split(';').map((x) => (x.startsWith('c:') ? `color:#${x.slice(2)}` : x.startsWith('h:') ? `background-color:#${x.slice(2)}` : '')).filter(Boolean).join(';');
      return `<span style="${css}">`;
    })
    .replace(re('MK/END'), '</span>')
    .replace(re('MK[^END]*END'), '');
}
/** A Word file's comments: Map(Word's id → { author, text, at (ms, or null) }). */
export async function commentsOfWord(buffer) {
  const out = new Map();
  try {
    const xml = await (await JSZip.loadAsync(buffer)).file('word/comments.xml')?.async('string');
    const unx = (t) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
    for (const m of String(xml || '').matchAll(/<w:comment\b([^>]*)>([\s\S]*?)<\/w:comment>/g)) {
      const id = /w:id="(\d+)"/.exec(m[1])?.[1];
      const author = unx(/w:author="([^"]*)"/.exec(m[1])?.[1] || '').trim();
      const date = Date.parse(/w:date="([^"]*)"/.exec(m[1])?.[1] || '');
      const text = [...m[2].matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)].map((p) => unx([...p[0].matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((t) => t[1]).join(''))).join('\n').trim();
      const paraId = [...m[2].matchAll(/w14:paraId="([0-9A-Fa-f]+)"/g)].pop()?.[1]?.toUpperCase() || null;
      if (id && text) out.set(id, { author: author.slice(0, 100), text: text.slice(0, 5000), at: Number.isFinite(date) ? date : null, paraId });
      if (out.size >= 500) break;
    }
    // Replies and resolved threads (Word 2013 on): commentsExtended.xml links a comment's last paragraph to its parent's.
    const ext = await (await JSZip.loadAsync(buffer)).file('word/commentsExtended.xml')?.async('string');
    if (ext) {
      const byPara = new Map([...out].filter(([, c]) => c.paraId).map(([wid, c]) => [c.paraId, wid]));
      for (const e of ext.matchAll(/<w15:commentEx\b([^>]*)\/?>/g)) {
        const pid = /w15:paraId="([0-9A-Fa-f]+)"/.exec(e[1])?.[1]?.toUpperCase();
        const parent = /w15:paraIdParent="([0-9A-Fa-f]+)"/.exec(e[1])?.[1]?.toUpperCase();
        const wid = pid && byPara.get(pid);
        if (!wid) continue;
        if (parent && byPara.has(parent) && byPara.get(parent) !== wid) out.get(wid).parent = byPara.get(parent);
        if (/w15:done="1"/.test(e[1])) out.get(wid).done = true;
      }
      // A reply to a reply belongs to the same thread.
      for (const c of out.values()) { let p = c.parent; for (let k = 0; p && out.get(p)?.parent && k < 50; k++) p = out.get(p).parent; if (p) c.parent = p; }
    }
  } catch { /* none */ }
  for (const c of out.values()) delete c.paraId;
  return out;
}
async function withMarks(buffer) {
  try {
    const zip = await JSZip.loadAsync(buffer);
    const f = zip.file('word/document.xml');
    if (!f) return buffer;
    zip.file('word/document.xml', markWordXml(await f.async('string')));
    return await zip.generateAsync({ type: 'nodebuffer' });
  } catch { return buffer; }
}

/**
 * A Word file's content as a Docs document (JSON), plus any warnings about what didn't carry over.
 * `savePicture(name, data, mime)` keeps a picture as a Drive file and gives its id; without it,
 * pictures are left out with a note.
 */
export async function docFromWord(buffer, { savePicture } = {}) {
  let n = 0;
  const { value: marked, messages } = await mammoth.convertToHtml({ buffer: await withMarks(buffer) }, {
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
  // Word's comments: each becomes a thread (a new id), on the words it was about.
  const wordComments = await commentsOfWord(buffer);
  const ids = new Map();
  const commentId = (wid) => {
    const top = wordComments.get(wid)?.parent || wid; // a reply's words are its thread's
    if (!ids.has(top)) ids.set(top, crypto.randomBytes(9).toString('base64url'));
    return ids.get(top);
  };
  const html = unmarkWordHtml(marked, (wid) => (wordComments.has(wid) ? commentId(wid) : null));
  const withNotes = bookmarksFromWord(footnotesFromWord(html)).replace(/<img [^>]*alt="\[picture\]"[^>]*>/g, '<em>[picture]</em>');
  const doc = checklists(generateJSON(withNotes || '<p></p>', EXTENSIONS));
  // A deletion right before an insertion, by the same person at the same time, is one replacement (as Docs makes them).
  const joinReplacements = (n) => {
    const kids = n.content || [];
    for (let i = 0; i + 1 < kids.length; i++) {
      const del = kids[i].marks?.find((m) => m.type === 'suggestDelete');
      if (!del) continue;
      for (let j = i + 1; j < kids.length; j++) {
        const ins = kids[j].marks?.find((m) => m.type === 'suggestInsert');
        const sameDel = kids[j].marks?.find((m) => m.type === 'suggestDelete' && m.attrs.id === del.attrs.id);
        if (sameDel) continue; // more of the same deletion (other formatting)
        if (!ins || ins.attrs.name !== del.attrs.name || ins.attrs.at !== del.attrs.at) break;
        const old = ins.attrs.id;
        for (let k = j; k < kids.length; k++) { const m = kids[k].marks?.find((x) => x.type === 'suggestInsert' && x.attrs.id === old); if (!m) break; m.attrs.id = del.attrs.id; }
        break;
      }
    }
    kids.forEach(joinReplacements);
  };
  joinReplacements(doc);
  // The words each comment covers, now in the document (a comment whose words are gone is still kept, unanchored).
  const quotes = new Map();
  const walk = (n) => { if (n.type === 'text') for (const mk of n.marks || []) if (mk.type === 'comment') quotes.set(mk.attrs.id, (quotes.get(mk.attrs.id) || '') + n.text); (n.content || []).forEach(walk); };
  walk(doc);
  const comments = [...wordComments].filter(([, c]) => !c.parent).map(([wid, c]) => ({
    id: commentId(wid), author: c.author, text: c.text, at: c.at, quote: (quotes.get(commentId(wid)) || '').slice(0, 500),
    ...(c.done && { resolved: true }),
    replies: [...wordComments.values()].filter((r) => r.parent === wid).map((r) => ({ author: r.author, text: r.text, at: r.at })),
  }));
  return { doc, comments, warnings: messages.filter((m) => m.type === 'warning').map((m) => m.message) };
}

/** Paragraphs starting with a box (☐, or ☑ ☒ when ticked), one after another, become a checklist. */
function checklists(doc) {
  const BOX = /^\s*([☐☑☒])\s*/;
  const out = [];
  for (const n of doc.content || []) {
    const first = n.type === 'paragraph' && n.content?.[0];
    const m = first?.type === 'text' && BOX.exec(first.text);
    if (!m) { out.push(n); continue; }
    const rest = first.text.slice(m[0].length);
    const content = [...(rest ? [{ ...first, text: rest }] : []), ...n.content.slice(1)];
    const item = { type: 'taskItem', attrs: { checked: m[1] !== '☐' }, content: [{ type: 'paragraph', ...(content.length && { content }) }] };
    const last = out[out.length - 1];
    if (last?.type === 'taskList') last.content.push(item); else out.push({ type: 'taskList', content: [item] });
  }
  return { ...doc, content: out };
}

const ALIGN = { center: AlignmentType.CENTER, right: AlignmentType.RIGHT, justify: AlignmentType.JUSTIFIED };
const HEADINGS = { 1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3, 4: HeadingLevel.HEADING_4, 5: HeadingLevel.HEADING_5, 6: HeadingLevel.HEADING_6 };

/** The first font of a CSS font list ("Georgia, serif" → Georgia), for Word. */
const fontName = (stack) => { const f = String(stack || '').split(',')[0].trim().replace(/^["']|["']$/g, ''); return f && !/^(serif|sans-serif|monospace)$/i.test(f) ? f : null; };
/** A CSS size ("14pt", "18px") in Word's half-points. */
const halfPoints = (v) => { const m = /^([\d.]+)(pt|px)$/.exec(String(v || '').trim()); if (!m) return null; const pt = m[2] === 'px' ? Number(m[1]) * 0.75 : Number(m[1]); return pt >= 4 && pt <= 200 ? Math.round(pt * 2) : null; };
/** Line spacing (a multiple, such as 1.5) as Word paragraph spacing. */
const spacing = (lh) => { const n = Number(lh); return n >= 0.5 && n <= 4 ? { spacing: { line: Math.round(240 * n), lineRule: LineRuleType.AUTO } } : {}; };

// Dropdown chips' colours, as shading behind their text.
const CHIP_FILLS = { grey: 'E8EAED', blue: 'D3E3FD', green: 'C4EED0', yellow: 'FFE8A3', red: 'FAD2CF', purple: 'E9D7FE' };

// The notes of the document being written (wordFromDoc fills it as it meets footnote markers).
let footnotes = null;
let revisionNo = 0; // tracked changes' numbers while writing
// While writing: the comment threads going into the file (thread id → Word's comment number).
let commentNos = null;
// Its bookmarks' ids, so links to them become links inside the Word file.
let bookmarkIds = new Set();
// Its headings' anchors (#budget-costs) → their Word bookmarks (toc_1…).
let headingAnchors = new Map();
/** The Word bookmark a link to a place in this document goes to (a bookmark, or a heading by its #anchor), or null. */
const internalAnchor = (href) => {
  const h = String(href || '');
  const m = /#bm-([a-z0-9]{6,16})$/.exec(h);
  if (m) return bookmarkIds.has(m[1]) ? `bm_${m[1]}` : null;
  if (!h.startsWith('#')) return null;
  try { return headingAnchors.get(decodeURIComponent(h.slice(1)).toLowerCase()) || null; } catch { return null; }
};

function runs(nodes = [], extra = {}) {
  const out = [];
  // Comments: a range starts where a thread's words start and ends (with its reference) where they stop.
  const open = new Set();
  // A thread's number and its replies' (each a Word comment of its own, on the same words).
  const comments = (n) => (commentNos ? (n.marks || []).filter((m) => m.type === 'comment' && commentNos.has(m.attrs?.id)).flatMap((m) => commentNos.get(m.attrs.id)) : []);
  const close = (keep = []) => {
    for (const no of [...open]) if (!keep.includes(no)) { out.push(new CommentRangeEnd(no), new TextRun({ children: [new CommentReference(no)] })); open.delete(no); }
  };
  for (const n of nodes) {
    const here = n.type === 'text' ? comments(n) : [];
    close(here);
    for (const no of here) if (!open.has(no)) { out.push(new CommentRangeStart(no)); open.add(no); }
    if (n.type === 'hardBreak') { out.push(new TextRun({ break: 1 })); continue; }
    if (n.type === 'mention') { out.push(new TextRun({ text: `@${n.attrs?.name || ''}`, bold: true, color: '1A73E8' })); continue; }
    if (n.type === 'citation') { out.push(new TextRun({ text: inText(n.attrs), ...extra })); continue; }
    if (n.type === 'math') { const l = String(n.attrs?.latex || '').trim(); if (l) out.push(new WordMath({ children: [new MathRun(l)] })); continue; }
    if (n.type === 'datechip') { out.push(new TextRun({ text: dateText(n.attrs?.date), color: '1A73E8', underline: {} })); continue; }
    if (n.type === 'filechip') { out.push(new TextRun({ text: n.attrs?.name || '', color: '1A73E8', underline: {} })); continue; }
    if (n.type === 'dropchip') { const fill = CHIP_FILLS[(n.attrs?.options || []).find((o) => o?.label === n.attrs?.value)?.color] || 'E8EAED'; out.push(new TextRun({ text: ` ${chipText(n.attrs)} `, bold: true, shading: { type: ShadingType.CLEAR, color: 'auto', fill } })); continue; }
    if (n.type === 'bookmark') { if (BOOKMARK_ID.test(n.attrs?.id || '')) out.push(new Bookmark({ id: `bm_${n.attrs.id}`, children: [] })); continue; }
    if (n.type === 'footnote' && footnotes) {
      const id = footnotes.length + 1;
      footnotes.push(n.attrs?.note || '');
      out.push(new FootnoteReferenceRun(id));
      continue;
    }
    if (n.type !== 'text') continue;
    const marks = Object.fromEntries((n.marks || []).map((m) => [m.type, m.attrs || true]));
    const hex = (c) => (/^#[0-9a-f]{6}$/i.test(c || '') ? c.slice(1).toUpperCase() : null);
    const color = hex(marks.textStyle?.color), fill = hex(marks.textStyle?.backgroundColor);
    const font = fontName(marks.textStyle?.fontFamily), size = halfPoints(marks.textStyle?.fontSize);
    const run = {
      text: n.text, bold: !!marks.bold, italics: !!marks.italic, strike: !!marks.strike, ...(marks.underline && { underline: {} }), ...(marks.code && { font: 'Consolas' }),
      ...(marks.superscript && { superScript: true }), ...(marks.subscript && { subScript: true }),
      ...(color && { color }), ...(fill && { shading: { type: ShadingType.CLEAR, color: 'auto', fill } }), ...(font && { font }), ...(size && { size }), ...extra,
    };
    // A pending suggestion: a Word tracked change (an insertion, or a deletion) by whoever suggested it.
    if (marks.suggestInsert || marks.suggestDelete) {
      const sg = marks.suggestInsert || marks.suggestDelete;
      const change = { ...run, id: ++revisionNo, author: String(sg.name || 'Workspace').slice(0, 100), date: new Date(sg.at || Date.now()).toISOString().replace(/\.\d+Z$/, 'Z') };
      out.push(marks.suggestInsert ? new InsertedTextRun(change) : new DeletedTextRun(change));
      continue;
    }
    if (marks.link?.href && internalAnchor(marks.link.href)) out.push(new InternalHyperlink({ anchor: internalAnchor(marks.link.href), children: [new TextRun({ ...run, style: 'Hyperlink' })] }));
    else if (marks.link?.href) out.push(new ExternalHyperlink({ link: marks.link.href, children: [new TextRun({ ...run, style: 'Hyperlink' })] }));
    else out.push(new TextRun(run));
  }
  close();
  return out;
}

const xmlAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Word's own watermark: a faint diagonal WordArt text shape in the page header (VML, as Word writes it).
const WATERMARK_TYPE = '<v:shapetype id="_x0000_t136" coordsize="21600,21600" o:spt="136" adj="10800" path="m@7,l@8,m@5,21600l@6,21600e"><v:formulas><v:f eqn="sum #0 0 10800"/><v:f eqn="prod #0 2 1"/><v:f eqn="sum 21600 0 @1"/><v:f eqn="sum 0 0 @2"/><v:f eqn="sum 21600 0 @3"/><v:f eqn="if @0 @3 0"/><v:f eqn="if @0 21600 @1"/><v:f eqn="if @0 0 @2"/><v:f eqn="if @0 @4 21600"/><v:f eqn="mid @5 @6"/><v:f eqn="mid @8 @5"/><v:f eqn="mid @7 @8"/><v:f eqn="mid @6 @7"/><v:f eqn="sum @6 0 @5"/></v:formulas><v:path textpathok="t" o:connecttype="custom" o:connectlocs="@9,0;@10,10800;@11,21600;@12,10800" o:connectangles="270,180,90,0"/><v:textpath on="t" fitshape="t"/><v:handles><v:h position="#0,bottomRight" xrange="6629,14971"/></v:handles><o:lock v:ext="edit" text="t" shapetype="t"/></v:shapetype>';
export const watermarkXml = (text) => `<w:r><w:pict>${WATERMARK_TYPE}<v:shape id="PowerPlusWaterMarkObject" o:spid="_x0000_s2049" type="#_x0000_t136" style="position:absolute;margin-left:0;margin-top:0;width:468pt;height:117pt;rotation:315;z-index:-251657216;mso-position-horizontal:center;mso-position-horizontal-relative:margin;mso-position-vertical:center;mso-position-vertical-relative:margin" o:allowincell="f" fillcolor="silver" stroked="f"><v:fill opacity=".5"/><v:textpath style="font-family:&quot;Calibri&quot;;font-size:1pt" string="${xmlAttr(text)}"/></v:shape></w:pict></w:r>`;
const VML_NS = { 'xmlns:v': 'urn:schemas-microsoft-com:vml', 'xmlns:o': 'urn:schemas-microsoft-com:office:office' };

/** The written Word file with the watermark in each header's first paragraph. */
async function withWatermark(buffer, text) {
  const zip = await JSZip.loadAsync(buffer);
  const headers = Object.keys(zip.files).filter((f) => /^word\/header\d+\.xml$/.test(f));
  for (const f of headers) {
    let xml = await zip.file(f).async('string');
    for (const [ns, uri] of Object.entries(VML_NS)) if (!xml.includes(`${ns}=`)) xml = xml.replace(/<w:hdr\b/, `<w:hdr ${ns}="${uri}"`);
    const at = xml.indexOf('</w:p>');
    xml = at >= 0 ? xml.slice(0, at) + watermarkXml(text) + xml.slice(at) : xml.replace('</w:hdr>', `<w:p>${watermarkXml(text)}</w:p></w:hdr>`);
    zip.file(f, xml);
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** A Word file's watermark text (the first one in its headers), or ''. */
export async function watermarkOfWord(buffer) {
  try {
    const zip = await JSZip.loadAsync(buffer);
    for (const f of Object.keys(zip.files).filter((n) => /^word\/header\d+\.xml$/.test(n)).sort()) {
      const m = /<v:textpath\b[^>]*\bstring="([^"]*)"/.exec(await zip.file(f).async('string'));
      if (m) return m[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim().slice(0, 40);
    }
  } catch { /* not a zip: no watermark */ }
  return '';
}

/** A Word file's text layout (its last section's, which is the document's own): how many columns
 *  it's in (1 to 3), and whether its lines are numbered. */
export async function layoutOfWord(buffer) {
  try {
    const xml = await (await JSZip.loadAsync(buffer)).file('word/document.xml')?.async('string');
    const sect = (xml && [...xml.matchAll(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g)].pop()?.[0]) || '';
    const n = Number(/<w:cols\b[^>]*\bw:num="(\d+)"/.exec(sect)?.[1]);
    return { columns: n >= 2 ? Math.min(n, 3) : 1, lineNumbers: /<w:lnNumType\b/.test(sect) };
  } catch { return { columns: 1, lineNumbers: false }; }
}

/**
 * A Word file's page setup, as Docs keeps it: the paper (A4, Letter, Legal or A5, whichever is
 * nearest), portrait or landscape, margins (normal, narrow or wide, nearest), the default header's and
 * footer's text, and whether the footer has the page number. Read from its last section (the document's own).
 */
export async function pageOfWord(buffer) {
  const out = {};
  try {
    const zip = await JSZip.loadAsync(buffer);
    const xml = await zip.file('word/document.xml')?.async('string');
    const sect = (xml && [...xml.matchAll(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g)].pop()?.[0]) || '';
    const mm = (twips) => (Number(twips) / 1440) * 25.4;
    const sz = /<w:pgSz\b([^>]*)\/?>/.exec(sect)?.[1] || '';
    const w = mm(/w:w="(\d+)"/.exec(sz)?.[1]), h = mm(/w:h="(\d+)"/.exec(sz)?.[1]);
    if (w > 0 && h > 0) {
      out.orientation = /w:orient="landscape"/.test(sz) || w > h ? 'landscape' : 'portrait';
      const [a, b] = [Math.min(w, h), Math.max(w, h)];
      const best = Object.entries(PAPER).map(([k, [pw, ph]]) => [k, Math.abs(pw - a) + Math.abs(ph - b)]).sort((x, y) => x[1] - y[1])[0];
      if (best[1] < 12) out.size = best[0];
    }
    const left = mm(/<w:pgMar\b[^>]*\bw:left="(\d+)"/.exec(sect)?.[1]);
    if (left > 0) out.margin = Object.entries(MARGINS).sort((x, y) => Math.abs(x[1] - left) - Math.abs(y[1] - left))[0][0];
    // Header and footer: the default ones, by their relationships.
    const rels = (await zip.file('word/_rels/document.xml.rels')?.async('string')) || '';
    const partOf = (kind) => {
      const rid = new RegExp(`<w:${kind}Reference\\b[^>]*w:type="default"[^>]*r:id="([^"]+)"|<w:${kind}Reference\\b[^>]*r:id="([^"]+)"[^>]*w:type="default"`).exec(sect);
      const id = rid?.[1] || rid?.[2];
      const target = id && new RegExp(`<Relationship\\b[^>]*Id="${id}"[^>]*Target="([^"]+)"|<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="${id}"`).exec(rels);
      return target ? `word/${(target[1] || target[2]).replace(/^\/?word\//, '')}` : null;
    };
    const unx = (t) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
    const textOf = (part) => {
      const noFields = part.replace(/<w:fldSimple\b[\s\S]*?<\/w:fldSimple>/g, '').replace(/<w:fldChar w:fldCharType="separate"\/>[\s\S]*?<w:fldChar w:fldCharType="end"\/>/g, '');
      return unx([...noFields.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('')).replace(/\s+/g, ' ').trim().slice(0, 200);
    };
    const header = partOf('header'), footer = partOf('footer');
    const hx = header && (await zip.file(header)?.async('string'));
    const fx = footer && (await zip.file(footer)?.async('string'));
    if (hx) out.header = textOf(hx);
    if (fx) { out.footer = textOf(fx); out.numbers = /w:instr="\s*PAGE\b|<w:instrText[^>]*>\s*PAGE\b/.test(fx); }
  } catch { /* not a Word file we can read: the defaults */ }
  return out;
}

/** Word's page size, margins, header and footer (page number included) from the document's page setup. */
function sectionSetup(setup) {
  if (!setup) return {};
  const twip = (mm) => Math.round((mm / 25.4) * 1440);
  const [w, h] = pageMm({ ...setup, orientation: 'portrait' }); // the library turns it for landscape
  const m = twip(MARGINS[setup.margin] || MARGINS.normal);
  const line = (text, withNumber) => new Paragraph({ alignment: AlignmentType.CENTER, children: [
    ...(text ? [new TextRun({ text, color: '666666', size: 18 })] : []),
    ...(withNumber ? [new TextRun({ text: text ? '   ' : '', size: 18 }), new TextRun({ children: [PageNumber.CURRENT], color: '666666', size: 18 })] : []),
  ] });
  return {
    properties: {
      page: { size: { width: twip(w), height: twip(h), orientation: setup.orientation === 'landscape' ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT }, margin: { top: m, bottom: m, left: m, right: m } },
      ...(setup.columns > 1 && { column: { count: setup.columns, space: 720, equalWidth: true } }), // half an inch between
      ...(setup.lineNumbers && { lineNumbers: { countBy: 1, restart: 'continuous' } }), // every line, numbered on through the document
    },
    // A watermark lives in the header (added to its first paragraph once the file is written: withWatermark).
    ...((setup.header || setup.watermark) && { headers: { default: new Header({ children: [line(setup.header, false)] }) } }),
    ...((setup.footer || setup.numbers) && { footers: { default: new Footer({ children: [line(setup.footer, setup.numbers)] }) } }),
  };
}

const PAGE_PX = 624; // the width between the margins of an A4/Letter page, at 96 to the inch
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/bmp': 'bmp' };

/**
 * A Docs document as a Word file (Buffer). `pictureData(fileId)` gives a picture's { data, mime }
 * (or null to leave it out).
 */
/** The signatures on a signed document, on a page of their own at the end. */
function signaturePage(sig) {
  const stamp = (t) => new Date(t).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const out = [new Paragraph({ children: [new PageBreak()] }), new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('Signatures')] })];
  for (const s of sig.signers) {
    const png = typeof s.image === 'string' && /^data:image\/png;base64,/.test(s.image) ? Buffer.from(s.image.split(',')[1], 'base64') : null;
    out.push(png
      ? new Paragraph({ children: [new ImageRun({ type: 'png', data: png, transformation: { width: 220, height: 64 }, altText: { name: 'Signature', description: `Signature of ${s.name}` } })] })
      : new Paragraph({ children: [new TextRun({ text: s.name || '', italics: true, size: 40, font: 'Segoe Script' })] }));
    out.push(new Paragraph({ border: { top: { style: BorderStyle.SINGLE, size: 6, color: '999999', space: 2 } }, children: [new TextRun({ text: s.name || s.email, bold: true }), new TextRun(`  ${s.email}`)] }));
    out.push(new Paragraph({ children: [new TextRun({ text: `Signed ${stamp(s.signed_at)}${s.ip ? ` from ${s.ip}` : ''} · ${png ? 'drawn' : 'typed'} signature`, size: 18, color: '666666' })] }));
    out.push(new Paragraph(''));
  }
  out.push(new Paragraph({ children: [new TextRun({ text: `Signed electronically in Workspace; completed ${stamp(sig.completed_at)}. Document fingerprint (SHA-256): ${sig.hash}`, size: 16, color: '666666' })] }));
  return out;
}

/**
 * `comments`: the document's open threads, [{ id, author, at, text, replies: [{ author, at, text }] }];
 * each becomes a Word comment on the words its thread marks (replies as further paragraphs).
 */
export async function wordFromDoc(doc, title = 'Document', { pictureData, page, signatures = null, comments = [] } = {}) {
  doc = flattenTabs(doc); // tabs one after another, each from a new page under its name
  // Pictures first (reading them is asynchronous), then the document in one pass.
  const pictures = new Map();
  const collect = (n) => { if (n?.type === 'image' && n.attrs?.fileId) pictures.set(n.attrs.fileId, null); for (const c of n?.content || []) collect(c); };
  collect(doc);
  if (pictureData) for (const id of pictures.keys()) { try { pictures.set(id, await pictureData(id)); } catch { /* left out */ } }

  // A table of contents lists the headings (with text) as links to bookmarks on them.
  const textOf = (n) => (n.text ?? (n.content || []).map(textOf).join(''));
  const contents = [];
  const gather = (n) => {
    if (n.type === 'heading') { const text = textOf(n).trim(); if (text) contents.push({ level: n.attrs?.level || 1, text }); return; }
    if (n.type !== 'paragraph') for (const c of n.content || []) gather(c);
  };
  gather(doc || {});
  const top = Math.min(...contents.map((h) => h.level));
  let headingNo = 0;
  const contentsBlock = () => [
    new Paragraph({ children: [new TextRun({ text: 'Contents', bold: true })], spacing: { after: 120 } }),
    ...contents.map((h, k) => new Paragraph({
      indent: { left: 360 * (h.level - top) },
      children: [new InternalHyperlink({ anchor: `toc_${k + 1}`, children: [new TextRun({ text: h.text, style: 'Hyperlink' })] })],
    })),
    new Paragraph(''),
  ];
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
      // Indented paragraphs: half an inch (720 twentieths of a point) a step, as in Docs.
      const indent = Number(n.attrs?.indent) > 0 ? { indent: { left: 720 * Math.min(8, Math.round(n.attrs.indent)) } } : {};
      if (n.type === 'paragraph') paras.push(new Paragraph({ children: runs(n.content), alignment: align, ...spacing(n.attrs?.lineHeight), ...indent, ...ctx.para }));
      else if (n.type === 'heading') paras.push(new Paragraph({ children: textOf(n).trim() ? [new Bookmark({ id: `toc_${++headingNo}`, children: runs(n.content) })] : runs(n.content), heading: HEADINGS[n.attrs?.level] || HeadingLevel.HEADING_1, alignment: align, ...spacing(n.attrs?.lineHeight), ...indent }));
      else if (n.type === 'bulletList' || n.type === 'orderedList') {
        const level = (ctx.level ?? -1) + 1;
        for (const li of n.content || []) walk(li.content, { level, para: n.type === 'bulletList' ? { bullet: { level } } : { numbering: { reference: 'numbers', level } } });
      } else if (n.type === 'taskList') {
        // A checklist: each item's first paragraph gets a box (☐, or ☑ when ticked); the rest follow indented.
        const level = (ctx.level ?? -1) + 1;
        for (const li of n.content || []) {
          const [first, ...rest] = li.content || [];
          const box = new TextRun({ text: li.attrs?.checked ? '☑ ' : '☐ ' });
          paras.push(new Paragraph({ children: [box, ...runs(first?.type === 'paragraph' ? first.content : [])], indent: { left: 360 * (level + 1), hanging: 280 } }));
          walk(first?.type === 'paragraph' ? rest : li.content, { level });
        }
      } else if (n.type === 'blockquote') walk(n.content, { ...ctx, para: { indent: { left: 720 }, border: { left: { style: BorderStyle.SINGLE, size: 12, color: 'BBBBBB', space: 8 } } } });
      else if (n.type === 'codeBlock') for (const line of (n.content?.map((c) => c.text).join('') || '').split('\n')) paras.push(new Paragraph({ children: [new TextRun({ text: line, font: 'Consolas' })] }));
      else if (n.type === 'horizontalRule') paras.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'BBBBBB', space: 1 } } }));
      else if (n.type === 'image') paras.push(picture(n));
      else if (n.type === 'tableOfContents') paras.push(...contentsBlock());
      else if (n.type === 'references') { // every source cited, APA style, with a hanging indent
        paras.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun('References')] }));
        for (const s of sourcesOf(doc)) paras.push(new Paragraph({ indent: { left: 720, hanging: 720 }, children: reference(s).map((p) => new TextRun({ text: p.text, italics: !!p.italic })) }));
      }
      else if (n.type === 'sheetChart') { // a chart from Sheets: its title and its figures
        const { title, rows } = chartTable(n.attrs);
        paras.push(new Paragraph({ children: [new TextRun({ text: title, bold: true })] }));
        if (rows.length) {
          paras.push(new WordTable({ width: { size: 100, type: WidthType.PERCENTAGE }, columnWidths: rows[0].map(() => Math.floor(9000 / rows[0].length)),
            rows: rows.map((r, ri) => new WordRow({ tableHeader: ri === 0, children: r.map((t) => new WordCell({ ...(ri === 0 && { shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'F1F3F4' } }), children: [new Paragraph({ children: [new TextRun({ text: t, bold: ri === 0 })] })] })) })) }));
        }
        paras.push(new Paragraph(''));
      }
      else if (n.type === 'eventDraft') { // a meeting planned in the document: what, when, who, where, then its notes
        for (const [k, v] of eventLines(n.attrs)) paras.push(new Paragraph({ children: [new TextRun({ text: `${k}: `, bold: true, color: '5F6368' }), new TextRun(v)] }));
        walk(n.content, ctx);
        paras.push(new Paragraph(''));
      }
      else if (n.type === 'emailDraft') { // an email written in the document: its fields, then its text
        const a = n.attrs || {};
        for (const [k, v] of [['To', a.to], ['Cc', a.cc], ['Subject', a.subject]]) if (v || k !== 'Cc') paras.push(new Paragraph({ children: [new TextRun({ text: `${k}: `, bold: true, color: '5F6368' }), new TextRun(String(v || ''))] }));
        walk(n.content, ctx);
        paras.push(new Paragraph(''));
      }
      else if (n.type === 'pageBreak') paras.push(new Paragraph({ children: [new PageBreak()] }));
      else if (n.type === 'table') { paras.push(table(n)); paras.push(new Paragraph('')); }
      else if (n.content) walk(n.content, ctx);
    }
  }
  footnotes = [];
  // Only threads whose words are still in the document (Word needs somewhere to put them).
  const marked = new Set();
  const findMarks = (n) => { for (const m of n?.marks || []) if (m.type === 'comment') marked.add(m.attrs?.id); for (const c of n?.content || []) findMarks(c); };
  findMarks(doc);
  const wordComments = (comments || []).filter((c) => marked.has(c.id)).slice(0, 1000);
  // Word's comments: each thread, then its replies (pointing to it), numbered in that order.
  const wordList = [];
  commentNos = new Map();
  for (const c of wordComments) {
    const no = wordList.length;
    wordList.push({ id: no, author: c.author, at: c.at, text: c.text, resolved: !!c.resolved });
    const nos = [no];
    for (const r of (c.replies || []).slice(0, 100)) { nos.push(wordList.length); wordList.push({ id: wordList.length, author: r.author, at: r.at, text: r.text, parentId: no }); }
    commentNos.set(c.id, nos);
  }
  bookmarkIds = new Set();
  headingAnchors = new Map(anchorsOf(contents).map((a, k) => [a, `toc_${k + 1}`]));
  (function find(n) { if (n?.type === 'bookmark' && BOOKMARK_ID.test(n.attrs?.id || '')) bookmarkIds.add(n.attrs.id); (n?.content || []).forEach(find); })(doc);
  let paras, notes;
  try { paras = block(doc?.content); notes = footnotes; } finally { footnotes = null; commentNos = null; bookmarkIds = new Set(); headingAnchors = new Map(); }
  if (signatures) paras.push(...signaturePage(signatures));
  const file = new Document({
    title,
    ...(notes.length && { footnotes: Object.fromEntries(notes.map((t, i) => [i + 1, { children: [new Paragraph(t)] }])) }),
    ...(wordList.length && { comments: { children: wordList.map((c) => ({
      id: c.id, author: String(c.author || 'Workspace').slice(0, 100), ...(c.at && { date: new Date(c.at) }),
      ...(c.parentId !== undefined && { parentId: c.parentId }), ...(c.resolved && { resolved: true }),
      children: String(c.text || '').split('\n').map((line) => new Paragraph(line)),
    })) } }),
    numbering: { config: [{ reference: 'numbers', levels: [0, 1, 2, 3].map((level) => ({ level, format: LevelFormat.DECIMAL, text: `%${level + 1}.`, alignment: AlignmentType.START, style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } } })) }] },
    sections: [{ ...sectionSetup(page), children: paras.length ? paras : [new Paragraph('')] }],
  });
  const buf = await Packer.toBuffer(file);
  return page?.watermark ? withWatermark(buf, page.watermark) : buf;
}

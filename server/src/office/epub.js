// A document as an e-book (EPUB 3): readable on e-readers (Kobo, Kindle via Send to Kindle, Apple Books, phones).
// A chapter starts at each top-level heading (the first heading level used), with a table of contents;
// paragraphs and their alignment, bold/italic/underline/strike/code, links, lists and checklists, quotes, code,
// tables, pictures (in the book) and footnotes (as notes at the end of their chapter); chips as their text.
import { latexToMathElement } from './mathml.js';
import JSZip from 'jszip';
import crypto from 'node:crypto';
import { flattenTabs } from './doctabs.js';
import { cleanNumbering, cleanBullet, bulletChar } from './liststyle.js';
import { chipText, dateText, eventLines } from './chiptext.js';
import { inText, reference, sourcesOf } from './cite.js';
import { chartTable } from './sheetchart.js';
import { chartSvg } from './sheetpdfchart.js';

export const EPUB_MIME = 'application/epub+zip';
const x = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const textOf = (n) => (n.type === 'text' ? n.text || '' : (n.content || []).map(textOf).join(''));

/** The writer of a document's blocks as XHTML (pictures: file id → { path: the src to use }); notes collects footnotes. */
function bookWriter(doc, pictures, { toc = false } = {}) {
  // Headings: each an id (h1, h2…), in order, for a table of contents to link to.
  const heads = [];
  (function walk(list) { for (const n of list || []) { if (n.type === 'heading') heads.push(n); else if (n.content && n.type !== 'table') walk(n.content); } })(doc?.content);
  // (readable ones, from their words: "Expenses and travel" → expenses-and-travel, a second one -2)
  const ids = new Map(), used = new Set();
  for (const hd of heads) {
    const base = textOf(hd).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'section';
    let id = base;
    for (let k = 2; used.has(id); k++) id = `${base}-${k}`;
    used.add(id); ids.set(hd, id);
  }
  const headId = (n) => ids.get(n);
  const notes = [];
  const inline = (list = []) => list.map((n) => {
    if (n.type === 'hardBreak') return '<br/>';
    if (n.type === 'footnote') { notes.push(n.attrs?.note || ''); const k = notes.length; return `<a epub:type="noteref" id="r${k}" href="#n${k}"><sup>${k}</sup></a>`; }
    if (n.type === 'math' && String(n.attrs?.latex || '').trim()) return latexToMathElement(String(n.attrs.latex).trim()); // (MathML: EPUB 3 readers draw it)
    if (n.type === 'image') { const p = pictures.get(n.attrs?.fileId); return p ? `<img src="${p.path}" alt="${x(n.attrs?.alt || '')}"/>` : x(n.attrs?.alt ? `[${n.attrs.alt}]` : ''); }
    let t = n.type === 'text' ? n.text || '' : n.type === 'mention' ? `@${n.attrs?.name || ''}` : n.type === 'datechip' ? dateText(n.attrs?.date) : n.type === 'filechip' ? n.attrs?.name || ''
      : n.type === 'dropchip' ? chipText(n.attrs) : n.type === 'math' ? n.attrs?.latex || '' : n.type === 'citation' ? inText(n.attrs) : null;
    if (t === null) return inline(n.content);
    let out = x(t);
    for (const m of n.marks || []) {
      if (m.type === 'bold') out = `<strong>${out}</strong>`;
      else if (m.type === 'italic') out = `<em>${out}</em>`;
      else if (m.type === 'underline') out = `<u>${out}</u>`;
      else if (m.type === 'strike') out = `<s>${out}</s>`;
      else if (m.type === 'code') out = `<code>${out}</code>`;
      else if (m.type === 'superscript') out = `<sup>${out}</sup>`;
      else if (m.type === 'subscript') out = `<sub>${out}</sub>`;
      else if (m.type === 'link' && /^(https?:|mailto:)/i.test(m.attrs?.href || '')) out = `<a href="${x(m.attrs.href)}">${out}</a>`;
    }
    return out;
  }).join('');
  const align = (n) => (['center', 'right', 'justify'].includes(n.attrs?.textAlign) ? ` style="text-align: ${n.attrs.textAlign}"` : '');
  const blocks = (list = []) => list.map((n) => {
    const t = n.type;
    if (t === 'paragraph') return `<p${align(n)}>${inline(n.content)}</p>`;
    if (t === 'heading') { const lv = Math.min(6, n.attrs?.level || 1); return `<h${lv}${toc ? ` id="${headId(n)}"` : ''}${align(n)}>${inline(n.content)}</h${lv}>`; }
    if (t === 'bulletList' || t === 'orderedList') { // (in its own style: as the editor writes one, which reading systems show)
      const look = t === 'orderedList' ? (cleanNumbering(n.attrs?.listStyle) ? ` style="list-style-type: ${n.attrs.listStyle}"` : '') + ((n.attrs?.start || 1) > 1 ? ` start="${n.attrs.start}"` : '')
        : cleanBullet(n.attrs?.bullet) ? ` style='list-style-type: "${bulletChar(n.attrs.bullet)} "'` : '';
      return `<${t === 'bulletList' ? 'ul' : 'ol'}${look}>${(n.content || []).map((li) => `<li>${blocks(li.content)}</li>`).join('')}</${t === 'bulletList' ? 'ul' : 'ol'}>`;
    }
    if (t === 'taskList') return `<ul class="tasks">${(n.content || []).map((li) => `<li>${li.attrs?.checked ? '☒' : '☐'} ${blocks(li.content).replace(/^<p>|<\/p>$/g, '')}</li>`).join('')}</ul>`;
    if (t === 'blockquote') return `<blockquote>${blocks(n.content)}</blockquote>`;
    if (t === 'codeBlock') return `<pre><code>${x((n.content || []).map((c) => c.text).join(''))}</code></pre>`;
    if (t === 'horizontalRule') return '<hr/>';
    if (t === 'image') return `<p class="picture">${inline([n])}</p>`;
    if (t === 'table') return `<table>${(n.content || []).map((r) => `<tr>${(r.content || []).map((c) => { const tag = c.type === 'tableHeader' ? 'th' : 'td'; return `<${tag}${c.attrs?.colspan > 1 ? ` colspan="${c.attrs.colspan}"` : ''}>${blocks(c.content)}</${tag}>`; }).join('')}</tr>`).join('')}</table>`;
    if (t === 'sheetChart') { const { title: ct, rows } = chartTable(n.attrs); const svg = chartSvg(n.attrs); return `<p><strong>${x(ct)}</strong></p>${svg ? `<div class="chart">${svg}</div>` : ''}${rows.length ? `<table>${rows.map((r, i) => `<tr>${r.map((v) => `<${i ? 'td' : 'th'}>${x(v)}</${i ? 'td' : 'th'}>`).join('')}</tr>`).join('')}</table>` : ''}`; }
    if (t === 'references') return `<h2>References</h2>${sourcesOf(doc).map((s) => `<p class="ref">${reference(s).map((p) => (p.italic ? `<em>${x(p.text)}</em>` : x(p.text))).join('')}</p>`).join('')}`;
    if (t === 'emailDraft' || t === 'eventDraft') {
      const a = n.attrs || {};
      const lines = t === 'eventDraft' ? eventLines(a) : [['To', a.to || ''], ['Cc', a.cc || ''], ['Subject', a.subject || '']].filter(([k, v]) => v || k !== 'Cc');
      return `<div class="draft">${lines.map(([k, v]) => `<p><strong>${x(k)}:</strong> ${x(v)}</p>`).join('')}${blocks(n.content)}</div>`;
    }
    if (t === 'tableOfContents' && toc && heads.length) return `<nav class="toc"><p><strong>Contents</strong></p><ul>${heads.map((hd) => `<li class="toc${Math.min(6, hd.attrs?.level || 1)}"><a href="#${headId(hd)}">${x(textOf(hd).trim())}</a></li>`).join('')}</ul></nav>`;
    if (t === 'tableOfContents' || t === 'pageBreak') return '';
    return n.content ? blocks(n.content) : '';
  }).join('\n');

  return { inline, blocks, notes };
}

export async function epubFromDoc(doc, title = 'Document', { pictureData, author = '', lang = 'en' } = {}) {
  doc = flattenTabs(doc);
  const nodes = doc?.content || [];
  // Chapters: at the shallowest heading level used (none: one chapter).
  const levels = nodes.filter((n) => n.type === 'heading').map((n) => n.attrs?.level || 1);
  const top = levels.length ? Math.min(...levels) : null;
  const chapters = [];
  for (const n of nodes) {
    if (n.type === 'heading' && (n.attrs?.level || 1) === top) chapters.push({ title: textOf(n).trim() || `Chapter ${chapters.length + 1}`, nodes: [n] });
    else if (n.type === 'pageBreak') continue;
    else { if (!chapters.length) chapters.push({ title, nodes: [] }); chapters[chapters.length - 1].nodes.push(n); }
  }
  if (!chapters.length) chapters.push({ title, nodes: [{ type: 'paragraph' }] });

  const pictures = new Map(); // file id → { path, data, mime }
  for (const id of new Set(JSON.stringify(nodes).match(/"fileId":"[^"]+"/g)?.map((m) => m.slice(10, -1)) || [])) {
    const got = await pictureData?.(id);
    if (got && /^image\/(png|jpeg|gif|svg\+xml|webp)$/.test(got.mime)) pictures.set(id, { path: `images/${pictures.size + 1}.${got.mime.split('/')[1].replace('jpeg', 'jpg').replace('svg+xml', 'svg')}`, data: got.data, mime: got.mime });
  }

  const w = bookWriter(doc, pictures);
  const { blocks } = w;
  const css = 'body { font-family: serif; line-height: 1.5; } h1, h2, h3 { line-height: 1.2; } img { max-width: 100%; } table { border-collapse: collapse; } td, th { border: 1px solid #999; padding: 0.2em 0.4em; } blockquote { margin-left: 1em; padding-left: 0.8em; border-left: 3px solid #bbb; } pre { white-space: pre-wrap; font-size: 0.9em; } ul.tasks { list-style: none; padding-left: 0.5em; } .notes { font-size: 0.9em; border-top: 1px solid #ccc; margin-top: 2em; } .ref { padding-left: 2em; text-indent: -2em; }';
  const page = (t, body) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${x(lang)}" lang="${x(lang)}"><head><meta charset="UTF-8"/><title>${x(t)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body>
${body}
</body></html>`;
  const files = chapters.map((ch, i) => {
    w.notes.length = 0;
    const body = blocks(ch.nodes);
    const notes = w.notes;
    const endnotes = notes.length ? `<section class="notes" epub:type="footnotes">${notes.map((t, k) => `<aside epub:type="footnote" id="n${k + 1}"><p><a href="#r${k + 1}">${k + 1}.</a> ${x(t)}</p></aside>`).join('')}</section>` : '';
    return { path: `chapter${i + 1}.xhtml`, title: ch.title, xml: page(ch.title, `${i === 0 && chapters[0].nodes[0]?.type !== 'heading' ? `<h1>${x(title)}</h1>` : ''}${body}${endnotes}`) };
  });
  const id = `urn:uuid:${crypto.randomUUID()}`;
  const modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const nav = page('Contents', `<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>${files.map((f) => `<li><a href="${f.path}">${x(f.title)}</a></li>`).join('')}</ol></nav>`);
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${x(lang)}">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bookid">${id}</dc:identifier><dc:title>${x(title)}</dc:title><dc:language>${x(lang)}</dc:language>${author ? `<dc:creator>${x(author)}</dc:creator>` : ''}<meta property="dcterms:modified">${modified}</meta></metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="css" href="style.css" media-type="text/css"/>
${files.map((f, i) => `<item id="c${i + 1}" href="${f.path}" media-type="application/xhtml+xml"${f.xml.includes('<math ') ? ' properties="mathml"' : ''}/>`).join('\n')}
${[...pictures.values()].map((p, i) => `<item id="img${i + 1}" href="${p.path}" media-type="${p.mime}"/>`).join('\n')}
</manifest>
<spine>${files.map((f, i) => `<itemref idref="c${i + 1}"/>`).join('')}</spine>
</package>`;
  const zip = new JSZip();
  zip.file('mimetype', EPUB_MIME, { compression: 'STORE' });
  zip.file('META-INF/container.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file('OEBPS/content.opf', opf);
  zip.file('OEBPS/nav.xhtml', nav);
  zip.file('OEBPS/style.css', css);
  for (const f of files) zip.file(`OEBPS/${f.path}`, f.xml);
  for (const p of pictures.values()) zip.file(`OEBPS/${p.path}`, p.data);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', mimeType: EPUB_MIME });
}

// ---- the same document as one web page (.html): its pictures in it (data: addresses), equations as MathML,
// footnotes at the end; and as plain text (.txt).
export async function htmlFromDoc(doc, title = 'Document', { pictureData, lang = 'en' } = {}) {
  doc = flattenTabs(doc);
  const nodes = (doc?.content || []).filter((n) => n.type !== 'pageBreak');
  const pictures = new Map();
  for (const id of new Set(JSON.stringify(nodes).match(/"fileId":"[^"]+"/g)?.map((m) => m.slice(10, -1)) || [])) {
    const got = await pictureData?.(id);
    if (got && /^image\/(png|jpeg|gif|webp)$/.test(got.mime)) pictures.set(id, { path: `data:${got.mime};base64,${Buffer.from(got.data).toString('base64')}` });
  }
  const w = bookWriter(doc, pictures, { toc: true });
  const body = w.blocks(nodes).replace(/ epub:type="[^"]*"/g, '');
  const endnotes = w.notes.length ? `<section class="notes"><hr/>${w.notes.map((t, k) => `<p id="n${k + 1}"><a href="#r${k + 1}">${k + 1}.</a> ${x(t)}</p>`).join('')}</section>` : '';
  const css = 'body { font-family: Georgia, serif; line-height: 1.5; max-width: 46em; margin: 2em auto; padding: 0 1em; } img { max-width: 100%; } table { border-collapse: collapse; } td, th { border: 1px solid #999; padding: 0.2em 0.4em; } blockquote { margin-left: 1em; padding-left: 0.8em; border-left: 3px solid #bbb; } pre { white-space: pre-wrap; background: #f6f6f6; padding: 0.5em; } ul.tasks { list-style: none; padding-left: 0.5em; } .notes { font-size: 0.9em; } .ref { padding-left: 2em; text-indent: -2em; } .toc ul { list-style: none; padding-left: 0; } .toc2 { margin-left: 1em; } .toc3 { margin-left: 2em; } .toc4, .toc5, .toc6 { margin-left: 3em; }';
  const head = nodes.find((n) => n.type !== 'tableOfContents')?.type === 'heading' ? '' : `<h1>${x(title)}</h1>\n`; // (its own first heading is its title)
  return Buffer.from(`<!DOCTYPE html>\n<html lang="${x(lang)}"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>${x(title)}</title><style>${css}</style></head><body>\n${head}${body}\n${endnotes}</body></html>\n`, 'utf8');
}

/** The document as plain text: paragraphs apart by an empty line, lists with - or 1., tables by tabs, footnotes at the end. */
export function textFromDoc(doc) {
  doc = flattenTabs(doc);
  const notes = [];
  const inline = (list = []) => list.map((n) => {
    if (n.type === 'hardBreak') return '\n';
    if (n.type === 'footnote') { notes.push(n.attrs?.note || ''); return `[${notes.length}]`; }
    if (n.type === 'image') return n.attrs?.alt ? `[${n.attrs.alt}]` : '[picture]';
    if (n.type === 'math') return String(n.attrs?.latex || '');
    const t = n.type === 'text' ? n.text || '' : n.type === 'mention' ? `@${n.attrs?.name || ''}` : n.type === 'datechip' ? dateText(n.attrs?.date) : n.type === 'filechip' ? n.attrs?.name || ''
      : n.type === 'dropchip' ? chipText(n.attrs) : n.type === 'citation' ? inText(n.attrs) : null;
    if (t === null) return inline(n.content);
    const link = (n.marks || []).find((m) => m.type === 'link' && /^(https?:|mailto:)/i.test(m.attrs?.href || ''))?.attrs.href;
    return link && link !== t ? `${t} (${link})` : t;
  }).join('');
  const indent = (s, pre) => s.split('\n').map((l, i) => (i ? ' '.repeat(pre.length) : pre) + l).join('\n');
  const blocks = (list = []) => list.map((n) => {
    const t = n.type;
    if (t === 'paragraph') return inline(n.content);
    if (t === 'heading') return inline(n.content);
    if (t === 'bulletList') return (n.content || []).map((li) => indent(blocks(li.content), '- ')).join('\n');
    if (t === 'orderedList') return (n.content || []).map((li, k) => indent(blocks(li.content), `${(n.attrs?.start || 1) + k}. `)).join('\n');
    if (t === 'taskList') return (n.content || []).map((li) => indent(blocks(li.content), li.attrs?.checked ? '[x] ' : '[ ] ')).join('\n');
    if (t === 'blockquote') return blocks(n.content).split('\n').map((l) => `> ${l}`).join('\n');
    if (t === 'codeBlock') return (n.content || []).map((c) => c.text).join('');
    if (t === 'horizontalRule') return '---';
    if (t === 'image') return inline([n]);
    if (t === 'table') return (n.content || []).map((r) => (r.content || []).map((c) => blocks(c.content).replace(/\s*\n+\s*/g, ' ')).join('\t')).join('\n');
    if (t === 'sheetChart') { const { title: ct, rows } = chartTable(n.attrs); return [ct, ...rows.map((r) => r.join('\t'))].join('\n'); }
    if (t === 'references') return ['References', ...sourcesOf(doc).map((src) => reference(src).map((p) => p.text).join(''))].join('\n\n');
    if (t === 'emailDraft' || t === 'eventDraft') {
      const a = n.attrs || {};
      const lines = t === 'eventDraft' ? eventLines(a) : [['To', a.to || ''], ['Cc', a.cc || ''], ['Subject', a.subject || '']].filter(([k, v]) => v || k !== 'Cc');
      return [...lines.map(([k, v]) => `${k}: ${v}`), blocks(n.content)].filter(Boolean).join('\n');
    }
    if (t === 'tableOfContents' || t === 'pageBreak') return null;
    return n.content ? blocks(n.content) : null;
  }).filter((b) => b !== null && b !== undefined).join('\n\n');
  const body = blocks(doc?.content || []).replace(/\n{3,}/g, '\n\n').trim();
  return `${body}${notes.length ? `\n\n${notes.map((t, k) => `[${k + 1}] ${t}`).join('\n')}` : ''}\n`;
}

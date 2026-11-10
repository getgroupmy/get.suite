// A document as an e-book (EPUB 3): readable on e-readers (Kobo, Kindle via Send to Kindle, Apple Books, phones).
// A chapter starts at each top-level heading (the first heading level used), with a table of contents;
// paragraphs and their alignment, bold/italic/underline/strike/code, links, lists and checklists, quotes, code,
// tables, pictures (in the book) and footnotes (as notes at the end of their chapter); chips as their text.
import JSZip from 'jszip';
import crypto from 'node:crypto';
import { flattenTabs } from './doctabs.js';
import { chipText, dateText, eventLines } from './chiptext.js';
import { inText, reference, sourcesOf } from './cite.js';
import { chartTable } from './sheetchart.js';

export const EPUB_MIME = 'application/epub+zip';
const x = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const textOf = (n) => (n.type === 'text' ? n.text || '' : (n.content || []).map(textOf).join(''));

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

  let notes = [];
  const inline = (list = []) => list.map((n) => {
    if (n.type === 'hardBreak') return '<br/>';
    if (n.type === 'footnote') { notes.push(n.attrs?.note || ''); const k = notes.length; return `<a epub:type="noteref" id="r${k}" href="#n${k}"><sup>${k}</sup></a>`; }
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
    if (t === 'heading') { const lv = Math.min(6, n.attrs?.level || 1); return `<h${lv}${align(n)}>${inline(n.content)}</h${lv}>`; }
    if (t === 'bulletList' || t === 'orderedList') return `<${t === 'bulletList' ? 'ul' : 'ol'}>${(n.content || []).map((li) => `<li>${blocks(li.content)}</li>`).join('')}</${t === 'bulletList' ? 'ul' : 'ol'}>`;
    if (t === 'taskList') return `<ul class="tasks">${(n.content || []).map((li) => `<li>${li.attrs?.checked ? '☑' : '☐'} ${blocks(li.content).replace(/^<p>|<\/p>$/g, '')}</li>`).join('')}</ul>`;
    if (t === 'blockquote') return `<blockquote>${blocks(n.content)}</blockquote>`;
    if (t === 'codeBlock') return `<pre><code>${x((n.content || []).map((c) => c.text).join(''))}</code></pre>`;
    if (t === 'horizontalRule') return '<hr/>';
    if (t === 'image') return `<p class="picture">${inline([n])}</p>`;
    if (t === 'table') return `<table>${(n.content || []).map((r) => `<tr>${(r.content || []).map((c) => { const tag = c.type === 'tableHeader' ? 'th' : 'td'; return `<${tag}${c.attrs?.colspan > 1 ? ` colspan="${c.attrs.colspan}"` : ''}>${blocks(c.content)}</${tag}>`; }).join('')}</tr>`).join('')}</table>`;
    if (t === 'sheetChart') { const { title: ct, rows } = chartTable(n.attrs); return `<p><strong>${x(ct)}</strong></p>${rows.length ? `<table>${rows.map((r, i) => `<tr>${r.map((v) => `<${i ? 'td' : 'th'}>${x(v)}</${i ? 'td' : 'th'}>`).join('')}</tr>`).join('')}</table>` : ''}`; }
    if (t === 'references') return `<h2>References</h2>${sourcesOf(doc).map((s) => `<p class="ref">${reference(s).map((p) => (p.italic ? `<em>${x(p.text)}</em>` : x(p.text))).join('')}</p>`).join('')}`;
    if (t === 'emailDraft' || t === 'eventDraft') {
      const a = n.attrs || {};
      const lines = t === 'eventDraft' ? eventLines(a) : [['To', a.to || ''], ['Cc', a.cc || ''], ['Subject', a.subject || '']].filter(([k, v]) => v || k !== 'Cc');
      return `<div class="draft">${lines.map(([k, v]) => `<p><strong>${x(k)}:</strong> ${x(v)}</p>`).join('')}${blocks(n.content)}</div>`;
    }
    if (t === 'tableOfContents' || t === 'pageBreak') return '';
    return n.content ? blocks(n.content) : '';
  }).join('\n');

  const css = 'body { font-family: serif; line-height: 1.5; } h1, h2, h3 { line-height: 1.2; } img { max-width: 100%; } table { border-collapse: collapse; } td, th { border: 1px solid #999; padding: 0.2em 0.4em; } blockquote { margin-left: 1em; padding-left: 0.8em; border-left: 3px solid #bbb; } pre { white-space: pre-wrap; font-size: 0.9em; } ul.tasks { list-style: none; padding-left: 0.5em; } .notes { font-size: 0.9em; border-top: 1px solid #ccc; margin-top: 2em; } .ref { padding-left: 2em; text-indent: -2em; }';
  const page = (t, body) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${x(lang)}" lang="${x(lang)}"><head><meta charset="UTF-8"/><title>${x(t)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body>
${body}
</body></html>`;
  const files = chapters.map((ch, i) => {
    notes = [];
    const body = blocks(ch.nodes);
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
${files.map((f, i) => `<item id="c${i + 1}" href="${f.path}" media-type="application/xhtml+xml"/>`).join('\n')}
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

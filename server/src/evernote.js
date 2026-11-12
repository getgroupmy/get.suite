// Evernote's export (.enex): <en-export><note><title/><content><![CDATA[<en-note>…ENML…</en-note>]]></content><created>20240105T101500Z</created>
// <updated/><tag/>…</note>…</en-export>. Each note as { title, body, items, labels, created_at, updated_at }: a note made of
// to-dos (<en-todo checked="true"/>) becomes a checklist; otherwise its text, a line per paragraph.
import { parseDocument, DomUtils } from 'htmlparser2';
import { createHash } from 'node:crypto';

const PICTURES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

const BLOCK = /^(div|p|br|li|h[1-6]|tr|blockquote|pre|en-note|ul|ol|table)$/;
const stamp = (v) => { const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(String(v || '').trim()); return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null; };

/** ENML (Evernote's HTML) as lines of text, to-dos marked "[ ] " / "[x] ". */
export function enmlLines(enml, { html = false, shown = null, takePicture = null } = {}) {
  const doc = html ? (typeof enml === 'string' ? parseDocument(enml, { decodeEntities: true }) : enml)
    : parseDocument(String(enml || '').replace(/&nbsp;/g, '&#160;'), { xmlMode: true, decodeEntities: true }); // ENML is XHTML: <en-todo/> closes itself
  let out = '';
  const walk = (n) => {
    if (n.type === 'text') { out += n.data; return; }
    if (n.type !== 'tag') { for (const c of n.children || []) walk(c); return; }
    if (n.name === 'en-todo') { out += n.attribs?.checked === 'true' ? '[x] ' : '[ ] '; return; }
    if (n.name === 'en-media') { if (!shown?.has(String(n.attribs?.hash || '').toLowerCase())) out += '[attachment] '; return; } // a picture brought in as one isn't marked in the text
    if (/^(script|style|head|title|noscript|template)$/.test(n.name)) return;
    if (n.name === 'input' && n.attribs?.type === 'checkbox') { out += n.attribs.checked !== undefined ? '[x] ' : '[ ] '; return; }
    if (n.name === 'img') { if (!takePicture?.(String(n.attribs?.src || ''))) out += '[picture] '; return; } // one kept as the note's picture isn't marked
    if (n.name === 'li') out += '\n• ';
    for (const c of n.children || []) walk(c);
    if (BLOCK.test(n.name)) out += '\n';
  };
  walk(doc);
  return out.replace(/ /g, ' ').split('\n').map((l) => l.replace(/[ \t]+$/g, '')).filter((l, i, a) => l.trim() || (i > 0 && a[i - 1].trim()));
}

/** The notes in an .enex file, or { error }. */
export function notesFromEnex(xml) {
  const doc = parseDocument(String(xml || ''), { xmlMode: true });
  const notes = DomUtils.getElementsByTagName('note', doc.children, true);
  if (!notes.length && !DomUtils.getElementsByTagName('en-export', doc.children, true).length) return { error: 'That isn’t an Evernote export (.enex)' };
  const text = (n, tag) => { const el = DomUtils.getElementsByTagName(tag, n.children, false)[0]; return el ? DomUtils.textContent(el) : ''; };
  return {
    notes: notes.map((n) => {
      // Its pictures: <resource><data encoding="base64">…</data><mime>image/png</mime></resource>, matched to <en-media hash="md5"/>.
      const pictures = DomUtils.getElementsByTagName('resource', n.children, false).flatMap((r) => {
        const mime = text(r, 'mime').trim().toLowerCase().replace('image/jpg', 'image/jpeg');
        if (!PICTURES.includes(mime)) return [];
        const data = Buffer.from(text(r, 'data').replace(/\s+/g, ''), 'base64');
        return data.length && data.length <= 10 * 1024 * 1024 ? [{ mime, data, hash: createHash('md5').update(data).digest('hex') }] : [];
      }).slice(0, 10);
      const lines = enmlLines(text(n, 'content'), { shown: new Set(pictures.map((p) => p.hash)) });
      const todos = lines.filter((l) => /^\[( |x)\] /.test(l.trim()));
      const isList = todos.length > 0 && todos.length >= lines.filter((l) => l.trim()).length / 2;
      return {
        title: text(n, 'title').trim().slice(0, 300),
        body: isList ? '' : lines.join('\n').trim().slice(0, 20000),
        items: isList ? lines.filter((l) => l.trim()).map((l) => { const m = /^\[( |x)\] (.*)$/.exec(l.trim()); return m ? { text: m[2], done: m[1] === 'x' } : { text: l.trim(), done: false }; }) : null,
        labels: DomUtils.getElementsByTagName('tag', n.children, false).map((t) => DomUtils.textContent(t).trim()).filter(Boolean),
        created_at: stamp(text(n, 'created')), updated_at: stamp(text(n, 'updated')),
        pictures: pictures.map(({ mime, data }) => ({ mime, data })),
      };
    }).filter((x) => x.title || x.body || (x.items || []).length || x.pictures.length),
  };
}

/**
 * One note from an HTML file (Apple Notes, OneNote, Bear or Google Keep's own .html, saved web pages): the title from
 * <title>, a Keep "title" block or the first heading, else the file name; ticked boxes make it a checklist as in Evernote.
 */
export function noteFromHtml(html, name = '', { files = new Map() } = {}) {
  const doc = parseDocument(String(html || ''), { decodeEntities: true });
  const one = (pred) => DomUtils.findOne(pred, doc.children, true);
  const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  const keepTitle = one((e) => /(^|\s)title(\s|$)/.test(e.attribs?.class || ''));
  const h1 = one((e) => /^h[1-3]$/.test(e.name));
  const titleEl = one((e) => e.name === 'title');
  const title = (clean(keepTitle && DomUtils.textContent(keepTitle)) || clean(titleEl && DomUtils.textContent(titleEl)) || clean(h1 && DomUtils.textContent(h1))
    || String(name).replace(/\.[^.]+$/, '')).slice(0, 300);
  const bodyEl = one((e) => /(^|\s)content(\s|$)/.test(e.attribs?.class || '')) || one((e) => e.name === 'body') || doc;
  // Its pictures: ones written into the page (data: URLs, as Apple Notes exporters do) or files beside it in the same .zip (files: src → { mime, data }).
  const pictures = [];
  const takePicture = (src) => {
    if (pictures.length >= 10) return false;
    const m = /^data:(image\/(?:png|jpe?g|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/i.exec(src.trim());
    const pic = m ? { mime: m[1].toLowerCase().replace('image/jpg', 'image/jpeg'), data: Buffer.from(m[2].replace(/\s+/g, ''), 'base64') } : files.get(src) || files.get((() => { try { return decodeURI(src); } catch { return src; } })());
    if (!pic || !pic.data?.length || pic.data.length > 10 * 1024 * 1024) return false;
    pictures.push(pic);
    return true;
  };
  let lines = enmlLines(bodyEl, { html: true, takePicture }).map((l) => l.trimStart()).filter((l) => l.trim()); // HTML spacing isn't meant as blank lines
  if (lines[0] && clean(lines[0]) === title) lines = lines.slice(1); // the heading the title came from
  const todos = lines.filter((l) => /^(• )?\[( |x)\] /.test(l.trim()));
  const isList = todos.length > 0 && todos.length >= lines.filter((l) => l.trim()).length / 2;
  return {
    title,
    body: isList ? '' : lines.join('\n').trim().slice(0, 20000),
    items: isList ? lines.filter((l) => l.trim()).map((l) => { const m = /^(?:• )?\[( |x)\] (.*)$/.exec(l.trim()); return m ? { text: m[2].trim(), done: m[1] === 'x' } : { text: l.trim(), done: false }; }) : null,
    labels: [],
    pictures,
  };
}

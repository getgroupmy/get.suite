// Evernote's export (.enex): <en-export><note><title/><content><![CDATA[<en-note>…ENML…</en-note>]]></content><created>20240105T101500Z</created>
// <updated/><tag/>…</note>…</en-export>. Each note as { title, body, items, labels, created_at, updated_at }: a note made of
// to-dos (<en-todo checked="true"/>) becomes a checklist; otherwise its text, a line per paragraph.
import { parseDocument, DomUtils } from 'htmlparser2';

const BLOCK = /^(div|p|br|li|h[1-6]|tr|blockquote|pre|en-note|ul|ol|table)$/;
const stamp = (v) => { const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(String(v || '').trim()); return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null; };

/** ENML (Evernote's HTML) as lines of text, to-dos marked "[ ] " / "[x] ". */
export function enmlLines(enml) {
  const doc = parseDocument(String(enml || '').replace(/&nbsp;/g, '&#160;'), { xmlMode: true, decodeEntities: true }); // ENML is XHTML: <en-todo/> closes itself
  let out = '';
  const walk = (n) => {
    if (n.type === 'text') { out += n.data; return; }
    if (n.type !== 'tag') { for (const c of n.children || []) walk(c); return; }
    if (n.name === 'en-todo') { out += n.attribs?.checked === 'true' ? '[x] ' : '[ ] '; return; }
    if (n.name === 'en-media') { out += '[attachment] '; return; }
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
      const lines = enmlLines(text(n, 'content'));
      const todos = lines.filter((l) => /^\[( |x)\] /.test(l.trim()));
      const isList = todos.length > 0 && todos.length >= lines.filter((l) => l.trim()).length / 2;
      return {
        title: text(n, 'title').trim().slice(0, 300),
        body: isList ? '' : lines.join('\n').trim().slice(0, 20000),
        items: isList ? lines.filter((l) => l.trim()).map((l) => { const m = /^\[( |x)\] (.*)$/.exec(l.trim()); return m ? { text: m[2], done: m[1] === 'x' } : { text: l.trim(), done: false }; }) : null,
        labels: DomUtils.getElementsByTagName('tag', n.children, false).map((t) => DomUtils.textContent(t).trim()).filter(Boolean),
        created_at: stamp(text(n, 'created')), updated_at: stamp(text(n, 'updated')),
      };
    }).filter((x) => x.title || x.body || (x.items || []).length),
  };
}

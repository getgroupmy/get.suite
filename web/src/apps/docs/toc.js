// A table of contents block: the document's headings, kept up to date as anyone edits, each one a
// link to its heading. Stored as an empty node; the list is drawn from the headings around it.
import { Node } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { headingsOf } from './outline.js';

/** The entries of a contents list: [{ level (from 1, relative to the top heading), text, pos }]. */
export function contentsOf(doc) {
  const hs = headingsOf(doc);
  const top = Math.min(...hs.map((h) => h.level));
  return hs.map((h) => ({ ...h, level: h.level - top + 1 }));
}

const escapeHtml = (t) => t.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const slug = (t, used) => {
  const base = t.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'section';
  let s = base;
  for (let i = 2; used.has(s); i++) s = `${base}-${i}`;
  used.add(s);
  return s;
};
/**
 * HTML from the editor with each contents block filled in as links to its headings (given ids).
 * `html` is editor.getHTML(); `doc` the editor's document.
 */
export function htmlWithContents(html, doc) {
  if (!html.includes('data-toc')) return html;
  const entries = contentsOf(doc);
  const used = new Set();
  const ids = entries.map((e) => slug(e.text, used));
  let i = 0;
  // Headings with text get ids in order (empty ones are skipped, as in the list).
  const withIds = html.replace(/<h([1-6])([^>]*)>([\s\S]*?)<\/h\1>/g, (m, lvl, attrs, inner) => {
    if (!inner.replace(/<[^>]+>/g, '').trim() || i >= ids.length) return m;
    return `<h${lvl}${attrs} id="${ids[i++]}">${inner}</h${lvl}>`;
  });
  const list = entries.length
    ? `<ul>${entries.map((e, k) => `<li style="margin-left:${(e.level - 1) * 1.5}em"><a href="#${ids[k]}">${escapeHtml(e.text)}</a></li>`).join('')}</ul>`
    : '';
  return withIds.replace(/<nav([^>]*data-toc[^>]*)><\/nav>/g, `<nav$1><p><strong>Contents</strong></p>${list}</nav>`);
}

export const TableOfContents = Node.create({
  name: 'tableOfContents',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  parseHTML: () => [{ tag: 'nav[data-toc]' }],
  renderHTML: () => ['nav', { 'data-toc': '', class: 'doc-toc' }],
  addCommands() {
    return { insertTableOfContents: () => ({ commands }) => commands.insertContent({ type: this.name }) };
  },
  addNodeView() {
    return ({ editor }) => {
      const dom = document.createElement('nav');
      dom.className = 'doc-toc';
      dom.setAttribute('data-toc', '');
      dom.setAttribute('aria-label', 'Table of contents');
      dom.contentEditable = 'false';
      let last = '';
      const draw = () => {
        const entries = contentsOf(editor.state.doc);
        const sig = JSON.stringify(entries.map((e) => [e.level, e.text]));
        if (sig === last) return;
        last = sig;
        dom.replaceChildren();
        const title = document.createElement('div');
        title.className = 'doc-toc-title';
        title.textContent = 'Contents';
        dom.append(title);
        if (!entries.length) {
          const p = document.createElement('div');
          p.className = 'doc-toc-empty';
          p.textContent = 'Add headings to the document and they are listed here.';
          dom.append(p);
          return;
        }
        const ul = document.createElement('ul');
        entries.forEach((e, k) => {
          const li = document.createElement('li');
          li.style.paddingLeft = `${(e.level - 1) * 1.5}em`;
          const a = document.createElement('a');
          a.href = '#';
          a.textContent = e.text;
          a.addEventListener('mousedown', (ev) => ev.preventDefault());
          a.addEventListener('click', (ev) => {
            ev.preventDefault();
            const h = contentsOf(editor.state.doc)[k];
            if (!h) return;
            const { view } = editor;
            const node = view.state.doc.nodeAt(h.pos);
            if (editor.isEditable && node) view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, h.pos + 1 + node.content.size)));
            view.nodeDOM(h.pos)?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
          });
          li.append(a);
          ul.append(li);
        });
        dom.append(ul);
      };
      draw();
      editor.on('update', draw);
      // A link goes to its heading; a click elsewhere selects the block (to move or delete it).
      return { dom, ignoreMutation: () => true, stopEvent: (e) => !!e.target?.closest?.('a'), destroy: () => editor.off('update', draw) };
    };
  },
});

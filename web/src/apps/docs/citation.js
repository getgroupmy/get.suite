// Citations: an inline chip "(Smith, 2020)" holding its source, and a References block listing every
// source cited in the document (APA style), redrawn as anyone edits. Formatting: cite.js (the same as
// the server's, which writes them into Word and Markdown downloads).
import { Node } from '@tiptap/core';
import { CITE_FIELDS, cleanSource, inText, reference, sourcesOf } from './cite.js';

export const Citation = Node.create({
  name: 'citation',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => Object.fromEntries(CITE_FIELDS.map((k) => [k, { default: '', parseHTML: (el) => el.getAttribute(`data-${k}`) || '', renderHTML: (a) => (a[k] ? { [`data-${k}`]: a[k] } : {}) }])),
  parseHTML: () => [{ tag: 'span[data-cite]' }],
  renderHTML: ({ node, HTMLAttributes }) => ['span', { ...HTMLAttributes, 'data-cite': '', class: 'doc-cite', role: 'button', title: reference(node.attrs).map((p) => p.text).join(''), 'aria-label': `Citation ${inText(node.attrs)}` }, inText(node.attrs)],
  renderText: ({ node }) => inText(node.attrs),
  addCommands() {
    return { insertCitation: (src) => ({ commands }) => commands.insertContent({ type: this.name, attrs: cleanSource(src) }) };
  },
});

const draw = (dom, doc) => {
  dom.replaceChildren();
  const title = document.createElement('div');
  title.className = 'doc-refs-title';
  title.textContent = 'References';
  dom.append(title);
  const list = sourcesOf(doc);
  if (!list.length) {
    const p = document.createElement('div');
    p.className = 'doc-refs-empty';
    p.textContent = 'Cite a source (❝ Cite in the toolbar) and it is listed here.';
    dom.append(p);
    return;
  }
  for (const s of list) {
    const p = document.createElement('p');
    p.className = 'doc-ref';
    for (const part of reference(s)) {
      const el = document.createElement(part.italic ? 'em' : 'span');
      el.textContent = part.text;
      p.append(el);
    }
    dom.append(p);
  }
};

export const References = Node.create({
  name: 'references',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  parseHTML: () => [{ tag: 'section[data-references]' }],
  renderHTML: () => ['section', { 'data-references': '', class: 'doc-refs' }],
  addCommands() {
    return { insertReferences: () => ({ commands }) => commands.insertContent({ type: this.name }) };
  },
  addNodeView() {
    return ({ editor }) => {
      const dom = document.createElement('section');
      dom.className = 'doc-refs';
      dom.setAttribute('data-references', '');
      dom.setAttribute('aria-label', 'References');
      dom.contentEditable = 'false';
      let last = '';
      const update = () => {
        const json = editor.getJSON();
        const sig = JSON.stringify(sourcesOf(json));
        if (sig === last) return;
        last = sig;
        draw(dom, json);
      };
      update();
      editor.on('update', update);
      return { dom, ignoreMutation: () => true, destroy: () => editor.off('update', update) };
    };
  },
});

const esc = (t) => t.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
/** HTML from the editor with each references block filled in (for the HTML download). */
export function htmlWithReferences(html, docJson) {
  if (!html.includes('data-references')) return html;
  const list = sourcesOf(docJson).map((s) => `<p style="padding-left:2em;text-indent:-2em">${reference(s).map((p) => (p.italic ? `<em>${esc(p.text)}</em>` : esc(p.text))).join('')}</p>`).join('');
  return html.replace(/<section([^>]*data-references[^>]*)><\/section>/g, `<section$1><h2>References</h2>${list}</section>`);
}

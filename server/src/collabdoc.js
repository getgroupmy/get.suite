// Converting a document between its stored JSON (ProseMirror/TipTap) and the shared Yjs form the
// editors co-edit, the same way TipTap's Yjs bridge (y-tiptap) does: elements carry their non-null
// attributes, runs of text become one XmlText with marks as formatting attributes.
import * as Y from 'yjs';

function fill(parent, nodes) {
  const out = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.type === 'text') {
      const text = new Y.XmlText();
      const delta = [];
      for (; i < nodes.length && nodes[i].type === 'text'; i++) {
        const t = nodes[i];
        delta.push({ insert: t.text || '', attributes: Object.fromEntries((t.marks || []).map((m) => [m.type, m.attrs || {}])) });
      }
      i--;
      out.push([text, delta]);
    } else {
      const el = new Y.XmlElement(n.type);
      for (const [k, v] of Object.entries(n.attrs || {})) if (v !== null && v !== undefined && k !== 'ychange') el.setAttribute(k, v);
      out.push([el, n.content || []]);
    }
  }
  parent.insert(parent.length, out.map(([t]) => t));
  // Children are filled once their parent is part of the document.
  for (const [t, inner] of out) { if (t instanceof Y.XmlText) t.applyDelta(inner); else fill(t, inner); }
}

/** A new Yjs document holding this JSON document. */
export function docFromJson(json, field = 'default') {
  const doc = new Y.Doc();
  doc.transact(() => fill(doc.getXmlFragment(field), json?.content || []));
  return doc;
}

/** The JSON document held in a Yjs document. */
export function jsonFromDoc(doc, field = 'default') {
  const serialize = (item) => {
    if (item instanceof Y.XmlText) {
      return item.toDelta().map((d) => {
        const t = { type: 'text', text: d.insert };
        if (d.attributes && Object.keys(d.attributes).length) {
          t.marks = Object.entries(d.attributes).map(([k, attrs]) => ({ type: k.split('--')[0], ...(attrs && Object.keys(attrs).length && { attrs }) }));
        }
        return t;
      });
    }
    const n = { type: item.nodeName };
    const attrs = item.getAttributes();
    if (Object.keys(attrs).length) n.attrs = attrs;
    const children = item.toArray();
    if (children.length) n.content = children.flatMap(serialize);
    return n;
  };
  return { type: 'doc', content: doc.getXmlFragment(field).toArray().flatMap(serialize) };
}

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

// ---- spreadsheets: a list of sheets, each with cells, column widths and formats as maps, so two
// people changing different cells at once both keep their change (the same cell: the later wins).
const SHEET_MAPS = ['cells', 'colWidths', 'formats'];

/** Make a Y.Map for one sheet from its JSON. */
function sheetMap(sheet) {
  const m = new Y.Map();
  m.set('name', sheet.name || 'Sheet');
  for (const k of SHEET_MAPS) {
    const inner = new Y.Map();
    for (const [key, v] of Object.entries(sheet[k] || {})) inner.set(key, v);
    m.set(k, inner);
  }
  return m;
}

export function sheetDocFromJson(json) {
  const doc = new Y.Doc();
  doc.transact(() => { doc.getArray('sheets').push((json?.sheets?.length ? json.sheets : [{ name: 'Sheet1' }]).map(sheetMap)); });
  return doc;
}

export function jsonFromSheetDoc(doc) {
  return { sheets: doc.getArray('sheets').toArray().map((m) => {
    const s = { name: m.get('name') };
    for (const k of SHEET_MAPS) { const inner = m.get(k); s[k] = inner ? inner.toJSON() : {}; }
    if (!Object.keys(s.formats).length) delete s.formats;
    return s;
  }) };
}

/**
 * Bring the shared spreadsheet in line with `next` using the smallest changes (cell by cell), so
 * concurrent edits elsewhere are kept. Used by the editor for each change it makes.
 */
export function applySheetJson(doc, next) {
  const arr = doc.getArray('sheets');
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  doc.transact(() => {
    const want = next.sheets || [];
    if (arr.length > want.length) arr.delete(want.length, arr.length - want.length);
    want.forEach((sheet, i) => {
      if (i >= arr.length) { arr.push([sheetMap(sheet)]); return; }
      const m = arr.get(i);
      if (m.get('name') !== sheet.name) m.set('name', sheet.name);
      for (const k of SHEET_MAPS) {
        let inner = m.get(k);
        if (!inner) { inner = new Y.Map(); m.set(k, inner); }
        const target = sheet[k] || {};
        for (const key of [...inner.keys()]) if (!(key in target)) inner.delete(key);
        for (const [key, v] of Object.entries(target)) if (!same(inner.get(key), v)) inner.set(key, v);
      }
    });
  });
}

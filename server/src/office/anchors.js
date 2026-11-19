// Headings' anchors (#budget-costs), as in web/src/apps/docs/outline.js: slugOf and anchorsOf are the
// same code (test/anchors-copy.test.js checks), so a Word download keeps links to headings working.

/** A heading's text as an address fragment: lower case, words joined by "-" ("Q3 Results!" → "q3-results"). */
export function slugOf(text) {
  return String(text).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'section';
}

/** Each heading's anchor, unique in the document (a repeated title gets -2, -3…). */
export function anchorsOf(headings) {
  const seen = new Map();
  return headings.map((h) => {
    const base = slugOf(h.text);
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  });
}

/** A document's (TipTap JSON) headings with text, in order, as the editor lists them: [{ node, level, text, anchor }]. */
export function headingsOfDoc(doc) {
  const textOf = (n) => (n.type === 'text' ? n.text || '' : (n.content || []).map(textOf).join(''));
  const out = [];
  (function walk(n) {
    if (n.type === 'heading') { const text = textOf(n).trim(); if (text) out.push({ node: n, level: n.attrs?.level || 1, text }); return; }
    if (n.type !== 'paragraph') for (const c of n.content || []) walk(c);
  })(doc || {});
  anchorsOf(out).forEach((a, k) => { out[k].anchor = a; });
  return out;
}

/**
 * Links to a bookmark at the very start of a heading (as Word and LibreOffice files link to headings) made links to
 * the heading itself (#its-anchor, as the editor makes them), and bookmarks there left out (the heading is the
 * place: Word downloads put one on every heading once any is linked to). Changes `doc` in place.
 */
export function linksToHeadings(doc) {
  const at = new Map(); // bookmark id → the heading's anchor
  for (const h of headingsOfDoc(doc)) {
    for (const c of h.node.content || []) {
      if (c.type === 'bookmark' && c.attrs?.id) { at.set(c.attrs.id, h.anchor); continue; }
      if (c.type === 'text' && !c.text.trim()) continue;
      break;
    }
  }
  if (!at.size) return doc;
  (function walk(n) {
    for (const m of n.marks || []) {
      const id = m.type === 'link' && /^#bm-(.+)$/.exec(m.attrs?.href || '')?.[1];
      if (id && at.has(id)) m.attrs.href = `#${at.get(id)}`;
    }
    for (const c of n.content || []) walk(c);
  })(doc);
  for (const h of headingsOfDoc(doc)) if (h.node.content) h.node.content = h.node.content.filter((c) => !(c.type === 'bookmark' && at.has(c.attrs?.id)));
  return doc;
}

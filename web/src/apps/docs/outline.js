// The document's outline: its headings in order, with where each is, and which one the cursor is under.

/** [{ level, text, pos }] for each heading with text (pos: where the heading starts). */
export function headingsOf(doc) {
  const out = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'heading') {
      const text = node.textContent.trim();
      if (text) out.push({ level: node.attrs.level || 1, text, pos });
      return false;
    }
    return node.type.name !== 'paragraph'; // headings can sit inside tables; nothing is inside a paragraph
  });
  return out;
}

/** The index of the heading the position `at` comes under (-1 before the first). */
export function currentHeading(headings, at) {
  let i = -1;
  for (let k = 0; k < headings.length && headings[k].pos <= at; k++) i = k;
  return i;
}

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

/** The heading an address's #anchor points at (or null). */
export function headingForAnchor(headings, anchor) {
  const want = decodeURIComponent(String(anchor || '').replace(/^#/, '')).toLowerCase();
  if (!want) return null;
  const i = anchorsOf(headings).indexOf(want);
  return i >= 0 ? headings[i] : null;
}

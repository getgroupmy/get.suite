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

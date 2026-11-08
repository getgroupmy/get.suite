// Citations in documents, APA style: "(Smith & Lee, 2020)" in the text, and a references list of
// every source cited. The same file is in web/src/apps/docs/cite.js (keep the two the same; a test
// checks). A source: { author, year, title, publisher, url }; authors are separated by ";" or "&".

const LIMITS = { author: 300, year: 20, title: 500, publisher: 200, url: 500 };
export const CITE_FIELDS = Object.keys(LIMITS);

/** A source as typed, tidied: trimmed, within limits, the address only if it's a web address. */
export function cleanSource(s) {
  const out = {};
  for (const k of CITE_FIELDS) out[k] = String(s?.[k] ?? '').replace(/\s+/g, ' ').trim().slice(0, LIMITS[k]);
  if (out.url && !/^https?:\/\/\S+$/i.test(out.url)) out.url = '';
  return out;
}

/** The authors of a source: "Smith, J.; Lee, K." or "Jane Smith & Kim Lee" → ["Smith, J.", "Lee, K."]. */
export function authorsOf(author) {
  return String(author || '').split(/\s*;\s*|\s+&\s+|\s+and\s+/i).map((a) => a.trim().replace(/,$/, '')).filter(Boolean);
}

/** An author's family name: "Smith, J." → Smith, "Jane Smith" → Smith, "World Health Organization" stays whole. */
export function familyName(a) {
  if (a.includes(',')) return a.split(',')[0].trim();
  const words = a.trim().split(/\s+/);
  return words.length <= 2 ? words[words.length - 1] : a.trim(); // three words or more: an organisation
}

/** The citation in the text: (Smith, 2020), (Smith & Lee, 2020), (Smith et al., 2020), or the title without an author. */
export function inText(src) {
  const names = authorsOf(src?.author).map(familyName);
  const title = String(src?.title || '').trim();
  const who = !names.length ? (title ? `“${title.length > 40 ? `${title.slice(0, 40).trim()}…` : title}”` : 'Anonymous')
    : names.length === 1 ? names[0] : names.length === 2 ? `${names[0]} & ${names[1]}` : `${names[0]} et al.`;
  return `(${who}, ${String(src?.year || '').trim() || 'n.d.'})`;
}

/**
 * The source in the references list, as parts: [{ text, italic? }]. APA: Authors. (Year). *Title*. Publisher. URL
 */
export function reference(src) {
  const s = cleanSource(src);
  const names = authorsOf(s.author);
  const authors = names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')}, & ${names[names.length - 1]}`;
  const dot = (t) => (/[.?!]$/.test(t) ? t : `${t}.`);
  const parts = [];
  if (authors) parts.push({ text: `${dot(authors)} ` });
  parts.push({ text: `(${s.year || 'n.d.'}). ` });
  if (s.title) parts.push({ text: dot(s.title), italic: true });
  if (s.publisher) parts.push({ text: ` ${dot(s.publisher)}` });
  if (s.url) parts.push({ text: ` ${s.url}` });
  return parts;
}
export const referenceText = (src) => reference(src).map((p) => p.text).join('');

/** One key per source, so citing it twice lists it once. */
export const sourceKey = (src) => [src?.author, src?.year, src?.title].map((x) => String(x || '').trim().toLowerCase()).join('|');

/** The sources cited in a document (TipTap JSON), once each, in references-list order (by author, then year). */
export function sourcesOf(doc) {
  const found = new Map();
  const walk = (n) => {
    if (!n) return;
    if (n.type === 'citation') { const s = cleanSource(n.attrs); const k = sourceKey(s); if (!found.has(k)) found.set(k, s); }
    for (const c of n.content || []) walk(c);
  };
  walk(doc);
  const sortKey = (s) => `${(authorsOf(s.author)[0] || s.title).toLowerCase()} ${s.year}`;
  return [...found.values()].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
}

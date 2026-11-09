// Links (Docs, the 🔗 button or Ctrl+K): to a web address, an email address, or a place in this same
// document: a heading (#its-title) or a bookmark (#bm-…). Pure functions on the editor's document.
import { headingsOf, anchorsOf } from './outline.js';
import { bookmarksOf, bookmarkAnchor } from './bookmark.js';

/** The headings and bookmarks a link can go to, in document order: { kind, text, href, level? }. */
export function placesOf(doc) {
  const hs = headingsOf(doc);
  const anchors = anchorsOf(hs);
  const out = [
    ...hs.map((h, i) => ({ kind: 'heading', level: h.level, text: h.text, href: `#${anchors[i]}`, pos: h.pos })),
    ...bookmarksOf(doc).map((b) => ({ kind: 'bookmark', text: b.text || 'Bookmark', href: `#${bookmarkAnchor(b.id)}`, pos: b.pos })),
  ];
  return out.sort((a, b) => a.pos - b.pos).map(({ pos, ...p }) => p);
}

/** What's typed as a link's address, made usable: { href } or { error }. "example.com" gets https://. */
export function cleanHref(input) {
  const v = String(input || '').trim();
  if (!v) return { error: 'Type an address, or choose a place in the document' };
  if (/\s/.test(v)) return { error: 'An address has no spaces' };
  if (/^(https?:\/\/[^/]|mailto:[^@\s]+@|\/|#.)/i.test(v)) return { href: v };
  if (/^[^@/:]+@[\w-]+(\.[\w-]+)+$/.test(v)) return { href: `mailto:${v}` };
  if (/^(www\.)?[\w-]+(\.[\w-]+)+(:\d+)?([/?#].*)?$/i.test(v)) return { href: `https://${v}` };
  return { error: 'That isn’t a web or email address' };
}

/** Where an address goes, in words: the heading or bookmark it names in this document, or the address. */
export function describeHref(href, places) {
  const p = String(href || '').startsWith('#') && places.find((x) => x.href === href);
  if (p) return p.kind === 'heading' ? `Heading: ${p.text}` : `Bookmark: ${p.text}`;
  return String(href || '').replace(/^mailto:/, '');
}

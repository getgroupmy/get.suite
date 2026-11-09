// Links on slides: a box (text, picture, shape, table, chart) can lead to a web address or to another
// slide of the presentation, followed with a click while presenting. Kept on the box as
// link: { url: "https://…" } or link: { slide: "<slide id>" }.
import { safeLink } from '../sheets/formula.js';

/** A link as stored, or null when it isn't a usable one (a slide that's gone, an address that isn't web or email). */
export function cleanLink(link, slideIds) {
  if (!link || typeof link !== 'object') return null;
  if (link.slide !== undefined) return slideIds.includes(String(link.slide)) ? { slide: String(link.slide) } : null;
  const url = safeLink(link.url);
  return url ? { url: url.slice(0, 2000) } : null;
}

/** Where a link goes in this deck: { url } or { i } (the slide's index), or null. */
export function linkTarget(deck, link) {
  if (!link) return null;
  if (link.slide !== undefined) { const i = (deck.slides || []).findIndex((s) => s.id === link.slide); return i >= 0 ? { i } : null; }
  const url = safeLink(link.url);
  return url ? { url } : null;
}

/** "Slide 3: Prices" / "example.com/orders", for tooltips and the toolbar. */
export function linkLabel(deck, link) {
  const t = linkTarget(deck, link);
  if (!t) return '';
  if (t.url) return t.url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
  return `Slide ${t.i + 1}${slideTitle(deck.slides[t.i]) ? `: ${slideTitle(deck.slides[t.i])}` : ''}`;
}

/** A slide's title (its title box, else its first text). */
export function slideTitle(slide) {
  const items = slide?.items || [];
  const t = items.find((it) => it.type === 'text' && it.role === 'title' && it.text?.trim()) || items.find((it) => it.type === 'text' && it.text?.trim());
  return t ? t.text.trim().split('\n')[0].slice(0, 60) : '';
}

/** Links to a slide that was deleted are dropped (the boxes stay). */
export function dropLinksTo(deck, slideId) {
  return { ...deck, slides: deck.slides.map((s) => ({ ...s, items: s.items.map((it) => (it.link?.slide === slideId ? (({ link, ...rest }) => rest)(it) : it)) })) };
}

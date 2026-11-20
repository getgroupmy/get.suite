// Where in a presentation or spreadsheet a search's words are (Search everything, Drive's search): the first
// slide with all of them, or the first cell with the first of them, as a place link's hash and words for it.

// As search reads words: any case, accents left out (cafe finds café), the start of a word enough.
const fold = (t) => String(t || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
const wordsOf = (q) => (fold(q).match(/[\p{L}\p{N}]+/gu) || []).slice(0, 12);
const has = (text, w) => fold(text).includes(w);

/** A slide's words (as search reads them): its boxes, shapes, tables, chart titles, picture descriptions, notes. */
const slideText = (s) => [...(s.items || []).map((it) => (it.type === 'text' || it.type === 'shape' ? it.text || '' : it.type === 'table' ? (it.cells || []).flat().join(' ')
  : it.type === 'chart' ? it.title || '' : it.type === 'image' ? it.alt || '' : '')), s.notes || ''].join('\n');

/** { hash, words } for where `query` is in a presentation's or spreadsheet's JSON, or null. */
export function placeOfMatch(kind, json, query) {
  const words = wordsOf(query);
  if (!words.length) return null;
  if (kind === 'slides') {
    const slides = json?.slides || [];
    const at = slides.findIndex((s) => { const t = slideText(s); return words.every((w) => has(t, w)); });
    return at < 0 ? null : { hash: `#slide=${encodeURIComponent(slides[at].id)}`, words: `Slide ${at + 1}` };
  }
  if (kind === 'sheet') {
    for (const s of json?.sheets || []) {
      const keys = Object.keys(s.cells || {}).filter((k) => /^[A-Z]{1,3}\d+$/.test(k)).sort((a, b) => {
        const [, ca, ra] = /^([A-Z]+)(\d+)$/.exec(a); const [, cb, rb] = /^([A-Z]+)(\d+)$/.exec(b);
        return Number(ra) - Number(rb) || ca.length - cb.length || ca.localeCompare(cb);
      });
      const k = keys.find((key) => { const v = s.cells[key]; return typeof v === 'string' && !v.startsWith('=') && has(v, words[0]); });
      if (k) return { hash: `#sheet=${encodeURIComponent(s.name)}&range=${k}`, words: `${s.name} · ${k}` };
    }
    return null;
  }
  return null;
}

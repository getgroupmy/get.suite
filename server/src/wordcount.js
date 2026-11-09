// A copy of web/src/apps/docs/wordcount.js (the server counts a document's words for Drive's Details).
// Keep the two the same: test/wordcount-copy.test.js checks.
// Word count (Docs): words, characters (with and without spaces), paragraphs and reading time, for the
// whole document or the selected part. Words are counted as Docs and Word count them: "it’s",
// "2026.11" and "e-mail" are one word each; punctuation and symbols on their own aren't words.
const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’\-_.]*/gu;
export const WORDS_PER_MINUTE = 230;

/** Counts for plain text (lines are paragraphs; line breaks aren't characters). */
export function countText(text) {
  const t = String(text || '');
  return {
    words: (t.match(WORD) || []).length,
    characters: t.replace(/\n/g, '').length,
    noSpaces: t.replace(/\s/g, '').length,
    paragraphs: t.split('\n').filter((l) => l.trim()).length,
  };
}

/** Minutes to read that many words (at least 1 when there are any). */
export const readingMinutes = (words) => (words > 0 ? Math.max(1, Math.round(words / WORDS_PER_MINUTE)) : 0);

/** "1 min" / "12 min" / "1 h 5 min". */
export function readingTime(words) {
  const m = readingMinutes(words);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}

/** Counts for a ProseMirror document, or for from..to in it (pictures and other blocks count as nothing). */
export function countDoc(doc, from = 0, to = doc.content.size) {
  const lines = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true;
    const a = Math.max(from, pos + 1), b = Math.min(to, pos + 1 + node.content.size);
    lines.push(b > a ? doc.textBetween(a, b, ' ', ' ') : '');
    return false;
  });
  return countText(lines.join('\n'));
}

/** What the counter shows while typing: "340 words", or "12 of 340 words" with a selection. */
export function counterText(all, part) {
  const n = (x) => x.toLocaleString('en-GB');
  return part ? `${n(part.words)} of ${n(all.words)} ${all.words === 1 ? 'word' : 'words'}` : `${n(all.words)} ${all.words === 1 ? 'word' : 'words'}`;
}

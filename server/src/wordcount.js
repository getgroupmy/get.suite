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

/** Minutes to say that many words aloud (a talk or a speech, at about 130 words a minute). */
export const SPEAKING_WORDS_PER_MINUTE = 130;
export function speakingTime(words) {
  const m = words > 0 ? Math.max(1, Math.round(words / SPEAKING_WORDS_PER_MINUTE)) : 0;
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}

/** Sentences: runs of text ending in . ! ? or … (or the end of a line), with a word in them. */
export function countSentences(text) {
  return String(text || '').split(/[.!?…]+(?=\s|$)|\n+/u).filter((x) => WORD.test(x) && (WORD.lastIndex = 0, true)).length;
}

/** Syllables in an English word, roughly (vowel groups, a silent final e, at least one). */
export function syllables(word) {
  const w = String(word).toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const groups = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '').match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
}

/**
 * How easy the text is to read (Flesch reading ease, for English): { score (0–100, higher is easier), label },
 * or null with too little text (under 30 words) to say.
 */
export function readability(text) {
  const words = String(text || '').match(WORD) || [];
  if (words.length < 30) return null;
  const sentences = Math.max(1, countSentences(text));
  const syl = words.reduce((n, w) => n + syllables(w), 0);
  const score = Math.round(Math.min(100, Math.max(0, 206.835 - 1.015 * (words.length / sentences) - 84.6 * (syl / words.length))));
  const label = score >= 90 ? 'Very easy' : score >= 80 ? 'Easy' : score >= 70 ? 'Fairly easy' : score >= 60 ? 'Plain English' : score >= 50 ? 'Fairly difficult' : score >= 30 ? 'Difficult' : 'Very difficult';
  return { score, label };
}

/** The text of a ProseMirror document, or of from..to in it: one line per paragraph (pictures and other blocks are nothing). */
export function textOfDoc(doc, from = 0, to = doc.content.size) {
  const lines = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true;
    const a = Math.max(from, pos + 1), b = Math.min(to, pos + 1 + node.content.size);
    lines.push(b > a ? doc.textBetween(a, b, ' ', ' ') : '');
    return false;
  });
  return lines.join('\n');
}

/** Counts for a ProseMirror document, or for from..to in it. */
export const countDoc = (doc, from = 0, to = doc.content.size) => countText(textOfDoc(doc, from, to));

/** What the counter shows while typing: "340 words", or "12 of 340 words" with a selection. */
export function counterText(all, part) {
  const n = (x) => x.toLocaleString('en-GB');
  return part ? `${n(part.words)} of ${n(all.words)} ${all.words === 1 ? 'word' : 'words'}` : `${n(all.words)} ${all.words === 1 ? 'word' : 'words'}`;
}

/** Progress towards a word count goal: { text: "350 / 1,000 words", pct: 35, done } ("✓" once it's reached). */
export function goalProgress(words, goal) {
  const n = (x) => x.toLocaleString('en-GB');
  const pct = Math.min(100, Math.floor((words / goal) * 100));
  const done = words >= goal;
  return { text: `${done ? '✓ ' : ''}${n(words)} / ${n(goal)} words`, pct, done };
}

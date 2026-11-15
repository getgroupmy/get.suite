// Voice typing: what's said turned into text for the document. The browser recognises the speech
// (SpeechRecognition); here, spoken punctuation becomes punctuation ("comma", "full stop" or "period",
// "question mark", "new line", "new paragraph"…), sentences get their capital letter, and the spacing
// fits what's already before the cursor.

const MARKS = [
  [/\b(?:full stop|period)\b/gi, '.'], [/\bcomma\b/gi, ','], [/\bquestion mark\b/gi, '?'], [/\bexclamation (?:mark|point)\b/gi, '!'],
  [/\bcolon\b/gi, ':'], [/\bsemicolon\b/gi, ';'], [/\b(?:dash|hyphen)\b/gi, '-'], [/\bellipsis\b/gi, '…'],
  [/\bopen (?:bracket|parenthesis)\b/gi, '('], [/\bclose (?:bracket|parenthesis)\b/gi, ')'],
  [/\bopen quote\b/gi, '“'], [/\bclose quote\b/gi, '”'],
  [/\bnew paragraph\b/gi, '\n\n'], [/\bnew line\b/gi, '\n'],
];

/**
 * One recognised phrase as text to insert, given the text just before the cursor (`before`, '' at the start
 * of a paragraph). → the text, with "\n" for a new line and "\n\n" for a new paragraph.
 */
export function spokenToText(phrase, before = '') {
  let t = ` ${String(phrase || '').trim()} `;
  for (const [re, mark] of MARKS) t = t.replace(re, mark);
  t = t
    .replace(/\s+([.,?!:;…)”])/g, '$1') // no space before closing punctuation
    .replace(/([(“])\s+/g, '$1') // nor after opening
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^[ \t]+|[ \t]+$/g, '');
  if (!t) return '';
  // A capital after the end of a sentence, a new line, or at the start.
  const prev = before.replace(/[ \t]+$/, '');
  const startsSentence = !prev || /[.?!…]["”’)]?$/.test(prev) || /\n$/.test(before);
  t = t.replace(/(^|[.?!…]\s+|\n)(\p{Ll})/gu, (m, p, c) => (p || startsSentence ? p + c.toUpperCase() : m));
  if (!startsSentence) t = t.replace(/^(\p{Lu})(\p{Ll})/u, (m, a, b) => (/^I\b/.test(t) ? m : a.toLowerCase() + b)); // the browser's own capital, mid-sentence
  // A space between what was there and this, unless it starts with punctuation or a new line.
  const needsSpace = before && !/\s$/.test(before) && !/^[.,?!:;…)”\n]/.test(t);
  return (needsSpace ? ' ' : '') + t;
}

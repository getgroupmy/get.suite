// Did you mean to attach something? The words of a message that say a file comes with it ("I've attached",
// "see attachment", "enclosed", "PFA"), leaving out what's quoted from earlier mail (a reply's
// "On … wrote:" and the blockquote under it), which may well talk about attachments that were there.
const SAYS = [
  /\battach(?:ed|ment|ments|ing)\b(?!\s+(?:to|importance|significance)\b)/i, // "attached to the idea" isn't a file
  /\battach\s+(?:the|a|an|my|our|it|them|this|these|those|herewith)\b/i,
  /\b(?:enclosed|enclosing|herewith)\b/i,
  /\bp\.?f\.?a\.?\b/i, // please find attached
  /\bplease find\b[^.!?\n]{0,40}\b(?:file|copy|document|spreadsheet|pdf|invoice|report)/i,
  /\bpi[eè]ce[s]? jointe?s?\b|\banbei\b|\badjunt[oa]s?\b|\ballegat[oi]\b|\bbijlage\b/i, // a few other languages
];

/** The message's own words: no quoted earlier mail, no tags. */
export function ownText(html) {
  let s = String(html || '');
  const q = s.search(/<blockquote[\s>]/i);
  if (q >= 0) {
    // The "On (date), (someone) wrote:" line just before the quote goes too.
    const before = s.slice(0, q).replace(/<p[^>]*>(?:(?!<p[\s>]).)*wrote:\s*<\/p>\s*$/is, '');
    s = before;
  }
  return s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"');
}

/** The words that say something is attached (as written), or null. Plain text is used when there's no HTML. `words` are
 * the person's own (Settings → Mail), matched as whole words in any case. */
export function mentionsAttachment({ html = '', text = '', subject = '', words = [] } = {}) {
  const own = words.filter(Boolean).map((w) => new RegExp(`(?<![\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}(?![\\p{L}\\p{N}])`, 'iu'));
  const body = html ? ownText(html) : String(text).split('\n').filter((l) => !/^\s*>/.test(l)).join('\n');
  const ownSubject = /^\s*(re|fwd?|aw|wg)\s*:/i.test(subject) ? '' : String(subject); // a reply's subject was someone else's
  for (const where of [body, ownSubject]) {
    for (const re of [...SAYS, ...own]) {
      const m = where.match(re);
      if (m) return m[0].trim();
    }
  }
  return null;
}

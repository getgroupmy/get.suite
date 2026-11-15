// Emoji by typing: ":" and a word (":thu", ":party") offers matching emoji under the cursor, as "@" offers
// colleagues; Enter or Tab puts the one picked in place of what was typed.
import { searchEmoji } from '../../components/emoji.js';

/** The ":word" being typed just before the cursor: { from, query } or null. Times (10:30) and "Note: x" aren't. */
export function emojiQuery(textBefore, cursor) {
  const m = /(^|[\s(“"'])[:]([a-z][a-z0-9_+-]{1,23})$/i.exec(textBefore);
  return m ? { from: cursor - m[2].length - 1, query: m[2] } : null;
}

/** Emoji matching what's typed (words joined by _ or -), at most eight; an exact name first. */
export function matchEmoji(query, max = 8) {
  const words = query.toLowerCase().replace(/[_-]+/g, ' ').trim();
  if (!words) return [];
  const list = searchEmoji(words);
  const exact = (e) => e.name.toLowerCase() === words;
  return [...list.filter(exact), ...list.filter((e) => !exact(e))].slice(0, max);
}

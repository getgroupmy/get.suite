// Emoji by typing: ":" and a word (":thu", ":party") offers matching emoji under the cursor, as "@" offers
// colleagues; Enter or Tab puts the one picked in place of what was typed. In Docs, and in Chat's
// message boxes (useEmojiTyping in emojityping.jsx).
import { searchEmoji } from './emoji.js';

/** The ":word" being typed just before the cursor: { from, query } or null. Times (10:30) and "Note: x" aren't. */
export function emojiQuery(textBefore, cursor) {
  const m = /(^|[\s(“"'])[:]([a-z][a-z0-9_+-]{1,23})$/i.exec(textBefore);
  return m ? { from: cursor - m[2].length - 1, query: m[2] } : null;
}

/**
 * Emoji matching what's typed (words joined by _ or -), at most eight; an exact name first. `custom`
 * ([{ name, img }], Chat's company emoji) come before the rest when their name has what's typed; they go
 * in as ":name:".
 */
export function matchEmoji(query, max = 8, custom = []) {
  const words = query.toLowerCase().replace(/[_-]+/g, ' ').trim();
  if (!words) return [];
  const raw = query.toLowerCase();
  const own = custom.filter((c) => c.name.includes(raw) || c.name.replace(/[_-]+/g, ' ').includes(words))
    .sort((a, b) => b.name.startsWith(raw) - a.name.startsWith(raw)).map((c) => ({ char: `:${c.name}:`, name: c.name, img: c.img }));
  const list = searchEmoji(words);
  const exact = (e) => e.name.toLowerCase() === words;
  return [...own, ...list.filter(exact), ...list.filter((e) => !exact(e))].slice(0, max);
}

// Slide text boxes as lists: Tab and Shift+Tab move lines a level in or out (a tab at a line's start per level).
import { SLIDE_LEVELS } from '../docs/liststyle.js';

/** Lines from the one holding `from` to the one holding `to` moved a level in (by +1) or out (-1): { text, first, total } (the
 * change at the first line and in all, for the selection). */
export function indentLines(v, from, to, by) {
  let first = 0, total = 0, pos = 0;
  const lines = v.split('\n').map((l) => {
    const start = pos; pos += l.length + 1;
    if (start + l.length < from || start > to) return l;
    const tabs = /^\t*/.exec(l)[0].length;
    const d = by > 0 ? (tabs < SLIDE_LEVELS - 1 ? 1 : 0) : (tabs > 0 ? -1 : 0);
    if (start <= from && from <= start + l.length) first = d;
    total += d;
    return d > 0 ? `\t${l}` : d < 0 ? l.slice(1) : l;
  });
  return { text: lines.join('\n'), first, total };
}

// Comments on a line of a text file: the comment keeps the line's number and its text as it was, so when lines are
// added or taken out above it the comment follows its line; if the line itself was rewritten it stays at its old
// number and says so.
export const MARK_TEXT = 300;
const key = (s) => String(s ?? '').slice(0, MARK_TEXT);

/** What a comment on line n (1-based) keeps. */
export const lineAnchor = (n, text) => ({ line: n, text: key(text) });

/** Where a commented line is now: { line, moved (it's at another number), lost (its text is no longer in the file) }. */
export function placeMark(lines, anchor) {
  const want = key(anchor.text), i = anchor.line - 1;
  const same = (k) => k >= 0 && k < lines.length && key(lines[k]) === want;
  if (same(i)) return { line: anchor.line, moved: false, lost: false };
  // The nearest line that reads the same (a blank line can't be told from any other, so it isn't followed).
  if (want.trim()) for (let d = 1; d <= Math.max(i, lines.length - i); d++) {
    if (same(i - d)) return { line: i - d + 1, moved: true, lost: false };
    if (same(i + d)) return { line: i + d + 1, moved: true, lost: false };
  }
  return { line: Math.min(Math.max(1, anchor.line), Math.max(1, lines.length)), moved: false, lost: true };
}

/** Each comment's place, by id; and for each line (1-based) the comments on it, in the order given. */
export function placeMarks(lines, marks) {
  const placed = {}, byLine = new Map();
  for (const m of marks || []) {
    const p = placeMark(lines, m);
    placed[m.id] = p;
    if (!byLine.has(p.line)) byLine.set(p.line, []);
    byLine.get(p.line).push(m.id);
  }
  return { placed, byLine };
}

/** “Line 12”, or “Line 12 (since changed)” when the line was rewritten or removed. */
export const lineLabel = (anchor, place) => `Line ${(place?.line ?? anchor.line).toLocaleString()}${place?.lost ? ' (since changed)' : ''}`;

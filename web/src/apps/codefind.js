// Find in a file's text (the code viewer): every place the words appear, line by line, ignoring case.

/** [{ line, start, end }] for each match of q in lines (case-insensitive; matches don't overlap). At most `max`. */
export function findInLines(lines, q, max = 5000) {
  const needle = String(q || '').toLowerCase();
  if (!needle) return [];
  const out = [];
  for (let i = 0; i < lines.length && out.length < max; i++) {
    const hay = lines[i].toLowerCase();
    for (let at = hay.indexOf(needle); at !== -1 && out.length < max; at = hay.indexOf(needle, at + needle.length)) out.push({ line: i, start: at, end: at + needle.length });
  }
  return out;
}

/** A line cut into pieces around its matches: [{ text, hit: index into all matches, or -1 }]. */
export function piecesOf(text, matches, firstIndex) {
  const parts = [];
  let pos = 0;
  matches.forEach((m, k) => {
    if (m.start > pos) parts.push({ text: text.slice(pos, m.start), hit: -1 });
    parts.push({ text: text.slice(m.start, m.end), hit: firstIndex + k });
    pos = m.end;
  });
  if (pos < text.length || !parts.length) parts.push({ text: text.slice(pos), hit: -1 });
  return parts;
}

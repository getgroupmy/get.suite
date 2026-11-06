// The document's outline: its headings in order, with where each is, and which one the cursor is under.

/** [{ level, text, pos }] for each heading with text (pos: where the heading starts). */
export function headingsOf(doc) {
  const out = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'heading') {
      const text = node.textContent.trim();
      if (text) out.push({ level: node.attrs.level || 1, text, pos });
      return false;
    }
    return node.type.name !== 'paragraph'; // headings can sit inside tables; nothing is inside a paragraph
  });
  return out;
}

/** The index of the heading the position `at` comes under (-1 before the first). */
export function currentHeading(headings, at) {
  let i = -1;
  for (let k = 0; k < headings.length && headings[k].pos <= at; k++) i = k;
  return i;
}

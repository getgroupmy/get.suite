// Pending suggestions (Docs' suggesting mode) aren't part of the document until someone accepts them:
// downloads show the text as it stands, without suggested insertions and with suggested deletions kept.

/** A copy of a document (TipTap JSON) with every pending suggestion left out. */
export function withoutSuggestions(node) {
  if (!node || typeof node !== 'object') return node;
  if (node.type === 'text') {
    const marks = node.marks || [];
    if (marks.some((m) => m.type === 'suggestInsert')) return null;
    const kept = marks.filter((m) => m.type !== 'suggestDelete');
    const out = { ...node };
    if (kept.length) out.marks = kept; else delete out.marks;
    return out;
  }
  if (!Array.isArray(node.content)) return node;
  const content = [];
  for (const child of node.content) {
    const c = withoutSuggestions(child);
    if (!c) continue;
    // Neighbouring text with the same formatting joins up again.
    const prev = content[content.length - 1];
    if (c.type === 'text' && prev?.type === 'text' && JSON.stringify(prev.marks || []) === JSON.stringify(c.marks || [])) prev.text += c.text;
    else content.push(c);
  }
  return { ...node, content };
}

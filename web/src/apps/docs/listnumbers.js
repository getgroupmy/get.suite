// Numbered lists (Docs): where one starts — a number of your own, or carrying on from the numbered list before it.

/** The first number a list starts at (1 to 9999). */
export const cleanStart = (v) => Math.max(1, Math.min(9999, Math.round(Number(v) || 1)));

/**
 * The numbered list the cursor is in (the innermost one) and the one before it at the same level, if any,
 * with the number that would carry on from it. `$pos` is a ProseMirror resolved position.
 */
export function listAt($pos) {
  for (let d = $pos.depth; d > 0; d--) {
    const node = $pos.node(d);
    if (node.type.name !== 'orderedList') continue;
    const parent = $pos.node(d - 1), index = $pos.index(d - 1);
    let prev = null;
    for (let i = index - 1; i >= 0; i--) { const n = parent.child(i); if (n.type.name === 'orderedList') { prev = n; break; } }
    return { node, pos: $pos.before(d), start: cleanStart(node.attrs.start), next: prev ? cleanStart(prev.attrs.start) + prev.childCount : null };
  }
  return null;
}

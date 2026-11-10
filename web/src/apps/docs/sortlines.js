// Sort lines (Docs): the paragraphs or list items the selection covers, put in order by their text,
// A → Z or Z → A. Numbers inside are compared as numbers ("Item 2" before "Item 10"), capitals don't
// matter, and blank lines go last. Each line keeps its own formatting; one undo puts them back.

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** The order to put lines in, as indexes into `texts`; a stable sort (equal lines keep their order). */
export function sortedOrder(texts, desc = false) {
  return texts.map((t, i) => ({ t: String(t).trim(), i }))
    .sort((a, b) => {
      if (!a.t !== !b.t) return a.t ? -1 : 1; // blank lines last, either way
      const c = collator.compare(a.t, b.t);
      return (desc ? -c : c) || a.i - b.i;
    })
    .map((x) => x.i);
}

/** The transaction that sorts the blocks under the selection (null when there's fewer than two, or nothing changes). */
export function sortTransaction(state, desc = false) {
  const { $from, $to } = state.selection;
  const range = $from.blockRange($to);
  if (!range || range.endIndex - range.startIndex < 2) return null;
  const nodes = [];
  for (let i = range.startIndex; i < range.endIndex; i++) nodes.push(range.parent.child(i));
  const order = sortedOrder(nodes.map((n) => n.textContent), desc);
  if (order.every((v, i) => v === i)) return null;
  return state.tr.replaceWith(range.start, range.end, order.map((i) => nodes[i])).scrollIntoView();
}

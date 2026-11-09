// Checklists in Notes: items can be sub-items (indent: 1) of the item above, moved up and down
// (an item takes its sub-items with it), and ticked together with their sub-items.

/** An item and its sub-items: the indexes from..to (inclusive) of the block starting at index i. */
function blockAt(items, i) {
  let end = i;
  if (!items[i]?.indent) while (items[end + 1]?.indent) end++;
  return [i, end];
}

/** The first item can't be a sub-item (there's nothing above it). */
export const tidy = (items) => items.map((it, i) => (i === 0 && it.indent ? { ...it, indent: 0 } : it)).map(({ indent, ...it }) => (indent ? { ...it, indent: 1 } : it));

/** Make an item a sub-item of the one above (dir 1) or a main item again (dir -1). */
export function indent(items, id, dir) {
  const i = items.findIndex((x) => x.id === id);
  if (i < 0 || (dir > 0 && i === 0)) return items;
  return tidy(items.map((x) => (x.id === id ? { ...x, indent: dir > 0 ? 1 : 0 } : x)));
}

/** Move an item (with its sub-items) one place up (-1) or down (1), past the neighbouring item or block. */
export function moveItem(items, id, by) {
  const i = items.findIndex((x) => x.id === id);
  if (i < 0) return items;
  const [a, b] = blockAt(items, i);
  const block = items.slice(a, b + 1);
  const rest = [...items.slice(0, a), ...items.slice(b + 1)];
  let at;
  if (by < 0) {
    if (a === 0) return items;
    // the start of the item (or block) just above
    let j = a - 1;
    if (!items[i].indent) while (j > 0 && items[j].indent) j--;
    at = j;
  } else {
    if (b === items.length - 1) return items;
    const [, nb] = items[i].indent ? [b + 1, b + 1] : blockAt(items, b + 1);
    at = nb - block.length + 1;
  }
  rest.splice(at, 0, ...block);
  return tidy(rest);
}

/** Tick or untick an item; a main item takes its sub-items with it. */
export function tick(items, id, done) {
  const i = items.findIndex((x) => x.id === id);
  if (i < 0) return items;
  const [a, b] = blockAt(items, i);
  return items.map((x, k) => (k >= a && k <= b ? { ...x, done } : x));
}

export const untickAll = (items) => items.map((x) => (x.done ? { ...x, done: false } : x));

/** Without the ticked items (sub-items left without their main item become main items). */
export const dropTicked = (items) => tidy(items.filter((x) => !x.done));

/** Move an item (with its sub-items) to where `target` is, a place at a time; for dragging. */
export function moveItemTo(items, id, target) {
  const want = items.findIndex((x) => x.id === target);
  let cur = items;
  for (let guard = 0; guard < items.length; guard++) {
    const at = cur.findIndex((x) => x.id === id);
    if (at < 0 || want < 0 || at === want) break;
    const next = moveItem(cur, id, at > want ? -1 : 1);
    if (next === cur) break;
    const now = next.findIndex((x) => x.id === id);
    if ((at > want && now < want) || (at < want && now > want)) { cur = next; break; } // stepped past a block: close enough
    cur = next;
  }
  return cur;
}

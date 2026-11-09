// Putting note cards in your own order: where a dragged card lands, and moving one a place earlier or later.

/** The ids with `id` moved to where `target` is (before it when coming from later, after it when from earlier). */
export function moveTo(ids, id, target) {
  const from = ids.indexOf(id), to = ids.indexOf(target);
  if (from < 0 || to < 0 || from === to) return ids;
  const out = ids.filter((x) => x !== id);
  out.splice(to, 0, id);
  return out;
}

/** The ids with `id` moved `by` places (-1 earlier, 1 later), staying within the list. */
export function moveBy(ids, id, by) {
  const from = ids.indexOf(id);
  if (from < 0) return ids;
  const to = Math.max(0, Math.min(ids.length - 1, from + by));
  return to === from ? ids : moveTo(ids, id, ids[to]);
}

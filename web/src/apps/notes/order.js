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

export const NOTE_SORTS = [['mine', 'Your order'], ['edited', 'Last edited'], ['created', 'Newest first'], ['title', 'Title']];
/** Notes in the chosen order ('mine' leaves them as they are); a note without a title sorts by its text. */
export function sortNotes(notes, sort) {
  const list = [...notes];
  const name = (n) => (n.title || n.body || (n.items || []).map((i) => i.text).join(' ') || '').trim().toLowerCase();
  if (sort === 'edited') list.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
  else if (sort === 'created') list.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  else if (sort === 'title') list.sort((a, b) => name(a).localeCompare(name(b)));
  return list;
}

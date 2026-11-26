// Home's New note comments card: notes with comments new to you (others' since you last opened the note),
// the most new first (then as listed), up to max, and how many more there are.
export function newNoteComments(notes, max = 5) {
  const all = (notes || []).filter((n) => n.comments_new > 0).map((n, i) => [n, i]).sort((a, b) => b[0].comments_new - a[0].comments_new || a[1] - b[1]).map(([n]) => n);
  return { items: all.slice(0, max), more: Math.max(0, all.length - max) };
}

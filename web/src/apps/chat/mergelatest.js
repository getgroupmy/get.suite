// After the live connection comes back (or first opens), what was missed: the conversation's latest messages,
// merged into those shown. New ones are added, changed ones (edits, reactions) replace what was there, in
// time order; older ones already shown stay. Messages still being sent (no id from the server yet) stay too.
export function mergeLatest(shown, latest) {
  const byId = new Map(shown.map((m) => [m.id, m]));
  for (const m of latest) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => (a.created_at ?? Infinity) - (b.created_at ?? Infinity));
}

/** Whether merging changes anything (so a view isn't re-rendered for nothing). */
export function sameMessages(a, b) {
  return a.length === b.length && a.every((m, i) => m === b[i]);
}

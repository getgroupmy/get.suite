// Merging a list of items with ids (a form's questions) changed in two places from the same starting point:
// `base` is what this editor started from, `mine` what it has now, `theirs` what's stored now (changed by
// someone else meanwhile). Item by item: one changed here takes mine; one not changed here takes theirs;
// one added on either side is kept; one deleted on either side (and not changed on the other) goes. The
// order is mine if items were moved here, otherwise theirs, with items added here placed after the item
// they follow here.
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function mergeList(base, mine, theirs) {
  const B = new Map(base.map((x) => [x.id, x]));
  const M = new Map(mine.map((x) => [x.id, x]));
  const T = new Map(theirs.map((x) => [x.id, x]));
  const pick = (id) => {
    const b = B.get(id), m = M.get(id), t = T.get(id);
    if (!b) return m ?? t;                       // added on one side
    if (!m) return t && !same(t, b) ? t : null;  // deleted here: gone, unless changed elsewhere
    if (!t) return same(m, b) ? null : m;        // deleted elsewhere: gone, unless changed here
    return same(m, b) ? t : m;                   // changed here wins; otherwise theirs
  };
  const baseOrder = base.map((x) => x.id);
  const movedHere = !same(mine.map((x) => x.id).filter((id) => B.has(id)), baseOrder.filter((id) => M.has(id)));
  const [skeleton, other] = movedHere ? [mine, theirs] : [theirs, mine];
  const out = skeleton.map((x) => x.id);
  // What the other side added (not in base), placed after the item it follows there.
  other.forEach((x, i) => {
    if (B.has(x.id) || out.includes(x.id)) return;
    let at = 0;
    for (let k = i - 1; k >= 0; k--) { const p = out.indexOf(other[k].id); if (p >= 0) { at = p + 1; break; } }
    out.splice(at, 0, x.id);
  });
  // Items deleted on the skeleton's side but changed on the other: kept where they were.
  for (const id of baseOrder) if (!out.includes(id) && pick(id)) out.splice(Math.min(baseOrder.indexOf(id), out.length), 0, id);
  return out.map(pick).filter(Boolean);
}

// Merged cells: a block of cells shown as one (its top-left cell), kept per sheet in `merges` as
// ranges ("A1:C1"). Only the top-left cell keeps a value; merging clears the others.
import { parseRef, cellKey } from './formula.js';

/** A range as { c1, r1, c2, r2 }, or null. */
export function box(text) {
  const [a, b = a] = String(text || '').toUpperCase().split(':');
  const p = parseRef(a), q = parseRef(b);
  if (!p || !q) return null;
  return { c1: Math.min(p.c, q.c), r1: Math.min(p.r, q.r), c2: Math.max(p.c, q.c), r2: Math.max(p.r, q.r) };
}
const text = (b) => `${cellKey(b.c1, b.r1)}:${cellKey(b.c2, b.r2)}`;
const overlaps = (a, b) => a.c1 <= b.c2 && b.c1 <= a.c2 && a.r1 <= b.r2 && b.r1 <= a.r2;
const inside = (b, c, r) => c >= b.c1 && c <= b.c2 && r >= b.r1 && r <= b.r2;

/** How to draw the merges: spans for each top-left cell, and the cells they cover (not drawn). */
export function mergeLayout(merges = []) {
  const spans = new Map(), covered = new Map(); // covered: key → the top-left cell's key
  for (const m of merges) {
    const b = box(m);
    if (!b) continue;
    const top = cellKey(b.c1, b.r1);
    spans.set(top, { colSpan: b.c2 - b.c1 + 1, rowSpan: b.r2 - b.r1 + 1, box: b });
    for (let r = b.r1; r <= b.r2; r++) for (let c = b.c1; c <= b.c2; c++) if (c !== b.c1 || r !== b.r1) covered.set(cellKey(c, r), top);
  }
  return { spans, covered };
}

/** The merge a cell is in ({ c1, r1, c2, r2 }), or null. */
export function mergeAt(merges = [], c, r) {
  for (const m of merges) { const b = box(m); if (b && inside(b, c, r)) return b; }
  return null;
}

/** Merge a range (more than one cell): merges it overlaps are replaced. */
export function addMerge(merges = [], range) {
  const b = typeof range === 'string' ? box(range) : range;
  if (!b || (b.c1 === b.c2 && b.r1 === b.r2)) return merges;
  return [...merges.filter((m) => { const o = box(m); return o && !overlaps(o, b); }), text(b)];
}

/** Unmerge everything the range touches. */
export function removeMerges(merges = [], range) {
  const b = typeof range === 'string' ? box(range) : range;
  return merges.filter((m) => { const o = box(m); return o && !overlaps(o, b); });
}

/** A range grown to take in every merge it partly covers (so a selection never cuts one). */
export function growToMerges(merges = [], range) {
  let b = { ...range }, again = true;
  while (again) {
    again = false;
    for (const m of merges) {
      const o = box(m);
      if (o && overlaps(o, b) && (o.c1 < b.c1 || o.r1 < b.r1 || o.c2 > b.c2 || o.r2 > b.r2)) {
        b = { c1: Math.min(b.c1, o.c1), r1: Math.min(b.r1, o.r1), c2: Math.max(b.c2, o.c2), r2: Math.max(b.r2, o.r2) };
        again = true;
      }
    }
  }
  return b;
}

/**
 * Moving the cursor by (dc, dr) from (c, r): out of a merge it leaves from its edge; into one it
 * lands on its top-left cell.
 */
export function stepWithMerges(merges = [], c, r, dc, dr, limits) {
  const here = mergeAt(merges, c, r);
  let nc = c + dc, nr = r + dr;
  if (here) { if (dc > 0) nc = here.c2 + dc; if (dr > 0) nr = here.r2 + dr; if (dc < 0) nc = here.c1 + dc; if (dr < 0) nr = here.r1 + dr; if (!dc) nc = here.c1; if (!dr) nr = here.r1; }
  nc = Math.max(0, Math.min(limits.cols - 1, nc));
  nr = Math.max(0, Math.min(limits.rows - 1, nr));
  const there = mergeAt(merges, nc, nr);
  return there ? { c: there.c1, r: there.r1 } : { c: nc, r: nr };
}

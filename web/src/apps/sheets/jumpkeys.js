// Getting around a big sheet from the keyboard, as in Excel and Google Sheets: Ctrl+Arrow jumps to the edge of
// the data, Ctrl+Home to A1, Ctrl+End to the last cell with something in it.
import { parseRef } from './formula.js';

/**
 * Ctrl+Arrow from (c, r) one way (dc, dr): within a run of filled cells, to its last cell; from an empty cell
 * or the end of a run, to the next filled cell; with nothing further, to the sheet's edge.
 */
export function dataEdge(filled, c, r, dc, dr, { cols, rows }) {
  const inside = (x, y) => x >= 0 && y >= 0 && x < cols && y < rows;
  if (!inside(c + dc, r + dr)) return { c, r };
  let x = c + dc, y = r + dr;
  if (filled(c, r) && filled(x, y)) {
    while (inside(x + dc, y + dr) && filled(x + dc, y + dr)) { x += dc; y += dr; }
    return { c: x, r: y };
  }
  while (!filled(x, y) && inside(x + dc, y + dr)) { x += dc; y += dr; }
  return { c: x, r: y };
}

/** Ctrl+End: the last row and last column with something in them (A1 for an empty sheet). */
export function lastUsed(cells) {
  let c = 0, r = 0;
  for (const [k, v] of Object.entries(cells || {})) {
    if (v === '' || v === undefined || v === null) continue;
    const p = parseRef(k);
    if (p) { c = Math.max(c, p.c); r = Math.max(r, p.r); }
  }
  return { c, r };
}

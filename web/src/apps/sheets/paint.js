// Paint format (Sheets): copy the formatting of the selected cells and put it on other cells. A
// block of several cells repeats across a bigger target (like Google Sheets and Excel).
import { cellKey } from './formula.js';

/** The formats of a range as rows of cells (null where a cell has none). */
export function copyFormats(formats, g) {
  const rows = [];
  for (let r = g.r1; r <= g.r2; r++) {
    const row = [];
    for (let c = g.c1; c <= g.c2; c++) { const f = formats?.[cellKey(c, r)]; row.push(f && Object.keys(f).length ? { ...f } : null); }
    rows.push(row);
  }
  return rows;
}

/** The formats after painting `pattern` over the target range: each cell's formatting is replaced. */
export function paintFormats(formats, target, pattern) {
  const out = { ...(formats || {}) };
  const h = pattern.length, w = pattern[0]?.length || 0;
  if (!h || !w) return out;
  for (let r = target.r1; r <= target.r2; r++) for (let c = target.c1; c <= target.c2; c++) {
    const f = pattern[(r - target.r1) % h][(c - target.c1) % w];
    const k = cellKey(c, r);
    if (f) out[k] = { ...f }; else delete out[k];
  }
  return out;
}

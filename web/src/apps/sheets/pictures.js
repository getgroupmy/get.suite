// Pictures (and charts and slicers) over a sheet's cells move with their cells, as Excel's do: each is tied to the cell its top-left corner is
// over and how far into it, so inserting, deleting or resizing rows and columns before it carries it along.
import { colName } from './formula.js';
import { DEFAULT_H } from './rowheights.js';

const GRID_LEFT = 46, GRID_TOP = 24, DEFAULT_W = 100; // the row numbers and column letters in front of the cells
const widthOf = (colWidths, c) => Number(colWidths?.[colName(c)]) || DEFAULT_W;
const heightOf = (rowHeights, r) => Number(rowHeights?.[String(r + 1)]) || DEFAULT_H;

/** The cell a picture's corner is over and how far in: { col, row, dx, dy } (0-based). */
export function anchorOf(p, colWidths, rowHeights) {
  let col = 0, dx = Math.max(0, (Number(p.x) || 0) - GRID_LEFT), row = 0, dy = Math.max(0, (Number(p.y) || 0) - GRID_TOP);
  for (let w; col < 16383 && dx >= (w = widthOf(colWidths, col)); col++) dx -= w;
  for (let h; row < 1048575 && dy >= (h = heightOf(rowHeights, row)); row++) dy -= h;
  return { col, row, dx, dy };
}

/** Where on the grid a cell's corner plus (dx, dy) is: { x, y }. */
export function placeOf({ col, row, dx, dy }, colWidths, rowHeights) {
  let x = GRID_LEFT, y = GRID_TOP;
  for (let c = 0; c < col; c++) x += widthOf(colWidths, c);
  for (let r = 0; r < row; r++) y += heightOf(rowHeights, r);
  return { x: Math.round(x + dx), y: Math.round(y + dy) };
}

/**
 * The pictures placed again after the sheet's rows or columns changed: `before` and `after` are { colWidths, rowHeights }
 * and `move` maps an old column or row index to its new one (null: deleted, when the picture goes to the corner of the
 * cell where the deleted ones were, as Excel keeps it). Pictures with nothing to move come back as they were.
 */
export function movePictures(pictures, before, after, move = {}) {
  if (!pictures || !Object.keys(pictures).length) return pictures;
  const out = {};
  for (const [id, p] of Object.entries(pictures)) {
    if (!Number.isFinite(Number(p?.x)) || !Number.isFinite(Number(p?.y)) || p.x === null || p.y === null) { out[id] = p; continue; } // (nowhere in particular: left so)
    const a = anchorOf(p, before.colWidths, before.rowHeights);
    const col = move.col ? move.col(a.col) : a.col, row = move.row ? move.row(a.row) : a.row;
    const at = { col: col ?? move.colGone ?? a.col, row: row ?? move.rowGone ?? a.row, dx: col === null ? 0 : a.dx, dy: row === null ? 0 : a.dy };
    out[id] = { ...p, ...placeOf(at, after.colWidths, after.rowHeights) };
  }
  return out;
}

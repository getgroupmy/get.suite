// Paste special: what copying inside Sheets put on the clipboard, put back in another way.
//   all        formulas (moved to the new place) and formatting, as a normal paste
//   values     what the cells show, as plain values (formulas become their results); formatting stays
//   formats    only the formatting; the values already there stay
//   transpose  rows become columns (and columns rows), with formulas and formatting
import { cellKey } from './formula.js';

export const PASTE_MODES = [['values', 'Values only'], ['formats', 'Formatting only'], ['transpose', 'Transposed']];

/**
 * clip: { raws, fmts, vals, origin: { c, r } } as copied (2-D, rows of cells); at: { c, r } the top-left
 * cell to paste into; shift(raw, dc, dr) moves a formula. Returns { cells, formats } of the cells to
 * change (cells: key → raw; formats: key → format or null to clear). Only what the mode pastes is there.
 */
export function pasteSpecial(clip, at, mode, shift) {
  const cells = {}, formats = {};
  const rows = clip.raws.length;
  clip.raws.forEach((row, ri) => row.forEach((raw, ci) => {
    const [dr, dc] = mode === 'transpose' ? [ci, ri] : [ri, ci];
    const k = cellKey(at.c + dc, at.r + dr);
    const fmt = clip.fmts?.[ri]?.[ci] || null;
    if (mode === 'values') { cells[k] = String(clip.vals?.[ri]?.[ci] ?? ''); return; }
    if (mode !== 'formats') cells[k] = shift(raw, at.c + dc - (clip.origin.c + ci), at.r + dr - (clip.origin.r + ri));
    formats[k] = fmt;
  }));
  return { cells, formats, size: mode === 'transpose' ? { rows: clip.raws[0]?.length || 0, cols: rows } : { rows, cols: clip.raws[0]?.length || 0 } };
}

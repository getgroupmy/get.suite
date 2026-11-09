// The whiteboard in a meeting (Meet → 🖍): everyone in the room draws on the same board. The server
// keeps the board's strokes while the meeting lasts and passes each new one to everyone; the board is
// 1000 × 600 units, whatever size each person sees it.
export const BOARD_W = 1000, BOARD_H = 600;
export const MAX_STROKES = 3000, MAX_POINTS = 600;
export const KINDS = ['pen', 'line', 'arrow', 'box', 'ellipse', 'erase'];
const COLOR = /^#[0-9a-f]{6}$/i;

/**
 * A stroke as sent by a browser, checked: { id, kind, color, size, points: [[x, y], …] } with the
 * points rounded and kept on the board; shapes keep their first and last point. Null if it isn't one.
 */
export function cleanStroke(s) {
  if (!s || typeof s !== 'object' || !KINDS.includes(s.kind)) return null;
  const id = String(s.id ?? '');
  if (!/^[\w-]{4,40}$/.test(id)) return null;
  let points = (Array.isArray(s.points) ? s.points : []).slice(0, MAX_POINTS)
    .filter((p) => Array.isArray(p) && Number.isFinite(+p[0]) && Number.isFinite(+p[1]))
    .map(([x, y]) => [Math.round(Math.min(BOARD_W, Math.max(0, +x)) * 10) / 10, Math.round(Math.min(BOARD_H, Math.max(0, +y)) * 10) / 10]);
  if (!points.length) return null;
  if (s.kind !== 'pen' && s.kind !== 'erase') points = [points[0], points[points.length - 1]];
  const size = [2, 4, 8, 16].includes(+s.size) ? +s.size : 4;
  return { id, kind: s.kind, color: s.kind === 'erase' ? '#ffffff' : COLOR.test(s.color || '') ? s.color.toLowerCase() : '#202124', size, points };
}

/** A meeting's board: add a stroke (by whom), take back someone's last one, clear it. */
export function makeBoard() {
  const strokes = [];
  return {
    strokes,
    add(stroke, by) {
      const s = cleanStroke(stroke);
      if (!s || strokes.length >= MAX_STROKES || strokes.some((x) => x.id === s.id)) return null;
      const out = { ...s, by };
      strokes.push(out);
      return out;
    },
    undo(by) {
      for (let i = strokes.length - 1; i >= 0; i--) if (strokes[i].by === by) return strokes.splice(i, 1)[0];
      return null;
    },
    clear() { strokes.length = 0; },
  };
}

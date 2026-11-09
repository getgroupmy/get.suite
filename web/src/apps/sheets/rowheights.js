// Row heights (Sheets): rows dragged or set taller (or shorter) than the standard 24 pixels. Kept on the
// sheet as rowHeights: { "3": 80 } (row number → pixels); a row not listed has the standard height and
// still grows to fit wrapped text or a picture.
export const DEFAULT_H = 24, MIN_H = 16, MAX_H = 600;

const clamp = (h) => Math.round(Math.max(MIN_H, Math.min(MAX_H, Number(h))));

/** The height set for row r (0-based), or null. */
export const heightOf = (heights, r) => (heights && heights[String(r + 1)]) || null;

/** Heights with rows a..b (0-based) set to h pixels, or back to the standard height when h is empty. */
export function setHeights(heights, a, b, h) {
  const out = { ...(heights || {}) };
  const none = h === null || h === undefined || h === '' || !Number.isFinite(Number(h));
  for (let r = Math.min(a, b); r <= Math.max(a, b); r++) {
    if (none || clamp(h) === DEFAULT_H) delete out[String(r + 1)];
    else out[String(r + 1)] = clamp(h);
  }
  return Object.keys(out).length ? out : null;
}

/** Heights as stored: whole numbers within limits, for rows 1–10000. */
export function cleanHeights(heights) {
  const out = {};
  for (const [k, v] of Object.entries(heights || {})) {
    if (!/^\d+$/.test(k) || Number(k) < 1 || Number(k) > 10000 || !Number.isFinite(Number(v))) continue;
    out[String(Number(k))] = clamp(v);
  }
  return Object.keys(out).length ? out : null;
}

/** Heights after rows are inserted (count > 0) or deleted (count < 0) at `at` (0-based); columns don't change them. */
export function adjustRowHeights(heights, change) {
  if (!heights || change.axis !== 'row') return heights;
  const out = {};
  for (const [k, v] of Object.entries(heights)) {
    const r = Number(k) - 1;
    if (r < change.at) out[k] = v;
    else if (change.count > 0) out[String(r + change.count + 1)] = v;
    else if (r >= change.at - change.count) out[String(r + change.count + 1)] = v; // below the deleted rows: up
    // in the deleted rows: gone
  }
  return Object.keys(out).length ? out : null;
}

// Hiding rows and columns: the sheet keeps `hide: { rows: [..], cols: [..] }` (0-based, sorted),
// left out when nothing is hidden. Pure functions on the sheet's JSON.

const tidy = (list) => [...new Set(list)].filter((n) => Number.isInteger(n) && n >= 0).sort((a, b) => a - b);

/** `hide` with `rows`/`cols` replaced, or null when nothing is left hidden. */
function make(rows, cols) {
  rows = tidy(rows); cols = tidy(cols);
  return rows.length || cols.length ? { ...(rows.length && { rows }), ...(cols.length && { cols }) } : null;
}

/** Hide (or, with show, unhide) indexes `from`..`to` on an axis. */
export function setHidden(hide, axis, from, to, show = false) {
  const key = axis === 'row' ? 'rows' : 'cols';
  const span = new Set(Array.from({ length: to - from + 1 }, (_, i) => from + i));
  const now = hide?.[key] || [];
  const next = show ? now.filter((n) => !span.has(n)) : [...now, ...span];
  return make(key === 'rows' ? next : hide?.rows || [], key === 'cols' ? next : hide?.cols || []);
}

/** Is any of `from`..`to` hidden on that axis? */
export function anyHidden(hide, axis, from, to) {
  return (hide?.[axis === 'row' ? 'rows' : 'cols'] || []).some((n) => n >= from && n <= to);
}

/** Runs of hidden indexes: [[first, last], …]. */
export function hiddenRuns(list) {
  const runs = [];
  for (const n of tidy(list || [])) {
    const last = runs[runs.length - 1];
    if (last && last[1] === n - 1) last[1] = n; else runs.push([n, n]);
  }
  return runs;
}

/** `hide` after inserting or deleting rows/columns (see structure.js): deleted ones go, later ones move. */
export function adjustHide(hide, change) {
  if (!hide) return hide;
  const key = change.axis === 'row' ? 'rows' : 'cols';
  const moved = (hide[key] || []).map((i) => {
    if (change.count > 0) return i >= change.at ? i + change.count : i;
    if (i < change.at) return i;
    if (i < change.at - change.count) return null;
    return i + change.count;
  }).filter((i) => i !== null);
  return make(key === 'rows' ? moved : hide.rows || [], key === 'cols' ? moved : hide.cols || []);
}

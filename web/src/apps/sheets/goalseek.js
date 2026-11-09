// Goal seek (Sheets, Data → Goal seek…): the number to put in one cell so that a formula elsewhere
// comes to a value you want ("what price gives a profit of 10,000?"). The sheet is worked out again
// for each try, with the secant method from the cell's own value, and halving between two tries that
// fall either side of the goal when that fails.
import { bookEvaluator, parseRef, cellKey } from './formula.js';

const MAX_TRIES = 200;

/** A cell address as typed ("b3", "$B$3") as its key ("B3"), or null. */
export function cellOf(text) {
  const t = String(text || '').trim().replace(/\$/g, '').toUpperCase();
  if (!/^[A-Z]{1,3}[1-9]\d{0,6}$/.test(t)) return null;
  const p = parseRef(t);
  return p ? cellKey(p.c, p.r) : null;
}

/**
 * The value for `changing` that makes the formula in `set` equal `goal`.
 * Gives { value, result, tries } or { error } (a message for people).
 */
export function goalSeek(sheets, index, set, goal, changing, { imports = null, functions = null } = {}) {
  const setKey = cellOf(set), chKey = cellOf(changing);
  if (!setKey) return { error: 'Set cell: type a cell, like B5' };
  if (!chKey) return { error: 'By changing: type a cell, like B2' };
  const cells = sheets[index]?.cells || {};
  if (typeof cells[setKey] !== 'string' || !cells[setKey].startsWith('=')) return { error: `${setKey} needs a formula, worked out from ${chKey}` };
  const raw = cells[chKey];
  if (typeof raw === 'string' && raw.startsWith('=')) return { error: `${chKey} has a formula: choose a cell with a number in it` };
  const start = raw === undefined || raw === null || raw === '' ? 0 : Number(raw);
  if (!Number.isFinite(start)) return { error: `${chKey} needs a number in it (or nothing)` };
  const want = Number(String(goal).trim().replace(/,/g, ''));
  if (String(goal).trim() === '' || !Number.isFinite(want)) return { error: 'To value: type a number' };

  let tries = 0;
  const f = (x) => {
    tries++;
    const copy = sheets.map((s, i) => (i === index ? { ...s, cells: { ...s.cells, [chKey]: x } } : s));
    const v = bookEvaluator(copy, index, imports, functions)(setKey);
    return typeof v === 'number' && Number.isFinite(v) ? v - want : NaN;
  };
  const tol = (y) => Math.abs(y) <= 1e-9 * Math.max(1, Math.abs(want));
  const done = (x) => ({ value: tidy(x), result: f(tidy(x)) + want, tries });

  let x0 = start, y0 = f(x0);
  if (Number.isNaN(y0)) return { error: `${setKey} doesn't come to a number` };
  if (tol(y0)) return done(x0);
  let x1 = x0 === 0 ? 1 : x0 * 1.1, y1 = f(x1);
  if (!Number.isNaN(y1) && y1 === y0) {
    x1 = x0 + 1000; y1 = f(x1);
    if (y1 === y0) return { error: `Changing ${chKey} doesn't change ${setKey}` };
  }
  // Secant steps.
  for (let i = 0; i < 60 && tries < MAX_TRIES; i++) {
    if (Number.isNaN(y1)) break;
    if (tol(y1)) return done(x1);
    if ((y0 < 0) !== (y1 < 0)) return bisect(f, x0, y0, x1, y1);
    if (y1 === y0) break;
    const x2 = x1 - (y1 * (x1 - x0)) / (y1 - y0);
    if (!Number.isFinite(x2)) break;
    x0 = x1; y0 = y1; x1 = x2; y1 = f(x1);
  }
  // Look outwards from the start for a try on the other side of the goal, then halve the gap.
  const y = f(start);
  for (let step = 1; step < 1e15 && tries < MAX_TRIES; step *= 4) {
    for (const x of [start + step, start - step]) {
      const yx = f(x);
      if (!Number.isNaN(yx) && (tol(yx) || (yx < 0) !== (y < 0))) return tol(yx) ? done(x) : bisect(f, start, y, x, yx);
    }
  }
  return { error: `No value of ${chKey} found that makes ${setKey} ${want}` };

  function bisect(fn, a, fa, b, fb) {
    for (let i = 0; i < 200 && tries < MAX_TRIES * 2; i++) {
      const m = (a + b) / 2, fm = fn(m);
      if (Number.isNaN(fm)) return { error: `${setKey} stops being a number on the way` };
      if (tol(fm) || Math.abs(b - a) <= 1e-12 * Math.max(1, Math.abs(m))) return done(m);
      if ((fm < 0) === (fa < 0)) { a = m; fa = fm; } else { b = m; fb = fm; }
    }
    return done((a + b) / 2);
  }
}

/** Rounding noise taken off (1.9999999999997 → 2), keeping 12 significant digits. */
export function tidy(x) {
  if (!Number.isFinite(x) || x === 0) return x;
  return Number(x.toPrecision(12));
}

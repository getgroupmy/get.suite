// Filling (Sheets): dragging the fill handle, or Ctrl+D / Ctrl+R, carries the selected cells on into
// the next ones. Numbers with a steady step keep stepping (1, 2 → 3, 4; 10, 20 → 30), text ending in
// a number counts on ("Item 1" → "Item 2"), weekdays and months go round, and formulas move their
// references like copy and paste. Anything else repeats.
import { cellKey, shiftFormula } from './formula.js';

const LISTS = [
  ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
  ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
  ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  ['Q1', 'Q2', 'Q3', 'Q4'],
];
const NUM = /^-?(\d+\.?\d*|\.\d+)$/;

/** Match the case of `like` ("MON", "mon", "Mon"). */
function cased(word, like) {
  if (like === like.toUpperCase() && like !== like.toLowerCase()) return word.toUpperCase();
  if (like === like.toLowerCase()) return word.toLowerCase();
  return word;
}
const decimalsOf = (s) => (String(s).split('.')[1] || '').length;
const fmtNum = (n, places) => String(Number(n.toFixed(Math.min(10, places))));

/**
 * `count` more values after `src` (a run of raw cell values in fill order). For formulas, `moveBy(i)`
 * gives how far (dc, dr) the i-th new cell is from the source cell it copies.
 */
export function continueSeries(src, count, moveBy = () => [0, 0]) {
  const n = src.length;
  const out = [];
  if (!n) return out;
  const vals = src.map((v) => (v == null ? '' : String(v)));
  // Numbers: one repeats; two or more with an even step keep stepping.
  if (vals.every((v) => NUM.test(v.trim()))) {
    const nums = vals.map(Number);
    const step = n > 1 ? nums[1] - nums[0] : 0;
    const even = n > 1 && nums.every((x, i) => i === 0 || Math.abs(x - nums[i - 1] - step) < 1e-9);
    const places = Math.max(...vals.map(decimalsOf));
    for (let i = 0; i < count; i++) out.push(even ? fmtNum(nums[n - 1] + step * (i + 1), places) : vals[i % n]);
    return out;
  }
  // Days, months, quarters.
  for (const list of LISTS) {
    const idx = vals.map((v) => list.findIndex((w) => w.toLowerCase() === v.trim().toLowerCase()));
    if (idx.every((x) => x >= 0)) {
      const step = n > 1 ? ((idx[1] - idx[0]) % list.length + list.length) % list.length || list.length : 1;
      for (let i = 0; i < count; i++) out.push(cased(list[(idx[n - 1] + step * (i + 1)) % list.length], vals[n - 1].trim()));
      return out;
    }
  }
  // Text with a number at the end: count on from the last (by the step, when there are several).
  const tail = vals.map((v) => /^(.*?)(\d+)$/.exec(v));
  if (tail.every(Boolean) && tail.every((m) => m[1] === tail[0][1]) && !vals[0].startsWith('=')) {
    const nums = tail.map((m) => Number(m[2]));
    const step = n > 1 ? nums[1] - nums[0] : 1;
    const even = n === 1 || nums.every((x, i) => i === 0 || x - nums[i - 1] === step);
    const width = tail[n - 1][2].length;
    for (let i = 0; i < count; i++) {
      if (!even) { out.push(vals[i % n]); continue; }
      const next = nums[n - 1] + step * (i + 1);
      out.push(`${tail[0][1]}${next >= 0 ? String(next).padStart(tail[n - 1][2].startsWith('0') ? width : 1, '0') : next}`);
    }
    return out;
  }
  // Everything else repeats, formulas moving with it.
  for (let i = 0; i < count; i++) {
    const v = vals[i % n];
    const [dc, dr] = moveBy(i);
    out.push(v.startsWith('=') ? shiftFormula(v, dc, dr) : v);
  }
  return out;
}

/**
 * The cells a fill writes: from the box `src` ({ c1, r1, c2, r2 }) out to `to` (a box that contains
 * it and grows one way: down, up, right or left). Returns { "B5": value, … } (empty source → "").
 */
export function fillCells(cells, src, to) {
  const out = {};
  const down = to.r2 > src.r2, up = to.r1 < src.r1, right = to.c2 > src.c2, left = to.c1 < src.c1;
  if (down || up) {
    for (let c = src.c1; c <= src.c2; c++) {
      const rows = [];
      for (let r = src.r1; r <= src.r2; r++) rows.push(r);
      const order = up ? [...rows].reverse() : rows;
      const count = up ? src.r1 - to.r1 : to.r2 - src.r2;
      const h = rows.length;
      const values = continueSeries(order.map((r) => cells[cellKey(c, r)]), count, (i) => [0, (up ? -1 : 1) * (Math.floor(i / h) + 1) * h]);
      values.forEach((v, i) => { out[cellKey(c, up ? src.r1 - 1 - i : src.r2 + 1 + i)] = v ?? ''; });
    }
  } else if (right || left) {
    for (let r = src.r1; r <= src.r2; r++) {
      const cols = [];
      for (let c = src.c1; c <= src.c2; c++) cols.push(c);
      const order = left ? [...cols].reverse() : cols;
      const count = left ? src.c1 - to.c1 : to.c2 - src.c2;
      const w = cols.length;
      const values = continueSeries(order.map((c) => cells[cellKey(c, r)]), count, (i) => [(left ? -1 : 1) * (Math.floor(i / w) + 1) * w, 0]);
      values.forEach((v, i) => { out[cellKey(left ? src.c1 - 1 - i : src.c2 + 1 + i, r)] = v ?? ''; });
    }
  }
  return out;
}

/** For each cell a fill writes, the source cell it continues (for copying its format). */
export function fillSources(src, to) {
  const out = {};
  const h = src.r2 - src.r1 + 1, w = src.c2 - src.c1 + 1;
  const mod = (a, n) => ((a % n) + n) % n;
  for (let r = to.r1; r <= to.r2; r++) for (let c = to.c1; c <= to.c2; c++) {
    if (r >= src.r1 && r <= src.r2 && c >= src.c1 && c <= src.c2) continue;
    out[cellKey(c, r)] = cellKey(src.c1 + mod(c - src.c1, w), src.r1 + mod(r - src.r1, h));
  }
  return out;
}

/** Where a drag from the selection to cell (c, r) fills: further along whichever way is further. */
export function fillTarget(src, c, r) {
  const below = r - src.r2, above = src.r1 - r, after = c - src.c2, before = src.c1 - c;
  const best = Math.max(below, above, after, before);
  if (best <= 0) return null;
  if (best === below) return { ...src, r2: r };
  if (best === above) return { ...src, r1: r };
  if (best === after) return { ...src, c2: c };
  return { ...src, c1: c };
}

/** Sum, average, smallest, largest and counts of what a selection shows (numbers only for the sums). */
export function selectionStats(values) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  const filled = values.filter((v) => v !== null && v !== undefined && v !== '').length;
  if (!nums.length) return { count: filled, numbers: 0 };
  const sum = nums.reduce((a, b) => a + b, 0);
  return { count: filled, numbers: nums.length, sum, average: sum / nums.length, min: Math.min(...nums), max: Math.max(...nums) };
}

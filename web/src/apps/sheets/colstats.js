// Column stats (Sheets): a quick look at one column — how many cells are filled, empty and different,
// the numbers' sum, average, middle value, smallest and largest, and the values that come up most.
import { cellKey } from './formula.js';
import { filterLabel } from './filter.js';

/**
 * Stats for column `c` from row `r1` to `r2` (0-based, both included); `value(key)` gives a cell's
 * value. Skips a heading row when `header`.
 */
export function columnStats(value, c, r1, r2, { header = false, top = 10 } = {}) {
  const counts = new Map();
  const nums = [];
  let filled = 0, empty = 0;
  for (let r = header ? r1 + 1 : r1; r <= r2; r++) {
    const v = value(cellKey(c, r));
    const label = filterLabel(v);
    if (label === '') { empty++; continue; }
    filled++;
    counts.set(label, (counts.get(label) || 0) + 1);
    if (typeof v === 'number' && Number.isFinite(v)) nums.push(v);
  }
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const sum = nums.reduce((a, b) => a + b, 0);
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const frequent = [...counts].map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || collator.compare(a.label, b.label)).slice(0, top);
  return {
    rows: filled + empty, filled, empty, unique: counts.size, frequent,
    numbers: nums.length ? {
      count: nums.length, sum, average: sum / nums.length,
      median: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
      min: sorted[0], max: sorted.at(-1),
    } : null,
  };
}

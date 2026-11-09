// A copy of web/src/apps/sheets/filtercond.js (the server uses it to hide filtered rows in Excel downloads).
// Keep the two the same: test/filtercond-copy.test.js checks.
// Filter conditions: besides ticking values, a filter column can show only rows whose value meets a
// condition, kept as { op, a, b } (b only for "between"). Text tests ignore case; number tests leave
// out cells that aren't numbers.

export const CONDITIONS = [
  { op: 'empty', label: 'Is empty', args: 0 },
  { op: 'notempty', label: 'Is not empty', args: 0 },
  { op: 'contains', label: 'Text contains', args: 1 },
  { op: 'notcontains', label: 'Text does not contain', args: 1 },
  { op: 'starts', label: 'Text starts with', args: 1 },
  { op: 'ends', label: 'Text ends with', args: 1 },
  { op: 'is', label: 'Text is exactly', args: 1 },
  { op: 'gt', label: 'Greater than', args: 1 },
  { op: 'gte', label: 'Greater than or equal to', args: 1 },
  { op: 'lt', label: 'Less than', args: 1 },
  { op: 'lte', label: 'Less than or equal to', args: 1 },
  { op: 'eq', label: 'Is equal to', args: 1 },
  { op: 'neq', label: 'Is not equal to', args: 1 },
  { op: 'between', label: 'Is between', args: 2 },
  { op: 'notbetween', label: 'Is not between', args: 2 },
];
const BY_OP = Object.fromEntries(CONDITIONS.map((c) => [c.op, c]));

const toNum = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean' || v === null || v === undefined) return null;
  const t = String(v).trim().replace(/,/g, '');
  if (!t) return null;
  const pct = /%$/.test(t);
  const n = Number(pct ? t.slice(0, -1) : t);
  return Number.isFinite(n) ? (pct ? n / 100 : n) : null;
};
const toText = (v) => (v === null || v === undefined ? '' : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v));

/** A condition as stored, or null when it isn't a whole one. */
export function cleanCondition(c) {
  const def = BY_OP[c?.op];
  if (!def) return null;
  const a = String(c.a ?? '').slice(0, 200), b = String(c.b ?? '').slice(0, 200);
  if (def.args >= 1 && a.trim() === '') return null;
  if (def.args === 2 && b.trim() === '') return null;
  return { op: c.op, ...(def.args >= 1 && { a }), ...(def.args === 2 && { b }) };
}

/** Whether a cell's value meets the condition (so its row shows). */
export function meetsCondition(cond, v) {
  const c = cleanCondition(cond);
  if (!c) return true;
  const text = toText(v), low = text.toLowerCase(), a = (c.a || '').toLowerCase();
  switch (c.op) {
    case 'empty': return text === '';
    case 'notempty': return text !== '';
    case 'contains': return low.includes(a);
    case 'notcontains': return !low.includes(a);
    case 'starts': return low.startsWith(a);
    case 'ends': return low.endsWith(a);
    case 'is': return low === a;
  }
  const n = toNum(v), x = toNum(c.a);
  if (c.op === 'eq' || c.op === 'neq') {
    const same = x === null ? low === a.trim() : n !== null && n === x;
    return c.op === 'eq' ? same : !same;
  }
  if (n === null || x === null) return false;
  switch (c.op) {
    case 'gt': return n > x;
    case 'gte': return n >= x;
    case 'lt': return n < x;
    case 'lte': return n <= x;
  }
  const y = toNum(c.b);
  if (y === null) return false;
  const inside = n >= Math.min(x, y) && n <= Math.max(x, y);
  return c.op === 'between' ? inside : !inside;
}

/** A few words for the condition, for the menu and tooltips. */
export function describeCondition(cond) {
  const c = cleanCondition(cond);
  if (!c) return '';
  const def = BY_OP[c.op];
  return def.args === 0 ? def.label : def.args === 1 ? `${def.label} ${c.a}` : `${def.label} ${c.a} and ${c.b}`;
}

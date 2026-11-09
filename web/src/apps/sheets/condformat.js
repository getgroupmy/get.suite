// Conditional formatting: rules that colour cells by their value. Each rule applies to a range,
// and the first matching rule (in list order) for a cell wins, as in other spreadsheets.
import { parseRef, cellKey, shiftFormula } from './formula.js';
import { parseRange } from './charts.js';

export const CONDITIONS = [
  ['gt', 'Greater than'], ['gte', 'Greater than or equal to'], ['lt', 'Less than'], ['lte', 'Less than or equal to'],
  ['between', 'Between'], ['eq', 'Equal to'], ['ne', 'Not equal to'],
  ['contains', 'Text contains'], ['notContains', 'Text does not contain'], ['starts', 'Text starts with'],
  ['empty', 'Is empty'], ['notEmpty', 'Is not empty'], ['error', 'Is an error'],
  ['duplicate', 'Duplicate values'], ['unique', 'Unique values'], ['top', 'Top (how many)'], ['bottom', 'Bottom (how many)'],
  ['aboveAvg', 'Above average'], ['belowAvg', 'Below average'], ['formula', 'Custom formula is'],
];
export const NEEDS_VALUE = new Set(['gt', 'gte', 'lt', 'lte', 'between', 'eq', 'ne', 'contains', 'notContains', 'starts', 'top', 'bottom', 'formula']);
/** Rules that look at every cell they apply to, not just the one being coloured. */
export const WHOLE_RANGE = new Set(['duplicate', 'unique', 'top', 'bottom', 'aboveAvg', 'belowAvg']);
const MAX_RULE_CELLS = 50000;
export const STYLES = [
  ['#e6f4ea', '#137333', 'Green'], ['#fce8e6', '#c5221f', 'Red'], ['#fef7e0', '#b06000', 'Yellow'], ['#e8f0fe', '#1967d2', 'Blue'], ['#f3e8fd', '#8430ce', 'Purple'], ['#f1f3f4', '#3c4043', 'Grey'],
];

const num = (v) => (typeof v === 'number' ? v : v !== null && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : null);
const text = (v) => (v === null || v === undefined ? '' : typeof v === 'object' ? '' : String(v));

const keyOf = (v) => (typeof v === 'number' ? `n${v}` : `t${text(v).trim().toLowerCase()}`);
/** What a whole-range rule needs to know about its cells: how often each value comes, the numbers, their average. */
export function rangeStats(rule, valueAt) {
  const g = parseRange(rule.range);
  const counts = new Map(), numbers = [];
  if (!g) return { counts, numbers, avg: null };
  let seen = 0;
  for (let r = g.r1; r <= g.r2; r++) for (let c = g.c1; c <= g.c2; c++) {
    if (++seen > MAX_RULE_CELLS) break;
    const v = valueAt(cellKey(c, r));
    if (v === null || v === undefined || v === '' || (typeof v === 'object')) continue;
    counts.set(keyOf(v), (counts.get(keyOf(v)) || 0) + 1);
    const x = num(v);
    if (x !== null) numbers.push(x);
  }
  numbers.sort((a, b) => b - a);
  return { counts, numbers, avg: numbers.length ? numbers.reduce((a, b) => a + b, 0) / numbers.length : null };
}
/** Is a value among the rule's top (or bottom) n of the range? Ties at the edge count too, as elsewhere. */
function inTop(stats, x, n, bottom) {
  const k = Math.trunc(num(n) ?? 0);
  if (k < 1 || !stats.numbers.length) return false;
  const list = bottom ? [...stats.numbers].reverse() : stats.numbers;
  const edge = list[Math.min(k, list.length) - 1];
  return bottom ? x <= edge : x >= edge;
}
/** A custom formula rule: written for the range's first cell ("=$C2>100"), moved along to each cell. */
export function formulaFor(rule, key) {
  const g = parseRange(rule.range), p = parseRef(key);
  const src = String(rule.value ?? '').trim();
  if (!g || !p || !src) return null;
  return shiftFormula(src.startsWith('=') ? src : `=${src}`, p.c - g.c1, p.r - g.r1);
}

/** Does a cell's computed value meet the rule's condition? ctx (for rules that need more): { stats, formulaValue }. */
export function matches(rule, v, ctx = {}) {
  if (rule.when === 'formula') { const f = ctx.formulaValue; return f === true || (typeof f === 'number' && f !== 0) || (typeof f === 'string' && f.toUpperCase() === 'TRUE'); }
  const isErr = v && typeof v === 'object' && v.error;
  if (rule.when === 'error') return !!isErr;
  if (isErr) return false;
  const empty = v === null || v === undefined || v === '';
  if (rule.when === 'empty') return empty;
  if (rule.when === 'notEmpty') return !empty;
  if (empty) return false;
  const a = num(rule.value), b = num(rule.value2), x = num(v);
  const st = ctx.stats;
  switch (rule.when) {
    case 'duplicate': return !!st && (st.counts.get(keyOf(v)) || 0) > 1;
    case 'unique': return !!st && st.counts.get(keyOf(v)) === 1;
    case 'top': return !!st && x !== null && inTop(st, x, rule.value, false);
    case 'bottom': return !!st && x !== null && inTop(st, x, rule.value, true);
    case 'aboveAvg': return !!st && x !== null && st.avg !== null && x > st.avg;
    case 'belowAvg': return !!st && x !== null && st.avg !== null && x < st.avg;
    case 'gt': return x !== null && a !== null && x > a;
    case 'gte': return x !== null && a !== null && x >= a;
    case 'lt': return x !== null && a !== null && x < a;
    case 'lte': return x !== null && a !== null && x <= a;
    case 'between': return x !== null && a !== null && b !== null && x >= Math.min(a, b) && x <= Math.max(a, b);
    case 'eq': return x !== null && a !== null ? x === a : text(v).toLowerCase() === text(rule.value).toLowerCase();
    case 'ne': return x !== null && a !== null ? x !== a : text(v).toLowerCase() !== text(rule.value).toLowerCase();
    case 'contains': return text(v).toLowerCase().includes(text(rule.value).toLowerCase());
    case 'notContains': return !text(v).toLowerCase().includes(text(rule.value).toLowerCase());
    case 'starts': return text(v).toLowerCase().startsWith(text(rule.value).toLowerCase());
    default: return false;
  }
}

/** Is a cell inside a rule's range? */
export function covers(rule, key) {
  const g = parseRange(rule.range), p = parseRef(key);
  return !!(g && p && p.c >= g.c1 && p.c <= g.c2 && p.r >= g.r1 && p.r <= g.r2);
}

/**
 * What the rules need from the sheet, worked out once per calculation: a cell's value (for rules over
 * a whole range) and a formula as if in a cell (for custom formula rules). Both are optional.
 */
export function ruleContext(valueAt, formulaAt) {
  const stats = new Map();
  return {
    stats: (rule) => { if (!valueAt) return null; if (!stats.has(rule)) stats.set(rule, rangeStats(rule, valueAt)); return stats.get(rule); },
    formulaValue: (rule, key) => { if (!formulaAt) return null; const f = formulaFor(rule, key); return f ? formulaAt(f, key) : null; },
  };
}

/** The style the rules give a cell ({ background, color, fontWeight }), or null. */
export function ruleStyle(rules, key, value, context = null) {
  for (const r of rules || []) {
    if (!covers(r, key)) continue;
    const ctx = r.when === 'formula' ? { formulaValue: context?.formulaValue(r, key) } : WHOLE_RANGE.has(r.when) ? { stats: context?.stats(r) } : undefined;
    if (!matches(r, value, ctx)) continue;
    return { ...(r.fill && { background: r.fill }), ...(r.color && { color: r.color }), ...(r.bold && { fontWeight: 700 }) };
  }
  return null;
}

/** A rule in words: "B2:B20 · Greater than 100". */
export function describeRule(r) {
  const what = CONDITIONS.find(([k]) => k === r.when)?.[1] || r.when;
  if (r.when === 'top' || r.when === 'bottom') return `${r.range} · ${r.when === 'top' ? 'Top' : 'Bottom'} ${r.value ?? ''}`;
  return `${r.range} · ${what}${NEEDS_VALUE.has(r.when) ? ` ${r.value ?? ''}${r.when === 'between' ? ` and ${r.value2 ?? ''}` : ''}` : ''}`;
}

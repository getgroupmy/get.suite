// Conditional formatting: rules that colour cells by their value. Each rule applies to a range,
// and the first matching rule (in list order) for a cell wins, as in other spreadsheets.
import { parseRef } from './formula.js';
import { parseRange } from './charts.js';

export const CONDITIONS = [
  ['gt', 'Greater than'], ['gte', 'Greater than or equal to'], ['lt', 'Less than'], ['lte', 'Less than or equal to'],
  ['between', 'Between'], ['eq', 'Equal to'], ['ne', 'Not equal to'],
  ['contains', 'Text contains'], ['notContains', 'Text does not contain'], ['starts', 'Text starts with'],
  ['empty', 'Is empty'], ['notEmpty', 'Is not empty'], ['error', 'Is an error'],
];
export const NEEDS_VALUE = new Set(['gt', 'gte', 'lt', 'lte', 'between', 'eq', 'ne', 'contains', 'notContains', 'starts']);
export const STYLES = [
  ['#e6f4ea', '#137333', 'Green'], ['#fce8e6', '#c5221f', 'Red'], ['#fef7e0', '#b06000', 'Yellow'], ['#e8f0fe', '#1967d2', 'Blue'], ['#f3e8fd', '#8430ce', 'Purple'], ['#f1f3f4', '#3c4043', 'Grey'],
];

const num = (v) => (typeof v === 'number' ? v : v !== null && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : null);
const text = (v) => (v === null || v === undefined ? '' : typeof v === 'object' ? '' : String(v));

/** Does a cell's computed value meet the rule's condition? */
export function matches(rule, v) {
  const isErr = v && typeof v === 'object' && v.error;
  if (rule.when === 'error') return !!isErr;
  if (isErr) return false;
  const empty = v === null || v === undefined || v === '';
  if (rule.when === 'empty') return empty;
  if (rule.when === 'notEmpty') return !empty;
  if (empty) return false;
  const a = num(rule.value), b = num(rule.value2), x = num(v);
  switch (rule.when) {
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

/** The style the rules give a cell ({ background, color, fontWeight }), or null. */
export function ruleStyle(rules, key, value) {
  for (const r of rules || []) {
    if (!covers(r, key) || !matches(r, value)) continue;
    return { ...(r.fill && { background: r.fill }), ...(r.color && { color: r.color }), ...(r.bold && { fontWeight: 700 }) };
  }
  return null;
}

/** A rule in words: "B2:B20 · Greater than 100". */
export function describeRule(r) {
  const what = CONDITIONS.find(([k]) => k === r.when)?.[1] || r.when;
  return `${r.range} · ${what}${NEEDS_VALUE.has(r.when) ? ` ${r.value ?? ''}${r.when === 'between' ? ` and ${r.value2 ?? ''}` : ''}` : ''}`;
}

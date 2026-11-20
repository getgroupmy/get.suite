// Cleanup suggestions: what looks untidy in a table, each with a fix. Text cells only (formulas,
// numbers and empty cells are left alone):
//  - spaces: extra spaces at the ends or doubled inside ("  Acme  Ltd ");
//  - spelling: the same value written differently in a column ("north", "North", "NORTH"), made like
//    the most common one;
//  - duplicates: rows repeating an earlier one (as Remove duplicates finds them);
//  - numbers: numbers and dates kept as text ("1,234", "50%", "$5.00", "20/11/2026", from before they were read
//    as typed, or from elsewhere), which sums and sorting pass over.
import { cellKey, colName } from './formula.js';
import { removeDuplicates, mapText, trimText } from './data.js';
import { typedNumber, typedDate, mergeFormat } from './cellformat.js';

const isText = (v) => typeof v === 'string' && v !== '' && !v.startsWith('=') && !/^[-+]?(\d[\d,]*\.?\d*|\.\d+)(e[-+]?\d+)?%?$/i.test(v.trim());
const fold = (v) => trimText(v).toLowerCase();

/** Does the first row look like headings (all text, and the row under it not all text)? */
export function looksLikeHeader(sheet, range) {
  const cells = sheet.cells || {};
  if (range.r2 <= range.r1) return false;
  const row = (r) => Array.from({ length: range.c2 - range.c1 + 1 }, (_, j) => cells[cellKey(range.c1 + j, r)]);
  const top = row(range.r1).filter((v) => v !== undefined && v !== '');
  return top.length > 0 && top.every(isText) && !row(range.r1 + 1).filter((v) => v !== undefined && v !== '').every(isText);
}

/** The suggestions for a range: [{ kind, count, … }] (nothing to suggest: []). */
export function cleanupSuggestions(sheet, range, value, { header = false } = {}) {
  const cells = sheet.cells || {};
  const r1 = header ? range.r1 + 1 : range.r1;
  const out = [];
  // Extra spaces.
  let spaces = 0;
  for (let r = r1; r <= range.r2; r++) for (let c = range.c1; c <= range.c2; c++) { const v = cells[cellKey(c, r)]; if (isText(v) && trimText(v) !== v) spaces++; }
  if (spaces) out.push({ kind: 'spaces', count: spaces });
  // The same value spelled differently, column by column.
  for (let c = range.c1; c <= range.c2; c++) {
    const groups = new Map(); // folded → Map(form → how often), in the order first seen
    for (let r = r1; r <= range.r2; r++) {
      const v = cells[cellKey(c, r)];
      if (!isText(v)) continue;
      const f = fold(v), form = trimText(v);
      if (!groups.has(f)) groups.set(f, new Map());
      groups.get(f).set(form, (groups.get(f).get(form) || 0) + 1);
    }
    const mixed = [...groups.values()].filter((forms) => forms.size > 1).map((forms) => {
      const list = [...forms];
      const to = list.reduce((best, x) => (x[1] > best[1] ? x : best))[0]; // the most common (the first, if tied)
      return { to, forms: list.map(([f]) => f), cells: list.filter(([f]) => f !== to).reduce((n, [, k]) => n + k, 0) };
    });
    if (mixed.length) out.push({ kind: 'spelling', col: colName(c), c, groups: mixed, count: mixed.reduce((n, g) => n + g.cells, 0) });
  }
  // Numbers and dates kept as text.
  const asNumbers = numbersAsText(sheet, range, { header });
  if (asNumbers.length) out.push({ kind: 'numbers', count: asNumbers.length, example: asNumbers[0].raw });
  // Duplicate rows (a dry run of Remove duplicates).
  const dup = removeDuplicates(sheet, range, { header, value });
  if (dup.removed) out.push({ kind: 'duplicates', count: dup.removed });
  return out;
}

/** Make the spellings in column c match: { cells, changed }. */
export function fixSpelling(sheet, range, suggestion, { header = false } = {}) {
  const to = new Map(suggestion.groups.map((g) => [fold(g.to), g.to]));
  const r1 = header ? range.r1 + 1 : range.r1;
  return mapText(sheet, { c1: suggestion.c, c2: suggestion.c, r1, r2: range.r2 }, (v) => (to.has(fold(v)) && trimText(v) !== to.get(fold(v)) ? to.get(fold(v)) : v));
}

/** The cells holding a number or date as text: [{ key, raw, value, fmt }]. */
function numbersAsText(sheet, range, { header = false } = {}) {
  const cells = sheet.cells || {}, out = [];
  for (let r = header ? range.r1 + 1 : range.r1; r <= range.r2; r++) {
    for (let c = range.c1; c <= range.c2; c++) {
      const key = cellKey(c, r), raw = cells[key];
      if (typeof raw !== 'string' || raw === '' || raw.startsWith('=') || raw.startsWith("'")) continue;
      const t = typedNumber(raw) ?? typedDate(raw);
      if (t) out.push({ key, raw, ...t });
    }
  }
  return out;
}

/** Turn numbers and dates kept as text into numbers and dates, in the matching format where a cell has none: { cells, formats, changed }. */
export function fixNumbers(sheet, range, { header = false } = {}) {
  const cells = { ...(sheet.cells || {}) }, formats = { ...(sheet.formats || {}) };
  const list = numbersAsText(sheet, range, { header });
  for (const { key, value, fmt } of list) {
    cells[key] = String(value);
    if (!formats[key]?.num) formats[key] = mergeFormat(formats[key], fmt);
  }
  return { cells, formats, changed: list.length };
}

/** Tidy the spaces: { cells, changed }. */
export function fixSpaces(sheet, range, { header = false } = {}) {
  return mapText(sheet, { ...range, r1: header ? range.r1 + 1 : range.r1 }, (v) => (isText(v) ? trimText(v) : v));
}

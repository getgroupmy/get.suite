// Find and replace in a sheet. Cells are searched by what they show; with "formulas" on, a
// formula cell is searched (and replaced) by its formula text instead. Replacing never touches a
// formula cell's formula unless "formulas" is on, so a search for a number can't break one.
import { parseRef } from './formula.js';

const escape = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A RegExp for the search, or null when there's nothing to look for. */
export function pattern(term, { matchCase = false, wholeCell = false } = {}) {
  if (!term) return null;
  return new RegExp(wholeCell ? `^${escape(term)}$` : escape(term), matchCase ? 'g' : 'gi');
}
const isFormula = (raw) => typeof raw === 'string' && raw.startsWith('=');

/**
 * The cells matching, in reading order (along each row, then down).
 * shown(key) gives the text a cell displays; hidden is a Set of rows a filter hides (skipped).
 */
export function findCells(cells, shown, term, opts = {}, hidden = new Set()) {
  const re = pattern(term, opts);
  if (!re) return [];
  const out = [];
  for (const [k, raw] of Object.entries(cells)) {
    const p = parseRef(k);
    if (!p || hidden.has(p.r) || raw === '' || raw == null) continue;
    const text = opts.formulas && isFormula(raw) ? raw : String(shown(k) ?? '');
    re.lastIndex = 0;
    if (re.test(text)) out.push({ key: k, c: p.c, r: p.r });
  }
  return out.sort((a, b) => a.r - b.r || a.c - b.c);
}

/** The new entry for a cell after replacing, or null when it can't or needn't change. */
export function replaceEntry(raw, term, replacement, opts = {}) {
  const re = pattern(term, opts);
  if (!re || raw == null || raw === '') return null;
  if (isFormula(raw) && !opts.formulas) return null;
  const next = String(raw).replace(re, () => replacement); // the replacement is literal text ($ isn't special)
  return next === String(raw) ? null : next;
}

/** Replace in every matching cell: { updates, count, skipped } (skipped: formula cells left alone). */
export function replaceAll(cells, matches, term, replacement, opts = {}) {
  const updates = {};
  let skipped = 0;
  for (const { key } of matches) {
    const next = replaceEntry(cells[key], term, replacement, opts);
    if (next !== null) updates[key] = next;
    else if (isFormula(cells[key])) skipped++;
  }
  return { updates, count: Object.keys(updates).length, skipped };
}

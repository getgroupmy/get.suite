// Find and replace in a sheet. Cells are searched by what they show; with "formulas" on, a
// formula cell is searched (and replaced) by its formula text instead. Replacing never touches a
// formula cell's formula unless "formulas" is on, so a search for a number can't break one.
import { parseRef } from './formula.js';
import { matchesInText } from '../docs/findReplace.js';

/** Where the search is in a cell's text ([{ from, to }]): accents don't matter unless matchDiacritics, as in Docs. */
const matchesIn = (text, term, { matchCase = false, wholeCell = false, matchDiacritics = false } = {}) =>
  matchesInText(String(text), term, { matchCase, wholeText: wholeCell, matchDiacritics });
const isFormula = (raw) => typeof raw === 'string' && raw.startsWith('=');

/**
 * The cells matching, in reading order (along each row, then down).
 * shown(key) gives the text a cell displays; hidden is a Set of rows a filter hides (skipped).
 */
export function findCells(cells, shown, term, opts = {}, hidden = new Set()) {
  if (!term) return [];
  const out = [];
  for (const [k, raw] of Object.entries(cells)) {
    const p = parseRef(k);
    if (!p || hidden.has(p.r) || raw === '' || raw == null) continue;
    const text = opts.formulas && isFormula(raw) ? raw : String(shown(k) ?? '');
    if (matchesIn(text, term, opts).length) out.push({ key: k, c: p.c, r: p.r });
  }
  return out.sort((a, b) => a.r - b.r || a.c - b.c);
}

/** The new entry for a cell after replacing, or null when it can't or needn't change. */
export function replaceEntry(raw, term, replacement, opts = {}) {
  if (!term || raw == null || raw === '') return null;
  if (isFormula(raw) && !opts.formulas) return null;
  // The replacement is literal text ($ isn't special), put where each match is (last first)
  let next = String(raw);
  for (const m of matchesIn(next, term, opts).reverse()) next = next.slice(0, m.from) + replacement + next.slice(m.to);
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

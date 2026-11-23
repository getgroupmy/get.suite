// The value list of a filter menu: what a search finds, and what Select all, Clear and Only these tick.
import { has } from '../../fold.js';

/** The values a search finds — accents and case aside, so "zoe" finds "Zoë"; nothing typed finds all. */
export const foundValues = (values, find) => values.filter((v) => !find.trim() || has(v.label || '(Blanks)', find.trim()));

/** Select all: every value — or, while searching, the found ones as well as what was ticked. */
export const tickFound = (show, values, find) => new Set([...(find.trim() ? show : []), ...foundValues(values, find).map((v) => v.label)]);

/** Clear: nothing ticked — or, while searching, the found ones unticked and the rest left alone. */
export function untickFound(show, values, find) {
  if (!find.trim()) return new Set();
  const out = new Set(show);
  for (const v of foundValues(values, find)) out.delete(v.label);
  return out;
}

/** Only these: just what the search found. */
export const onlyFound = (values, find) => new Set(foundValues(values, find).map((v) => v.label));

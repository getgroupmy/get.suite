// Data validation: cells that offer a list of choices (a dropdown), or a tick box. A sheet keeps
// them as `validations`: [{ id, range: "B2:B20", type: "list", values: ["Open", "Done"], strict }]
// or { id, range, type: "checkbox" }. Later entries win where ranges overlap.
import { covers } from './condformat.js';

export const MAX_CHOICES = 200;

/** The validation for a cell, or null. */
export function validationAt(validations, key) {
  let found = null;
  for (const v of validations || []) if (covers(v, key)) found = v;
  return found;
}

/** Choices typed as "Open, In progress, Done" or one per line: trimmed, no blanks or repeats. */
export function parseChoices(text) {
  const seen = new Set(), out = [];
  for (const part of String(text || '').split(/\r?\n|,/)) {
    const t = part.trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t.slice(0, 200));
    if (out.length >= MAX_CHOICES) break;
  }
  return out;
}

/**
 * What typing `raw` into a cell with validation `v` should store: { value } (possibly corrected to
 * the choice's own spelling) or { error } when a strict list doesn't have it. Empty and formulas pass.
 */
export function checkEntry(v, raw) {
  if (!v || raw === '' || raw == null || String(raw).startsWith('=')) return { value: raw };
  const text = String(raw).trim();
  if (v.type === 'checkbox') {
    if (/^(true|yes|1|x|✓)$/i.test(text)) return { value: 'TRUE' };
    if (/^(false|no|0)$/i.test(text)) return { value: 'FALSE' };
    return { error: 'This cell is a tick box: TRUE or FALSE' };
  }
  if (v.type === 'list') {
    const hit = (v.values || []).find((c) => c.toLowerCase() === text.toLowerCase());
    if (hit) return { value: hit };
    if (v.strict) return { error: `Choose one of: ${(v.values || []).slice(0, 8).join(', ')}${(v.values || []).length > 8 ? '…' : ''}` };
  }
  return { value: raw };
}

/** Is a value ticked (for a tick-box cell)? */
export const isTicked = (value) => value === true || (typeof value === 'string' && value.toUpperCase() === 'TRUE') || value === 1;

/** "Dropdown: Open, Done" / "Tick box", for the list of validations. */
export function describeValidation(v) {
  if (v.type === 'checkbox') return 'Tick box';
  const vals = v.values || [];
  return `Dropdown: ${vals.slice(0, 5).join(', ')}${vals.length > 5 ? ` and ${vals.length - 5} more` : ''}${v.strict ? '' : ' (other values allowed)'}`;
}

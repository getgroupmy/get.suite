// Data validation: cells that offer a list of choices (a dropdown), or a tick box. A sheet keeps
// them as `validations`: [{ id, range: "B2:B20", type: "list", values: ["Open", "Done"], strict }]
// or { id, range, type: "checkbox" }. Later entries win where ranges overlap. A dropdown can take its
// choices from cells instead (`source: "Lists!A2:A20"` or "D2:D10" on the same sheet), so they stay in
// step with that list, and give choices a colour (`colors: { Done: "#ceead6" }`) to show them as chips.
import { covers } from './condformat.js';
import { colIndex, colName, display } from './formula.js';

export const MAX_CHOICES = 200;

/** The validation for a cell, or null. */
export function validationAt(validations, key) {
  let found = null;
  for (const v of validations || []) if (covers(v, key)) found = v;
  return found;
}

/** Colours a choice can have (light, so dark text reads on all of them). */
export const CHIP_COLOURS = [
  { name: 'Grey', hex: '#e8eaed' }, { name: 'Red', hex: '#fad2cf' }, { name: 'Orange', hex: '#fde3c8' }, { name: 'Yellow', hex: '#fef1c4' },
  { name: 'Green', hex: '#ceead6' }, { name: 'Teal', hex: '#c8ecef' }, { name: 'Blue', hex: '#d2e3fc' }, { name: 'Purple', hex: '#e9d2fd' },
];
const HEX = /^#[0-9a-f]{6}$/i;

/** "Lists!A2:A20", "'Q1 data'!$B$2:$B$9" or "D2:D10" → { sheet (null for this sheet), c1, r1, c2, r2 } (0-based), or null. */
export function parseSource(text) {
  const m = /^\s*(?:'((?:[^']|'')+)'!|([^'!:\s][^'!:]*)!)?\$?([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?\s*$/i.exec(String(text || ''));
  if (!m) return null;
  const sheet = m[1] ? m[1].replace(/''/g, "'") : m[2] ? m[2].trim() : null;
  const a = { c: colIndex(m[3].toUpperCase()), r: Number(m[4]) - 1 }, b = m[5] ? { c: colIndex(m[5].toUpperCase()), r: Number(m[6]) - 1 } : a;
  if (a.r < 0 || b.r < 0) return null;
  return { sheet, c1: Math.min(a.c, b.c), c2: Math.max(a.c, b.c), r1: Math.min(a.r, b.r), r2: Math.max(a.r, b.r) };
}

/** A source written the usual way: "Lists!A2:A20", quoting a sheet name that needs it. */
export function cleanSource(text) {
  const p = parseSource(text);
  if (!p) return null;
  const range = `${colName(p.c1)}${p.r1 + 1}:${colName(p.c2)}${p.r2 + 1}`;
  if (!p.sheet) return range;
  return `${/^[A-Z_][A-Z0-9_]*$/i.test(p.sheet) ? p.sheet : `'${p.sheet.replace(/'/g, "''")}'`}!${range}`;
}

/**
 * The choices a source range gives, as each cell shows them (down each column, then across):
 * no blanks, errors or repeats, at most MAX_CHOICES. `valueOf(sheet, key)` gives a cell's value
 * (sheet is null for this sheet); null when the sheet isn't there.
 */
export function choicesFrom(source, valueOf) {
  const p = parseSource(source);
  if (!p) return [];
  const seen = new Set(), out = [];
  for (let c = p.c1; c <= p.c2; c++) for (let r = p.r1; r <= Math.min(p.r2, p.r1 + 2000); r++) {
    const v = valueOf(p.sheet, `${colName(c)}${r + 1}`);
    if (v === null || v === undefined || (typeof v === 'object' && !Array.isArray(v))) continue;
    const t = String(display(Array.isArray(v) ? v[0]?.[0] : v)).trim().slice(0, 200);
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
    if (out.length >= MAX_CHOICES) return out;
  }
  return out;
}

/** The validation with `values` filled in from its range, when it takes them from one. */
export function withChoices(v, valueOf) {
  return v?.type === 'list' && v.source ? { ...v, values: choicesFrom(v.source, valueOf) } : v;
}

/** The colour a value has in a dropdown (matching its choice whatever the case), or null. */
export function chipColour(v, value) {
  if (v?.type !== 'list' || !v.colors || value === '' || value == null) return null;
  const t = String(value).toLowerCase();
  for (const [k, c] of Object.entries(v.colors)) if (k.toLowerCase() === t && HEX.test(c)) return c.toLowerCase();
  return null;
}

/** Colours as stored: only real colours, for choices in `keep` (when given). */
export function cleanColours(colors, keep) {
  const allowed = keep && new Set(keep.map((x) => x.toLowerCase()));
  const out = {};
  for (const [k, c] of Object.entries(colors || {})) {
    if (!HEX.test(c || '') || (allowed && !allowed.has(k.toLowerCase()))) continue;
    out[String(k).slice(0, 200)] = c.toLowerCase();
    if (Object.keys(out).length >= MAX_CHOICES) break;
  }
  return Object.keys(out).length ? out : null;
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
  if (v.source) return `Dropdown from ${v.source}${v.strict ? '' : ' (other values allowed)'}`;
  const vals = v.values || [];
  return `Dropdown: ${vals.slice(0, 5).join(', ')}${vals.length > 5 ? ` and ${vals.length - 5} more` : ''}${v.strict ? '' : ' (other values allowed)'}`;
}

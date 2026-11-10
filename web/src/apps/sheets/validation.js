// Data validation: cells that offer a list of choices (a dropdown), or a tick box. A sheet keeps
// them as `validations`: [{ id, range: "B2:B20", type: "list", values: ["Open", "Done"], strict }]
// or { id, range, type: "checkbox" }. Later entries win where ranges overlap. A dropdown can take its
// choices from cells instead (`source: "Lists!A2:A20"` or "D2:D10" on the same sheet), so they stay in
// step with that list, and give choices a colour (`colors: { Done: "#ceead6" }`) to show them as chips.
import { covers, formulaFor } from './condformat.js';
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
// ---- several choices in a cell (multi): kept as "Design, Marketing", in the order picked.
/** The choices in a cell of a several-choices dropdown. */
export const splitMulti = (value) => String(value ?? '').split(',').map((x) => x.trim()).filter(Boolean);
/** The cell's value with `choice` added, or taken out if it was there (any case). */
export function toggleChoice(current, choice) {
  const parts = splitMulti(current);
  const has = parts.some((x) => x.toLowerCase() === String(choice).toLowerCase());
  return (has ? parts.filter((x) => x.toLowerCase() !== String(choice).toLowerCase()) : [...parts, choice]).join(', ');
}
/** Each choice in a several-choices cell with its colour (null when it has none), for chips. */
export const chipsOf = (v, value) => splitMulti(value).map((text) => ({ text, color: chipColour(v, text) }));

export function checkEntry(v, raw) {
  if (!v || raw === '' || raw == null || String(raw).startsWith('=')) return { value: raw };
  const text = String(raw).trim();
  if (v.type === 'checkbox') {
    if (/^(true|yes|1|x|✓)$/i.test(text)) return { value: 'TRUE' };
    if (/^(false|no|0)$/i.test(text)) return { value: 'FALSE' };
    return { error: 'This cell is a tick box: TRUE or FALSE' };
  }
  if (v.type === 'rule') {
    if (v.check?.kind === 'formula' || passes(v.check, text)) return { value: raw };
    const why = v.message || `Enter a value that fits: ${describeCheck(v.check).replace(/^./, (c) => c.toLowerCase())}`;
    return v.strict ? { error: why } : { value: raw, warning: why };
  }
  if (v.type === 'list' && v.multi) {
    const out = [], wrong = [];
    for (const part of splitMulti(text)) {
      const hit = (v.values || []).find((c) => c.toLowerCase() === part.toLowerCase());
      if (hit) { if (!out.includes(hit)) out.push(hit); } else { wrong.push(part); out.push(part); }
    }
    if (wrong.length && v.strict) return { error: `Not a choice: ${wrong.join(', ')}. Choose from: ${(v.values || []).slice(0, 8).join(', ')}${(v.values || []).length > 8 ? '…' : ''}` };
    return { value: out.join(', ') };
  }
  if (v.type === 'list') {
    const hit = (v.values || []).find((c) => c.toLowerCase() === text.toLowerCase());
    if (hit) return { value: hit };
    if (v.strict) return { error: `Choose one of: ${(v.values || []).slice(0, 8).join(', ')}${(v.values || []).length > 8 ? '…' : ''}` };
  }
  return { value: raw };
}

// ---- rules: what a cell may hold, beyond a list of choices.
// { type: 'rule', check: { kind, op, a, b }, strict, message }: kind is number, whole, date, length,
// email, url or formula; op (for number, whole, date and length) is between, notBetween, gt, gte, lt,
// lte, eq or ne. strict refuses other values as they're typed; otherwise they're kept and marked.
export const RULE_KINDS = [
  ['number', 'Number'], ['whole', 'Whole number'], ['date', 'Date'], ['length', 'Text length'],
  ['email', 'Email address'], ['url', 'Web address'], ['formula', 'Custom formula is TRUE'],
];
export const RULE_OPS = [
  ['between', 'between'], ['notBetween', 'not between'], ['gt', 'greater than'], ['gte', 'at least'],
  ['lt', 'less than'], ['lte', 'at most'], ['eq', 'equal to'], ['ne', 'not equal to'],
];
export const WITH_OP = new Set(['number', 'whole', 'date', 'length']);
const DATE_TEXT = /^(\d{4})-(\d{2})-(\d{2})(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/;
const dayNumber = (t) => {
  const m = DATE_TEXT.exec(String(t ?? '').trim());
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  return new Date(ms).getUTCDate() === +m[3] ? ms / 864e5 : null;
};
const asNumber = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v.trim())) ? Number(v.trim()) : null);
const compare = (op, x, a, b) => {
  switch (op) {
    case 'between': return x >= Math.min(a, b) && x <= Math.max(a, b);
    case 'notBetween': return x < Math.min(a, b) || x > Math.max(a, b);
    case 'gt': return x > a;
    case 'gte': return x >= a;
    case 'lt': return x < a;
    case 'lte': return x <= a;
    case 'eq': return x === a;
    case 'ne': return x !== a;
    default: return true;
  }
};
const EMAIL = /^[^\s@<>"(),;:]+@[^\s@<>"(),;:]+\.[a-z]{2,}$/i;
const URL_RE = /^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/\S*)?$/i;
/**
 * Does a value pass a rule (not the custom formula kind, which needs the sheet)? Blank always passes.
 * Bad limits (a date that isn't one) let everything through rather than refuse it all.
 */
export function passes(check, value) {
  if (value === null || value === undefined || value === '') return true;
  if (typeof value === 'object') return false; // an error
  const { kind, op } = check || {};
  if (kind === 'email') return EMAIL.test(String(value).trim());
  if (kind === 'url') return URL_RE.test(String(value).trim());
  if (kind === 'length') {
    const a = asNumber(check.a), b = asNumber(check.b);
    if (a === null || (/between/i.test(op) && b === null)) return true;
    return compare(op, String(value).length, a, b);
  }
  if (kind === 'date') {
    const x = dayNumber(value), a = dayNumber(check.a), b = dayNumber(check.b);
    if (a === null || (/between/i.test(op) && b === null)) return x !== null;
    return x !== null && compare(op, x, a, b);
  }
  if (kind === 'number' || kind === 'whole') {
    const x = asNumber(value), a = asNumber(check.a), b = asNumber(check.b);
    if (x === null || (kind === 'whole' && !Number.isInteger(x))) return false;
    if (a === null || (/between/i.test(op) && b === null)) return true;
    return compare(op, x, a, b);
  }
  return true;
}
/** Does a cell break its rule? `formulaAt(src, key)` works out a custom formula at the cell. */
export function breaksRule(v, key, value, formulaAt) {
  if (v?.type !== 'rule' || value === null || value === undefined || value === '') return false;
  if (v.check?.kind === 'formula') {
    if (!formulaAt) return false;
    const f = formulaFor({ range: v.range, value: v.check.a }, key);
    if (!f) return false;
    const r = formulaAt(f, key);
    return !(r === true || (typeof r === 'number' && r !== 0) || (typeof r === 'string' && r.toUpperCase() === 'TRUE'));
  }
  return !passes(v.check, value);
}
/** A rule in words: "Whole number between 1 and 10", "Date after 2026-01-01", "Email address". */
export function describeCheck(check) {
  const kind = RULE_KINDS.find(([k]) => k === check?.kind)?.[1] || 'Rule';
  if (check?.kind === 'formula') return `Custom formula ${check.a || ''}`.trim();
  if (!WITH_OP.has(check?.kind)) return kind;
  const op = check.kind === 'date' ? { gt: 'after', lt: 'before', gte: 'on or after', lte: 'on or before', eq: 'on', ne: 'not on' }[check.op] || RULE_OPS.find(([k]) => k === check.op)?.[1] : RULE_OPS.find(([k]) => k === check.op)?.[1];
  return `${kind} ${op || ''} ${check.a ?? ''}${/between/i.test(check.op) ? ` and ${check.b ?? ''}` : ''}`.replace(/\s+/g, ' ').trim();
}

/** Is a value ticked (for a tick-box cell)? */
export const isTicked = (value) => value === true || (typeof value === 'string' && value.toUpperCase() === 'TRUE') || value === 1;

/** "Dropdown: Open, Done" / "Tick box", for the list of validations. */
export function describeValidation(v) {
  if (v.type === 'checkbox') return 'Tick box';
  if (v.type === 'rule') return `${describeCheck(v.check)}${v.strict ? '' : ' (other values marked)'}`;
  const several = v.multi ? ', several choices per cell' : '';
  if (v.source) return `Dropdown from ${v.source}${several}${v.strict ? '' : ' (other values allowed)'}`;
  const vals = v.values || [];
  return `Dropdown: ${vals.slice(0, 5).join(', ')}${vals.length > 5 ? ` and ${vals.length - 5} more` : ''}${several}${v.strict ? '' : ' (other values allowed)'}`;
}

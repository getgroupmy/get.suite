// Smart fill: from a few rows where you typed what you want (“J. Smith” beside “John Smith”), learn how
// it's made from the other columns and fill in the rest. A pattern is pieces of the row's other cells
// (the whole text, its nth word or number, the nth part between separators, or just their first letter;
// as typed, lower case, UPPER CASE or Capitalised) joined with fixed text. The simplest pattern that gives
// every example exactly is used; if none does, nothing is filled.

const SEPS = [' ', ',', '@', '.', '-', '/', '_', ':', ';', '|'];
const CASES = ['', 'lower', 'upper', 'proper'];
const MAX_OUT = 120; // longer examples aren't learnt from
const MAX_PART = 6; // parts counted from the start…
const MAX_BACK = 3; // …and from the end

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const monthOf = (w) => { const i = MONTHS.findIndex((m) => m.slice(0, 3).toLowerCase() === String(w).slice(0, 3).toLowerCase()); return i < 0 ? null : i + 1; };
const real = (y, m, d) => { const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? { y, m, d } : null; };
const fullYear = (y) => (y.length === 2 ? 2000 + +y : +y);

/**
 * A cell's text as a date, or null: "2026-11-15" (how Sheets keeps dates, a time after it allowed),
 * "15/11/2026" or "15.11.26" (day first, unless that can't be: "11/25/2026"), "15 Nov 2026", "Nov 15, 2026".
 */
export function parseDate(text) {
  const s = String(text ?? '').trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ]\d{1,2}:\d{2}(?::\d{2})?)?$/.exec(s);
  if (m) return real(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})$/.exec(s);
  if (m) { const [a, b, y] = [+m[1], +m[2], fullYear(m[3])]; return a > 12 || b <= 12 ? real(y, b, a) : real(y, a, b); }
  m = /^(\d{1,2})(?:st|nd|rd|th)? ([A-Za-z]{3,9})\.?,? (\d{4})$/.exec(s);
  if (m && monthOf(m[2])) return real(+m[3], monthOf(m[2]), +m[1]);
  m = /^([A-Za-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})$/.exec(s);
  if (m && monthOf(m[1])) return real(+m[3], monthOf(m[1]), +m[2]);
  return null;
}
const pad2 = (n) => String(n).padStart(2, '0');
/** One part of a date, as text. */
const DATE_PARTS = {
  d: (t) => String(t.d), dd: (t) => pad2(t.d), m: (t) => String(t.m), mm: (t) => pad2(t.m),
  mon: (t) => MONTHS[t.m - 1].slice(0, 3), month: (t) => MONTHS[t.m - 1],
  yyyy: (t) => String(t.y), yy: (t) => pad2(t.y % 100),
  wd: (t) => DAYS[new Date(Date.UTC(t.y, t.m - 1, t.d)).getUTCDay()].slice(0, 3), weekday: (t) => DAYS[new Date(Date.UTC(t.y, t.m - 1, t.d)).getUTCDay()],
};
const TEXT_PARTS = new Set(['mon', 'month', 'wd', 'weekday']);

const proper = (s) => s.toLowerCase().replace(/(^|[^\p{L}\p{N}'’])(\p{L})/gu, (_, a, b) => a + b.toUpperCase());
const recase = (s, c) => (c === 'lower' ? s.toLowerCase() : c === 'upper' ? s.toUpperCase() : c === 'proper' ? proper(s) : s);
const pick = (list, idx) => (idx >= 0 ? list[idx] : list[list.length + idx]);

/** Every way to take a piece out of one cell, simplest first (which wins when two give the same examples). */
function atomsFor(nCols) {
  const out = [];
  const idxs = [0, -1, 1, -2, 2, -3, 3, 4, 5].filter((i) => (i >= 0 ? i < MAX_PART : -i <= MAX_BACK));
  for (const first of [false, true]) {
    for (const cs of CASES) {
      for (let col = 0; col < nCols; col++) {
        if (!first) out.push({ col, kind: 'whole', case: cs, first });
        if (!first) for (const part of Object.keys(DATE_PARTS)) if (!cs || TEXT_PARTS.has(part)) out.push({ col, kind: 'date', part, case: cs, first });
        for (const idx of idxs) out.push({ col, kind: 'word', idx, case: cs, first });
        for (const idx of idxs) out.push({ col, kind: 'num', idx, case: '', first });
        for (const sep of SEPS) for (const idx of idxs) out.push({ col, kind: 'part', sep, idx, case: cs, first });
      }
    }
  }
  return out.filter((a) => !(a.kind === 'num' && a.case));
}

/** The piece an atom takes from a row's cells, or null when the row hasn't got it (no third word, say). */
export function atomValue(a, inputs) {
  const s = String(inputs[a.col] ?? '');
  if (!s) return null;
  let v;
  if (a.kind === 'whole') v = s;
  else if (a.kind === 'date') { const t = parseDate(s); if (!t) return null; v = DATE_PARTS[a.part](t); }
  else if (a.kind === 'word') v = pick(s.match(/[\p{L}\p{N}'’]+/gu) || [], a.idx);
  else if (a.kind === 'num') v = pick(s.match(/\d+(?:[.,]\d+)?/g) || [], a.idx);
  else {
    const parts = s.split(a.sep);
    if (parts.length < 2) return null; // no such separator: not a "part"
    v = pick(parts, a.idx);
    v = v === undefined ? undefined : v.trim();
  }
  if (!v) return null;
  if (a.first) v = [...v][0];
  return recase(v, a.case);
}

const COST_ATOM = 1, COST_TEXT = 1;
// Typed letters and digits cost more than spaces and punctuation: they're more likely to come from the row.
const textCost = (t) => COST_TEXT + [...t].reduce((n, ch) => n + (/[\p{L}\p{N}]/u.test(ch) ? 1.5 : 0.3), 0);

/**
 * Learn a pattern from examples [{ inputs: [cell text…], output }]: { steps: [{ atom } | { text }] }, or null.
 * The search walks along every example's output together, taking a piece of the cells or fixed text at
 * each step; the cheapest way to the end of all of them wins (pieces are cheaper than typed text).
 */
export function learnFill(examples) {
  if (!examples.length || examples.some((e) => !e.output || e.output.length > MAX_OUT)) return null;
  const nCols = Math.max(...examples.map((e) => e.inputs.length));
  // Atoms that give something in every example, one per distinct set of values (the simplest kept).
  const seen = new Set(), atoms = [];
  for (const a of atomsFor(nCols)) {
    const vals = examples.map((e) => atomValue(a, e.inputs));
    if (vals.some((v) => v === null)) continue;
    const key = vals.join('\u0000');
    if (seen.has(key)) continue;
    seen.add(key);
    atoms.push({ a, vals });
  }
  const outs = examples.map((e) => e.output);
  const memo = new Map();
  const best = (pos, afterText) => {
    if (pos.every((p, k) => p === outs[k].length)) return { cost: 0, steps: [] };
    if (pos.some((p, k) => p === outs[k].length)) return null; // one finished before the others
    const key = `${pos.join(',')}|${afterText ? 1 : 0}`;
    if (memo.has(key)) return memo.get(key);
    memo.set(key, null); // (no cycles: every step moves forward)
    let win = null;
    for (const { a, vals } of atoms) {
      if (!vals.every((v, k) => outs[k].startsWith(v, pos[k]))) continue;
      const rest = best(pos.map((p, k) => p + vals[k].length), false);
      if (rest && (!win || rest.cost + COST_ATOM < win.cost)) win = { cost: rest.cost + COST_ATOM, steps: [{ atom: a }, ...rest.steps] };
    }
    if (!afterText) { // fixed text, the same in every example (never two in a row: one longer piece is cheaper)
      const room = outs[0].length - pos[0];
      for (let len = 1; len <= room; len++) {
        const t = outs[0].slice(pos[0], pos[0] + len);
        if (!outs.every((o, k) => o.startsWith(t, pos[k]))) break;
        const rest = best(pos.map((p) => p + len), true);
        const cost = textCost(t);
        if (rest && (!win || rest.cost + cost < win.cost)) win = { cost: rest.cost + cost, steps: [{ text: t }, ...rest.steps] };
      }
    }
    memo.set(key, win);
    return win;
  };
  const found = best(outs.map(() => 0), false);
  if (!found) return null;
  // Only fixed text with nothing from the row: that's not a pattern unless every example agrees on it
  // (and then there must be two of them).
  if (!found.steps.some((s) => s.atom) && examples.length < 2) return null;
  return { steps: found.steps };
}

/** A row's result, or null when it hasn't got a piece the pattern needs. */
export function applyFill(pattern, inputs) {
  let out = '';
  for (const s of pattern.steps) {
    if (s.text !== undefined) { out += s.text; continue; }
    const v = atomValue(s.atom, inputs);
    if (v === null) return null;
    out += v;
  }
  return out;
}

const DATE_WORDS = { d: 'day', dd: 'day (2 digits)', m: 'month number', mm: 'month number (2 digits)', mon: 'month name, short', month: 'month name', yyyy: 'year', yy: 'year (2 digits)', wd: 'weekday, short', weekday: 'weekday' };
const ORD = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth'];
const BACK = ['last', 'second to last', 'third to last'];
const nth = (i) => (i >= 0 ? ORD[i] : BACK[-i - 1]);
const SEP_NAMES = { ' ': 'space', ',': 'comma', '@': '@', '.': 'full stop', '-': 'hyphen', '/': 'slash', '_': 'underscore', ':': 'colon', ';': 'semicolon', '|': 'bar' };

/** The pattern in words, for the preview: “first letter of the first word of A, then “. ”, then the last word of A”. */
export function describeFill(pattern, colNames) {
  return pattern.steps.map((s) => {
    if (s.text !== undefined) return `“${s.text}”`;
    const a = s.atom, col = colNames[a.col] ?? `column ${a.col + 1}`;
    const what = a.kind === 'whole' ? col
      : a.kind === 'date' ? `the ${DATE_WORDS[a.part]} of the date in ${col}`
      : a.kind === 'word' ? `the ${nth(a.idx)} word of ${col}`
      : a.kind === 'num' ? `the ${nth(a.idx)} number in ${col}`
      : `the ${nth(a.idx)} part of ${col} between ${SEP_NAMES[a.sep]}s`;
    const cs = { lower: ', in lower case', upper: ', in capitals', proper: ', capitalised' }[a.case] || '';
    return `${a.first ? `the first letter of ${what}` : what}${cs}`;
  }).join(' + ');
}

/**
 * Plan smart fill for a column of a table: rows r1–r2 (a heading row skipped, when told or when it doesn't fit), the target column and the
 * columns to learn from; value(c, r) is a cell's shown text. { error } or { pattern, examples, fills: [{ r, v, from }] }.
 */
export function planSmartFill(o) {
  // Headings aren't always easy to tell (“Short” over “K. Park”): when the first row spoils the pattern,
  // try again without it.
  const first = planRows({ ...o, header: !!o.header });
  if (!first.error || o.header || o.r2 <= o.r1) return first;
  const again = planRows({ ...o, header: true });
  return again.error ? first : again;
}

function planRows({ r1, r2, target, cols, header, value }) {
  const inputsOf = (r) => cols.map((c) => value(c, r));
  const examples = [], todo = [];
  for (let r = header ? r1 + 1 : r1; r <= r2; r++) {
    const inputs = inputsOf(r);
    if (inputs.every((v) => !v)) continue;
    const out = value(target, r);
    if (out) examples.push({ r, inputs, output: out });
    else if (r > r1) todo.push({ r, inputs }); // the table's top row, empty in this column, is its heading row
  }
  if (!cols.length) return { error: 'Smart fill needs a column of data beside this one to learn from' };
  if (!examples.length) return { error: 'Type what you want in a cell or two of this column first, then use Smart fill' };
  if (!todo.length) return { error: 'Every row of this column is already filled in' };
  const pattern = learnFill(examples.slice(0, 6));
  if (!pattern) return { error: 'No pattern found that gives your examples: type another example, or check them' };
  // The later examples must fit too (only the first few were learnt from).
  if (examples.slice(6).some((e) => applyFill(pattern, e.inputs) !== e.output)) return { error: 'Your examples don\'t follow one pattern: check them' };
  const fills = [];
  for (const t of todo) { const v = applyFill(pattern, t.inputs); if (v !== null && v !== '') fills.push({ r: t.r, v, from: t.inputs.find(Boolean) }); }
  if (!fills.length) return { error: 'The pattern gives nothing for the other rows' };
  return { pattern, examples: examples.length, fills };
}

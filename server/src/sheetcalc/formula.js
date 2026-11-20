// Small spreadsheet formula engine: arithmetic, comparisons, text, cell refs, ranges, common functions.

import { convertUnits } from './unitconvert.js';
import { runQuery, QueryError } from './query.js';
import { tablesOf, plainTableRefs } from './tablerefs.js';
import { normCdf, normPdf, normInv, tCdf, tPdf, tInv, chiCdf, chiPdf, binomPmf, binomCdf, poissonPmf, poissonCdf, tTest, interestPart, capitalPart, ddb, db, yearFrac, parseDateText, parseTimeText, lnGamma, gammaP, betaI } from './statmath.js';

export class FormulaError extends Error {
  /** `why` says what went wrong in words, for errors where the code alone doesn't (QUERY's). */
  constructor(code, why) { super(code); this.code = code; if (why) this.why = why; }
}
const errorValue = (e) => ({ error: e.code, ...(e.why && { why: e.why }) });
const err = (code) => { throw new FormulaError(code); };

export function colName(i) {
  let s = '';
  for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}
export function colIndex(letters) {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
export const cellKey = (c, r) => `${colName(c)}${r + 1}`;
export function parseRef(ref) {
  const m = /^\$?([A-Z]+)\$?(\d+)$/i.exec(ref);
  if (!m) return null;
  return { c: colIndex(m[1]), r: Number(m[2]) - 1 };
}

// ---------- tokenizer ----------
const TOKEN_RE = /\s*(?:(\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+)|("(?:[^"]|"")*")|(\$?[A-Z]+\$?\d+(?::\$?[A-Z]+\$?\d+)?)(?![A-Z0-9_(])|([A-Z_][A-Z0-9_.]*)|(<=|>=|<>|[-+*/^&=<>(),:%{};]))/iy;

// A reference on another sheet: Sheet2!A1, 'Q1 data'!B2:B9.
const XREF_RE = /\s*(?:'((?:[^']|'')+)'|([A-Z_][A-Z0-9_]*))!(?:(\$?[A-Z]+\$?\d+(?::\$?[A-Z]+\$?\d+)?)(?![A-Z0-9_(])|([A-Z_][A-Z0-9_]*)(?![A-Z0-9_(]))/iy;
/** How a sheet's name is written before "!" in a formula (quoted when it has to be). */
export const sheetPrefix = (name) => (/^[A-Z_][A-Z0-9_]*$/i.test(name) && !/^[A-Z]{1,3}\d+$/i.test(name) ? name : `'${String(name).replace(/'/g, "''")}'`);

function tokenize(src) {
  const out = [];
  TOKEN_RE.lastIndex = 0;
  while (TOKEN_RE.lastIndex < src.length) {
    if (/^\s*$/.test(src.slice(TOKEN_RE.lastIndex))) break;
    const refErr = /^\s*#REF!/i.exec(src.slice(TOKEN_RE.lastIndex)); // a reference to cells that were deleted
    if (refErr) { out.push({ t: 'referr' }); TOKEN_RE.lastIndex += refErr[0].length; continue; }
    XREF_RE.lastIndex = TOKEN_RE.lastIndex;
    const x = XREF_RE.exec(src);
    if (x) {
      const sheet = x[1] !== undefined ? x[1].replace(/''/g, "'") : x[2];
      out.push(x[3] !== undefined ? { t: 'xref', sheet, v: x[3].toUpperCase() } : { t: 'xname', sheet, v: x[4].toUpperCase() }); // Data!Total: a named range there
      TOKEN_RE.lastIndex = XREF_RE.lastIndex; continue;
    }
    const m = TOKEN_RE.exec(src);
    if (!m) err('#ERROR!');
    if (m[1] !== undefined) out.push({ t: 'num', v: Number(m[1]) });
    else if (m[2] !== undefined) out.push({ t: 'str', v: m[2].slice(1, -1).replace(/""/g, '"') });
    else if (m[3] !== undefined) out.push({ t: 'ref', v: m[3].toUpperCase() });
    else if (m[4] !== undefined) out.push({ t: 'id', v: m[4].toUpperCase() });
    else out.push({ t: 'op', v: m[5] });
  }
  return out;
}

// ---------- parser (recursive descent -> AST) ----------
export function parse(src) {
  const toks = tokenize(src);
  let i = 0;
  const peek = () => toks[i];
  const isOp = (...ops) => peek()?.t === 'op' && ops.includes(peek().v);
  const expect = (v) => { if (!isOp(v)) err('#ERROR!'); i++; };

  function comparison() {
    let left = concat();
    while (isOp('=', '<>', '<', '>', '<=', '>=')) { const op = toks[i++].v; left = { k: 'bin', op, left, right: concat() }; }
    return left;
  }
  function concat() {
    let left = additive();
    while (isOp('&')) { i++; left = { k: 'bin', op: '&', left, right: additive() }; }
    return left;
  }
  function additive() {
    let left = multiplicative();
    while (isOp('+', '-')) { const op = toks[i++].v; left = { k: 'bin', op, left, right: multiplicative() }; }
    return left;
  }
  function multiplicative() {
    let left = power();
    while (isOp('*', '/')) { const op = toks[i++].v; left = { k: 'bin', op, left, right: power() }; }
    return left;
  }
  function power() {
    let left = unary();
    while (isOp('^')) { i++; left = { k: 'bin', op: '^', left, right: unary() }; }
    return left;
  }
  function unary() {
    if (isOp('-')) { i++; return { k: 'neg', e: unary() }; }
    if (isOp('+')) { i++; return unary(); }
    return postfix();
  }
  function postfix() {
    let e = primary();
    while (isOp('%')) { i++; e = { k: 'bin', op: '/', left: e, right: { k: 'num', v: 100 } }; }
    return e;
  }
  function primary() {
    const tk = toks[i++];
    if (!tk) err('#ERROR!');
    if (tk.t === 'num') return { k: 'num', v: tk.v };
    if (tk.t === 'referr') return { k: 'referr' };
    if (tk.t === 'str') return { k: 'str', v: tk.v };
    if (tk.t === 'xref') { const [a, b = a] = tk.v.split(':'); return { k: 'xref', sheet: tk.sheet, a: parseRef(a), b: parseRef(b), one: !tk.v.includes(':') }; }
    if (tk.t === 'xname') return { k: 'xname', sheet: tk.sheet, v: tk.v };
    if (tk.t === 'ref') {
      if (tk.v.includes(':')) { const [a, b] = tk.v.split(':'); return { k: 'range', a: parseRef(a), b: parseRef(b) }; }
      return { k: 'ref', ref: parseRef(tk.v) };
    }
    if (tk.t === 'id') {
      if (isOp('(')) {
        i++;
        const args = [];
        if (!isOp(')')) { do { args.push(isOp(',', ')') ? { k: 'empty' } : comparison()); } while (isOp(',') && ++i); } // XLOOKUP(x, a, b, , 2): a skipped argument
        expect(')');
        return { k: 'call', name: tk.v, args };
      }
      if (tk.v === 'TRUE' || tk.v === 'FALSE') return { k: 'bool', v: tk.v === 'TRUE' };
      return { k: 'name', v: tk.v }; // a named range (looked up when it's worked out)
    }
    if (tk.t === 'op' && tk.v === '(') { const e = comparison(); expect(')'); return e; }
    // An array constant: {1,2,3} across, {1;2;3} down, {1,2;3,4} two rows of two (each row the same length).
    if (tk.t === 'op' && tk.v === '{') {
      const rows = [[]];
      if (!isOp('}')) {
        for (;;) {
          rows[rows.length - 1].push(comparison());
          if (isOp(',')) { i++; continue; }
          if (isOp(';')) { i++; rows.push([]); continue; }
          break;
        }
      }
      expect('}');
      if (!rows[0].length || rows.some((r) => r.length !== rows[0].length)) err('#ERROR!');
      return { k: 'array', rows };
    }
    err('#ERROR!');
  }

  const ast = comparison();
  if (i < toks.length) err('#ERROR!');
  return ast;
}

// ---------- evaluation ----------
/** A cell of an array that holds an error ({ error: '#DIV/0!' }), as =A1:A3/B1:B3 can give. */
const isErr = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && typeof v.error === 'string';
const raise = (v) => { throw new FormulaError(v.error, v.why); };
const toNum = (v) => {
  if (v === null || v === '' || v === undefined) return 0;
  if (isErr(v)) raise(v);
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = Number(v);
  if (Number.isNaN(n)) err('#VALUE!');
  return n;
};
/** A number as text, as Excel writes it: 15 significant digits (0.1+0.2 is "0.3"), exponents as E+21 and E-07. */
export const numText = (n) => {
  if (!Number.isFinite(n)) return String(n);
  const r = Number(n.toPrecision(15));
  return String(Object.is(r, -0) ? 0 : r).replace(/e([+-])(\d+)$/, (m, sign, d) => `E${sign}${d.padStart(2, '0')}`);
};
const toStr = (v) => (v === null || v === undefined ? '' : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : isErr(v) ? raise(v) : typeof v === 'number' ? numText(v) : String(v));
const toBool = (v) => (typeof v === 'string' ? v.toUpperCase() === 'TRUE' || (v !== '' && v.toUpperCase() !== 'FALSE' && toNum(v) !== 0) : !!toNum(v));
const flat = (args) => { const out = args.flat(Infinity); for (const v of out) if (isErr(v)) raise(v); return out; };
const nums = (args) => flat(args).filter((v) => typeof v === 'number');

/** Text with * (anything) and ? (one character) as a whole-text, any-case pattern; ~ escapes them. */
function wildcard(text) {
  let src = '';
  const t = String(text);
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === '~' && i + 1 < t.length && '*?~'.includes(t[i + 1])) { src += `\\${t[++i]}`; continue; }
    if (ch === '*') src += '[\\s\\S]*';
    else if (ch === '?') src += '[\\s\\S]';
    else src += ch.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
  }
  return new RegExp(`^${src}$`, 'i');
}
const hasWildcard = (t) => typeof t === 'string' && /(^|[^~])[*?]/.test(t);

function criteria(c) {
  const m = /^(<=|>=|<>|<|>|=)?(.*)$/.exec(toStr(c));
  const op = m[1] || '=';
  const rhs = m[2] !== '' && !Number.isNaN(Number(m[2])) ? Number(m[2]) : m[2].toLowerCase();
  if ((op === '=' || op === '<>') && hasWildcard(m[2])) { const re = wildcard(m[2]); return (v) => re.test(toStr(v)) === (op === '='); }
  return (v) => {
    const lhs = typeof rhs === 'number' ? (typeof v === 'number' ? v : Number.NaN) : toStr(v).toLowerCase();
    switch (op) {
      case '=': return lhs === rhs;
      case '<>': return lhs !== rhs;
      case '<': return lhs < rhs;
      case '>': return lhs > rhs;
      case '<=': return lhs <= rhs;
      default: return lhs >= rhs;
    }
  };
}

// ---- helpers for lookups, conditions and dates
const shapeOf = (a) => (Array.isArray(a) ? { rows: a.rows ?? a.length, cols: a.cols ?? 1, at: (r, c) => a[r * (a.cols ?? 1) + c] } : { rows: 1, cols: 1, at: () => a });
const same = (a, b) => (typeof a === 'string' && typeof b === 'string' ? a.toLowerCase() === b.toLowerCase() : a === b);
const before = (a, b) => (typeof a === 'number' && typeof b === 'number' ? a < b : typeof a === 'string' && typeof b === 'string' ? a.toLowerCase() < b.toLowerCase() : typeof a === 'number');
/** MATCH's search: 0 exact (wildcards allowed), 1 the last value ≤ x in ascending order, -1 the last ≥ x in descending order. Index or -1. */
function findIn(list, x, type) {
  if (type === 0) {
    const re = hasWildcard(x) ? wildcard(x) : null;
    return list.findIndex((v) => (re ? typeof v === 'string' && re.test(v) : same(v, x)));
  }
  let found = -1;
  for (let i = 0; i < list.length; i++) {
    const v = list[i];
    if (v === null || v === '') continue;
    if (same(v, x)) return i;
    if (type > 0 ? before(v, x) : before(x, v)) found = i; else break;
  }
  return found;
}
const notFound = () => err('#N/A');
const scalarOf = (v) => (Array.isArray(v) ? (v.length === 1 ? v[0] : err("#VALUE!")) : v);
/** Pairs of (range, criterion) from the rest of the arguments, all tested together. */
function multi(pairs, other) {
  if (!pairs.length || pairs.length % 2) err('#VALUE!');
  const tests = [];
  for (let i = 0; i < pairs.length; i += 2) tests.push([flat([pairs[i]]), criteria(pairs[i + 1])]);
  const n = tests[0][0].length;
  if (tests.some(([r]) => r.length !== n) || (other && flat([other]).length !== n)) err('#VALUE!'); // all the same size
  return (i) => tests.every(([r, t]) => t(r[i]));
}
const DAY_MS = 864e5;
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
/** A date from "2026-11-06" (as TODAY and DATE give) or a spreadsheet serial number, as UTC ms. */
function toDate(v) {
  if (typeof v === 'number') return EXCEL_EPOCH + Math.floor(v) * DAY_MS;
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(toStr(v).trim());
  if (!m) err('#VALUE!');
  return Date.UTC(+m[1], +m[2] - 1, +m[3]);
}
const dateText = (ms) => new Date(ms).toISOString().slice(0, 10);
/** When every value given (leaving out empty cells) is a date: their day numbers, for MIN and MAX of dates. */
function onlyDates(args) {
  const vals = args.flat(Infinity).filter((v) => v !== null && v !== undefined && v !== '');
  if (!vals.length || vals.some((v) => typeof v !== 'string')) return null;
  const d = vals.map(dateSerial);
  return d.every((x) => x !== null) ? d : null;
}

// ---- date arithmetic: dates are kept as text ("2026-11-09", or "2026-11-09 14:30" with a time), and
// work like day numbers in + and -: a date plus 7 is a week later, one date minus another is the days between.
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/;
/** A date written as text, as a day number (with the time as a fraction), or null when it isn't one. */
export function dateSerial(v) {
  const m = typeof v === 'string' && DATE_RE.exec(v.trim());
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  return Number.isNaN(ms) ? null : (ms - EXCEL_EPOCH) / DAY_MS;
}
/** A day number back as a date ("2026-11-16"), with the time when it has one ("2026-11-09 14:30"). */
export function serialDate(n) {
  const ms = Math.round((n * DAY_MS + EXCEL_EPOCH) / 1000) * 1000;
  if (!Number.isFinite(ms) || n < -693593 || n > 2958465) err('#NUM!');
  const iso = new Date(ms).toISOString();
  const time = iso.slice(11, 19);
  return time === '00:00:00' ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${time.endsWith(':00') ? time.slice(0, 5) : time}`;
}
/** + and - when a date is involved: a date (date ± days), the days between (date − date), or null (not dates). */
function dateMath(op, l, r) {
  const a = dateSerial(l), b = dateSerial(r);
  if (a === null && b === null) return null;
  if (op === '+') { if (a !== null && b !== null) err('#VALUE!'); return serialDate((a ?? toNum(l)) + (b ?? toNum(r))); }
  if (a !== null && b !== null) return Math.round((a - b) * 1e9) / 1e9; // days between (a fraction with times)
  if (a !== null) return serialDate(a - toNum(r));
  return toNum(l) - b; // a number minus a date: just numbers
}
const roundTo = (v, d, how) => { const f = 10 ** toNum(d ?? 0); const x = toNum(v) * f; return how(Math.abs(x) + 1e-9 * (how === Math.floor ? 1 : -1)) * Math.sign(x) / f; };

// ---- helpers for statistics, TEXT, working days and loans
function variance(a, sample) {
  const n = nums(a);
  if (n.length < (sample ? 2 : 1)) err('#DIV/0!');
  const mean = n.reduce((s, x) => s + x, 0) / n.length;
  return n.reduce((s, x) => s + (x - mean) ** 2, 0) / (n.length - (sample ? 1 : 0));
}
/** Matching pairs of numbers from two ranges of the same size (cells empty or text in either are left out). */
function pairs(ys, xs) {
  const a = flat([ys]), b = flat([xs]);
  if (a.length !== b.length) err('#N/A');
  const out = [];
  for (let i = 0; i < a.length; i++) if (typeof a[i] === 'number' && typeof b[i] === 'number') out.push([a[i], b[i]]);
  return out;
}
/** Least-squares line through the pairs [y, x]: { slope, intercept, r }. */
function fitLine(ys, xs) {
  const p = pairs(ys, xs);
  if (p.length < 2) err('#DIV/0!');
  const my = p.reduce((s, [y]) => s + y, 0) / p.length, mx = p.reduce((s, [, x]) => s + x, 0) / p.length;
  let sxy = 0, sxx = 0, syy = 0;
  for (const [y, x] of p) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
  if (!sxx) err('#DIV/0!');
  return { slope: sxy / sxx, intercept: my - (sxy / sxx) * mx, r: syy ? sxy / Math.sqrt(sxx * syy) : NaN };
}
/** The k-th (0–1) point through the sorted numbers, between neighbours as Excel's PERCENTILE.INC does. */
function percentile(a, k) {
  const n = nums([a]).sort((x, y) => x - y), p = toNum(k);
  if (!n.length || p < 0 || p > 1) err('#NUM!');
  const at = p * (n.length - 1), lo = Math.floor(at);
  return lo + 1 < n.length ? n[lo] + (at - lo) * (n[lo + 1] - n[lo]) : n[lo];
}
const gcd2 = (a, b) => { a = Math.abs(a); b = Math.abs(b); while (b) [a, b] = [b, a % b]; return a; };
const whole = (v) => { const n = Math.trunc(toNum(v)); if (n < 0) err('#NUM!'); return n; };
const factorial = (n) => { if (n > 170) err('#NUM!'); let f = 1; for (let i = 2; i <= n; i++) f *= i; return f; };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** TEXT(value, format): number patterns (0, 0.00, #,##0, 0%, with text around them) and dates (yyyy mm dd mmm mmmm ddd dddd). */
function formatText(v, fmt) {
  const f = toStr(fmt);
  if (/[yd]|m{3,}/i.test(f.replace(/"[^"]*"/g, ''))) return formatDate(toDate(v), f);
  const m = /^([^0#]*?)([#0,]*0[#0,]*|#[#,]*)(?:\.(0+|#+))?([^0#]*)$/.exec(f);
  if (!m) return toStr(v);
  let n = toNum(v);
  const [, pre, int, dec = '', post] = m;
  if (post.includes('%')) n *= 100;
  const places = dec.length;
  let text = Math.abs(n).toFixed(places);
  if (dec.startsWith('#')) text = text.replace(/\.?0+$/, '');
  let [whole, frac] = text.split('.');
  const minDigits = (int.match(/0/g) || []).length;
  whole = whole.replace(/^0+(?=\d)/, '');
  if (whole === '0' && minDigits === 0) whole = '';
  whole = whole.padStart(minDigits, '0');
  if (int.includes(',')) whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${n < 0 && Number(text) !== 0 ? '-' : ''}${pre.replace(/"/g, '')}${whole}${frac !== undefined ? `.${frac}` : ''}${post.replace(/"/g, '')}`;
}
function formatDate(ms, f) {
  const d = new Date(ms);
  const Y = d.getUTCFullYear(), M = d.getUTCMonth(), D = d.getUTCDate(), W = d.getUTCDay();
  const two = (x) => String(x).padStart(2, '0');
  return f.replace(/"([^"]*)"|yyyy|yy|mmmm|mmm|mm|m|dddd|ddd|dd|d/gi, (t, lit) => {
    if (lit !== undefined) return lit;
    switch (t.toLowerCase()) {
      case 'yyyy': return String(Y);
      case 'yy': return two(Y % 100);
      case 'mmmm': return MONTHS[M];
      case 'mmm': return MONTHS[M].slice(0, 3);
      case 'mm': return two(M + 1);
      case 'm': return String(M + 1);
      case 'dddd': return WEEKDAYS[W];
      case 'ddd': return WEEKDAYS[W].slice(0, 3);
      case 'dd': return two(D);
      default: return String(D);
    }
  });
}
const holidaySet = (h) => new Set(h === undefined ? [] : flat([h]).filter((x) => x !== null && x !== '').map((x) => toDate(x)));
const isWorkday = (ms, hol, weekend = WEEKEND) => !weekend.has(new Date(ms).getUTCDay()) && !hol.has(ms);
const WEEKEND = new Set([0, 6]);
/**
 * The weekend days (0 Sunday … 6 Saturday) for NETWORKDAYS.INTL and WORKDAY.INTL: 1 Saturday and Sunday,
 * 2–7 the next pairs (Sunday–Monday … Friday–Saturday), 11–17 one day (Sunday … Saturday), or seven
 * 0s and 1s from Monday ("0000011" is Saturday and Sunday). Every day a weekend: #VALUE!.
 */
function weekendOf(v) {
  if (v === undefined || v === null || v === '') return WEEKEND;
  if (typeof v === 'string' && !/^\d+$/.test(v) || (typeof v === 'string' && v.length === 7)) {
    if (!/^[01]{7}$/.test(v) || v === '1111111') err('#VALUE!');
    return new Set([...v].flatMap((c, i) => (c === '1' ? [(i + 1) % 7] : [])));
  }
  const n = Math.trunc(toNum(v));
  if (n === 1) return WEEKEND;
  if (n >= 2 && n <= 7) return new Set([n - 2, n - 1]);
  if (n >= 11 && n <= 17) return new Set([n - 11]);
  return err('#NUM!');
}
/** Loan maths shared by PMT, PV and FV (type 1: payments at the start of each period). */
function pmt(rate, n, pv, fv, type) {
  if (!n) err('#NUM!');
  if (!rate) return -(pv + fv) / n;
  const g = (1 + rate) ** n;
  return -(rate * (fv + pv * g)) / ((1 + rate * type) * (g - 1));
}

/** A grid of values (rows of cells) as a range-shaped array. */
function grid(rows) {
  const out = rows.flat();
  out.rows = rows.length;
  out.cols = rows[0]?.length ?? 0;
  return out;
}
const rowsOf = (a) => { const s = shapeOf(a); return Array.from({ length: s.rows }, (_, r) => Array.from({ length: s.cols }, (_, c) => s.at(r, c) ?? null)); };
/** Sort order for SORT: numbers, then text (any case), then TRUE/FALSE, then blanks. */
function order(a, b) {
  const rank = (v) => (v === null || v === undefined || v === '' ? 3 : typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : 2);
  const ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return a - b;
  if (ra === 1) return a.toLowerCase().localeCompare(b.toLowerCase());
  return Number(a) - Number(b);
}
/** Functions that give back several cells, which spill into the cells beside and below. */
const ARRAY_FUNCS = new Set(['OFFSET', 'INDIRECT', 'TEXTSPLIT', 'CHOOSECOLS', 'CHOOSEROWS', 'WRAPROWS', 'WRAPCOLS', 'TOCOL', 'TOROW', 'FLATTEN', 'SORTBY', 'FREQUENCY', 'RANDARRAY', 'EXPAND', 'FILTER', 'UNIQUE', 'SORT', 'SEQUENCE', 'TRANSPOSE', 'IMPORTRANGE', 'IMPORTDATA', 'IMPORTHTML', 'IMPORTFEED', 'QUERY', 'XLOOKUP', 'SPLIT', 'GROUPBY', 'PIVOTBY', 'TRIMRANGE', 'VSTACK', 'HSTACK', 'TAKE', 'DROP', 'CHOOSE', 'REGEXEXTRACT', 'LET', 'MAP', 'BYROW', 'BYCOL', 'MAKEARRAY', 'REDUCE', 'SCAN', 'ARRAYFORMULA', 'MMULT', 'SORTN', 'TREND', 'GROWTH', 'LINEST', 'LOGEST']);

// ---- helpers for regular expressions, times and cash flows
/** A pattern from a formula (RE2-like: no lookbehind needed); a bad one, or one too long, is #VALUE!. */
function regex(pattern, flags = '') {
  const src = toStr(pattern);
  if (src.length > 500) err('#VALUE!');
  try { return new RegExp(src, flags); } catch { return err('#VALUE!'); }
}
const MAX_REGEX_TEXT = 50000;
/** The time of day as a fraction of a day: from a number (its fraction), "14:30", "2:30 PM", "2026-11-08 14:30:15". */
function dayFraction(v) {
  if (typeof v === 'number') return v - Math.floor(v);
  const m = /(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?\s*$/i.exec(toStr(v).trim());
  if (!m) { if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(toStr(v).trim())) return 0; return err('#VALUE!'); }
  let h = +m[1];
  if (m[4]) { if (h > 12) err('#VALUE!'); h = (h % 12) + (m[4].toLowerCase() === 'pm' ? 12 : 0); }
  if (h > 23 || +m[2] > 59 || +(m[3] || 0) > 59) err('#VALUE!');
  return (h * 3600 + +m[2] * 60 + +(m[3] || 0)) / 86400;
}
const secondsOf = (v) => Math.round(dayFraction(v) * 86400) % 86400;
/** Present value of cash flows at a rate, the first one period from now (as NPV does). */
const npv = (rate, flows) => flows.reduce((s, x, i) => s + x / (1 + rate) ** (i + 1), 0);
/** Solve f(x) = 0 near a guess (Newton's method, with a numerical slope); #NUM! when it doesn't settle. */
function solve(f, guess) {
  let x = guess;
  for (let i = 0; i < 100; i++) {
    const y = f(x);
    if (!Number.isFinite(y)) break;
    if (Math.abs(y) < 1e-10) return x;
    const h = 1e-7 * Math.max(1, Math.abs(x));
    const slope = (f(x + h) - y) / h;
    if (!slope || !Number.isFinite(slope)) break;
    const next = x - y / slope;
    if (Math.abs(next - x) < 1e-12) return next;
    x = next;
    if (x <= -1) x = -0.999999;
  }
  return err('#NUM!');
}
/** Several ranges (or values) put together above one another (VSTACK) or side by side (HSTACK); gaps are #N/A. */
function stack(arrays, across) {
  const parts = arrays.filter((a) => a !== undefined).map(rowsOf);
  if (!parts.length) err('#VALUE!');
  if (!across) {
    const cols = Math.max(...parts.map((p) => p[0]?.length || 0));
    return grid(parts.flatMap((p) => p.map((row) => [...row, ...Array(cols - row.length).fill('#N/A')])));
  }
  const rows = Math.max(...parts.map((p) => p.length));
  return grid(Array.from({ length: rows }, (_, r) => parts.flatMap((p) => p[r] || Array(p[0]?.length || 0).fill('#N/A'))));
}

// ---- helpers for reshaping arrays and for numbers in other bases
const given = (v) => v !== undefined && v !== null;
/** What a LAMBDA's parameter holds when it isn't given (ISOMITTED is TRUE for it; it reads as an empty cell). */
const OMITTED = Symbol('omitted');
/** For securities: settlement and maturity (as days), the fraction of a year between them by the day count, and the days. */
function securityTerm(settlement, maturity, basis) {
  const s = Math.floor(dateMs(settlement) / DAY_MS), m = Math.floor(dateMs(maturity) / DAY_MS), b = given(basis) && basis !== '' ? Math.trunc(toNum(basis)) : 0;
  if (s >= m || b < 0 || b > 4) err('#NUM!');
  return { years: yearFrac(s * DAY_MS, m * DAY_MS, b), days: m - s };
}
/**
 * A bond paying coupons `frequency` times a year (1, 2 or 4) up to maturity: the coupon dates around settlement
 * (stepping back from maturity, last days of months kept as such), how many are left, and the days of the period
 * by the day count (as Excel works them out).
 */
function coupons(settlement, maturity, frequency, basis) {
  const s = Math.floor(dateMs(settlement) / DAY_MS) * DAY_MS, m = Math.floor(dateMs(maturity) / DAY_MS) * DAY_MS;
  const f = Math.trunc(toNum(frequency)), b = given(basis) && basis !== '' ? Math.trunc(toNum(basis)) : 0;
  if (s >= m || ![1, 2, 4].includes(f) || b < 0 || b > 4) err('#NUM!');
  const md = new Date(m), y = md.getUTCFullYear(), mo = md.getUTCMonth(), d = md.getUTCDate();
  const lastDay = (yy, mm) => new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
  const eom = d === lastDay(y, mo);
  const back = (k) => { const t = mo - (k * 12) / f, yy = y + Math.floor(t / 12), mm = ((t % 12) + 12) % 12; return Date.UTC(yy, mm, eom ? lastDay(yy, mm) : Math.min(d, lastDay(yy, mm))); };
  let k = 1;
  while (back(k) > s) k++;
  const pcd = back(k), ncd = back(k - 1), days30 = (a, z) => Math.round(yearFrac(a, z, b) * 360);
  const periodDays = b === 1 ? Math.round((ncd - pcd) / DAY_MS) : b === 3 ? 365 / f : 360 / f;
  const sinceLast = b === 0 || b === 4 ? days30(pcd, s) : Math.round((s - pcd) / DAY_MS);
  const toNext = b === 0 || b === 4 ? periodDays - sinceLast : Math.round((ncd - s) / DAY_MS);
  return { f, b, pcd, ncd, count: k, periodDays, sinceLast, toNext };
}
/** A bond's price per 100 from its yield (Excel's PRICE). */
function bondPrice(c, rate, yld, redemption) {
  const coupon = (100 * rate) / c.f, frac = c.toNext / c.periodDays, accrued = coupon * (c.sinceLast / c.periodDays);
  if (c.count === 1) return (redemption + coupon) / (1 + frac * (yld / c.f)) - accrued;
  let p = redemption / (1 + yld / c.f) ** (c.count - 1 + frac);
  for (let k = 1; k <= c.count; k++) p += coupon / (1 + yld / c.f) ** (k - 1 + frac);
  return p - accrued;
}
/** Macaulay duration in years. */
function bondDuration(c, rate, yld) {
  const coupon = (100 * rate) / c.f, frac = c.toNext / c.periodDays;
  let pv = 0, weighted = 0;
  for (let k = 1; k <= c.count; k++) {
    const t = k - 1 + frac, cash = coupon + (k === c.count ? 100 : 0), v = cash / (1 + yld / c.f) ** t;
    pv += v; weighted += t * v;
  }
  return weighted / pv / c.f;
}
/** Days from a to z by the day count, and the days of its year (for PRICEMAT and YIELDMAT). */
const dayCount = (a, z, b) => (b === 0 || b === 4 ? Math.round(yearFrac(a, z, b) * 360) : Math.round((z - a) / DAY_MS));
const yearDays = (b, y) => (b === 3 ? 365 : b === 1 ? (isLeapYear(y) ? 366 : 365) : 360);
const isLeapYear = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
function maturityTerms(settlement, maturity, issue, basis) {
  const s = Math.floor(dateMs(settlement) / DAY_MS) * DAY_MS, m = Math.floor(dateMs(maturity) / DAY_MS) * DAY_MS, i = Math.floor(dateMs(issue) / DAY_MS) * DAY_MS;
  const b = given(basis) && basis !== '' ? Math.trunc(toNum(basis)) : 0;
  if (s >= m || i > s || b < 0 || b > 4) err('#NUM!');
  const B = yearDays(b, new Date(s).getUTCFullYear());
  return { dim: dayCount(i, m, b) / B, a: dayCount(i, s, b) / B, dsm: dayCount(s, m, b) / B };
}
// ---- Bessel functions of whole orders, from their integral forms (accurate to about 1e-12)
/** Simpson's rule over [a, b] with n (even) steps. */
function simpson(f, a, b, n) {
  const h = (b - a) / n;
  let s = f(a) + f(b);
  for (let i = 1; i < n; i++) s += (i % 2 ? 4 : 2) * f(a + i * h);
  return (s * h) / 3;
}
/** J_n(x) = 1/π ∫₀^π cos(nτ − x sin τ) dτ (periodic, so the trapezoid rule is very accurate). */
function besselJ(x, n) {
  const m = 2 * Math.ceil(Math.abs(x) + n + 40);
  let s = 0;
  for (let i = 0; i < m; i++) { const t = (2 * Math.PI * i) / m; s += Math.cos(n * t - x * Math.sin(t)); }
  return s / m;
}
/** I_n(x) = Σ (x/2)^(2k+n) / (k! (k+n)!). */
function besselI(x, n) {
  let term = (x / 2) ** n / Math.exp(lnGamma(n + 1)), s = term;
  for (let k = 1; k < 500 && Math.abs(term) > 1e-17 * Math.abs(s); k++) { term *= (x * x) / 4 / (k * (k + n)); s += term; }
  return s;
}
/** K_n(x) = ∫₀^∞ e^(−x cosh t) cosh(nt) dt, x > 0. */
function besselK(x, n) {
  let end = 1;
  while (x * Math.cosh(end) - n * end < 750) end += 1;
  return simpson((t) => Math.exp(-x * Math.cosh(t) + n * t) / 2 + Math.exp(-x * Math.cosh(t) - n * t) / 2, 0, end, 4000);
}
/** Y_n(x) = 1/π ∫₀^π sin(x sin θ − nθ) dθ − 1/π ∫₀^∞ (e^(nt) + (−1)^n e^(−nt)) e^(−x sinh t) dt, x > 0. */
function besselY(x, n) {
  const first = simpson((t) => Math.sin(x * Math.sin(t) - n * t), 0, Math.PI, 4000 + 2 * Math.ceil(x));
  let end = 1;
  while (x * Math.sinh(end) - n * end < 750) end += 1;
  const sign = n % 2 ? -1 : 1;
  const second = simpson((t) => Math.exp(n * t - x * Math.sinh(t)) + sign * Math.exp(-n * t - x * Math.sinh(t)), 0, end, 8000);
  return (first - second) / Math.PI;
}
/** A Bessel function's x and whole order n (n ≥ 0; x > 0 when it must be). */
const besselArgs = (x, n, positiveX) => {
  const v = toNum(x), k = Math.trunc(toNum(n));
  if (k < 0 || (positiveX && v <= 0)) err('#NUM!');
  return [v, k];
};
const positiveNum = (v) => { const x = toNum(v); if (x <= 0) err('#NUM!'); return x; };
/** Treasury bills: days to maturity (a year at most). */
const tbillDays = (settlement, maturity) => { const { days } = securityTerm(settlement, maturity, 0); if (days > 366) err('#NUM!'); return days; };

// ---- complex numbers, written as Excel writes them: "3+4i", "-2.5j", "i", "7"
const NUM_RE = String.raw`(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?`;
const COMPLEX_RE = new RegExp(`^([+-]?${NUM_RE})?(?:([+-])(${NUM_RE})?([ij]))?$|^([+-]?)(${NUM_RE})?([ij])$`);
/** A complex number from text or a number: { re, im, suffix } (#NUM! when it isn't one). */
function complexOf(v) {
  if (typeof v === 'number') return { re: v, im: 0, suffix: null };
  if (typeof v === 'boolean') err('#VALUE!');
  const t = toStr(v).trim();
  if (t === '') return { re: 0, im: 0, suffix: null };
  const m = COMPLEX_RE.exec(t);
  if (!m) err('#NUM!');
  if (m[7]) return { re: 0, im: (m[5] === '-' ? -1 : 1) * (m[6] ? Number(m[6]) : 1), suffix: m[7] }; // only an imaginary part
  if (m[1] === undefined && !m[4]) err('#NUM!');
  return { re: m[1] !== undefined ? Number(m[1]) : 0, im: m[4] ? (m[2] === '-' ? -1 : 1) * (m[3] ? Number(m[3]) : 1) : 0, suffix: m[4] || null };
}
const complexNum = (x) => { const r = Number(x.toPrecision(15)); return (Object.is(r, -0) ? 0 : r).toString().toUpperCase(); };
/** Back as text, as Excel shows it ("8+i", "-4i", "1.5"). */
function complexText(re, im, suffix = 'i') {
  if (!Number.isFinite(re) || !Number.isFinite(im)) err('#NUM!');
  const r = Number(re.toPrecision(15)), i = Number(im.toPrecision(15));
  if (!i) return complexNum(r);
  const imag = `${i === 1 ? '' : i === -1 ? '-' : complexNum(i)}${suffix || 'i'}`;
  return r ? `${complexNum(r)}${i > 0 ? '+' : ''}${imag}` : imag;
}
/** The suffix the result takes: the arguments' (#VALUE! when they mix i and j). */
function suffixOf(zs) {
  const s = [...new Set(zs.map((z) => z.suffix).filter(Boolean))];
  if (s.length > 1) err('#VALUE!');
  return s[0] || 'i';
}
const complexFn = (f) => ([z]) => { const c = complexOf(scalarOf(z)); const [re, im] = f(c); return complexText(re, im, c.suffix); };
const cAbs = (c) => Math.hypot(c.re, c.im);
const cLn = (c) => { if (!c.re && !c.im) err('#NUM!'); return [Math.log(cAbs(c)), Math.atan2(c.im, c.re)]; };
const isErrorText = (v) => typeof v === 'string' && /^#(N\/A|NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|CALC!|SPILL!)$/.test(v);
const MAX_CELLS = 10000;
const MAX_REF_CELLS = 100000; // the most cells OFFSET or INDIRECT can point at
/** Picks rows (or columns) by number, 1 the first, -1 the last; out of range is #VALUE!. */
function pick(list, which) {
  const n = list.length;
  return flat(which).map((w) => { const i = Math.trunc(toNum(w)); if (!i || Math.abs(i) > n) err('#VALUE!'); return list[i > 0 ? i - 1 : n + i]; });
}
/** A list of values cut into rows (or columns) of `count`, the last padded (#N/A unless given). */
function wrap(vector, count, pad, byCols) {
  const s = shapeOf(vector);
  if (s.rows > 1 && s.cols > 1) err('#VALUE!');
  const vals = flat([vector]);
  const k = Math.trunc(toNum(count));
  if (k < 1) err('#NUM!');
  const lines = [];
  for (let i = 0; i < vals.length; i += k) { const line = vals.slice(i, i + k); while (line.length < k) line.push(given(pad) ? pad : '#N/A'); lines.push(line); }
  if (!lines.length) err('#VALUE!');
  return grid(byCols ? lines[0].map((_, c) => lines.map((l) => l[c])) : lines);
}
/** All of an array's values in one line, row by row (or column by column), leaving out blanks (1), errors (2) or both (3). */
function line(array, ignore, byCol) {
  const rows = rowsOf(array);
  const vals = byCol ? (rows[0] || []).flatMap((_, c) => rows.map((r) => r[c])) : rows.flat();
  const how = Math.trunc(toNum(ignore ?? 0));
  if (how < 0 || how > 3) err('#VALUE!');
  const out = vals.filter((v) => !((how & 1) && (v === null || v === undefined || v === '')) && !((how & 2) && isErrorText(v)));
  if (!out.length) err('#CALC!');
  return out;
}
/** Where a delimiter (or any of several) is found in text, from the start or (instance < 0) the end. */
function findDelim(text, delims, instance, anyCase) {
  const ds = flat([delims]).map(toStr);
  if (!ds.length || ds.some((d) => d === '')) err('#VALUE!');
  const hay = anyCase ? text.toLowerCase() : text;
  const hits = [];
  for (let i = 0; i < text.length;) {
    const d = ds.find((x) => hay.startsWith(anyCase ? x.toLowerCase() : x, i));
    if (d) { hits.push([i, d.length]); i += d.length; } else i++;
  }
  const n = Math.trunc(toNum(instance ?? 1));
  if (!n || Math.abs(n) > text.length) err('#VALUE!');
  return (n > 0 ? hits[n - 1] : hits[hits.length + n]) || null;
}
/** Text split on any of several delimiters (exact, or ignoring case). */
function splitOn(text, delims, anyCase) {
  const ds = flat([delims]).map(toStr);
  if (!ds.length || ds.some((d) => d === '')) err('#VALUE!');
  const hay = anyCase ? text.toLowerCase() : text, needles = anyCase ? ds.map((d) => d.toLowerCase()) : ds;
  const out = [];
  let from = 0;
  for (let i = 0; i < text.length;) {
    const d = needles.find((x) => hay.startsWith(x, i));
    if (d) { out.push(text.slice(from, i)); i += d.length; from = i; } else i++;
  }
  out.push(text.slice(from));
  return out;
}
const asNumber = (x) => (x !== '' && /^\s*-?\d+(\.\d+)?(e[+-]?\d+)?\s*$/i.test(x) ? Number(x) : x);
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** A whole number written in another base (2 to 36), at least `places` digits; negative numbers as 10-digit two's complement (as Excel's DEC2BIN etc.). */
function toBase(v, radix, places, signedDigits = 0) {
  let n = Math.trunc(toNum(v));
  if (n < 0) {
    if (!signedDigits) err('#NUM!');
    const span = radix ** signedDigits;
    if (n < -span / 2) err('#NUM!');
    n += span;
  } else if (signedDigits && n >= radix ** signedDigits / 2) err('#NUM!');
  if (n > Number.MAX_SAFE_INTEGER) err('#NUM!');
  const out = n.toString(radix).toUpperCase();
  if (!given(places)) return out;
  const p = Math.trunc(toNum(places));
  if (p < out.length || p > 255) err('#NUM!');
  return out.padStart(p, '0');
}
/** A number written in another base, back to a number; 10-digit values with the top digit set are negative (two's complement). */
function fromBase(v, radix, signedDigits = 0) {
  const t = toStr(v).trim().toUpperCase();
  if (!t || t.length > (signedDigits || 255) || [...t].some((ch) => { const d = DIGITS.indexOf(ch); return d < 0 || d >= radix; })) err('#NUM!');
  const n = parseInt(t, radix);
  return signedDigits && t.length === signedDigits && n >= radix ** signedDigits / 2 ? n - radix ** signedDigits : n;
}
const ROMAN = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
const xnpv = (rate, flows, days) => flows.reduce((s, x, i) => s + x / (1 + rate) ** ((days[i] - days[0]) / 365), 0);

/** Σ f(x, y) over two ranges of the same size (cells not numbers in either are left out). */
function sumPairs(a, b, f) {
  const x = flat([a]), y = flat([b]);
  if (x.length !== y.length) err('#N/A');
  let s = 0;
  for (let i = 0; i < x.length; i++) if (typeof x[i] === 'number' && typeof y[i] === 'number') s += f(x[i], y[i]);
  return s;
}
function shiftBits(a, by) {
  const x = toNum(a);
  if (x < 0 || !Number.isInteger(x) || x >= 2 ** 48 || !Number.isInteger(by) || Math.abs(by) > 53) err('#NUM!');
  const r = by >= 0 ? BigInt(x) << BigInt(by) : BigInt(x) >> BigInt(-by);
  if (r >= 2n ** 48n) err('#NUM!');
  return Number(r);
}
const bits = (a, b, f) => { const x = toNum(a), y = toNum(b); if (x < 0 || y < 0 || !Number.isInteger(x) || !Number.isInteger(y) || x >= 2 ** 48 || y >= 2 ** 48) err('#NUM!'); return Number(f(BigInt(x), BigInt(y))); };
/** The error function (Abramowitz and Stegun 7.1.26 is too rough: by the incomplete gamma function instead). */
const erf = (x) => (x < 0 ? -gammaP(0.5, x * x) : gammaP(0.5, x * x));

const FUNCS = {
  // Text before or after a delimiter (the nth one, or counting from the end when negative), and text cut into a grid.
  TEXTBEFORE: ([text, delim, instance, mode, , ifNotFound]) => {
    const t = toStr(scalarOf(text));
    const hit = findDelim(t, delim, instance, toNum(mode ?? 0) === 1);
    if (!hit) return given(ifNotFound) ? ifNotFound : notFound();
    return t.slice(0, hit[0]);
  },
  TEXTAFTER: ([text, delim, instance, mode, , ifNotFound]) => {
    const t = toStr(scalarOf(text));
    const hit = findDelim(t, delim, instance, toNum(mode ?? 0) === 1);
    if (!hit) return given(ifNotFound) ? ifNotFound : notFound();
    return t.slice(hit[0] + hit[1]);
  },
  TEXTSPLIT: ([text, colDelim, rowDelim, ignoreEmpty, mode, pad]) => {
    const t = toStr(scalarOf(text)), anyCase = toNum(mode ?? 0) === 1, skip = given(ignoreEmpty) && toBool(ignoreEmpty);
    if (!given(colDelim) && !given(rowDelim)) err('#VALUE!');
    let rows = given(rowDelim) ? splitOn(t, rowDelim, anyCase) : [t];
    if (skip) rows = rows.filter((r) => r !== '');
    let cells = rows.map((r) => (given(colDelim) ? splitOn(r, colDelim, anyCase) : [r]));
    if (skip) cells = cells.map((r) => r.filter((x) => x !== ''));
    cells = cells.filter((r) => r.length);
    if (!cells.length) err('#CALC!');
    const width = Math.max(...cells.map((r) => r.length));
    if (width * cells.length > MAX_CELLS) err('#NUM!');
    return grid(cells.map((r) => [...r.map(asNumber), ...Array(width - r.length).fill(given(pad) ? pad : '#N/A')]));
  },
  // Reshaping: chosen columns or rows, a list wrapped into rows or columns, everything in one column or row.
  CHOOSECOLS: ([array, ...cols]) => {
    if (!cols.length) err('#VALUE!');
    const rows = rowsOf(array);
    const idx = pick(rows[0].map((_, c) => c), cols);
    return grid(rows.map((r) => idx.map((c) => r[c])));
  },
  CHOOSEROWS: ([array, ...rows]) => { if (!rows.length) err('#VALUE!'); return grid(pick(rowsOf(array), rows)); },
  WRAPROWS: ([vector, count, pad]) => wrap(vector, count, pad, false),
  WRAPCOLS: ([vector, count, pad]) => wrap(vector, count, pad, true),
  TOCOL: ([array, ignore, byCol]) => grid(line(array, ignore, given(byCol) && toBool(byCol)).map((v) => [v])),
  TOROW: ([array, ignore, byCol]) => grid([line(array, ignore, given(byCol) && toBool(byCol))]),
  FLATTEN: (arrays) => grid(arrays.filter((a) => a !== undefined).flatMap((a) => rowsOf(a).flat()).map((v) => [v])),
  EXPAND: ([array, rows, cols, pad]) => {
    const g = rowsOf(array);
    const r = given(rows) ? Math.trunc(toNum(rows)) : g.length, c = given(cols) ? Math.trunc(toNum(cols)) : g[0].length;
    if (r < g.length || c < g[0].length) err('#VALUE!');
    if (r * c > MAX_CELLS) err('#NUM!');
    const fill = given(pad) ? pad : '#N/A';
    return grid(Array.from({ length: r }, (_, i) => Array.from({ length: c }, (_, j) => (i < g.length && j < g[0].length ? g[i][j] : fill))));
  },
  // SORTBY(names, scores, -1): rows in the order of other ranges (each with 1 up, -1 down), ties keeping their order.
  SORTBY: ([array, ...pairs]) => {
    const rows = rowsOf(array);
    if (!pairs.length) err('#VALUE!');
    const keys = [];
    for (let i = 0; i < pairs.length; i += 2) {
      const by = flat([pairs[i]]);
      if (by.length !== rows.length) err('#VALUE!');
      const dir = given(pairs[i + 1]) ? toNum(pairs[i + 1]) : 1;
      if (dir !== 1 && dir !== -1) err('#VALUE!');
      keys.push([by, dir]);
    }
    return grid(rows.map((row, i) => i).sort((a, b) => { for (const [by, dir] of keys) { const o = order(by[a], by[b]); if (o) return dir * o; } return a - b; }).map((i) => rows[i]));
  },
  // FREQUENCY(scores, bins): how many values fall up to each bin (above the last one at the end); spills down.
  FREQUENCY: ([data, bins]) => {
    const d = nums([data]), b = nums([bins]);
    const sorted = b.map((x, i) => [x, i]).sort((x, y) => x[0] - y[0]);
    const counts = Array(b.length + 1).fill(0);
    for (const x of d) { const at = sorted.find(([bin]) => x <= bin); counts[at ? at[1] : b.length] += 1; }
    return grid(counts.map((n) => [n]));
  },
  RANDARRAY: ([rows, cols, min, max, whole]) => {
    const r = given(rows) ? Math.trunc(toNum(rows)) : 1, c = given(cols) ? Math.trunc(toNum(cols)) : 1;
    const lo = given(min) ? toNum(min) : 0, hi = given(max) ? toNum(max) : 1, ints = given(whole) && toBool(whole);
    if (r < 1 || c < 1 || hi < lo) err('#VALUE!');
    if (r * c > MAX_CELLS) err('#NUM!');
    const one = () => (ints ? Math.ceil(lo) + Math.floor(Math.random() * (Math.floor(hi) - Math.ceil(lo) + 1)) : lo + Math.random() * (hi - lo));
    return grid(Array.from({ length: r }, () => Array.from({ length: c }, one)));
  },
  // Numbers in other bases, Roman numerals and characters by their code.
  BASE: ([v, radix, places]) => { const r = Math.trunc(toNum(radix)); if (r < 2 || r > 36 || toNum(v) < 0) err('#NUM!'); return toBase(v, r, places); },
  DEC2BIN: ([v, places]) => { if (toNum(v) < -512 || toNum(v) > 511) err('#NUM!'); return toBase(v, 2, places, 10); },
  DEC2OCT: ([v, places]) => toBase(v, 8, places, 10),
  DEC2HEX: ([v, places]) => toBase(v, 16, places, 10),
  BIN2DEC: ([v]) => fromBase(v, 2, 10),
  OCT2DEC: ([v]) => fromBase(v, 8, 10),
  HEX2DEC: ([v]) => fromBase(v, 16, 10),
  ROMAN: ([v]) => {
    let n = Math.trunc(toNum(v));
    if (n < 0 || n > 3999) err('#VALUE!');
    let out = '';
    for (const [k, sym] of ROMAN) while (n >= k) { out += sym; n -= k; }
    return out;
  },
  UNICODE: ([v]) => { const t = toStr(scalarOf(v)); if (!t) err('#VALUE!'); return t.codePointAt(0); },
  UNICHAR: ([v]) => { const n = Math.trunc(toNum(v)); if (n < 1 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) err('#VALUE!'); return String.fromCodePoint(n); },
  PERMUT: ([n, k]) => { const a = Math.trunc(toNum(n)), b = Math.trunc(toNum(k)); if (a < 0 || b < 0 || b > a) err('#NUM!'); let p = 1; for (let i = 0; i < b; i++) p *= a - i; return p; },
  // Cash flows on their own dates: XNPV and XIRR (a year of 365 days from the first date).
  XNPV: ([rate, values, dates]) => {
    const f = flat([values]), d = flat([dates]);
    if (!f.length || f.length !== d.length) err('#NUM!');
    return xnpv(toNum(rate), f.map(toNum), d.map((x) => toDate(x) / DAY_MS));
  },
  XIRR: ([values, dates, guess]) => {
    const f = flat([values]).map(toNum), d = flat([dates]).map((x) => toDate(x) / DAY_MS);
    if (f.length < 2 || f.length !== d.length || !f.some((x) => x > 0) || !f.some((x) => x < 0)) err('#NUM!');
    return solve((r) => xnpv(r, f, d), given(guess) ? toNum(guess) : 0.1);
  },
  FILTER: ([array, include, ifEmpty]) => {
    const rows = rowsOf(array), inc = shapeOf(include);
    let out;
    if (inc.cols === 1 && inc.rows === rows.length) out = rows.filter((_, r) => toBool(inc.at(r, 0)));
    else if (inc.rows === 1 && inc.cols === (rows[0]?.length ?? 0)) { const keep = rows[0].map((_, c) => toBool(inc.at(0, c))); out = rows.map((row) => row.filter((_, c) => keep[c])); if (!out[0]?.length) out = []; }
    else err('#VALUE!');
    if (!out.length) return ifEmpty === undefined ? err('#CALC!') : ifEmpty;
    return grid(out);
  },
  UNIQUE: ([array]) => {
    const seen = new Set();
    const out = rowsOf(array).filter((row) => { const k = JSON.stringify(row.map((v) => (typeof v === 'string' ? v.toLowerCase() : v))); if (seen.has(k)) return false; seen.add(k); return true; });
    return grid(out);
  },
  SORT: ([array, by, dir]) => {
    const rows = rowsOf(array);
    const c = by === undefined || by === null ? 0 : Math.trunc(toNum(by)) - 1;
    if (c < 0 || c >= (rows[0]?.length ?? 0)) err('#VALUE!');
    const sign = dir === undefined || dir === null || toNum(dir) >= 0 ? 1 : -1;
    return grid(rows.map((row, i) => [row, i]).sort((a, b) => sign * order(a[0][c], b[0][c]) || a[1] - b[1]).map(([row]) => row));
  },
  SEQUENCE: ([rows, cols, start, step]) => {
    const r = Math.trunc(toNum(rows)), c = cols === undefined || cols === null ? 1 : Math.trunc(toNum(cols));
    if (r < 1 || c < 1) err('#VALUE!');
    if (r * c > 10000) err('#NUM!');
    const s0 = start === undefined || start === null ? 1 : toNum(start), st = step === undefined || step === null ? 1 : toNum(step);
    return grid(Array.from({ length: r }, (_, i) => Array.from({ length: c }, (_, j) => s0 + (i * c + j) * st)));
  },
  TRANSPOSE: ([array]) => {
    const rows = rowsOf(array);
    return grid((rows[0] || []).map((_, c) => rows.map((row) => row[c])));
  },
  SUM: (a) => nums(a).reduce((s, n) => s + n, 0),
  AVERAGE: (a) => { const n = nums(a); if (!n.length) err('#DIV/0!'); return n.reduce((s, x) => s + x, 0) / n.length; },
  MIN: (a) => { const d = onlyDates(a); if (d) return serialDate(Math.min(...d)); const n = nums(a); return n.length ? Math.min(...n) : 0; },
  MAX: (a) => { const d = onlyDates(a); if (d) return serialDate(Math.max(...d)); const n = nums(a); return n.length ? Math.max(...n) : 0; },
  MEDIAN: (a) => {
    const n = nums(a).sort((x, y) => x - y);
    if (!n.length) err('#NUM!');
    const m = n.length >> 1;
    return n.length % 2 ? n[m] : (n[m - 1] + n[m]) / 2;
  },
  COUNT: (a) => nums(a).length,
  COUNTA: (a) => flat(a).filter((v) => v !== null && v !== '').length,
  COUNTIF: ([range, c]) => flat([range]).filter(criteria(c)).length,
  SUMIF: ([range, c, sumRange]) => {
    const r = flat([range]); const s = sumRange ? flat([sumRange]) : r; const test = criteria(c);
    return r.reduce((acc, v, i) => (test(v) && typeof s[i] === 'number' ? acc + s[i] : acc), 0);
  },
  ROUND: ([v, d]) => { const f = 10 ** toNum(d ?? 0); return Math.round(toNum(v) * f) / f; },
  ABS: ([v]) => Math.abs(toNum(v)),
  SQRT: ([v]) => { const n = toNum(v); if (n < 0) err('#NUM!'); return Math.sqrt(n); },
  POWER: ([a, b]) => toNum(a) ** toNum(b),
  MOD: ([a, b]) => { const d = toNum(b); if (!d) err('#DIV/0!'); return toNum(a) - d * Math.floor(toNum(a) / d); },
  INT: ([v]) => Math.floor(toNum(v)),
  CONCAT: (a) => flat(a).map(toStr).join(''),
  CONCATENATE: (a) => flat(a).map(toStr).join(''),
  LEN: ([v]) => toStr(v).length,
  UPPER: ([v]) => toStr(v).toUpperCase(),
  LOWER: ([v]) => toStr(v).toLowerCase(),
  TRIM: ([v]) => toStr(v).trim().replace(/\s+/g, ' '),
  LEFT: ([v, n]) => toStr(v).slice(0, toNum(n ?? 1)),
  RIGHT: ([v, n]) => { const s = toStr(v); return s.slice(Math.max(0, s.length - toNum(n ?? 1))); },
  AND: (a) => flat(a).every(toBool),
  OR: (a) => flat(a).some(toBool),
  NOT: ([v]) => !toBool(v),
  // Text by pattern (regular expressions, as in other spreadsheets).
  // Excel's REGEXTEST(text, pattern, [case_sensitivity]): 0 (the default) minds case, 1 doesn't.
  REGEXTEST: ([text, pattern, cs]) => {
    const t = toStr(scalarOf(text)), mode = given(cs) ? Math.trunc(toNum(cs)) : 0;
    if (t.length > MAX_REGEX_TEXT || (mode !== 0 && mode !== 1)) err('#VALUE!');
    return regex(scalarOf(pattern), mode ? 'i' : '').test(t);
  },
  // PERCENTOF(part, all): the share the part's sum is of the whole's (=PERCENTOF(B2, B2:B9)).
  PERCENTOF: ([part, all]) => { const whole = nums([all]).reduce((s, x) => s + x, 0); if (!whole) err('#DIV/0!'); return nums([part]).reduce((s, x) => s + x, 0) / whole; },
  REGEXMATCH: ([text, pattern]) => { const t = toStr(scalarOf(text)); if (t.length > MAX_REGEX_TEXT) err('#VALUE!'); return regex(scalarOf(pattern)).test(t); },
  REGEXEXTRACT: ([text, pattern]) => {
    const t = toStr(scalarOf(text));
    if (t.length > MAX_REGEX_TEXT) err('#VALUE!');
    const m = regex(scalarOf(pattern)).exec(t);
    if (!m) return err('#N/A');
    if (m.length <= 2) return m[1] ?? m[0];
    return grid([m.slice(1).map((x) => x ?? '')]); // several groups: side by side
  },
  REGEXREPLACE: ([text, pattern, replacement]) => { const t = toStr(scalarOf(text)); if (t.length > MAX_REGEX_TEXT) err('#VALUE!'); return t.replace(regex(scalarOf(pattern), 'g'), toStr(scalarOf(replacement))); },
  // SPLIT("a,b;c", ",;"): each character of the delimiter splits (or the whole of it, with FALSE); empty bits dropped unless asked.
  SPLIT: ([text, delim, eachChar, removeEmpty]) => {
    const t = toStr(scalarOf(text)), d = toStr(scalarOf(delim));
    if (!d) err('#VALUE!');
    const byChar = eachChar === undefined || toBool(eachChar);
    let parts = byChar ? t.split(new RegExp(`[${d.replace(/[\]\\^-]/g, '\\$&')}]`)) : t.split(d);
    if (removeEmpty === undefined || toBool(removeEmpty)) parts = parts.filter((x) => x !== '');
    return grid([(parts.length ? parts : ['']).map((x) => (x !== '' && !Number.isNaN(Number(x)) && /^\s*-?[\d.]+(e[+-]?\d+)?\s*$/i.test(x) ? Number(x) : x))]);
  },
  JOIN: ([sep, ...a]) => flat(a).map(toStr).join(toStr(sep)),
  CLEAN: ([t]) => toStr(t).replace(/[\u0000-\u001f]/g, ''),
  // DOLLAR(value, [places]): as money text, $1,234.57 (negative in brackets, as spreadsheets show it); places below 0 round to tens, hundreds…
  DOLLAR: ([v, places]) => {
    const d = places === undefined ? 2 : Math.trunc(toNum(places));
    const n = roundTo(toNum(v), d, Math.round);
    const [w, f] = Math.abs(n).toFixed(Math.max(0, d)).split('.');
    const txt = `$${w.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${f !== undefined ? `.${f}` : ''}`;
    return n < 0 ? `(${txt})` : txt;
  },
  FIXED: ([v, places, noCommas]) => { const d = places === undefined ? 2 : toNum(places); const n = roundTo(v, d, Math.round); const txt = Math.abs(n).toFixed(Math.max(0, d)); const [w, f] = txt.split('.'); return `${n < 0 ? '-' : ''}${toBool(noCommas ?? false) ? w : w.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${f !== undefined ? `.${f}` : ''}`; },
  COUNTUNIQUE: (a) => new Set(flat(a).filter((v) => v !== null && v !== '' && v !== undefined).map((v) => (typeof v === 'string' ? `s:${v.toLowerCase()}` : `${typeof v}:${v}`))).size,
  // Choosing and finding.
  CHOOSE: ([i, ...options]) => { const n = Math.floor(toNum(scalarOf(i))); if (n < 1 || n > options.length) err('#VALUE!'); return options[n - 1] ?? null; },
  // XMATCH(x, range, match_mode 0 exact / -1 exact or next smaller / 1 exact or next larger / 2 wildcards, search_mode 1 first / -1 last).
  XMATCH: ([x, range, mode, search]) => {
    const list = flat([range]), v = scalarOf(x), m = toNum(mode ?? 0), dir = toNum(search ?? 1) < 0 ? -1 : 1;
    const idx = dir > 0 ? list.map((_, k) => k) : list.map((_, k) => list.length - 1 - k);
    const re = m === 2 && typeof v === 'string' ? wildcard(v) : null;
    const hit = idx.find((k) => (re ? typeof list[k] === 'string' && re.test(list[k]) : same(list[k], v)));
    if (hit !== undefined) return hit + 1;
    if (m === -1 || m === 1) {
      let best = -1;
      for (const k of idx) {
        const c = list[k];
        if (typeof c !== typeof v || c === null || c === '') continue;
        if ((m === -1 ? before(c, v) : before(v, c)) && (best < 0 || (m === -1 ? before(list[best], c) : before(c, list[best])))) best = k;
      }
      if (best >= 0) return best + 1;
    }
    return notFound();
  },
  // Arrays: put together, or keep / leave out rows from the start (or the end, when negative).
  VSTACK: (a) => stack(a, false),
  HSTACK: (a) => stack(a, true),
  TAKE: ([array, rows, cols]) => {
    let g = rowsOf(array);
    const r = rows === undefined ? g.length : Math.trunc(toNum(rows)), c = cols === undefined ? g[0].length : Math.trunc(toNum(cols));
    if (!r || !c) err('#VALUE!');
    g = r > 0 ? g.slice(0, r) : g.slice(r);
    g = g.map((row) => (c > 0 ? row.slice(0, c) : row.slice(c)));
    return grid(g);
  },
  DROP: ([array, rows, cols]) => {
    let g = rowsOf(array);
    const r = Math.trunc(toNum(rows ?? 0)), c = Math.trunc(toNum(cols ?? 0));
    g = r >= 0 ? g.slice(r) : g.slice(0, r);
    g = g.map((row) => (c >= 0 ? row.slice(c) : row.slice(0, c)));
    if (!g.length || !g[0].length) err('#VALUE!');
    return grid(g);
  },
  // Times of day: a fraction of a day, as other spreadsheets keep them (shown with a time format, or used in sums).
  TIME: ([h, m, sec]) => { const t = (toNum(h) * 3600 + toNum(m) * 60 + toNum(sec ?? 0)) / 86400; if (t < 0) err('#NUM!'); return t - Math.floor(t); },
  HOUR: ([v]) => Math.floor(secondsOf(v) / 3600),
  MINUTE: ([v]) => Math.floor((secondsOf(v) % 3600) / 60),
  SECOND: ([v]) => secondsOf(v) % 60,
  // Week numbers: WEEKNUM (weeks start on Sunday, or Monday with 2; week 1 has 1 January) and ISOWEEKNUM (ISO 8601).
  WEEKNUM: ([v, type]) => {
    const ms = toDate(v), d = new Date(ms), jan1 = Date.UTC(d.getUTCFullYear(), 0, 1);
    const start = toNum(type ?? 1) === 2 ? 1 : 0;
    const offset = (new Date(jan1).getUTCDay() - start + 7) % 7;
    return Math.floor(((ms - jan1) / DAY_MS + offset) / 7) + 1;
  },
  ISOWEEKNUM: ([v]) => {
    const d = new Date(toDate(v));
    const day = (d.getUTCDay() + 6) % 7; // Monday 0
    d.setUTCDate(d.getUTCDate() - day + 3); // that week's Thursday
    const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
    return 1 + Math.round(((d - firstThu) / DAY_MS - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  },
  // Money over time: NPV, IRR (the rate where the cash flows come to nothing), RATE and NPER (a loan's rate or number of payments).
  NPV: ([rate, ...flows]) => npv(toNum(rate), nums(flows)),
  IRR: ([flows, guess]) => { const f = nums([flows]); if (!f.some((x) => x > 0) || !f.some((x) => x < 0)) err('#NUM!'); return solve((r) => f.reduce((s, x, i) => s + x / (1 + r) ** i, 0), guess === undefined ? 0.1 : toNum(guess)); },
  RATE: ([n, payment, pv, fv, type, guess]) => {
    const N = toNum(n), P = toNum(payment), V = toNum(pv), F = toNum(fv ?? 0), T = toNum(type ?? 0) ? 1 : 0;
    return solve((r) => (Math.abs(r) < 1e-12 ? V + P * N + F : V * (1 + r) ** N + P * (1 + r * T) * (((1 + r) ** N - 1) / r) + F), guess === undefined ? 0.1 : toNum(guess));
  },
  NPER: ([rate, payment, pv, fv, type]) => {
    const r = toNum(rate), P = toNum(payment), V = toNum(pv), F = toNum(fv ?? 0), T = toNum(type ?? 0) ? 1 : 0;
    if (!r) { if (!P) err('#NUM!'); return -(V + F) / P; }
    const a = P * (1 + r * T) - F * r, b = V * r + P * (1 + r * T);
    if (a / b <= 0) err('#NUM!');
    return Math.log(a / b) / Math.log(1 + r);
  },
  TODAY: () => new Date().toISOString().slice(0, 10),
  // lookups
  // LOOKUP(x, sorted list, [results]): the last one at or below x; without results, a table's first column
  // (or row, when it's wider than tall) is searched and its last column (or row) given back.
  LOOKUP: ([x, range, results]) => {
    const v = scalarOf(x);
    let keys = flat([range]), out = results === undefined ? null : flat([results]);
    if (!out && Array.isArray(range) && range.rows > 1 && range.cols > 1) {
      const { rows, cols } = range;
      if (cols > rows) { keys = range.slice(0, cols); out = range.slice((rows - 1) * cols); }
      else { keys = Array.from({ length: rows }, (_, r) => range[r * cols]); out = Array.from({ length: rows }, (_, r) => range[r * cols + cols - 1]); }
    }
    const i = findIn(keys, v, 1);
    if (i < 0) return notFound();
    const from = out || keys;
    return i < from.length ? from[i] : err('#N/A');
  },
  MATCH: ([x, range, type]) => { const t = type === undefined ? 1 : Math.sign(toNum(type)); const i = findIn(flat([range]), scalarOf(x), t); return i < 0 ? notFound() : i + 1; },
  INDEX: ([range, row, col]) => {
    const s = shapeOf(range);
    let r = toNum(row ?? 1), c = col === undefined ? 1 : toNum(col);
    if (col === undefined && s.rows === 1) { c = r; r = 1; } // one row: the number picks the column
    if (r < 1 || c < 1 || r > s.rows || c > s.cols) err('#REF!');
    return s.at(r - 1, c - 1);
  },
  VLOOKUP: ([x, range, col, approx]) => {
    const s = shapeOf(range), c = toNum(col);
    if (c < 1) err('#VALUE!');
    if (c > s.cols) err('#REF!');
    const keys = Array.from({ length: s.rows }, (_, r) => s.at(r, 0));
    const i = findIn(keys, scalarOf(x), approx === undefined || toBool(approx) ? 1 : 0);
    return i < 0 ? notFound() : s.at(i, c - 1);
  },
  HLOOKUP: ([x, range, row, approx]) => {
    const s = shapeOf(range), r = toNum(row);
    if (r < 1) err('#VALUE!');
    if (r > s.rows) err('#REF!');
    const keys = Array.from({ length: s.cols }, (_, c) => s.at(0, c));
    const i = findIn(keys, scalarOf(x), approx === undefined || toBool(approx) ? 1 : 0);
    return i < 0 ? notFound() : s.at(r - 1, i);
  },
  // conditions over ranges
  COUNTIFS: (a) => { const ok = multi(a); return flat([a[0]]).filter((_, i) => ok(i)).length; },
  SUMIFS: ([sum, ...a]) => { const ok = multi(a, sum); const s = flat([sum]); return s.reduce((acc, v, i) => (ok(i) && typeof v === 'number' ? acc + v : acc), 0); },
  AVERAGEIF: ([range, c, avg]) => { const r = flat([range]); const s = avg ? flat([avg]) : r; const t = criteria(c); const n = s.filter((v, i) => t(r[i]) && typeof v === 'number'); if (!n.length) err('#DIV/0!'); return n.reduce((x, y) => x + y, 0) / n.length; },
  AVERAGEIFS: ([avg, ...a]) => { const ok = multi(a, avg); const n = flat([avg]).filter((v, i) => ok(i) && typeof v === 'number'); if (!n.length) err('#DIV/0!'); return n.reduce((x, y) => x + y, 0) / n.length; },
  MAXIFS: ([range, ...a]) => { const ok = multi(a, range); const n = flat([range]).filter((v, i) => ok(i) && typeof v === 'number'); return n.length ? Math.max(...n) : 0; },
  MINIFS: ([range, ...a]) => { const ok = multi(a, range); const n = flat([range]).filter((v, i) => ok(i) && typeof v === 'number'); return n.length ? Math.min(...n) : 0; },
  COUNTBLANK: (a) => flat(a).filter((v) => v === null || v === '').length,
  PRODUCT: (a) => nums(a).reduce((s, n) => s * n, 1),
  LARGE: ([range, k]) => { const n = nums([range]).sort((x, y) => y - x); const i = toNum(k) - 1; if (i < 0 || i >= n.length) err('#NUM!'); return n[i]; },
  SMALL: ([range, k]) => { const n = nums([range]).sort((x, y) => x - y); const i = toNum(k) - 1; if (i < 0 || i >= n.length) err('#NUM!'); return n[i]; },
  // numbers
  ROUNDUP: ([v, d]) => roundTo(v, d, Math.ceil),
  ROUNDDOWN: ([v, d]) => roundTo(v, d, Math.floor),
  CEILING: ([v, sig]) => { const g = toNum(sig ?? 1); if (!g) return 0; return Math.ceil(toNum(v) / g - 1e-12) * g; },
  FLOOR: ([v, sig]) => { const g = toNum(sig ?? 1); if (!g) err('#DIV/0!'); return Math.floor(toNum(v) / g + 1e-12) * g; },
  SIGN: ([v]) => Math.sign(toNum(v)),
  PI: () => Math.PI,
  // text
  MID: ([v, start, n]) => { const st = toNum(start); if (st < 1 || toNum(n) < 0) err('#VALUE!'); return toStr(v).slice(st - 1, st - 1 + toNum(n)); },
  SUBSTITUTE: ([v, from, to, nth]) => {
    const t = toStr(v), f = toStr(from), r = toStr(to);
    if (!f) return t;
    if (nth === undefined) return t.split(f).join(r);
    let i = -1;
    for (let k = 0; k < toNum(nth); k++) { i = t.indexOf(f, i + 1); if (i < 0) return t; }
    return t.slice(0, i) + r + t.slice(i + f.length);
  },
  FIND: ([what, within, start]) => { const i = toStr(within).indexOf(toStr(what), toNum(start ?? 1) - 1); if (i < 0) err('#VALUE!'); return i + 1; },
  SEARCH: ([what, within, start]) => {
    const t = toStr(within), st = toNum(start ?? 1) - 1, w = toStr(what);
    const re = new RegExp(wildcard(w).source.slice(1, -1), 'i'); // the same pattern, anywhere
    const m = re.exec(t.slice(st));
    if (!m) err('#VALUE!');
    return st + m.index + 1;
  },
  VALUE: ([v]) => { if (typeof v === 'number') return v; const n = Number(toStr(v).trim().replace(/,/g, '')); if (toStr(v).trim() === '' || Number.isNaN(n)) err('#VALUE!'); return n; },
  PROPER: ([v]) => toStr(v).toLowerCase().replace(/(^|[^\p{L}])(\p{L})/gu, (m, a, b) => a + b.toUpperCase()),
  REPT: ([v, n]) => { const k = toNum(n); if (k < 0) err('#VALUE!'); return toStr(v).repeat(Math.min(k, 10000)); },
  EXACT: ([a, b]) => toStr(a) === toStr(b),
  // ISBETWEEN(value, lower, upper, [lower_inclusive], [upper_inclusive]): numbers, dates or text (compared as text).
  ISBETWEEN: ([v, lo, hi, loIn, hiIn]) => {
    const text = [v, lo, hi].some((x) => typeof x === 'string' && x !== '' && Number.isNaN(Number(x)));
    const [x, a, b] = text ? [v, lo, hi].map((y) => toStr(y).toLowerCase()) : [v, lo, hi].map(toNum);
    return (toBool(loIn ?? true) ? x >= a : x > a) && (toBool(hiIn ?? true) ? x <= b : x < b);
  },
  TEXTJOIN: ([sep, skipEmpty, ...a]) => flat(a).map(toStr).filter((x) => !toBool(skipEmpty) || x !== '').join(toStr(sep)),
  ISBLANK: ([v]) => v === null || v === undefined || v === '',
  ISNUMBER: ([v]) => typeof v === 'number',
  ISTEXT: ([v]) => typeof v === 'string' && v !== '',
  NA: () => err('#N/A'),
  // Trigonometry (radians), as in Excel.
  SIN: ([v]) => Math.sin(toNum(v)), COS: ([v]) => Math.cos(toNum(v)), TAN: ([v]) => Math.tan(toNum(v)),
  ASIN: ([v]) => { const x = toNum(v); if (x < -1 || x > 1) err('#NUM!'); return Math.asin(x); },
  ACOS: ([v]) => { const x = toNum(v); if (x < -1 || x > 1) err('#NUM!'); return Math.acos(x); },
  ATAN: ([v]) => Math.atan(toNum(v)),
  ATAN2: ([x, y]) => { const a = toNum(x), b = toNum(y); if (!a && !b) err('#DIV/0!'); return Math.atan2(b, a); }, // Excel's order: x, then y
  SINH: ([v]) => Math.sinh(toNum(v)), COSH: ([v]) => Math.cosh(toNum(v)), TANH: ([v]) => Math.tanh(toNum(v)),
  ASINH: ([v]) => Math.asinh(toNum(v)),
  ACOSH: ([v]) => { const x = toNum(v); if (x < 1) err('#NUM!'); return Math.acosh(x); },
  ATANH: ([v]) => { const x = toNum(v); if (x <= -1 || x >= 1) err('#NUM!'); return Math.atanh(x); },
  SEC: ([v]) => 1 / Math.cos(toNum(v)),
  SECH: ([v]) => 1 / Math.cosh(toNum(v)),
  COTH: ([v]) => { const t = Math.tanh(toNum(v)); if (!t) err('#DIV/0!'); return 1 / t; },
  COT: ([v]) => { const t = Math.tan(toNum(v)); if (!t) err('#DIV/0!'); return 1 / t; },
  DEGREES: ([v]) => (toNum(v) * 180) / Math.PI, RADIANS: ([v]) => (toNum(v) * Math.PI) / 180,
  SQRTPI: ([v]) => { const x = toNum(v); if (x < 0) err('#NUM!'); return Math.sqrt(x * Math.PI); },
  // Values and their kinds.
  TRUE: () => true, FALSE: () => false,
  XOR: (a) => flat(a).filter((v) => v !== null && v !== '' && toBool(v)).length % 2 === 1,
  N: ([v]) => (typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : 0),
  T: ([v]) => (typeof v === 'string' ? v : ''),
  TYPE: ([v]) => (Array.isArray(v) ? 64 : typeof v === 'boolean' ? 4 : typeof v === 'string' && v !== '' ? 2 : 1), // (an empty cell is 1, as in Excel)
  ISLOGICAL: ([v]) => typeof v === 'boolean',
  ISNONTEXT: ([v]) => !(typeof v === 'string' && v !== ''),
  // Text.
  REPLACE: ([v, start, count, text]) => { const s = toStr(v), a = Math.trunc(toNum(start)), n = Math.trunc(toNum(count)); if (a < 1 || n < 0) err('#VALUE!'); return s.slice(0, a - 1) + toStr(text) + s.slice(a - 1 + n); },
  // Statistics.
  MAXA: (a) => { const v = flat(a).filter((x) => x !== null && x !== '' && x !== undefined).map((x) => (typeof x === 'number' ? x : typeof x === 'boolean' ? (x ? 1 : 0) : 0)); return v.length ? Math.max(...v) : 0; },
  MINA: (a) => { const v = flat(a).filter((x) => x !== null && x !== '' && x !== undefined).map((x) => (typeof x === 'number' ? x : typeof x === 'boolean' ? (x ? 1 : 0) : 0)); return v.length ? Math.min(...v) : 0; },
  STDEVA: (a) => { const v = flat(a).filter((x) => x !== null && x !== '' && x !== undefined).map((x) => (typeof x === 'number' ? x : typeof x === 'boolean' ? (x ? 1 : 0) : 0)); return Math.sqrt(variance([v], true)); },
  HARMEAN: (a) => { const n = nums(a); if (!n.length || n.some((x) => x <= 0)) err('#NUM!'); return n.length / n.reduce((s, x) => s + 1 / x, 0); },
  TRIMMEAN: ([range, pct]) => {
    const n = nums([range]).sort((x, y) => x - y), p = toNum(pct);
    if (!n.length || p < 0 || p >= 1) err('#NUM!');
    const cut = Math.floor((n.length * p) / 2), kept = n.slice(cut, n.length - cut);
    return kept.reduce((s, x) => s + x, 0) / kept.length;
  },
  'PERCENTILE.EXC': ([range, k]) => {
    const n = nums([range]).sort((x, y) => x - y), p = toNum(k), at = p * (n.length + 1);
    if (!n.length || at < 1 || at > n.length) err('#NUM!');
    const lo = Math.floor(at);
    return lo < n.length ? n[lo - 1] + (at - lo) * (n[lo] - n[lo - 1]) : n[lo - 1];
  },
  'RANK.AVG': ([x, range, order]) => {
    const v = toNum(x), n = nums([range]);
    if (!n.includes(v)) err('#N/A');
    const better = n.filter((y) => (order !== undefined && toNum(order) ? y < v : y > v)).length, ties = n.filter((y) => y === v).length;
    return better + (ties + 1) / 2;
  },
  'MODE.MULT': (a) => {
    const counts = new Map();
    for (const x of nums(a)) counts.set(x, (counts.get(x) || 0) + 1);
    const top = Math.max(0, ...counts.values());
    if (top < 2) err('#N/A');
    const out = [...counts].filter(([, c]) => c === top).map(([x]) => x);
    return grid(out.map((x) => [x]));
  },
  STEYX: ([ys, xs]) => {
    const p = pairs(ys, xs);
    if (p.length < 3) err('#DIV/0!');
    const { slope, intercept } = fitLine(ys, xs);
    return Math.sqrt(p.reduce((s, [y, x]) => s + (y - (intercept + slope * x)) ** 2, 0) / (p.length - 2));
  },
  SUMX2MY2: ([a, b]) => sumPairs(a, b, (x, y) => x * x - y * y),
  SUMX2PY2: ([a, b]) => sumPairs(a, b, (x, y) => x * x + y * y),
  SUMXMY2: ([a, b]) => sumPairs(a, b, (x, y) => (x - y) ** 2),
  FISHER: ([v]) => { const x = toNum(v); if (x <= -1 || x >= 1) err('#NUM!'); return 0.5 * Math.log((1 + x) / (1 - x)); },
  GAMMALN: ([v]) => { const x = toNum(v); if (x <= 0) err('#NUM!'); return lnGamma(x); },
  GAMMA: ([v]) => { const x = toNum(v); if (x <= 0 && Number.isInteger(x)) err('#NUM!'); return x > 0 ? Math.exp(lnGamma(x)) : Math.PI / (Math.sin(Math.PI * x) * Math.exp(lnGamma(1 - x))); },
  ERF: ([lo, hi]) => (hi === undefined ? erf(toNum(lo)) : erf(toNum(hi)) - erf(toNum(lo))),
  'LOGNORM.DIST': ([x, mean, sd, cumulative]) => {
    const v = toNum(x), m = toNum(mean), s = toNum(sd);
    if (v <= 0 || s <= 0) err('#NUM!');
    const z = (Math.log(v) - m) / s;
    return toBool(cumulative) ? normCdf(z) : normPdf(z) / (v * s);
  },
  'WEIBULL.DIST': ([x, alpha, beta, cumulative]) => {
    const v = toNum(x), a = toNum(alpha), b = toNum(beta);
    if (v < 0 || a <= 0 || b <= 0) err('#NUM!');
    return toBool(cumulative) ? 1 - Math.exp(-((v / b) ** a)) : (a / b ** a) * v ** (a - 1) * Math.exp(-((v / b) ** a));
  },
  'BETA.DIST': ([x, alpha, beta, cumulative, lo, hi]) => {
    const a = toNum(alpha), b = toNum(beta), A = lo === undefined ? 0 : toNum(lo), B = hi === undefined ? 1 : toNum(hi), v = (toNum(x) - A) / (B - A);
    if (a <= 0 || b <= 0 || v < 0 || v > 1 || B <= A) err('#NUM!');
    if (toBool(cumulative)) return betaI(a, b, v);
    return Math.exp((a - 1) * Math.log(v) + (b - 1) * Math.log(1 - v) - (lnGamma(a) + lnGamma(b) - lnGamma(a + b))) / (B - A);
  },
  // Counting.
  COMBINA: ([n, k]) => { const a = whole(n), b = whole(k); if (!a && !b) return 1; return FUNCS.COMBIN([a + b - 1, b]); },
  FACTDOUBLE: ([v]) => { const n = Math.trunc(toNum(v)); if (n < -1) err('#NUM!'); let f = 1; for (let i = n; i > 1; i -= 2) f *= i; return f; },
  MULTINOMIAL: (a) => { const n = nums(a).map(Math.trunc); if (n.some((x) => x < 0)) err('#NUM!'); return Math.round(factorial(n.reduce((s, x) => s + x, 0)) / n.reduce((p, x) => p * factorial(x), 1)); },
  SERIESSUM: ([x, n, m, coef]) => { const v = toNum(x), a = toNum(n), b = toNum(m); return nums([coef]).reduce((s, c, i) => s + c * v ** (a + i * b), 0); },
  BESSELJ: ([x, n]) => besselJ(...besselArgs(x, n, false)),
  BESSELI: ([x, n]) => besselI(...besselArgs(x, n, false)),
  BESSELK: ([x, n]) => besselK(...besselArgs(x, n, true)),
  BESSELY: ([x, n]) => besselY(...besselArgs(x, n, true)),
  // complex numbers (text such as "3+4i")
  COMPLEX: ([re, im, suffix]) => {
    const s = given(suffix) && suffix !== '' ? toStr(suffix) : 'i';
    if (s !== 'i' && s !== 'j') err('#VALUE!');
    return complexText(toNum(re), toNum(im ?? 0), s);
  },
  IMREAL: ([z]) => complexOf(scalarOf(z)).re,
  IMAGINARY: ([z]) => complexOf(scalarOf(z)).im,
  IMABS: ([z]) => cAbs(complexOf(scalarOf(z))),
  IMARGUMENT: ([z]) => { const c = complexOf(scalarOf(z)); if (!c.re && !c.im) err('#DIV/0!'); return Math.atan2(c.im, c.re); },
  IMCONJUGATE: complexFn((c) => [c.re, -c.im]),
  IMSUM: (args) => { const zs = flat(args).filter((v) => v !== null && v !== undefined).map(complexOf); return complexText(zs.reduce((s, z) => s + z.re, 0), zs.reduce((s, z) => s + z.im, 0), suffixOf(zs)); },
  IMSUB: ([a, b]) => { const x = complexOf(scalarOf(a)), y = complexOf(scalarOf(b)); return complexText(x.re - y.re, x.im - y.im, suffixOf([x, y])); },
  IMPRODUCT: (args) => {
    const zs = flat(args).filter((v) => v !== null && v !== undefined).map(complexOf);
    let re = 1, im = 0;
    for (const z of zs) [re, im] = [re * z.re - im * z.im, re * z.im + im * z.re];
    return complexText(re, im, suffixOf(zs));
  },
  IMDIV: ([a, b]) => {
    const x = complexOf(scalarOf(a)), y = complexOf(scalarOf(b)), d = y.re ** 2 + y.im ** 2;
    if (!d) err('#NUM!');
    return complexText((x.re * y.re + x.im * y.im) / d, (x.im * y.re - x.re * y.im) / d, suffixOf([x, y]));
  },
  IMPOWER: ([z, n]) => {
    const c = complexOf(scalarOf(z)), p = toNum(n), r = cAbs(c);
    if (!r) { if (p <= 0) err('#NUM!'); return '0'; }
    const t = Math.atan2(c.im, c.re) * p, m = r ** p;
    return complexText(m * Math.cos(t), m * Math.sin(t), c.suffix);
  },
  IMSQRT: complexFn((c) => { const r = Math.sqrt(cAbs(c)), t = Math.atan2(c.im, c.re) / 2; return [r * Math.cos(t), r * Math.sin(t)]; }),
  IMEXP: complexFn((c) => [Math.exp(c.re) * Math.cos(c.im), Math.exp(c.re) * Math.sin(c.im)]),
  IMLN: complexFn(cLn),
  IMLOG10: complexFn((c) => cLn(c).map((x) => x / Math.LN10)),
  IMLOG2: complexFn((c) => cLn(c).map((x) => x / Math.LN2)),
  IMSIN: complexFn((c) => [Math.sin(c.re) * Math.cosh(c.im), Math.cos(c.re) * Math.sinh(c.im)]),
  IMCOS: complexFn((c) => [Math.cos(c.re) * Math.cosh(c.im), -Math.sin(c.re) * Math.sinh(c.im)]),
  DELTA: ([a, b]) => (toNum(a) === toNum(b ?? 0) ? 1 : 0),
  'CEILING.MATH': ([v, sig, mode]) => { const x = toNum(v), g = Math.abs(toNum(sig ?? 1)) || 0; if (!g) return 0; return x < 0 && mode !== undefined && toNum(mode) ? Math.floor(x / g + 1e-12) * g : Math.ceil(x / g - 1e-12) * g; },
  'FLOOR.MATH': ([v, sig, mode]) => { const x = toNum(v), g = Math.abs(toNum(sig ?? 1)) || 0; if (!g) return 0; return x < 0 && mode !== undefined && toNum(mode) ? Math.ceil(x / g - 1e-12) * g : Math.floor(x / g + 1e-12) * g; },
  // BITLSHIFT(n, by) and BITRSHIFT(n, by): n's bits moved left (right); a negative `by` goes the other way.
  BITLSHIFT: ([a, by]) => shiftBits(a, toNum(by)), BITRSHIFT: ([a, by]) => shiftBits(a, -toNum(by)),
  BITAND: ([a, b]) => bits(a, b, (x, y) => x & y), BITOR: ([a, b]) => bits(a, b, (x, y) => x | y), BITXOR: ([a, b]) => bits(a, b, (x, y) => x ^ y),
  // Money.
  FVSCHEDULE: ([pv, rates]) => nums([rates]).reduce((v, r) => v * (1 + r), toNum(pv)),
  RRI: ([n, pv, fv]) => { const k = toNum(n), a = toNum(pv), b = toNum(fv); if (k <= 0 || !a) err('#NUM!'); return (b / a) ** (1 / k) - 1; },
  MIRR: ([flows, finance, reinvest]) => {
    const f = nums([flows]), fr = toNum(finance), rr = toNum(reinvest), k = f.length;
    const pos = f.reduce((s, x, i) => s + (x > 0 ? x * (1 + rr) ** (k - 1 - i) : 0), 0), neg = f.reduce((s, x, i) => s + (x < 0 ? x / (1 + fr) ** i : 0), 0);
    if (!pos || !neg) err('#DIV/0!');
    return (-pos / neg) ** (1 / (k - 1)) - 1;
  },
  DAYS360: ([a, b, method]) => {
    const d = (v) => { const x = new Date(toDate(v)); return [x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate(), new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate()]; };
    let [y1, m1, d1, last1] = d(a), [y2, m2, d2] = d(b);
    if (method !== undefined && toBool(method)) { if (d1 === 31) d1 = 30; if (d2 === 31) d2 = 30; } // European
    else { if (d1 === last1 && m1 === 2) d1 = 30; if (d1 === 31) d1 = 30; if (d2 === 31 && d1 >= 30) d2 = 30; } // US (NASD)
    return (y2 - y1) * 360 + (m2 - m1) * 30 + (d2 - d1);
  },
  // dates (as YYYY-MM-DD text, like TODAY)
  DATE: ([y, m, d]) => dateText(Date.UTC(toNum(y), toNum(m) - 1, toNum(d))),
  YEAR: ([v]) => new Date(toDate(v)).getUTCFullYear(),
  MONTH: ([v]) => new Date(toDate(v)).getUTCMonth() + 1,
  DAY: ([v]) => new Date(toDate(v)).getUTCDate(),
  WEEKDAY: ([v, type]) => { const d = new Date(toDate(v)).getUTCDay(); const t = toNum(type ?? 1); return t === 2 ? ((d + 6) % 7) + 1 : t === 3 ? (d + 6) % 7 : d + 1; },
  DAYS: ([end, start]) => Math.round((toDate(end) - toDate(start)) / DAY_MS),
  EDATE: ([start, months]) => { const d = new Date(toDate(start)); const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + toNum(months), 1)); const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate(); return dateText(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), Math.min(d.getUTCDate(), last))); },
  EOMONTH: ([start, months]) => { const d = new Date(toDate(start)); return dateText(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + toNum(months) + 1, 0)); },
  NOW: () => new Date().toISOString().slice(0, 16).replace('T', ' '),
  // statistics
  'STDEV': (a) => Math.sqrt(variance(a, true)),
  'STDEV.S': (a) => Math.sqrt(variance(a, true)),
  'STDEV.P': (a) => Math.sqrt(variance(a, false)),
  'STDEVP': (a) => Math.sqrt(variance(a, false)),
  'VAR': (a) => variance(a, true),
  'VAR.S': (a) => variance(a, true),
  'VAR.P': (a) => variance(a, false),
  'VARP': (a) => variance(a, false),
  // SUBTOTAL(9, B2:B20): one of eleven totals by number (1 AVERAGE, 2 COUNT, 3 COUNTA, 4 MAX, 5 MIN, 6 PRODUCT,
  // 7 STDEV, 8 STDEVP, 9 SUM, 10 VAR, 11 VARP), as Excel's table total rows write it; 101–111 are the same here.
  SUBTOTAL: ([fn, ...refs]) => {
    const n = Math.trunc(toNum(fn)) % 100;
    const name = ['AVERAGE', 'COUNT', 'COUNTA', 'MAX', 'MIN', 'PRODUCT', 'STDEV', 'STDEVP', 'SUM', 'VAR', 'VARP'][n - 1];
    if (!name || !refs.length) err('#VALUE!');
    return FUNCS[name](refs);
  },
  // more statistics
  MODE: (a) => {
    const counts = new Map();
    let best = null, most = 1;
    for (const x of nums(a)) { const c = (counts.get(x) || 0) + 1; counts.set(x, c); if (c > most) { most = c; best = x; } }
    if (best === null) err('#N/A'); // nothing repeats
    return best;
  },
  'MODE.SNGL': (a) => FUNCS.MODE(a),
  PERCENTILE: ([range, k]) => percentile(range, k),
  'PERCENTILE.INC': ([range, k]) => percentile(range, k),
  QUARTILE: ([range, q]) => { const n = Math.trunc(toNum(q)); if (n < 0 || n > 4) err('#NUM!'); return percentile(range, n / 4); },
  'QUARTILE.INC': (a) => FUNCS.QUARTILE(a),
  CORREL: ([ys, xs]) => { const { r } = fitLine(ys, xs); if (Number.isNaN(r)) err('#DIV/0!'); return r; },
  PEARSON: (a) => FUNCS.CORREL(a),
  RSQ: (a) => FUNCS.CORREL(a) ** 2,
  SLOPE: ([ys, xs]) => fitLine(ys, xs).slope,
  INTERCEPT: ([ys, xs]) => fitLine(ys, xs).intercept,
  FORECAST: ([x, ys, xs]) => { const l = fitLine(ys, xs); return l.intercept + l.slope * toNum(x); },
  'FORECAST.LINEAR': (a) => FUNCS.FORECAST(a),
  GEOMEAN: (a) => { const n = nums(a); if (!n.length || n.some((x) => x <= 0)) err('#NUM!'); return Math.exp(n.reduce((s, x) => s + Math.log(x), 0) / n.length); },
  AVERAGEA: (a) => { const v = flat(a).filter((x) => x !== null && x !== ''); if (!v.length) err('#DIV/0!'); return v.reduce((s, x) => s + (typeof x === 'number' ? x : x === true ? 1 : 0), 0) / v.length; },
  // more whole-number maths
  MROUND: ([v, m]) => { const x = toNum(v), step = toNum(m); if (!step) return 0; if (x * step < 0) err('#NUM!'); return Math.round(x / step + 1e-9) * step; }, // same signs: the quotient is never negative
  QUOTIENT: ([a, b]) => { const d = toNum(b); if (!d) err('#DIV/0!'); return Math.trunc(toNum(a) / d); },
  GCD: (a) => flat(a).map(whole).reduce(gcd2, 0),
  LCM: (a) => flat(a).map(whole).reduce((l, n) => (l === 0 || n === 0 ? 0 : (l / gcd2(l, n)) * n), 1),
  FACT: ([v]) => factorial(whole(v)),
  COMBIN: ([n, k]) => { const a = whole(n), b = whole(k); if (b > a) err('#NUM!'); let c = 1; for (let i = 1; i <= b; i++) c = (c * (a - b + i)) / i; return Math.round(c); },
  EVEN: ([v]) => { const x = toNum(v), up = Math.ceil(Math.abs(x) / 2) * 2; return Math.sign(x) * up; },
  ODD: ([v]) => { const x = toNum(v); const a = Math.abs(x); let up = Math.ceil(a); if (up % 2 === 0) up += 1; return (x < 0 ? -1 : 1) * up; },
  RANK: ([x, range, order]) => { const v = toNum(x); const n = nums([range]); if (!n.includes(v)) err('#N/A'); return 1 + n.filter((y) => (order !== undefined && toNum(order) ? y < v : y > v)).length; },
  'RANK.EQ': (a) => FUNCS.RANK(a),
  SUMPRODUCT: (a) => {
    const lists = a.map((x) => flat([x]));
    if (lists.some((l) => l.length !== lists[0].length)) err('#VALUE!');
    let total = 0;
    for (let i = 0; i < (lists[0]?.length || 0); i++) total += lists.reduce((p, l) => p * (typeof l[i] === 'number' ? l[i] : typeof l[i] === 'boolean' ? +l[i] : 0), 1);
    return total;
  },
  // more maths
  LN: ([v]) => { const n = toNum(v); if (n <= 0) err('#NUM!'); return Math.log(n); },
  LOG: ([v, base]) => { const n = toNum(v), b = toNum(base ?? 10); if (n <= 0 || b <= 0 || b === 1) err('#NUM!'); return b === 10 ? Math.log10(n) : b === 2 ? Math.log2(n) : Math.log(n) / Math.log(b); },
  LOG10: ([v]) => { const n = toNum(v); if (n <= 0) err('#NUM!'); return Math.log10(n); },
  EXP: ([v]) => Math.exp(toNum(v)),
  TRUNC: ([v, d]) => { const f = 10 ** toNum(d ?? 0); return Math.trunc(toNum(v) * f) / f; },
  ISODD: ([v]) => Math.abs(Math.trunc(toNum(v))) % 2 === 1,
  ISEVEN: ([v]) => Math.abs(Math.trunc(toNum(v))) % 2 === 0,
  RAND: () => Math.random(),
  RANDBETWEEN: ([lo, hi]) => { const a = Math.ceil(toNum(lo)), b = Math.floor(toNum(hi)); if (b < a) err('#NUM!'); return a + Math.floor(Math.random() * (b - a + 1)); },
  // loans and savings
  PMT: ([rate, n, pv, fv, type]) => pmt(toNum(rate), toNum(n), toNum(pv), toNum(fv), toNum(type) ? 1 : 0),
  FV: ([rate, n, payment, pv, type]) => {
    const r = toNum(rate), k = toNum(n), p = toNum(payment), v = toNum(pv), t = toNum(type) ? 1 : 0;
    if (!r) return -(v + p * k);
    const g = (1 + r) ** k;
    return -(v * g + p * (1 + r * t) * (g - 1) / r);
  },
  PV: ([rate, n, payment, fv, type]) => {
    const r = toNum(rate), k = toNum(n), p = toNum(payment), f = toNum(fv), t = toNum(type) ? 1 : 0;
    if (!r) return -(f + p * k);
    const g = (1 + r) ** k;
    return -(f + p * (1 + r * t) * (g - 1) / r) / g;
  },
  // lookups and text
  XLOOKUP: ([x, look, ret, ifNotFound, matchMode, searchMode]) => {
    const keys = flat([look]), s = shapeOf(ret), mode = toNum(matchMode ?? 0), from = toNum(searchMode ?? 1);
    const across = shapeOf(look).rows === 1 && keys.length > 1; // a row of keys picks columns
    if ((across ? s.cols : s.rows) !== keys.length) err('#VALUE!');
    const v = scalarOf(x);
    const order = keys.map((_, i) => i);
    if (from < 0) order.reverse();
    let hit = -1;
    if (mode === 2 || mode === 0) {
      const re = mode === 2 && hasWildcard(v) ? wildcard(v) : null;
      hit = order.find((i) => (re ? typeof keys[i] === 'string' && re.test(keys[i]) : same(keys[i], v))) ?? -1;
    } else { // -1: exact or the next smaller, 1: exact or the next larger
      for (const i of order) {
        const k = keys[i];
        if (k === null || k === '' || typeof k !== typeof v) continue;
        if (same(k, v)) { hit = i; break; }
        const ok = mode < 0 ? before(k, v) : before(v, k);
        if (ok && (hit < 0 || (mode < 0 ? before(keys[hit], k) : before(k, keys[hit])))) hit = i;
      }
    }
    if (hit < 0) return ifNotFound !== undefined ? ifNotFound : notFound();
    if (across) { const col = Array.from({ length: s.rows }, (_, r) => s.at(r, hit)); col.rows = s.rows; col.cols = 1; return s.rows === 1 ? col[0] : col; }
    if (s.cols === 1) return s.at(hit, 0);
    const row = Array.from({ length: s.cols }, (_, c) => s.at(hit, c)); row.rows = 1; row.cols = s.cols;
    return row;
  },
  TEXT: ([v, fmt]) => formatText(v, fmt),
  CHAR: ([v]) => { const n = toNum(v); if (n < 1 || n > 0x10ffff) err('#VALUE!'); return String.fromCodePoint(n); },
  CODE: ([v]) => { const t = toStr(v); if (!t) err('#VALUE!'); return t.codePointAt(0); },
  // working days and date differences
  NETWORKDAYS: ([start, end, holidays]) => {
    let a = toDate(start), b = toDate(end), sign = 1;
    if (b < a) { [a, b] = [b, a]; sign = -1; }
    if ((b - a) / DAY_MS > 36600) err('#NUM!');
    const hol = holidaySet(holidays);
    let n = 0;
    for (let t = a; t <= b; t += DAY_MS) if (isWorkday(t, hol)) n++;
    return n * sign;
  },
  WORKDAY: ([start, days, holidays]) => {
    let t = toDate(start), left = Math.trunc(toNum(days));
    if (Math.abs(left) > 36600) err('#NUM!');
    const step = left < 0 ? -DAY_MS : DAY_MS, hol = holidaySet(holidays);
    while (left) { t += step; if (isWorkday(t, hol)) left -= Math.sign(left); }
    return dateText(t);
  },
  // …with your own weekend (see weekendOf): a Friday–Saturday week, or Sundays only.
  'NETWORKDAYS.INTL': ([start, end, weekend, holidays]) => {
    let a = toDate(start), b = toDate(end), sign = 1;
    if (b < a) { [a, b] = [b, a]; sign = -1; }
    if ((b - a) / DAY_MS > 36600) err('#NUM!');
    const hol = holidaySet(holidays), wk = weekendOf(weekend);
    let n = 0;
    for (let t = a; t <= b; t += DAY_MS) if (isWorkday(t, hol, wk)) n++;
    return n * sign;
  },
  'WORKDAY.INTL': ([start, days, weekend, holidays]) => {
    let t = toDate(start), left = Math.trunc(toNum(days));
    if (Math.abs(left) > 36600) err('#NUM!');
    const step = left < 0 ? -DAY_MS : DAY_MS, hol = holidaySet(holidays), wk = weekendOf(weekend);
    while (left) { t += step; if (isWorkday(t, hol, wk)) left -= Math.sign(left); }
    return dateText(t);
  },
  // Units: CONVERT(6, "ft", "m"), CONVERT(100, "C", "F") (see unitconvert.js).
  CONVERT: ([v, from, to]) => { const out = convertUnits(toNum(v), toStr(from), toStr(to)); return out === null ? err('#N/A') : out; },
  DATEDIF: ([start, end, unit]) => {
    const a = new Date(toDate(start)), b = new Date(toDate(end));
    if (b < a) err('#NUM!');
    const months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth() - (b.getUTCDate() < a.getUTCDate() ? 1 : 0);
    switch (toStr(unit).toUpperCase()) {
      case 'D': return Math.round((b - a) / DAY_MS);
      case 'M': return months;
      case 'Y': return Math.floor(months / 12);
      case 'YM': return months % 12;
      case 'MD': { const anchor = Date.UTC(b.getUTCFullYear(), b.getUTCMonth() - (b.getUTCDate() < a.getUTCDate() ? 1 : 0), a.getUTCDate()); return Math.round((b - anchor) / DAY_MS); }
      case 'YD': { let anchor = Date.UTC(b.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate()); if (anchor > b) anchor = Date.UTC(b.getUTCFullYear() - 1, a.getUTCMonth(), a.getUTCDate()); return Math.round((b - anchor) / DAY_MS); }
      default: return err('#NUM!');
    }
  },
};
// ---- statistics and distributions, depreciation, loan pieces, dates in words, database functions (statmath.js does the maths)
const probability = (v) => { const p = toNum(v); if (!(p > 0 && p < 1)) err('#NUM!'); return p; };
const positive = (v) => { const n = toNum(v); if (!(n > 0)) err('#NUM!'); return n; };
const degrees = (v) => { const n = Math.trunc(toNum(v)); if (n < 1) err('#NUM!'); return n; };
/** Mean and sample standard deviation of the numbers; at least `min` of them. */
function spread(a, min) {
  const n = nums(a);
  if (n.length < min) err('#DIV/0!');
  const mean = n.reduce((s, x) => s + x, 0) / n.length;
  const sd = Math.sqrt(n.reduce((s, x) => s + (x - mean) ** 2, 0) / (n.length - 1));
  if (!sd) err('#DIV/0!');
  return { n, mean, sd };
}
function covariance(ys, xs, sample) {
  const p = pairs(ys, xs);
  if (p.length < (sample ? 2 : 1)) err('#DIV/0!');
  const my = p.reduce((s, [y]) => s + y, 0) / p.length, mx = p.reduce((s, [, x]) => s + x, 0) / p.length;
  return p.reduce((s, [y, x]) => s + (y - my) * (x - mx), 0) / (p.length - (sample ? 1 : 0));
}
/** TREND and GROWTH: the known points (x defaults to 1, 2, 3…), and where to work out new values (defaults to the known x). */
function fitArgs(ys, xs, newXs) {
  const y = flat([ys]);
  const x = given(xs) && xs !== '' ? flat([xs]) : y.map((_, i) => i + 1);
  if (x.length !== y.length) err('#REF!');
  const at = given(newXs) && newXs !== '' ? newXs : (given(xs) && xs !== '' ? xs : grid(y.map((_, i) => [i + 1])));
  return { y, x, at };
}
const mapShape = (v, fn) => (Array.isArray(v) ? elementwise(v, null, (x) => fn(toNum(x))) : fn(toNum(v)));
/** Database functions: the values of one column (by heading or number) on the rows the criteria range picks. */
function dbValues(database, field, crit) {
  const rows = rowsOf(database), c = rowsOf(crit);
  if (rows.length < 1 || c.length < 1) err('#VALUE!');
  const heads = rows[0].map((h) => toStr(h).trim().toLowerCase());
  const col = typeof field === 'number' ? Math.trunc(field) - 1 : heads.indexOf(toStr(field).trim().toLowerCase());
  if (col < 0 || col >= heads.length) err('#VALUE!');
  // Each criteria row below the headings is one way to match (OR); its filled cells must all hold (AND).
  const tests = c.slice(1).map((r) => r.map((v, i) => {
    if (v === null || v === '') return null;
    const k = heads.indexOf(toStr(c[0][i]).trim().toLowerCase());
    if (k < 0) err('#VALUE!');
    return [k, criteria(v)];
  }).filter(Boolean));
  const ok = (row) => !tests.length || tests.some((t) => t.every(([k, f]) => f(row[k])));
  return rows.slice(1).filter(ok).map((r) => r[col]);
}
const dateMs = (v) => {
  if (typeof v === 'number') return toDate(v);
  const t = toStr(v);
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.test(t.trim()) ? toDate(t) : parseDateText(t);
  if (iso === null) err('#VALUE!');
  return iso;
};

Object.assign(FUNCS, {
  'NORM.DIST': ([x, mean, sd, cumulative]) => { const s = positive(sd), z = (toNum(x) - toNum(mean)) / s; return toBool(cumulative) ? normCdf(z) : normPdf(z) / s; },
  NORMDIST: (a) => FUNCS['NORM.DIST'](a),
  'NORM.S.DIST': ([z, cumulative]) => (cumulative === undefined || toBool(cumulative) ? normCdf(toNum(z)) : normPdf(toNum(z))),
  NORMSDIST: ([z]) => normCdf(toNum(z)),
  'NORM.INV': ([p, mean, sd]) => toNum(mean) + positive(sd) * normInv(probability(p)),
  NORMINV: (a) => FUNCS['NORM.INV'](a),
  'NORM.S.INV': ([p]) => normInv(probability(p)),
  NORMSINV: (a) => FUNCS['NORM.S.INV'](a),
  STANDARDIZE: ([x, mean, sd]) => (toNum(x) - toNum(mean)) / positive(sd),
  SKEW: (a) => { const { n, mean, sd } = spread(a, 3); const k = n.length; return (k / ((k - 1) * (k - 2))) * n.reduce((s, x) => s + ((x - mean) / sd) ** 3, 0); },
  KURT: (a) => { const { n, mean, sd } = spread(a, 4); const k = n.length; return ((k * (k + 1)) / ((k - 1) * (k - 2) * (k - 3))) * n.reduce((s, x) => s + ((x - mean) / sd) ** 4, 0) - (3 * (k - 1) ** 2) / ((k - 2) * (k - 3)); },
  COVAR: ([ys, xs]) => covariance(ys, xs, false),
  'COVARIANCE.P': ([ys, xs]) => covariance(ys, xs, false),
  'COVARIANCE.S': ([ys, xs]) => covariance(ys, xs, true),
  DEVSQ: (a) => { const n = nums(a); const m = n.reduce((s, x) => s + x, 0) / (n.length || 1); return n.reduce((s, x) => s + (x - m) ** 2, 0); },
  AVEDEV: (a) => { const n = nums(a); if (!n.length) err('#NUM!'); const m = n.reduce((s, x) => s + x, 0) / n.length; return n.reduce((s, x) => s + Math.abs(x - m), 0) / n.length; },
  SUMSQ: (a) => nums(a).reduce((s, x) => s + x * x, 0),
  PERCENTRANK: ([range, x, significance]) => {
    const n = nums([range]).sort((p, q) => p - q), v = toNum(x), digits = given(significance) ? Math.trunc(toNum(significance)) : 3;
    if (!n.length || digits < 1 || v < n[0] || v > n[n.length - 1]) err(n.length && digits >= 1 ? '#N/A' : '#NUM!');
    if (n.length === 1) return 1;
    let rank;
    const first = n.indexOf(v);
    if (first >= 0) rank = first / (n.length - 1);
    else { const i = n.findIndex((y) => y > v) - 1; rank = (i + (v - n[i]) / (n[i + 1] - n[i])) / (n.length - 1); }
    const f = 10 ** digits;
    return Math.floor(rank * f + 1e-9) / f;
  },
  'PERCENTRANK.INC': (a) => FUNCS.PERCENTRANK(a),
  'BINOM.DIST': ([k, n, p, cumulative]) => {
    const tries = Math.trunc(toNum(n)), hits = Math.trunc(toNum(k)), chance = toNum(p);
    if (hits < 0 || hits > tries || chance < 0 || chance > 1) err('#NUM!');
    return toBool(cumulative) ? binomCdf(hits, tries, chance) : binomPmf(hits, tries, chance);
  },
  BINOMDIST: (a) => FUNCS['BINOM.DIST'](a),
  'POISSON.DIST': ([k, mean, cumulative]) => {
    const x = Math.trunc(toNum(k)), m = toNum(mean);
    if (x < 0 || m < 0) err('#NUM!');
    return toBool(cumulative) ? poissonCdf(x, m) : poissonPmf(x, m);
  },
  POISSON: (a) => FUNCS['POISSON.DIST'](a),
  'EXPON.DIST': ([x, lambda, cumulative]) => { const v = toNum(x), l = positive(lambda); if (v < 0) err('#NUM!'); return toBool(cumulative) ? 1 - Math.exp(-l * v) : l * Math.exp(-l * v); },
  EXPONDIST: (a) => FUNCS['EXPON.DIST'](a),
  'T.DIST': ([x, df, cumulative]) => { const d = degrees(df), t = toNum(x); return toBool(cumulative) ? tCdf(t, d) : tPdf(t, d); },
  'T.DIST.RT': ([x, df]) => 1 - tCdf(toNum(x), degrees(df)),
  'T.DIST.2T': ([x, df]) => { const t = toNum(x); if (t < 0) err('#NUM!'); return 2 * (1 - tCdf(t, degrees(df))); },
  TDIST: ([x, df, tails]) => { const t = toNum(x), k = Math.trunc(toNum(tails)); if (t < 0 || (k !== 1 && k !== 2)) err('#NUM!'); return k * (1 - tCdf(t, degrees(df))); },
  'T.INV': ([p, df]) => tInv(probability(p), degrees(df)),
  'T.INV.2T': ([p, df]) => { const q = toNum(p); if (!(q > 0 && q <= 1)) err('#NUM!'); return Math.abs(tInv(q / 2, degrees(df))); },
  TINV: (a) => FUNCS['T.INV.2T'](a),
  'T.TEST': ([r1, r2, tails, type]) => {
    const k = Math.trunc(toNum(tails)), ty = Math.trunc(toNum(type));
    if ((k !== 1 && k !== 2) || ty < 1 || ty > 3) err('#NUM!');
    let xs, ys;
    if (ty === 1) { const p = pairs(r1, r2); xs = p.map(([a]) => a); ys = p.map(([, b]) => b); } else { xs = nums([r1]); ys = nums([r2]); }
    const v = tTest(xs, ys, k, ty);
    if (v === null) err('#DIV/0!');
    return v;
  },
  TTEST: (a) => FUNCS['T.TEST'](a),
  'CHISQ.DIST': ([x, df, cumulative]) => { const v = toNum(x), d = degrees(df); if (v < 0) err('#NUM!'); return toBool(cumulative) ? chiCdf(v, d) : chiPdf(v, d); },
  'CHISQ.DIST.RT': ([x, df]) => { const v = toNum(x); if (v < 0) err('#NUM!'); return 1 - chiCdf(v, degrees(df)); },
  CHIDIST: (a) => FUNCS['CHISQ.DIST.RT'](a),
  'CHISQ.TEST': ([observed, expected]) => {
    const o = flat([observed]), e = flat([expected]), s = shapeOf(observed);
    if (o.length !== e.length || o.length < 2) err('#N/A');
    let chi = 0;
    for (let i = 0; i < o.length; i++) { const ex = toNum(e[i]); if (!(ex > 0)) err('#DIV/0!'); chi += (toNum(o[i]) - ex) ** 2 / ex; }
    const df = s.rows > 1 && s.cols > 1 ? (s.rows - 1) * (s.cols - 1) : o.length - 1;
    return 1 - chiCdf(chi, df);
  },
  CHITEST: (a) => FUNCS['CHISQ.TEST'](a),
  'CONFIDENCE.NORM': ([alpha, sd, size]) => normInv(1 - probability(alpha) / 2) * positive(sd) / Math.sqrt(degrees(size)),
  CONFIDENCE: (a) => FUNCS['CONFIDENCE.NORM'](a),
  'CONFIDENCE.T': ([alpha, sd, size]) => { const n = degrees(size); if (n < 2) err('#DIV/0!'); return tInv(1 - probability(alpha) / 2, n - 1) * positive(sd) / Math.sqrt(n); },
  'Z.TEST': ([range, x, sigma]) => {
    const n = nums([range]);
    if (!n.length) err('#N/A');
    const mean = n.reduce((s, v) => s + v, 0) / n.length;
    const sd = given(sigma) && sigma !== '' ? positive(sigma) : spread([range], 2).sd;
    return 1 - normCdf((mean - toNum(x)) / (sd / Math.sqrt(n.length)));
  },
  ZTEST: (a) => FUNCS['Z.TEST'](a),
  // straight lines and growth curves through points
  TREND: ([ys, xs, newXs]) => { const { y, x, at } = fitArgs(ys, xs, newXs); const l = fitLine(y, x); return mapShape(at, (v) => l.intercept + l.slope * v); },
  GROWTH: ([ys, xs, newXs]) => {
    const { y, x, at } = fitArgs(ys, xs, newXs);
    if (y.some((v) => typeof v === 'number' && v <= 0)) err('#NUM!');
    const l = fitLine(y.map((v) => (typeof v === 'number' ? Math.log(v) : v)), x);
    return mapShape(at, (v) => Math.exp(l.intercept + l.slope * v));
  },
  LINEST: ([ys, xs]) => { const { y, x } = fitArgs(ys, xs); const l = fitLine(y, x); return grid([[l.slope, l.intercept]]); },
  LOGEST: ([ys, xs]) => {
    const { y, x } = fitArgs(ys, xs);
    if (y.some((v) => typeof v === 'number' && v <= 0)) err('#NUM!');
    const l = fitLine(y.map((v) => (typeof v === 'number' ? Math.log(v) : v)), x);
    return grid([[Math.exp(l.slope), Math.exp(l.intercept)]]);
  },
  // rates, loan payments and depreciation
  EFFECT: ([rate, n]) => { const r = toNum(rate), k = Math.trunc(toNum(n)); if (r <= 0 || k < 1) err('#NUM!'); return (1 + r / k) ** k - 1; },
  NOMINAL: ([rate, n]) => { const r = toNum(rate), k = Math.trunc(toNum(n)); if (r <= 0 || k < 1) err('#NUM!'); return k * ((1 + r) ** (1 / k) - 1); },
  IPMT: ([rate, per, n, pv, fv, type]) => { const p = toNum(per), k = toNum(n); if (p < 1 || p > k) err('#NUM!'); return interestPart(toNum(rate), p, k, toNum(pv), toNum(fv), toNum(type) ? 1 : 0); },
  PPMT: ([rate, per, n, pv, fv, type]) => { const p = toNum(per), k = toNum(n); if (p < 1 || p > k) err('#NUM!'); return capitalPart(toNum(rate), p, k, toNum(pv), toNum(fv), toNum(type) ? 1 : 0); },
  CUMIPMT: ([rate, n, pv, start, end, type]) => cumulative(interestPart, rate, n, pv, start, end, type),
  CUMPRINC: ([rate, n, pv, start, end, type]) => cumulative(capitalPart, rate, n, pv, start, end, type),
  ISPMT: ([rate, per, n, pv]) => { const k = toNum(n); if (!k) err('#DIV/0!'); return toNum(pv) * toNum(rate) * (toNum(per) / k - 1); },
  SLN: ([cost, salvage, life]) => { const l = toNum(life); if (!l) err('#DIV/0!'); return (toNum(cost) - toNum(salvage)) / l; },
  SYD: ([cost, salvage, life, per]) => { const l = toNum(life), p = toNum(per); if (l <= 0 || p <= 0 || p > l) err('#NUM!'); return ((toNum(cost) - toNum(salvage)) * (l - p + 1) * 2) / (l * (l + 1)); },
  DDB: ([cost, salvage, life, period, factor]) => {
    const c = toNum(cost), s = toNum(salvage), l = toNum(life), p = toNum(period), f = given(factor) ? toNum(factor) : 2;
    if (c < 0 || s < 0 || l <= 0 || p <= 0 || p > l || f <= 0) err('#NUM!');
    return ddb(c, s, l, p, f);
  },
  DB: ([cost, salvage, life, period, month]) => {
    const c = toNum(cost), s = toNum(salvage), l = Math.trunc(toNum(life)), p = Math.trunc(toNum(period)), m = given(month) ? Math.trunc(toNum(month)) : 12;
    if (c <= 0 || s < 0 || l < 1 || p < 1 || m < 1 || m > 12 || p > (m < 12 ? l + 1 : l)) err('#NUM!');
    return db(c, s, l, p, m);
  },
  // dates in words, times, fractions of a year
  DATEVALUE: ([v]) => (dateMs(v) - EXCEL_EPOCH) / DAY_MS,
  TIMEVALUE: ([v]) => { if (typeof v === 'number') return v - Math.floor(v); const t = parseTimeText(toStr(v)); if (t === null) err('#VALUE!'); return t; },
  TO_DATE: ([v]) => (typeof v === 'number' ? serialDate(v) : v),
  ISDATE: ([v]) => dateSerial(v) !== null,
  // A Unix time (seconds since 1 January 1970, UTC; unit 2 for milliseconds, 3 for microseconds) as a date and time.
  EPOCHTODATE: ([t, unit]) => {
    const u = given(unit) ? Math.trunc(toNum(unit)) : 1, x = toNum(t);
    if (u < 1 || u > 3 || x < 0) err('#NUM!');
    return serialDate((Date.UTC(1970, 0, 1) - EXCEL_EPOCH) / DAY_MS + x / [1, 1e3, 1e6][u - 1] / 86400);
  },
  // bonds paying coupons: the coupon dates and days around settlement, price, yield and duration
  COUPPCD: ([s, m, f, basis]) => dateText(coupons(s, m, f, basis).pcd),
  COUPNCD: ([s, m, f, basis]) => dateText(coupons(s, m, f, basis).ncd),
  COUPNUM: ([s, m, f, basis]) => coupons(s, m, f, basis).count,
  COUPDAYS: ([s, m, f, basis]) => coupons(s, m, f, basis).periodDays,
  COUPDAYBS: ([s, m, f, basis]) => coupons(s, m, f, basis).sinceLast,
  COUPDAYSNC: ([s, m, f, basis]) => coupons(s, m, f, basis).toNext,
  PRICE: ([s, m, rate, yld, redemption, f, basis]) => {
    const r = toNum(rate), y = toNum(yld), red = positiveNum(redemption);
    if (r < 0 || y < 0) err('#NUM!');
    return bondPrice(coupons(s, m, f, basis), r, y, red);
  },
  YIELD: ([s, m, rate, pr, redemption, f, basis]) => {
    const r = toNum(rate), p = positiveNum(pr), red = positiveNum(redemption), c = coupons(s, m, f, basis);
    if (r < 0) err('#NUM!');
    let lo = 0, hi = 1;
    while (bondPrice(c, r, hi, red) > p) { hi *= 2; if (hi > 1e6) err('#NUM!'); }
    if (bondPrice(c, r, lo, red) < p) err('#NUM!'); // (a price above every yield's: a negative yield)
    for (let i = 0; i < 200 && hi - lo > 1e-15; i++) { const mid = (lo + hi) / 2; if (bondPrice(c, r, mid, red) > p) lo = mid; else hi = mid; }
    return (lo + hi) / 2;
  },
  DURATION: ([s, m, coupon, yld, f, basis]) => {
    const r = toNum(coupon), y = toNum(yld);
    if (r < 0 || y < 0) err('#NUM!');
    return bondDuration(coupons(s, m, f, basis), r, y);
  },
  MDURATION: ([s, m, coupon, yld, f, basis]) => {
    const r = toNum(coupon), y = toNum(yld);
    if (r < 0 || y < 0) err('#NUM!');
    const c = coupons(s, m, f, basis);
    return bondDuration(c, r, y) / (1 + y / c.f);
  },
  // securities paying their interest at maturity
  ACCRINTM: ([issue, settlement, rate, par, basis]) => {
    const i = Math.floor(dateMs(issue) / DAY_MS) * DAY_MS, s = Math.floor(dateMs(settlement) / DAY_MS) * DAY_MS;
    const r = positiveNum(rate), p = given(par) && par !== '' ? positiveNum(par) : 1000, b = given(basis) && basis !== '' ? Math.trunc(toNum(basis)) : 0;
    if (i >= s || b < 0 || b > 4) err('#NUM!');
    return p * r * yearFrac(i, s, b);
  },
  PRICEMAT: ([s, m, issue, rate, yld, basis]) => {
    const r = toNum(rate), y = toNum(yld), t = maturityTerms(s, m, issue, basis);
    if (r < 0 || y < 0) err('#NUM!');
    return (100 + t.dim * r * 100) / (1 + t.dsm * y) - t.a * r * 100;
  },
  YIELDMAT: ([s, m, issue, rate, pr, basis]) => {
    const r = toNum(rate), p = positiveNum(pr), t = maturityTerms(s, m, issue, basis);
    if (r < 0) err('#NUM!');
    return ((1 + t.dim * r) / (p / 100 + t.a * r) - 1) / t.dsm;
  },
  // discounted securities and Treasury bills
  DISC: ([s, m, pr, redemption, basis]) => { const p = positiveNum(pr), r = positiveNum(redemption); return (r - p) / r / securityTerm(s, m, basis).years; },
  INTRATE: ([s, m, investment, redemption, basis]) => { const i = positiveNum(investment), r = positiveNum(redemption); return (r - i) / i / securityTerm(s, m, basis).years; },
  RECEIVED: ([s, m, investment, discount, basis]) => {
    const i = positiveNum(investment), d = positiveNum(discount), left = 1 - d * securityTerm(s, m, basis).years;
    if (left <= 0) err('#NUM!');
    return i / left;
  },
  PRICEDISC: ([s, m, discount, redemption, basis]) => { const d = positiveNum(discount), r = positiveNum(redemption); return r - d * r * securityTerm(s, m, basis).years; },
  YIELDDISC: ([s, m, pr, redemption, basis]) => { const p = positiveNum(pr), r = positiveNum(redemption); return (r - p) / p / securityTerm(s, m, basis).years; },
  TBILLPRICE: ([s, m, discount]) => { const d = positiveNum(discount), p = 100 * (1 - (d * tbillDays(s, m)) / 360); if (p <= 0) err('#NUM!'); return p; },
  TBILLYIELD: ([s, m, pr]) => { const p = positiveNum(pr); return ((100 - p) / p) * (360 / tbillDays(s, m)); },
  TBILLEQ: ([s, m, discount]) => {
    const d = positiveNum(discount), n = tbillDays(s, m);
    if (n <= 182) return (365 * d) / (360 - d * n);
    const price = 100 * (1 - (d * n) / 360); // over half a year: the bond-equivalent yield of that price
    if (price <= 0) err('#NUM!');
    const a = (n / 365 - 0.5) / 2, b = n / 365, c = (price - 100) / price; // price × (1 + y/2)(1 + y(n/365 − ½)) = 100
    return (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
  },
  YEARFRAC: ([start, end, basis]) => { const b = given(basis) ? Math.trunc(toNum(basis)) : 0; if (b < 0 || b > 4) err('#NUM!'); return yearFrac(dateMs(start), dateMs(end), b); },
  // text and information
  ISURL: ([v]) => typeof v === 'string' && /^(https?|ftp):\/\/[^\s/$.?#][^\s]*$|^(www\.)[^\s.]+\.[^\s]+$/i.test(v.trim()),
  ISEMAIL: ([v]) => typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v.trim()),
  ENCODEURL: ([v]) => encodeURIComponent(toStr(v)),
  ARABIC: ([v]) => {
    const t = toStr(v).trim().toUpperCase(), neg = t.startsWith('-'), s = neg ? t.slice(1) : t;
    if (!/^[MDCLXVI]*$/.test(s)) err('#VALUE!');
    const val = { M: 1000, D: 500, C: 100, L: 50, X: 10, V: 5, I: 1 };
    let n = 0;
    for (let i = 0; i < s.length; i++) n += val[s[i]] < (val[s[i + 1]] || 0) ? -val[s[i]] : val[s[i]];
    return neg ? -n : n;
  },
  DECIMAL: ([v, radix]) => { const r = Math.trunc(toNum(radix)); if (r < 2 || r > 36) err('#NUM!'); return fromBase(v, r); },
  ADDRESS: ([row, col, abs, a1, sheet]) => {
    const r = Math.trunc(toNum(row)), c = Math.trunc(toNum(col)), mode = given(abs) ? Math.trunc(toNum(abs)) : 1;
    if (r < 1 || c < 1 || mode < 1 || mode > 4) err('#VALUE!');
    const absRow = mode === 1 || mode === 2, absCol = mode === 1 || mode === 3;
    const ref = given(a1) && !toBool(a1)
      ? `R${absRow ? r : `[${r}]`}C${absCol ? c : `[${c}]`}`
      : `${absCol ? '$' : ''}${colName(c - 1)}${absRow ? '$' : ''}${r}`;
    return given(sheet) && sheet !== '' ? `${sheetPrefix(toStr(sheet))}!${ref}` : ref;
  },
  // arrays
  ARRAYFORMULA: ([v]) => v,
  // TRIMRANGE(range, [rows], [columns]): the range without its empty rows and columns at the edges
  // (0 none, 1 at the start, 2 at the end, 3 both, the default).
  TRIMRANGE: ([range, tr, tc]) => {
    const rows = rowsOf(range), how = (v) => { const k = given(v) && v !== '' ? Math.trunc(toNum(v)) : 3; if (k < 0 || k > 3) err('#VALUE!'); return k; };
    const r = how(tr), c = how(tc), blank = (v) => v === null || v === undefined || v === '';
    let top = 0, bottom = rows.length - 1, left = 0, right = (rows[0]?.length ?? 0) - 1;
    const emptyRow = (i) => rows[i].every(blank), emptyCol = (j) => rows.every((row) => blank(row[j]));
    if (r & 1) while (top <= bottom && emptyRow(top)) top++;
    if (r & 2) while (bottom >= top && emptyRow(bottom)) bottom--;
    if (c & 1) while (left <= right && emptyCol(left)) left++;
    if (c & 2) while (right >= left && emptyCol(right)) right--;
    if (top > bottom || left > right) err('#REF!');
    return grid(rows.slice(top, bottom + 1).map((row) => row.slice(left, right + 1)));
  },
  MMULT: ([a, b]) => {
    const x = rowsOf(a), y = rowsOf(b);
    if (!x.length || !y.length || x[0].length !== y.length) err('#VALUE!');
    if (x.length * y[0].length > MAX_CELLS) err('#NUM!');
    const all = [...x.flat(), ...y.flat()];
    if (all.some((v) => typeof v !== 'number')) err('#VALUE!');
    return grid(x.map((row) => y[0].map((_, j) => row.reduce((s, v, k) => s + v * y[k][j], 0))));
  },
  SORTN: ([array, n, ties, col, asc]) => {
    const rows = rowsOf(array), k = given(n) && n !== '' ? Math.trunc(toNum(n)) : 1, mode = given(ties) && ties !== '' ? Math.trunc(toNum(ties)) : 0;
    const c = given(col) && col !== '' ? Math.trunc(toNum(col)) - 1 : 0, up = !given(asc) || asc === '' || toBool(asc);
    if (k < 0 || mode < 0 || mode > 3 || c < 0 || c >= (rows[0]?.length || 0)) err('#VALUE!');
    const sorted = rows.map((r, i) => [r, i]).sort((p, q) => (up ? order(p[0][c], q[0][c]) : order(q[0][c], p[0][c])) || p[1] - q[1]).map(([r]) => r);
    const key = (r) => JSON.stringify(r.map((v) => (typeof v === 'string' ? v.toLowerCase() : v)));
    let out;
    if (mode === 1) { const last = sorted[k - 1]; out = last ? sorted.filter((r, i) => i < k || same(r[c], last[c])) : sorted; } // ties with the last one too
    else if (mode === 2) { const seen = new Set(); out = sorted.filter((r) => { const x = key(r); if (seen.has(x)) return false; seen.add(x); return true; }).slice(0, k); } // no repeated rows
    else if (mode === 3) { const vals = []; out = sorted.filter((r) => { if (!vals.some((v) => same(v, r[c]))) { if (vals.length >= k) return false; vals.push(r[c]); } return true; }); } // the first n values, with all their rows
    else out = sorted.slice(0, k);
    if (!out.length) err('#N/A');
    return grid(out);
  },
  COUNTUNIQUEIFS: ([range, ...a]) => {
    const ok = multi(a, range), v = flat([range]);
    return new Set(v.filter((x, i) => ok(i) && x !== null && x !== '' && x !== undefined).map((x) => (typeof x === 'string' ? `s:${x.toLowerCase()}` : `${typeof x}:${x}`))).size;
  },
  // database functions: =DSUM(A1:D50, "Amount", F1:G2)
  DSUM: ([d, f, c]) => nums(dbValues(d, f, c)).reduce((s, x) => s + x, 0),
  DCOUNT: ([d, f, c]) => nums(dbValues(d, f, c)).length,
  DCOUNTA: ([d, f, c]) => dbValues(d, f, c).filter((x) => x !== null && x !== '').length,
  DAVERAGE: ([d, f, c]) => { const n = nums(dbValues(d, f, c)); if (!n.length) err('#DIV/0!'); return n.reduce((s, x) => s + x, 0) / n.length; },
  DMAX: ([d, f, c]) => { const n = nums(dbValues(d, f, c)); return n.length ? Math.max(...n) : 0; },
  DMIN: ([d, f, c]) => { const n = nums(dbValues(d, f, c)); return n.length ? Math.min(...n) : 0; },
  DPRODUCT: ([d, f, c]) => nums(dbValues(d, f, c)).reduce((s, x) => s * x, 1),
  DGET: ([d, f, c]) => { const v = dbValues(d, f, c); if (!v.length) err('#VALUE!'); if (v.length > 1) err('#NUM!'); return v[0]; },
});

// More of Excel's functions: distributions (and their inverses), matrices, bases, database statistics, depreciation.
/** x where f(x) = p, for f rising from lo to hi (bisection; the inverse distributions). */
function inverse(f, p, lo, hi) {
  let a = lo, b = hi;
  while (f(b) < p && b < 1e10) b *= 2;
  for (let i = 0; i < 200; i++) { const m = (a + b) / 2; if (f(m) < p) a = m; else b = m; if (b - a < 1e-12 * Math.max(1, Math.abs(m))) break; }
  return (a + b) / 2;
}
const fCdf = (x, d1, d2) => (x <= 0 ? 0 : betaI(d1 / 2, d2 / 2, (d1 * x) / (d1 * x + d2)));
const gammaCdf = (x, a, b) => (x <= 0 ? 0 : gammaP(a, x / b));
const hypgeom = (k, n, K, N) => Math.exp(lnChoose(K, k) + lnChoose(N - K, n - k) - lnChoose(N, n));
const lnChoose = (n, k) => lnGamma(n + 1) - lnGamma(k + 1) - lnGamma(n - k + 1);
/** A square matrix of numbers from a range or array, or #VALUE!. */
function squareOf(a) {
  const m = rowsOf(a);
  if (!m.length || m.some((r) => r.length !== m.length || r.some((v) => typeof v !== 'number'))) err('#VALUE!');
  return m.map((r) => [...r]);
}
/** Gaussian elimination: { det, inv } of a square matrix (inv null when it has none). */
function eliminate(m) {
  const n = m.length, a = m.map((r, i) => [...r, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  let det = 1;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    if (Math.abs(a[p][c]) < 1e-12) return { det: 0, inv: null };
    if (p !== c) { [a[p], a[c]] = [a[c], a[p]]; det = -det; }
    det *= a[c][c];
    const d = a[c][c];
    for (let j = 0; j < 2 * n; j++) a[c][j] /= d;
    for (let r = 0; r < n; r++) if (r !== c) { const f = a[r][c]; if (f) for (let j = 0; j < 2 * n; j++) a[r][j] -= f * a[c][j]; }
  }
  return { det, inv: a.map((r) => r.slice(n)) };
}
const valuesA = (a) => flat(a).filter((x) => x !== null && x !== '' && x !== undefined).map((x) => (typeof x === 'number' ? x : typeof x === 'boolean' ? (x ? 1 : 0) : 0));
Object.assign(FUNCS, {
  CSC: ([v]) => { const s = Math.sin(toNum(v)); if (!s) err('#DIV/0!'); return 1 / s; },
  CSCH: ([v]) => { const s = Math.sinh(toNum(v)); if (!s) err('#DIV/0!'); return 1 / s; },
  ERFC: ([v]) => 1 - (toNum(v) < 0 ? -gammaP(0.5, toNum(v) ** 2) : gammaP(0.5, toNum(v) ** 2)),
  FISHERINV: ([v]) => Math.tanh(toNum(v)),
  GAUSS: ([v]) => normCdf(toNum(v)) - 0.5,
  PHI: ([v]) => normPdf(toNum(v)),
  GESTEP: ([v, step]) => (toNum(v) >= toNum(step ?? 0) ? 1 : 0),
  PERMUTATIONA: ([n, k]) => { const a = Math.trunc(toNum(n)), b = Math.trunc(toNum(k)); if (a < 0 || b < 0) err('#NUM!'); return a ** b; },
  'ISO.CEILING': ([v, sig]) => FUNCS['CEILING.MATH']([v, sig ?? 1]),
  'ECMA.CEILING': ([v, sig]) => FUNCS.CEILING([v, sig]),
  NUMBERVALUE: ([v, dec, group]) => {
    const d = given(dec) ? toStr(dec)[0] || '.' : '.', g = given(group) ? toStr(group)[0] || ',' : ',';
    let t = toStr(v).replace(/\s/g, '');
    if (t === '') return 0;
    const pct = (t.match(/%+$/) || [''])[0].length;
    t = t.replace(/%+$/, '').split(g).join('');
    if (d !== '.') t = t.split(d).join('.');
    const n = Number(t);
    if (!t || Number.isNaN(n)) err('#VALUE!');
    return n / 100 ** pct;
  },
  BIN2HEX: ([v, places]) => toBase(fromBase(v, 2, 10), 16, places, 10),
  BIN2OCT: ([v, places]) => toBase(fromBase(v, 2, 10), 8, places, 10),
  HEX2BIN: ([v, places]) => { const n = fromBase(v, 16, 10); if (n < -512 || n > 511) err('#NUM!'); return toBase(n, 2, places, 10); },
  HEX2OCT: ([v, places]) => toBase(fromBase(v, 16, 10), 8, places, 10),
  OCT2BIN: ([v, places]) => { const n = fromBase(v, 8, 10); if (n < -512 || n > 511) err('#NUM!'); return toBase(n, 2, places, 10); },
  OCT2HEX: ([v, places]) => toBase(fromBase(v, 8, 10), 16, places, 10),
  VARA: (a) => variance([valuesA(a)], true),
  VARPA: (a) => variance([valuesA(a)], false),
  STDEVPA: (a) => Math.sqrt(variance([valuesA(a)], false)),
  'SKEW.P': (a) => { const n = nums(a); if (n.length < 3) err('#DIV/0!'); const m = n.reduce((s, x) => s + x, 0) / n.length, sd = Math.sqrt(n.reduce((s, x) => s + (x - m) ** 2, 0) / n.length); if (!sd) err('#DIV/0!'); return n.reduce((s, x) => s + ((x - m) / sd) ** 3, 0) / n.length; },
  'QUARTILE.EXC': ([range, q]) => { const n = Math.trunc(toNum(q)); if (n < 1 || n > 3) err('#NUM!'); return FUNCS['PERCENTILE.EXC']([range, n / 4]); },
  'PERCENTRANK.EXC': ([range, x, significance]) => {
    const n = nums([range]).sort((p, q) => p - q), v = toNum(x), digits = given(significance) ? Math.trunc(toNum(significance)) : 3;
    if (!n.length || digits < 1 || v < n[0] || v > n[n.length - 1]) err('#N/A');
    let pos = n.indexOf(v);
    if (pos < 0) { const i = n.findIndex((y) => y > v) - 1; pos = i + (v - n[i]) / (n[i + 1] - n[i]); }
    const f = 10 ** digits;
    return Math.floor(((pos + 1) / (n.length + 1)) * f + 1e-9) / f;
  },
  'F.DIST': ([x, d1, d2, cumulative]) => {
    const v = toNum(x), a = degrees(d1), b = degrees(d2);
    if (v < 0) err('#NUM!');
    if (toBool(cumulative)) return fCdf(v, a, b);
    if (v === 0) return a < 2 ? Infinity : a === 2 ? 1 : 0;
    return Math.exp(0.5 * a * Math.log(a * v) + 0.5 * b * Math.log(b) - 0.5 * (a + b) * Math.log(a * v + b) - Math.log(v) - (lnGamma(a / 2) + lnGamma(b / 2) - lnGamma((a + b) / 2)));
  },
  'F.DIST.RT': ([x, d1, d2]) => { const v = toNum(x); if (v < 0) err('#NUM!'); return 1 - fCdf(v, degrees(d1), degrees(d2)); },
  'F.INV': ([p, d1, d2]) => { const q = toNum(p); if (q < 0 || q > 1) err('#NUM!'); const a = degrees(d1), b = degrees(d2); return inverse((x) => fCdf(x, a, b), q, 0, 10); },
  'F.INV.RT': ([p, d1, d2]) => { const q = toNum(p); if (q < 0 || q > 1) err('#NUM!'); const a = degrees(d1), b = degrees(d2); return inverse((x) => fCdf(x, a, b), 1 - q, 0, 10); },
  'F.TEST': ([r1, r2]) => {
    const x = nums([r1]), y = nums([r2]);
    if (x.length < 2 || y.length < 2) err('#DIV/0!');
    const vx = variance([x], true), vy = variance([y], true);
    if (!vx || !vy) err('#DIV/0!');
    const f = vx / vy, c = fCdf(f, x.length - 1, y.length - 1);
    return 2 * Math.min(c, 1 - c);
  },
  'CHISQ.INV': ([p, df]) => { const q = toNum(p); if (q < 0 || q >= 1) err('#NUM!'); const d = degrees(df); return inverse((x) => chiCdf(x, d), q, 0, d + 10); },
  'CHISQ.INV.RT': ([p, df]) => { const q = toNum(p); if (q <= 0 || q > 1) err('#NUM!'); const d = degrees(df); return inverse((x) => chiCdf(x, d), 1 - q, 0, d + 10); },
  CHIINV: (a) => FUNCS['CHISQ.INV.RT'](a),
  'GAMMA.DIST': ([x, alpha, beta, cumulative]) => {
    const v = toNum(x), a = positive(alpha), b = positive(beta);
    if (v < 0) err('#NUM!');
    return toBool(cumulative) ? gammaCdf(v, a, b) : (v === 0 ? (a < 1 ? Infinity : a === 1 ? 1 / b : 0) : Math.exp((a - 1) * Math.log(v) - v / b - lnGamma(a) - a * Math.log(b)));
  },
  'GAMMA.INV': ([p, alpha, beta]) => { const q = toNum(p); if (q < 0 || q >= 1) err('#NUM!'); const a = positive(alpha), b = positive(beta); return inverse((x) => gammaCdf(x, a, b), q, 0, a * b + 10 * b); },
  LOGINV: ([p, mean, sd]) => Math.exp(toNum(mean) + positive(sd) * normInv(probability(p))),
  'LOGNORM.INV': ([p, mean, sd]) => Math.exp(toNum(mean) + positive(sd) * normInv(probability(p))),
  LOGNORMDIST: ([x, mean, sd]) => FUNCS['LOGNORM.DIST']([x, mean, sd, true]),
  'HYPGEOM.DIST': ([k, n, K, N, cumulative]) => {
    const a = Math.trunc(toNum(k)), b = Math.trunc(toNum(n)), c = Math.trunc(toNum(K)), d = Math.trunc(toNum(N));
    if (a < 0 || b <= 0 || c <= 0 || d <= 0 || b > d || c > d || a > Math.min(b, c) || a < Math.max(0, b - d + c)) err('#NUM!');
    if (!toBool(cumulative)) return hypgeom(a, b, c, d);
    let s = 0;
    for (let i = Math.max(0, b - d + c); i <= a; i++) s += hypgeom(i, b, c, d);
    return Math.min(1, s);
  },
  'NEGBINOM.DIST': ([f, s, p, cumulative]) => {
    const k = Math.trunc(toNum(f)), r = Math.trunc(toNum(s)), q = toNum(p);
    if (k < 0 || r < 1 || q <= 0 || q >= 1) err('#NUM!');
    const pmf = (i) => Math.exp(lnChoose(i + r - 1, i) + r * Math.log(q) + i * Math.log(1 - q));
    if (!toBool(cumulative)) return pmf(k);
    let t = 0;
    for (let i = 0; i <= k; i++) t += pmf(i);
    return Math.min(1, t);
  },
  // Excel 2007's names for these, as older files have them
  FDIST: (a) => FUNCS['F.DIST.RT'](a),
  FINV: (a) => FUNCS['F.INV.RT'](a),
  FTEST: (a) => FUNCS['F.TEST'](a),
  GAMMADIST: (a) => FUNCS['GAMMA.DIST'](a),
  GAMMAINV: (a) => FUNCS['GAMMA.INV'](a),
  WEIBULL: (a) => FUNCS['WEIBULL.DIST'](a),
  HYPGEOMDIST: ([k, n, K, N]) => FUNCS['HYPGEOM.DIST']([k, n, K, N, false]),
  NEGBINOMDIST: ([f, s, p]) => FUNCS['NEGBINOM.DIST']([f, s, p, false]),
  BETADIST: ([x, a, b, lo, hi]) => FUNCS['BETA.DIST']([x, a, b, true, lo, hi]),
  'BETA.INV': ([p, alpha, beta, lo, hi]) => {
    const q = toNum(p), a = toNum(alpha), b = toNum(beta), A = given(lo) ? toNum(lo) : 0, B = given(hi) ? toNum(hi) : 1;
    if (q <= 0 || q >= 1 || a <= 0 || b <= 0 || B <= A) err('#NUM!');
    let x0 = 0, x1 = 1;
    for (let i = 0; i < 200 && x1 - x0 > 1e-15; i++) { const m = (x0 + x1) / 2; if (betaI(a, b, m) < q) x0 = m; else x1 = m; }
    return A + ((x0 + x1) / 2) * (B - A);
  },
  BETAINV: (a) => FUNCS['BETA.INV'](a),
  // PROB(values, probabilities, lower, [upper]): the chance a value falls from lower to upper (or is lower).
  PROB: ([xs, ps, lower, upper]) => {
    const x = flat([xs]), p = flat([ps]);
    if (x.length !== p.length) err('#N/A');
    const pairs = x.map((v, i) => [v, p[i]]).filter(([v, q]) => typeof v === 'number' && typeof q === 'number');
    if (pairs.some(([, q]) => q < 0 || q > 1) || Math.abs(pairs.reduce((s, [, q]) => s + q, 0) - 1) > 1e-9) err('#NUM!');
    const lo = toNum(lower), hi = given(upper) ? toNum(upper) : lo;
    return pairs.reduce((s, [v, q]) => s + (v >= lo && v <= hi ? q : 0), 0);
  },
  'BINOM.INV': ([n, p, alpha]) => {
    const k = Math.trunc(toNum(n)), q = toNum(p), a = toNum(alpha);
    if (k < 0 || q < 0 || q > 1 || a <= 0 || a >= 1) err('#NUM!');
    for (let i = 0; i <= k; i++) if (binomCdf(i, k, q) >= a - 1e-12) return i;
    return k;
  },
  CRITBINOM: (a) => FUNCS['BINOM.INV'](a),
  'BINOM.DIST.RANGE': ([n, p, s1, s2]) => {
    const k = Math.trunc(toNum(n)), q = toNum(p), a = Math.trunc(toNum(s1)), b = given(s2) ? Math.trunc(toNum(s2)) : a;
    if (k < 0 || q < 0 || q > 1 || a < 0 || b < a || b > k) err('#NUM!');
    let t = 0;
    for (let i = a; i <= b; i++) t += binomPmf(i, k, q);
    return t;
  },
  PDURATION: ([rate, pv, fv]) => { const r = toNum(rate), a = toNum(pv), b = toNum(fv); if (r <= 0 || a <= 0 || b <= 0) err('#NUM!'); return (Math.log(b) - Math.log(a)) / Math.log(1 + r); },
  DOLLARDE: ([v, frac]) => { const f = Math.trunc(toNum(frac)); if (f < 1) err(f < 0 ? '#NUM!' : '#DIV/0!'); const x = toNum(v), i = Math.trunc(x), digits = 10 ** Math.ceil(Math.log10(f)); return i + ((x - i) * digits) / f; },
  DOLLARFR: ([v, frac]) => { const f = Math.trunc(toNum(frac)); if (f < 1) err(f < 0 ? '#NUM!' : '#DIV/0!'); const x = toNum(v), i = Math.trunc(x), digits = 10 ** Math.ceil(Math.log10(f)); return i + ((x - i) * f) / digits; },
  MDETERM: ([a]) => eliminate(squareOf(a)).det,
  MINVERSE: ([a]) => { const r = eliminate(squareOf(a)); if (!r.inv) err('#NUM!'); return grid(r.inv); },
  MUNIT: ([n]) => { const k = Math.trunc(toNum(n)); if (k < 1 || k * k > MAX_CELLS) err('#VALUE!'); return grid(Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => (i === j ? 1 : 0)))); },
  DSTDEV: ([d, f, c]) => Math.sqrt(variance([nums(dbValues(d, f, c))], true)),
  DSTDEVP: ([d, f, c]) => Math.sqrt(variance([nums(dbValues(d, f, c))], false)),
  DVAR: ([d, f, c]) => variance([nums(dbValues(d, f, c))], true),
  DVARP: ([d, f, c]) => variance([nums(dbValues(d, f, c))], false),
  // VDB: declining balance between two periods, switching to straight line when that's more (unless told not to).
  VDB: ([cost, salvage, life, start, end, factor, noSwitch]) => {
    const c = toNum(cost), s = toNum(salvage), l = toNum(life), a = toNum(start), b = toNum(end), f = given(factor) ? toNum(factor) : 2, ns = given(noSwitch) && toBool(noSwitch);
    if (c < 0 || s < 0 || l <= 0 || a < 0 || b < a || b > l || f <= 0) err('#NUM!');
    let value = c, total = 0;
    for (let p = 0; p < Math.ceil(b); p++) {
      const ddbPart = Math.min(value * (f / l), Math.max(0, value - s));
      const slPart = (value - s) / (l - p);
      const dep = !ns && slPart > ddbPart ? Math.max(0, slPart) : ddbPart;
      const from = Math.max(a, p), to = Math.min(b, p + 1);
      if (to > from) total += dep * (to - from);
      value -= dep;
    }
    return total;
  },
  // AGGREGATE(function, options, range…): one of 19 totals, skipping error cells when options says so (2, 3, 6, 7),
  // as Excel's =AGGREGATE(9, 6, B2:B50) sums a column with #N/A in it. (Hidden rows count here, as with SUBTOTAL.)
  // 14–19 take a k: =AGGREGATE(14, 6, B2:B50, 2) is the second largest.
  AGGREGATE: ([fn, options, ...rest]) => {
    const n = Math.trunc(toNum(fn)), o = given(options) ? Math.trunc(toNum(options)) : 0;
    const name = [null, 'AVERAGE', 'COUNT', 'COUNTA', 'MAX', 'MIN', 'PRODUCT', 'STDEV.S', 'STDEV.P', 'SUM', 'VAR.S', 'VAR.P', 'MEDIAN', 'MODE.SNGL', 'LARGE', 'SMALL', 'PERCENTILE.INC', 'QUARTILE.INC', 'PERCENTILE.EXC', 'QUARTILE.EXC'][n];
    if (!name || o < 0 || o > 7 || !rest.length) err('#VALUE!');
    const skipErrors = [2, 3, 6, 7].includes(o);
    const clean = (v) => { const all = Array.isArray(v) ? [...v] : [v]; return skipErrors ? all.filter((x) => !isErr(x)) : all; };
    if (n >= 14) {
      if (rest.length < 2) err('#VALUE!');
      return FUNCS[name]([clean(rest[0]), rest[1]]);
    }
    return FUNCS[name](rest.map(clean));
  },
  VALUETOTEXT: ([v, format]) => (typeof v === 'string' && given(format) && toNum(format) === 1 ? `"${v.replace(/"/g, '""')}"` : toStr(v)),
  ARRAYTOTEXT: ([v, format]) => {
    const strict = given(format) && toNum(format) === 1, rows = Array.isArray(v) ? rowsOf(v) : [[v]];
    const one = (x) => (strict && typeof x === 'string' ? `"${x.replace(/"/g, '""')}"` : toStr(x));
    return strict ? `{${rows.map((r) => r.map(one).join(',')).join(';')}}` : rows.flat().map(one).join(', ');
  },
});
function cumulative(part, rate, n, pv, start, end, type) {
  const r = toNum(rate), k = Math.trunc(toNum(n)), v = toNum(pv), a = Math.trunc(toNum(start)), b = Math.trunc(toNum(end)), t = toNum(type);
  if (r <= 0 || k <= 0 || v <= 0 || a < 1 || b < a || b > k || (t !== 0 && t !== 1)) err('#NUM!');
  let s = 0;
  for (let p = a; p <= b; p++) s += part(r, p, k, v, 0, t);
  return s;
}

// Lazily evaluated (short-circuit) functions receive thunks.
const LAZY = {
  IFS: (a) => { for (let i = 0; i + 1 < a.length; i += 2) if (toBool(a[i]())) return a[i + 1](); return err('#N/A'); },
  SWITCH: ([x, ...a]) => { const v = x(); for (let i = 0; i + 1 < a.length; i += 2) if (same(v, a[i]())) return a[i + 1](); return a.length % 2 ? a[a.length - 1]() : err('#N/A'); },
  IFNA: ([v, fallback]) => { try { return v(); } catch (e) { if (e instanceof FormulaError && e.code === '#N/A') return fallback ? fallback() : ''; throw e; } },
  ISERROR: ([v]) => { try { v(); return false; } catch (e) { if (e instanceof FormulaError) return true; throw e; } },
  ISNA: ([v]) => { try { v(); return false; } catch (e) { if (e instanceof FormulaError) return e.code === '#N/A'; throw e; } },
  ISERR: ([v]) => { try { v(); return false; } catch (e) { if (e instanceof FormulaError) return e.code !== '#N/A'; throw e; } },
  'ERROR.TYPE': ([v]) => {
    try { v(); } catch (e) { if (e instanceof FormulaError) { const n = ['#NULL!', '#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#NUM!', '#N/A', '#GETTING_DATA'].indexOf(e.code) + 1; return n || err('#N/A'); } throw e; }
    return err('#N/A');
  },
  IF: ([cond, a, b]) => (toBool(cond()) ? (a ? a() : true) : (b ? b() : false)),
  IFERROR: ([v, fallback]) => { try { return v(); } catch (e) { if (e instanceof FormulaError) return fallback ? fallback() : ''; throw e; } },
};

// Functions of single values work cell by cell when given a range or an array, and fill as many cells:
// =LEN(A2:A9), =IF(B2:B9>100, "big", "small"), =ROUND(C2:C9*1.2, 2), =VLOOKUP(A2:A9, Prices!A:B, 2, FALSE).
// null: every argument; otherwise which ones (VLOOKUP's table stays a table).
const LIFT = Object.fromEntries([
  ...('LEN UPPER LOWER PROPER TRIM CLEAN LEFT RIGHT MID FIND SEARCH SUBSTITUTE REPT EXACT VALUE TEXT CHAR CODE FIXED REGEXMATCH REGEXREPLACE UNICODE UNICHAR DOLLAR ISBETWEEN '
    + 'ABS SIGN SQRT POWER MOD INT ROUND ROUNDUP ROUNDDOWN MROUND CEILING FLOOR EVEN ODD EXP LN LOG LOG10 TRUNC ISODD ISEVEN QUOTIENT FACT '
    + 'YEAR MONTH DAY WEEKDAY WEEKNUM ISOWEEKNUM HOUR MINUTE SECOND DATE TIME DAYS EDATE EOMONTH DATEDIF DATEVALUE TIMEVALUE TO_DATE YEARFRAC '
    + 'ISBLANK ISNUMBER ISTEXT ISURL ISEMAIL NOT ENCODEURL ROMAN ARABIC DEC2BIN DEC2HEX DEC2OCT BIN2DEC HEX2DEC OCT2DEC BASE DECIMAL '
    + 'NORM.DIST NORM.S.DIST NORM.INV NORM.S.INV STANDARDIZE BINOM.DIST POISSON.DIST EXPON.DIST T.DIST T.INV IF IFERROR IFNA ISERROR IFS SWITCH').split(' ').map((n) => [n, null]),
  ['VLOOKUP', [0]], ['HLOOKUP', [0]], ['MATCH', [0]], ['XMATCH', [0]], ['COUNTIF', [1]], ['SUMIF', [1]], ['AVERAGEIF', [1]],
].filter(([n]) => FUNCS[n] || LAZY[n]));
const lifts = (which, i) => !which || which.includes(i);
/** Whether a call works cell by cell over an argument that may be several cells. */
const liftsArray = (n) => n.name in LIFT && n.args.some((a, i) => lifts(LIFT[n.name], i) && mayArray(a));

/**
 * Functions that take a LAMBDA: MAP(range…, LAMBDA(v…, …)) for each cell; BYROW / BYCOL for each row or
 * column; REDUCE(start, range, LAMBDA(total, v, …)) and SCAN (every step); MAKEARRAY(rows, cols, LAMBDA(r, c, …)).
 */
const LAMBDA_USERS = {
  // PIVOTBY(row_fields, col_fields, values, function, [field_headers], [row_total_depth], [row_sort_order],
  // [col_total_depth], [col_sort_order], [filter_array]): a pivot table — one row per row field, one column per column
  // field, each cell the values of both summed up by the function, with totals.
  PIVOTBY: (args, { evaluate, lambdaArg }) => {
    if (args.length < 4 || args.length > 10) err('#N/A');
    const opt = (i) => (args[i] && args[i].k !== 'empty' ? scalarOf(evaluate(args[i])) : null);
    let rk = rowsOf(evaluate(args[0])), ck = rowsOf(evaluate(args[1])), vals = rowsOf(evaluate(args[2]));
    const f = lambdaArg(args[3], 1);
    if (rk.length !== vals.length || ck.length !== vals.length || !vals.length) err('#VALUE!');
    if (rk[0].length !== 1 || ck[0].length !== 1 || vals[0].length !== 1) err('#VALUE!'); // one field and one column of values each
    const hasHeaders = typeof vals[0][0] === 'string' && vals.length > 1 && typeof vals[1][0] === 'number';
    const headerMode = opt(4) === null ? (hasHeaders ? 3 : 0) : Math.trunc(toNum(opt(4)));
    if (![0, 1, 3].includes(headerMode)) err('#VALUE!');
    const depth = (i) => { const d = opt(i) === null ? 1 : Math.trunc(toNum(opt(i))); if (![0, 1, -1].includes(d)) err('#VALUE!'); return d; };
    const dir = (i) => { const d = opt(i) === null ? 1 : Math.sign(toNum(opt(i))); if (!d) err('#VALUE!'); return d; };
    const rowTotal = depth(5), rowDir = dir(6), colTotal = depth(7), colDir = dir(8);
    let corner = null;
    if (headerMode) { corner = rk[0][0]; rk = rk.slice(1); ck = ck.slice(1); vals = vals.slice(1); }
    if (args[9] && args[9].k !== 'empty') {
      const keep = rowsOf(evaluate(args[9])).map((r) => toBool(r[0] ?? false));
      if (keep.length !== vals.length) err('#VALUE!');
      [rk, ck, vals] = [rk, ck, vals].map((a) => a.filter((_, i) => keep[i]));
    }
    if (!vals.length) err('#CALC!');
    const idOf = (v) => (typeof v === 'string' ? `s${v.toLowerCase()}` : `v${v ?? ''}`);
    const distinct = (keys, sign) => { // each once, as first written
      const seen = new Map();
      for (const [k] of keys) if (!seen.has(idOf(k))) seen.set(idOf(k), k);
      return [...seen.values()].sort((a, b) => sign * order(a, b));
    };
    const rows = distinct(rk, rowDir), cols = distinct(ck, colDir);
    const cell = (pick) => { const xs = vals.filter((_, i) => pick(i)).map((v) => [v[0]]); return xs.length ? scalarOf(f(grid(xs))) : null; };
    const colIds = cols.map(idOf), header = [corner, ...cols];
    if (colTotal) colTotal > 0 ? header.push('Total') : header.splice(1, 0, 'Total');
    const line = (label, inRow) => {
      const parts = colIds.map((id) => cell((i) => inRow(i) && idOf(ck[i][0]) === id));
      const all = cell(inRow);
      return [label, ...(colTotal > 0 ? [...parts, all] : colTotal < 0 ? [all, ...parts] : parts)];
    };
    let body = rows.map((r) => line(r, (i) => idOf(rk[i][0]) === idOf(r)));
    if (rowTotal) { const t = line('Total', () => true); body = rowTotal > 0 ? [...body, t] : [t, ...body]; }
    return grid([header, ...body]);
  },
  // GROUPBY(row_fields, values, function, [field_headers], [total_depth], [sort_order], [filter_array]): the values
  // summed up (or averaged, counted…: a LAMBDA or a function's name such as SUM) for each different row field.
  GROUPBY: (args, { evaluate, lambdaArg }) => {
    if (args.length < 3 || args.length > 7) err('#N/A');
    const opt = (i) => (args[i] && args[i].k !== 'empty' ? scalarOf(evaluate(args[i])) : null);
    let keys = rowsOf(evaluate(args[0])), vals = rowsOf(evaluate(args[1]));
    const f = lambdaArg(args[2], 1);
    if (keys.length !== vals.length || !keys.length) err('#VALUE!');
    const hasHeaders = (v) => typeof v[0][0] === 'string' && v.length > 1 && typeof v[1][0] === 'number';
    const headerMode = opt(3) === null ? (hasHeaders(vals) ? 3 : 0) : Math.trunc(toNum(opt(3)));
    if (![0, 1, 3].includes(headerMode)) err('#VALUE!');
    const total = opt(4) === null ? 1 : Math.trunc(toNum(opt(4)));
    if (![0, 1, -1].includes(total) && !(Math.abs(total) === 2 && keys[0].length === 1)) err('#VALUE!');
    let heads = null;
    if (headerMode) { heads = [...keys[0], ...vals[0]]; keys = keys.slice(1); vals = vals.slice(1); }
    if (args[6] && args[6].k !== 'empty') {
      const keep = rowsOf(evaluate(args[6])).map((r) => toBool(r[0] ?? false));
      if (keep.length !== keys.length) err('#VALUE!');
      keys = keys.filter((_, i) => keep[i]); vals = vals.filter((_, i) => keep[i]);
    }
    if (!keys.length) err('#CALC!');
    const groups = new Map();
    keys.forEach((k, i) => {
      const id = JSON.stringify(k.map((v) => (typeof v === 'string' ? v.toLowerCase() : v ?? '')));
      if (!groups.has(id)) groups.set(id, { keys: k, rows: [] });
      groups.get(id).rows.push(vals[i]);
    });
    const width = vals[0].length;
    const sum = (rows) => Array.from({ length: width }, (_, j) => scalarOf(f(grid(rows.map((r) => [r[j] ?? null])))));
    let out = [...groups.values()].map((g) => [...g.keys, ...sum(g.rows)]);
    const by = opt(5) === null ? null : Math.trunc(toNum(opt(5)));
    if (by !== null && (by === 0 || Math.abs(by) > keys[0].length + width)) err('#VALUE!');
    out.sort((a, b) => {
      if (by !== null) return Math.sign(by) * order(a[Math.abs(by) - 1], b[Math.abs(by) - 1]);
      for (let c = 0; c < keys[0].length; c++) { const d = order(a[c], b[c]); if (d) return d; }
      return 0;
    });
    if (total) {
      const row = ['Total', ...Array(keys[0].length - 1).fill(null), ...sum(vals)];
      out = total > 0 ? [...out, row] : [row, ...out];
    }
    if (headerMode === 3) out = [heads, ...out];
    return grid(out);
  },
  MAP: (args, { evaluate, lambdaArg }) => {
    if (args.length < 2) err('#N/A');
    const ranges = args.slice(0, -1).map(evaluate).map(shapeOf), f = lambdaArg(args[args.length - 1], ranges.length);
    const { rows, cols } = ranges[0];
    if (ranges.some((x) => x.rows !== rows || x.cols !== cols)) err('#VALUE!');
    return grid(Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => scalarOf(f(...ranges.map((x) => x.at(r, c) ?? null))))));
  },
  BYROW: ([range, l], { evaluate, lambdaArg }) => {
    const rows = rowsOf(evaluate(range)), f = lambdaArg(l, 1);
    return grid(rows.map((row) => { const a = grid([row]); return [scalarOf(f(a))]; }));
  },
  BYCOL: ([range, l], { evaluate, lambdaArg }) => {
    const rows = rowsOf(evaluate(range)), f = lambdaArg(l, 1);
    return grid([(rows[0] || []).map((_, c) => scalarOf(f(grid(rows.map((row) => [row[c]])))))]);
  },
  REDUCE: ([start, range, l], { evaluate, lambdaArg }) => {
    const f = lambdaArg(l, 2);
    return flat([evaluate(range)]).reduce((acc, v) => scalarOf(f(acc, v ?? null)), scalarOf(evaluate(start)));
  },
  SCAN: ([start, range, l], { evaluate, lambdaArg }) => {
    const s = shapeOf(evaluate(range)), f = lambdaArg(l, 2);
    let acc = scalarOf(evaluate(start));
    return grid(Array.from({ length: s.rows }, (_, r) => Array.from({ length: s.cols }, (_, c) => (acc = scalarOf(f(acc, s.at(r, c) ?? null))))));
  },
  MAKEARRAY: ([rows, cols, l], { evaluate, lambdaArg }) => {
    const nr = Math.trunc(toNum(scalarOf(evaluate(rows)))), nc = Math.trunc(toNum(scalarOf(evaluate(cols)))), f = lambdaArg(l, 2);
    if (nr < 1 || nc < 1 || nr * nc > 10000) err('#VALUE!');
    return grid(Array.from({ length: nr }, (_, r) => Array.from({ length: nc }, (_, c) => scalarOf(f(r + 1, c + 1)))));
  },
};

/**
 * A spreadsheet's named functions ([{ name, params, body, description }]) as a Map by name, or null.
 * Names and argument names follow the rules of named ranges; a name taken by a built-in function is skipped.
 */
export const OWN_NAME_RE = /^[A-Z][A-Z0-9_.]{0,39}$/i;
export const OWN_PARAM_RE = /^[A-Z_][A-Z0-9_]{0,29}$/i;
const looksLikeCell = (n) => /^[A-Z]{1,3}\d+$/i.test(n);
export function namedFunctions(list) {
  if (!Array.isArray(list) || !list.length) return null;
  const out = new Map();
  for (const f of list) {
    const name = String(f?.name || '').toUpperCase();
    const params = Array.isArray(f?.params) ? f.params.map((p) => String(p).toUpperCase()) : [];
    if (!OWN_NAME_RE.test(name) || looksLikeCell(name) || FUNCS[name] || LAZY[name] || LAMBDA_USERS[name] || BUILTIN_SPECIAL.has(name) || out.has(name)) continue;
    if (params.length > 10 || params.some((p) => !OWN_PARAM_RE.test(p) || looksLikeCell(p)) || new Set(params).size !== params.length) continue;
    out.set(name, { name, params, body: String(f.body || '').replace(/^=/, ''), description: f.description || '' });
  }
  return out.size ? out : null;
}
const BUILTIN_SPECIAL = new Set(['OFFSET', 'INDIRECT', 'IMPORTRANGE', 'IMPORTDATA', 'IMPORTHTML', 'IMPORTFEED', 'QUERY', 'HYPERLINK', 'SPARKLINE', 'IMAGE', 'ROW', 'COLUMN', 'ROWS', 'COLUMNS', 'LET', 'LAMBDA', 'TRUE', 'FALSE', 'ISFORMULA', 'FORMULATEXT', 'ISREF', 'CELL', 'SHEET', 'SHEETS', 'ISOMITTED']);

/** Every function a formula can call. */
export const FUNCTION_NAMES = [...Object.keys(FUNCS), ...Object.keys(LAZY), ...Object.keys(LAMBDA_USERS), 'OFFSET', 'INDIRECT', 'LET', 'LAMBDA', 'IMPORTRANGE', 'IMPORTDATA', 'IMPORTHTML', 'IMPORTFEED', 'QUERY', 'HYPERLINK', 'SPARKLINE', 'IMAGE', 'ROW', 'COLUMN', 'ROWS', 'COLUMNS', 'ISFORMULA', 'FORMULATEXT', 'ISREF', 'CELL', 'SHEET', 'SHEETS', 'ISOMITTED'];

/** A link a cell may open: web addresses and email (mailto:), nothing else. */
/**
 * The Drive picture an IMAGE formula shows: "drive:<file id>" (what Insert picture in cell writes).
 * Only pictures kept in Workspace: a link to another site would have everyone's browser fetch it.
 */
export function pictureId(src) {
  const m = /^drive:([A-Za-z0-9_-]{4,64})$/.exec(String(src ?? '').trim());
  return m ? m[1] : null;
}

/** The IMAGE formula for a picture: mode 1 fits the cell, 2 stretches, 3 is the picture's own size, 4 is height × width. */
export function imageFormula(id, mode = 1, h = 0, w = 0) {
  const ref = `"drive:${id}"`;
  return mode === 4 ? `=IMAGE(${ref}, 4, ${Math.round(h)}, ${Math.round(w)})` : mode === 1 ? `=IMAGE(${ref})` : `=IMAGE(${ref}, ${mode})`;
}

export function safeLink(v) {
  const t = String(v ?? '').trim();
  if (/^mailto:[^\s@]+@[^\s@]+$/i.test(t)) return t;
  if (/^[^\s@:/]+@[^\s@]+\.[^\s@]+$/.test(t)) return `mailto:${t}`;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(t) ? t : /^[\w-]+(\.[\w-]+)+(\/|$)/.test(t) ? `https://${t}` : null;
  if (!withScheme) return null;
  try { const u = new URL(withScheme); return ['http:', 'https:'].includes(u.protocol) ? u.toString() : null; } catch { return null; }
}

/** The file id in IMPORTRANGE's first argument: a spreadsheet's link (…/sheets/<id>) or the id itself. */
export function importFileId(arg) {
  const t = String(arg ?? '').trim();
  const m = /\/sheets\/([A-Za-z0-9_-]+)/.exec(t);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{6,}$/.test(t) ? t : null;
}

const IMPORT_DEPTH = 3;

/** Convert a raw cell entry into a literal value. */
export function literal(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const t = String(raw).trim();
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) return Number(t);
  if (/^true$/i.test(t)) return true;
  if (/^false$/i.test(t)) return false;
  return String(raw);
}

/**
 * Build an evaluator over a sheet's raw cells ({ "A1": "=SUM(B1:B3)" }).
 * Returns get(key) -> value (number | string | boolean | null) or { error: '#CODE' }.
 */
export function createEvaluator(cells, names = null, book = null, sheetName = null) {
  const memo = new Map();
  // Tables' structured references (Sales[Amount], [@Amount]) as ranges, worked out with the tables as they are now.
  const tables = book ? (book.tables ??= tablesOf(book.sheets)) : [];
  const source = (key, raw) => {
    const f = raw.slice(1);
    if (!tables.length) return f;
    const at = parseRef(key);
    return at ? plainTableRefs(f, tables, at.r + 1, at.c, sheetName) : f;
  };
  // The other sheets (for Sheet2!A1): { sheets: [{ name, cells, names }], open: Map(name -> evaluator) }, shared by them all.
  // Named ranges: { Tax: 'B1', Sales: 'A2:A10' }, matched whatever the case.
  const named = new Map(Object.entries(names || {}).map(([k, v]) => [k.toUpperCase(), String(v).toUpperCase().split(':')]));
  const visiting = new Set();
  let here = null; // the cell being worked out (for ROW() and COLUMN())
  const asts = new Map();
  const links = new Map(), sparks = new Map(), images = new Map(); // HYPERLINK, SPARKLINE and IMAGE cells
  // Spilling: a formula that gives back several cells (=SEQUENCE(5), =FILTER(…), =A1:A5*2) fills the
  // empty cells beside and below it. Those formulas are worked out first, so the cells they fill are
  // known; a cell they'd fill that has something in it shows #SPILL! in the formula's cell instead.
  const spillFrom = new Map(); // filled cell -> { anchor, value }
  let pending = null; // formulas that may spill and haven't been worked out yet (while finding spills)
  const isEmpty = (raw) => raw === undefined || raw === null || raw === '';
  // The rows the sheet hides, for SUBTOTAL 101–111 and AGGREGATE: { all, filtered } (Sets of 0-based rows), from
  // the page (its filter, slicers, Hide row and collapsed groups), worked out once; none known, none left out.
  let hiddenCache = null, findingHidden = false;
  const hiddenHere = () => {
    if (!book?.hiddenRowsOf) return { all: new Set(), filtered: new Set() };
    if (hiddenCache) return hiddenCache;
    if (findingHidden) return { all: new Set(), filtered: new Set() }; // a filter on the totals' own column
    findingHidden = true;
    try {
      const sheet = book.sheets.find((x) => String(x.name).toUpperCase() === String(sheetName ?? '').toUpperCase()) || { cells };
      hiddenCache = book.hiddenRowsOf(sheet, (k) => { try { return valueOf(k); } catch (e) { if (e instanceof FormulaError) return errorValue(e); throw e; } });
    } finally { findingHidden = false; }
    return hiddenCache;
  };

  function findSpills() {
    pending = [];
    for (const [k, raw] of Object.entries(cells)) {
      if (typeof raw !== 'string' || !raw.startsWith('=')) continue;
      try { const ast = asts.get(k) || parse(source(k, raw)); asts.set(k, ast); if (mayArray(ast)) pending.push(k); } catch { /* shows its error when asked */ }
    }
    runPending();
    pending = [];
  }
  function runPending() {
    while (pending.length) {
      const k = pending.shift();
      if (visiting.has(k) || memo.has(k)) continue;
      try { valueOf(k); } catch (e) { if (!(e instanceof FormulaError)) throw e; }
    }
  }

  function valueOf(key) {
    if (pending === null) findSpills();
    if (memo.has(key)) {
      const v = memo.get(key);
      if (v && typeof v === 'object' && v.error) throw new FormulaError(v.error, v.why);
      return v;
    }
    const raw = cells[key];
    if (isEmpty(raw) && pending.length) runPending(); // a formula still to come may fill this cell
    if (typeof raw !== 'string' || !raw.startsWith('=')) {
      const v = isEmpty(raw) && spillFrom.has(key) ? spillFrom.get(key).value : literal(raw);
      memo.set(key, v);
      return v;
    }
    if (visiting.has(key)) err('#CIRC!');
    visiting.add(key);
    try {
      let ast = asts.get(key);
      if (!ast) { ast = parse(source(key, raw)); asts.set(key, ast); }
      let v;
      if (ast.k === 'call' && ast.name === 'HYPERLINK') { // a link: the cell shows its label, and opens it
        const [url, label] = ast.args.map((a) => scalar(evaluate(a)));
        const href = safeLink(url);
        if (!href) err('#VALUE!');
        links.set(key, href);
        v = label === undefined || label === null || label === '' ? href : label;
      } else if (ast.k === 'call' && ast.name === 'IMAGE') { // a picture from Drive shown in the cell
        const [src, mode, h, w] = ast.args.map((a) => scalar(evaluate(a)));
        const id = pictureId(src);
        const m = mode === undefined || mode === null || mode === '' ? 1 : Number(mode);
        if (!id || ![1, 2, 3, 4].includes(m)) err('#VALUE!');
        const size = m === 4 ? { h: Number(h), w: Number(w) } : null;
        if (size && !(size.h > 0 && size.w > 0)) err('#VALUE!');
        images.set(key, { id, mode: m, ...(size && { h: Math.min(size.h, 1000), w: Math.min(size.w, 1000) }) });
        v = '';
      } else if (ast.k === 'call' && ast.name === 'SPARKLINE') { // a little chart drawn in the cell
        const [range, opts] = ast.args.map(evaluate);
        const values = (Array.isArray(range) ? range : [range]).map((x) => (typeof x === 'number' ? x : null));
        const type = String(Array.isArray(opts) ? opts[0] ?? '' : opts ?? '').toLowerCase() === 'column' ? 'column' : 'line';
        if (!values.some((x) => x !== null)) err('#VALUE!');
        sparks.set(key, { type, values: values.slice(0, 200) });
        v = '';
      } else { const outer = here; here = key; try { v = evaluate(ast); } finally { here = outer; } }
      if (typeof v === 'number' && !Number.isFinite(v)) err('#NUM!');
      if (typeof v === 'function') err('#VALUE!'); // a LAMBDA not given anything to work on
      if (Array.isArray(v)) v = spill(key, v);
      if (isErr(v)) raise(v);
      memo.set(key, v);
      return v;
    } catch (e) {
      if (!(e instanceof FormulaError)) throw e;
      memo.set(key, errorValue(e));
      throw e;
    } finally {
      visiting.delete(key);
    }
  }

  /** Fill the cells an array from `key` covers, or #SPILL! if one has something in it; its first value. */
  function spill(key, v) {
    const s = shapeOf(v);
    if (s.rows * s.cols <= 1) return s.rows && s.cols ? s.at(0, 0) ?? null : null;
    const at = parseRef(key);
    const targets = [];
    for (let r = 0; r < s.rows; r++) for (let c = 0; c < s.cols; c++) {
      if (!r && !c) continue;
      const t = cellKey(at.c + c, at.r + r);
      const other = spillFrom.get(t);
      if (!isEmpty(cells[t]) || (other && other.anchor !== key) || (memo.has(t) && !other && memo.get(t) !== null)) err('#SPILL!');
      targets.push([t, s.at(r, c) ?? null]);
    }
    for (const [t, value] of targets) { spillFrom.set(t, { anchor: key, value }); memo.set(t, value); }
    return s.at(0, 0) ?? null;
  }

  function namedValue(v) {
    const t = named.get(v);
    if (!t) err('#NAME?');
    if (t.length === 1 || t[0] === t[1]) { const p = parseRef(t[0]); if (!p) err('#REF!'); return valueOf(cellKey(p.c, p.r)); }
    return range(parseRef(t[0]), parseRef(t[1]));
  }

  function range(a, b) {
    if (!a || !b) err('#REF!');
    const out = [];
    for (let r = Math.min(a.r, b.r); r <= Math.max(a.r, b.r); r++) {
      for (let c = Math.min(a.c, b.c); c <= Math.max(a.c, b.c); c++) out.push(valueOf(cellKey(c, r)));
    }
    out.rows = Math.abs(a.r - b.r) + 1; // its shape, for INDEX, VLOOKUP and the like
    out.cols = Math.abs(a.c - b.c) + 1;
    return out;
  }

  // ---- OFFSET and INDIRECT: references worked out as the formula runs ----
  /** Where a reference points: { sheet (null for this one), a, b } with a the top left corner. */
  function refOf(node) {
    const box = (sheet, a, b) => { if (!a || !b) err('#REF!'); return { sheet, a: { r: Math.min(a.r, b.r), c: Math.min(a.c, b.c) }, b: { r: Math.max(a.r, b.r), c: Math.max(a.c, b.c) } }; };
    switch (node?.k) {
      case 'ref': return box(null, node.ref, node.ref);
      case 'range': return box(null, node.a, node.b);
      case 'xref': return box(node.sheet, node.a, node.b);
      case 'name': {
        const t = named.get(node.v);
        if (!t) err(scopes.some((sc) => sc.has(node.v)) ? '#VALUE!' : '#NAME?');
        return box(null, parseRef(t[0]), parseRef(t[t.length - 1]));
      }
      case 'call':
        if (node.name === 'OFFSET') return offsetRef(node.args);
        if (node.name === 'INDIRECT') return indirectRef(node.args);
        return err('#VALUE!');
      default: return err('#VALUE!');
    }
  }
  /** OFFSET(start, rows, columns, [height], [width]): a reference moved down and across, and resized. */
  function offsetRef(args) {
    if (args.length < 3 || args.length > 5) err('#N/A');
    const base = refOf(args[0]);
    const num = (a, dflt) => { if (!a || a.k === 'empty') return dflt; const v = scalar(evaluate(a)); return v === null || v === undefined || v === '' ? dflt : Math.trunc(toNum(v)); };
    const dr = num(args[1], 0), dc = num(args[2], 0);
    const h = num(args[3], base.b.r - base.a.r + 1), w = num(args[4], base.b.c - base.a.c + 1);
    if (!h || !w) err('#REF!');
    const top = base.a.r + dr + (h < 0 ? h + 1 : 0), left = base.a.c + dc + (w < 0 ? w + 1 : 0);
    if (top < 0 || left < 0) err('#REF!');
    if (Math.abs(h) * Math.abs(w) > MAX_REF_CELLS) err('#NUM!');
    return { sheet: base.sheet, a: { r: top, c: left }, b: { r: top + Math.abs(h) - 1, c: left + Math.abs(w) - 1 } };
  }
  /** INDIRECT("B3"), INDIRECT("Sheet2!A1:A9"), INDIRECT("Prices"), INDIRECT("R2C3", FALSE): a reference written as text. */
  function indirectRef(args) {
    if (!args.length || args.length > 2) err('#N/A');
    const text = toStr(scalar(evaluate(args[0]))).trim();
    const a1 = !args[1] || args[1].k === 'empty' ? true : toBool(scalar(evaluate(args[1])));
    const m = /^(?:'((?:[^']|'')+)'|([A-Z_][A-Z0-9_ .]*))!(.+)$/i.exec(text);
    const sheet = m ? (m[1] !== undefined ? m[1].replace(/''/g, "'") : m[2]) : null;
    const where = (m ? m[3] : text).replace(/\s+/g, '');
    const one = (t) => {
      if (a1) return parseRef(t);
      const rc = /^R(\d+)C(\d+)$/i.exec(t);
      return rc && +rc[1] > 0 && +rc[2] > 0 ? { r: +rc[1] - 1, c: +rc[2] - 1 } : null;
    };
    const [x, y = x] = where.split(':');
    const a = one(x), b = one(y);
    if (a && b) {
      if ((Math.abs(a.r - b.r) + 1) * (Math.abs(a.c - b.c) + 1) > MAX_REF_CELLS) err('#NUM!');
      return refOf({ k: sheet ? 'xref' : 'range', sheet, a, b });
    }
    if (!sheet && a1 && /^[A-Z_][A-Z0-9_]*$/i.test(where) && named.has(where.toUpperCase())) return refOf({ k: 'name', v: where.toUpperCase() });
    return err('#REF!');
  }
  /** The value(s) at a reference from refOf. */
  function readRef({ sheet, a, b }) {
    const single = a.r === b.r && a.c === b.c;
    if (sheet === null) return single ? valueOf(cellKey(a.c, a.r)) : range(a, b);
    const other = book && sheetEvaluator(book, sheet);
    if (!other) err('#REF!');
    return single ? other.cell(cellKey(a.c, a.r)) : other.range(a, b);
  }

  /** A cell-by-cell function given ranges (see LIFT): worked out for each cell, into an array that size. */
  function lifted(n) {
    const which = LIFT[n.name], lazy = LAZY[n.name];
    const vals = n.args.map((a) => { if (a.k === 'empty') return undefined; try { return evaluate(a); } catch (e) { if (e instanceof FormulaError) return errorValue(e); throw e; } });
    const shapes = vals.map((v, i) => (lifts(which, i) && Array.isArray(v) ? shapeOf(v) : null));
    const unwrap = (v) => (isErr(v) ? raise(v) : v);
    const call = (args) => (lazy ? lazy(args.map((v) => () => scalar(unwrap(v)))) : FUNCS[n.name](args.map(unwrap)));
    if (!shapes.some(Boolean)) return call(vals);
    const rows = Math.max(...shapes.map((s) => s?.rows ?? 1)), cols = Math.max(...shapes.map((s) => s?.cols ?? 1));
    if (rows * cols > MAX_REF_CELLS) err('#NUM!');
    const pick = (v, s, r, c) => (!s ? v : (s.rows !== 1 && r >= s.rows) || (s.cols !== 1 && c >= s.cols) ? { error: '#N/A' } : s.at(s.rows === 1 ? 0 : r, s.cols === 1 ? 0 : c) ?? null);
    const cell = (r, c) => {
      try {
        const v = call(vals.map((v, i) => pick(v, shapes[i], r, c)));
        if (typeof v === 'number' && !Number.isFinite(v)) err('#NUM!');
        return Array.isArray(v) ? scalar(v) : v;
      } catch (e) { if (e instanceof FormulaError) return errorValue(e); throw e; }
    };
    return grid(Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => cell(r, c))));
  }

  function evaluate(n) {
    switch (n.k) {
      case 'num': case 'str': case 'bool': return n.v;
      case 'array': return grid(n.rows.map((r) => r.map((x) => { const v = evaluate(x); return Array.isArray(v) ? scalarOf(v) : v; })));
      case 'empty': return undefined;
      case 'referr': return err('#REF!');
      case 'ref': if (!n.ref) err('#REF!'); return valueOf(cellKey(n.ref.c, n.ref.r));
      case 'range': return range(n.a, n.b);
      case 'xref': {
        const other = book && sheetEvaluator(book, n.sheet);
        if (!other || !n.a || !n.b) err('#REF!');
        return n.one ? other.cell(cellKey(n.a.c, n.a.r)) : other.range(n.a, n.b);
      }
      case 'xname': {
        const other = book && sheetEvaluator(book, n.sheet);
        if (!other) err('#REF!');
        return other.named(n.v);
      }
      case 'name': { for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].has(n.v)) { const v = scopes[i].get(n.v); return v === OMITTED ? null : v; } return namedValue(n.v); }
      case 'neg': { const v = evaluate(n.e); return Array.isArray(v) ? elementwise(v, null, (x) => -toNum(x)) : -toNum(v); }
      case 'call': {
        if (n.name === 'IMPORTRANGE') return importRange(n.args.map((a) => scalar(evaluate(a))));
        if (n.name === 'IMPORTDATA' || n.name === 'IMPORTHTML' || n.name === 'IMPORTFEED') return importWebPage(n.name, n.args.map((a) => scalar(evaluate(a))));
        if (n.name === 'QUERY') {
          // Columns go by their letters on the sheet, so where the range starts matters.
          const a = n.args[0];
          if (!a || n.args.length < 2) err('#N/A');
          const first = a.k === 'range' || a.k === 'xref' ? Math.min(a.a.c, a.b.c) : null;
          const h = n.args[2] && n.args[2].k !== 'empty' ? toNum(scalar(evaluate(n.args[2]))) : undefined;
          let out;
          try { out = runQuery(rowsOf(evaluate(a)), toStr(scalar(evaluate(n.args[1]))), h, first); } catch (e) { if (e instanceof QueryError) throw new FormulaError('#VALUE!', e.message); throw e; }
          if (!out) err('#N/A');
          return out.length === 1 && out[0].length === 1 ? out[0][0] : grid(out);
        }
        // SUBTOTAL and AGGREGATE read their ranges themselves: rows the sheet hides can be left out (SUBTOTAL 1–11
        // leaves out rows a filter hides, 101–111 every hidden row, AGGREGATE with options 1, 3, 5 or 7 too), and
        // AGGREGATE keeps error cells as errors, to skip them, rather than stopping at the first.
        if (n.name === 'SUBTOTAL' || n.name === 'AGGREGATE') {
          const [fn, opt, ...more] = n.args;
          const which = fn ? scalar(evaluate(fn)) : undefined, num = Math.trunc(toNum(which));
          const isAgg = n.name === 'AGGREGATE';
          const o = isAgg && opt && opt.k !== 'empty' ? Math.trunc(toNum(scalar(evaluate(opt)))) : 0;
          const hidden = hiddenHere();
          const skip = isAgg ? ([1, 3, 5, 7].includes(o) ? hidden.all : null) : num > 100 ? hidden.all : hidden.filtered;
          // Other SUBTOTAL and AGGREGATE cells in the range are left out (always for SUBTOTAL, options 0–3 for AGGREGATE),
          // so a grand total over rows with subtotals in them doesn't count anything twice.
          const nested = !isAgg || o <= 3;
          const isTotal = (key) => nested && typeof cells[key] === 'string' && /^=\s*(SUBTOTAL|AGGREGATE)\s*\(/i.test(cells[key]);
          const read = (a, soft) => {
            if (a.k !== 'range') { try { return evaluate(a); } catch (e) { if (soft && e instanceof FormulaError) return errorValue(e); throw e; } }
            if (!a.a || !a.b) err('#REF!');
            const out = [];
            for (let r = Math.min(a.a.r, a.b.r); r <= Math.max(a.a.r, a.b.r); r++) {
              if (skip?.has(r)) continue;
              for (let c = Math.min(a.a.c, a.b.c); c <= Math.max(a.a.c, a.b.c); c++) {
                if (isTotal(cellKey(c, r))) continue;
                try { out.push(valueOf(cellKey(c, r))); } catch (e) { if (soft && e instanceof FormulaError) out.push(errorValue(e)); else throw e; }
              }
            }
            return out;
          };
          if (!isAgg) return FUNCS.SUBTOTAL([which, ...[opt, ...more].filter(Boolean).map((a) => read(a, false))]);
          const withK = num >= 14; // 14–19: a range, then k
          return FUNCS.AGGREGATE([which, o, ...more.map((a, i) => (!withK || i === 0 ? read(a, true) : evaluate(a)))]);
        }
        if (n.name === 'OFFSET' || n.name === 'INDIRECT') return readRef(refOf(n));
        // Where cells are: ROW()/COLUMN() of this cell, or of a reference (a range gives its first); ROWS/COLUMNS count a range.
        if (n.name === 'ROW' || n.name === 'COLUMN') {
          const a = n.args[0];
          const at = !a || a.k === 'empty' ? (here ? parseRef(here) : err('#VALUE!')) : a.k === 'call' && (a.name === 'OFFSET' || a.name === 'INDIRECT') ? refOf(a).a : a.k === 'ref' ? a.ref : a.k === 'range' || (a.k === 'xref') ? { r: Math.min(a.a.r, a.b.r), c: Math.min(a.a.c, a.b.c) } : err('#VALUE!');
          if (!at) err('#REF!');
          return (n.name === 'ROW' ? at.r : at.c) + 1;
        }
        if (n.name === 'ROWS' || n.name === 'COLUMNS') {
          const a = n.args[0];
          if (a && (a.k === 'ref' || a.k === 'range' || a.k === 'xref')) { // a reference's size, whatever is in its cells (errors too)
            const r = refOf(a);
            return n.name === 'ROWS' ? r.b.r - r.a.r + 1 : r.b.c - r.a.c + 1;
          }
          const s = shapeOf(evaluate(a)); return n.name === 'ROWS' ? s.rows : s.cols;
        }
        if (n.name === 'LET' || n.name === 'LAMBDA' || LAMBDA_USERS[n.name]) return withNames(n);
        if (liftsArray(n)) return lifted(n);
        if (LAZY[n.name]) return LAZY[n.name](n.args.map((a) => () => scalar(evaluate(a))));
        if (n.name === 'ISFORMULA' || n.name === 'FORMULATEXT') { // the formula in a cell, not its value
          const a = n.args[0];
          if (!a || (a.k !== 'ref' && a.k !== 'range')) err(a ? '#VALUE!' : '#N/A');
          const at = a.k === 'ref' ? a.ref : { r: Math.min(a.a.r, a.b.r), c: Math.min(a.a.c, a.b.c) };
          if (!at) err('#REF!');
          const raw = cells[cellKey(at.c, at.r)];
          const isFormula = typeof raw === 'string' && raw.startsWith('=');
          return n.name === 'ISFORMULA' ? isFormula : isFormula ? raw : err('#N/A');
        }
        if (n.name === 'SHEET' || n.name === 'SHEETS') { // which sheet (1 for the first), and how many there are
          const names = (book?.sheets || []).map((x) => String(x.name).toUpperCase());
          const a = n.args[0];
          if (n.args.length > 1) err('#N/A');
          if (n.name === 'SHEETS') { if (!a || a.k === 'empty') return Math.max(names.length, 1); refOf(a); return 1; }
          const which = !a || a.k === 'empty' ? sheetName
            : ['ref', 'range', 'xref', 'name'].includes(a.k) || (a.k === 'call' && (a.name === 'OFFSET' || a.name === 'INDIRECT')) ? (refOf(a).sheet ?? sheetName)
              : toStr(scalar(evaluate(a)));
          if (which === null || which === undefined) return 1; // a spreadsheet of one sheet
          const at = names.indexOf(String(which).toUpperCase());
          return at >= 0 ? at + 1 : err('#N/A');
        }
        if (n.name === 'ISOMITTED') { // whether a LAMBDA's parameter was left out: =LAMBDA(x, [y], IF(ISOMITTED(y), x, x*y))
          const a = n.args[0];
          if (n.args.length !== 1) err('#N/A');
          if (a?.k !== 'name') return false;
          for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].has(a.v)) return scopes[i].get(a.v) === OMITTED;
          return false;
        }
        // A LAMBDA given a name with LET, called by it: =LET(add, LAMBDA(a, b, a+b), add(2, 3))
        for (let i = scopes.length - 1; i >= 0; i--) {
          if (!scopes[i].has(n.name)) continue;
          const fn = scopes[i].get(n.name);
          if (typeof fn !== 'function' || !fn.isLambda) err('#VALUE!');
          return fn(...n.args.map((a) => (a.k === 'empty' ? undefined : evaluate(a))));
        }
        if (n.name === 'ISREF') { // whether it's a reference (A1, Data!B2:C4, a named range, OFFSET, INDIRECT), not a value
          if (n.args.length !== 1) err('#N/A');
          try { refOf(n.args[0]); return true; } catch { return false; }
        }
        if (n.name === 'CELL') { // CELL("address" | "row" | "col" | "contents" | "type", a reference): about its top left cell
          if (n.args.length !== 2) err('#N/A');
          const what = toStr(scalar(evaluate(n.args[0]))).trim().toLowerCase();
          const at = refOf(n.args[1]);
          if (what === 'row') return at.a.r + 1;
          if (what === 'col') return at.a.c + 1;
          if (what === 'address') return `${at.sheet ? `${sheetPrefix(at.sheet)}!` : ''}$${colName(at.a.c)}$${at.a.r + 1}`;
          if (what !== 'contents' && what !== 'type') err('#VALUE!');
          const v = evaluate(n.args[1].k === 'range' || n.args[1].k === 'xref' || n.args[1].k === 'call'
            ? { k: at.sheet ? 'xref' : 'ref', sheet: at.sheet, ref: at.a, a: at.a, b: at.a, one: true } : n.args[1]);
          const top = Array.isArray(v) ? (Array.isArray(v[0]) ? v[0][0] : v[0]) : v;
          if (what === 'contents') return top ?? '';
          return top === null || top === undefined || top === '' ? 'b' : typeof top === 'string' ? 'l' : 'v';
        }
        const f = FUNCS[n.name];
        if (!f) {
          const own = book?.functions?.get(n.name);
          if (own) return callOwn(own, n.args.map(evaluate));
          err('#NAME?');
        }
        return f(n.args.map(evaluate));
      }
      case 'bin': {
        const l = evaluate(n.left);
        const r = evaluate(n.right);
        if (Array.isArray(l) || Array.isArray(r)) return elementwise(l, r, (x, y) => operate(n.op, x, y)); // A1:A5*2, B1:B5>10
        return operate(n.op, l, r);
      }
    }
    err('#ERROR!');
  }

  // ---- LET and LAMBDA ----
  // Names given in a formula (LET's, a LAMBDA's parameters), innermost last; they hide named ranges.
  let scopes = [];
  const paramName = (a) => { if (a?.k !== 'name' || /^[A-Z]{1,3}\d+$/.test(a.v)) err('#NAME?'); return a.v; };
  /** A LAMBDA as a value: called with values for its parameters, in the names that were there when it was made. */
  function makeLambda(args) {
    if (!args.length) err('#VALUE!');
    const params = args.slice(0, -1).map(paramName), body = args[args.length - 1], closure = scopes;
    const fn = (...vals) => {
      if (vals.length > params.length) err('#VALUE!');
      const saved = scopes;
      scopes = [...closure, new Map(params.map((p, i) => [p, vals[i] === undefined ? OMITTED : vals[i]]))]; // (left out: ISOMITTED)
      try { return evaluate(body); } finally { scopes = saved; }
    };
    fn.isLambda = true;
    fn.arity = params.length;
    return fn;
  }
  const lambdaArg = (a, arity) => {
    // A function's own name, as Excel lets you give one (=GROUPBY(A2:A9, C2:C9, SUM), =BYROW(A1:C3, MAX))
    if (a?.k === 'name' && FUNCS[a.v] && !named.has(a.v) && !scopes.some((sc) => sc.has(a.v))) {
      const fn = FUNCS[a.v];
      return (...xs) => fn(xs);
    }
    const f = evaluate(a); if (typeof f !== 'function' || !f.isLambda || f.arity !== arity) err('#VALUE!'); return f; };
  // A named function of the spreadsheet (⋮ → Named functions): its formula, with its argument names
  // set to what it's given and nothing else in scope (it works the same wherever it's used).
  let ownDepth = 0;
  function callOwn(fn, vals) {
    if (vals.length !== fn.params.length) err('#N/A');
    if (!fn.ast) { try { fn.ast = parse(fn.body); } catch { fn.ast = { k: 'referr' }; } }
    if (++ownDepth > 50) { ownDepth = 0; err('#REF!'); } // a function that calls itself for ever
    const saved = scopes;
    scopes = [new Map(fn.params.map((p, i) => [p, vals[i]]))];
    try { return evaluate(fn.ast); } finally { scopes = saved; ownDepth--; }
  }
  function withNames(n) {
    if (n.name === 'LAMBDA') return makeLambda(n.args);
    if (n.name === 'LET') {
      // LET(name1, value1, [name2, value2, …], result): each value can use the names before it.
      if (n.args.length < 3 || n.args.length % 2 === 0) err('#N/A');
      const saved = scopes;
      const mine = new Map();
      scopes = [...scopes, mine];
      try {
        for (let i = 0; i + 1 < n.args.length; i += 2) mine.set(paramName(n.args[i]), evaluate(n.args[i + 1]));
        return evaluate(n.args[n.args.length - 1]);
      } finally { scopes = saved; }
    }
    return LAMBDA_USERS[n.name](n.args, { evaluate, lambdaArg });
  }

  function operate(op, l, r) {
    switch (op) {
      case '+': return dateMath('+', l, r) ?? toNum(l) + toNum(r);
      case '-': return dateMath('-', l, r) ?? toNum(l) - toNum(r);
      case '*': return toNum(l) * toNum(r);
      case '/': { const d = toNum(r); if (d === 0) err('#DIV/0!'); return toNum(l) / d; }
      case '^': return toNum(l) ** toNum(r);
      case '&': return toStr(l) + toStr(r);
      default: return compare(op, l, r);
    }
  }

  // IMPORTRANGE("link or id", "Sheet1!A1:C10"): cells of another spreadsheet you can open, loaded by
  // book.imports ({ book(id) -> { sheets } | { error } | null while loading }, depth).
  function importRange([link, spec]) {
    const imports = book?.imports;
    const id = importFileId(link);
    if (!imports || !id || (imports.depth || 0) >= IMPORT_DEPTH) err('#REF!');
    const m = /^\s*(?:(?:'((?:[^']|'')+)'|([^!]+))!)?\s*(\$?[A-Z]+\$?\d+)(?::(\$?[A-Z]+\$?\d+))?\s*$/i.exec(String(spec ?? ''));
    if (!m) err('#REF!');
    const src = imports.book(id);
    if (!src) err('#LOADING');
    if (src.error || !Array.isArray(src.sheets)) err('#REF!');
    const name = m[1] !== undefined ? m[1].replace(/''/g, "'") : m[2]?.trim();
    const index = name === undefined ? 0 : src.sheets.findIndex((x) => String(x.name).toUpperCase() === name.toUpperCase());
    if (index < 0) err('#REF!');
    const a = parseRef(m[3].replace(/\$/g, '')), b = parseRef((m[4] || m[3]).replace(/\$/g, ''));
    if (!a || !b) err('#REF!');
    const ev = bookEvaluator(src.sheets, index, { book: imports.book, depth: (imports.depth || 0) + 1 });
    if (!m[4]) return ev.cell(cellKey(a.c, a.r));
    return ev.range(a, b);
  }

  // IMPORTDATA("https://…/data.csv") and IMPORTHTML("https://…", "table" | "list", n): a page on the
  // internet, fetched by the server; book.imports.web(url, type, n) -> { rows } | { error } | null while loading.
  function importWebPage(name, [url, query, index, more]) {
    const [query0, index0, more0] = [query, index, more];
    const fetchWeb = book?.imports?.web;
    if (!fetchWeb) err('#N/A');
    const u = toStr(url).trim();
    if (!/^https?:\/\/\S+$/i.test(u)) throw new FormulaError('#VALUE!', 'Give a web address starting with https:// or http://');
    let type = 'data', n = 1, extra = null;
    if (name === 'IMPORTFEED') {
      // IMPORTFEED(url, [query], [headers], [num_items]): an RSS or Atom feed's items (or the feed itself).
      type = 'feed';
      const [query, headers, num] = [query0, index0, more0];
      const howMany = num === undefined || num === null ? 20 : Math.trunc(toNum(num));
      if (howMany < 1 || howMany > 200) throw new FormulaError('#VALUE!', 'How many items: 1 to 200');
      extra = { query: query === undefined || query === null || query === '' ? 'items' : toStr(query).trim().toLowerCase(), headers: headers !== undefined && headers !== null && toBool(headers) ? '1' : '0', num: String(howMany) };
    } else if (name === 'IMPORTHTML') {
      type = toStr(query).trim().toLowerCase();
      if (type !== 'table' && type !== 'list') throw new FormulaError('#VALUE!', 'IMPORTHTML takes "table" or "list"');
      n = index === undefined || index === null ? 1 : Math.trunc(toNum(index));
      if (n < 1) throw new FormulaError('#VALUE!', 'Which table or list: a number from 1');
    }
    const got = extra ? fetchWeb(u, type, n, extra) : fetchWeb(u, type, n);
    if (!got) err('#LOADING');
    if (got.error) throw new FormulaError('#N/A', got.error);
    const rows = got.rows || [];
    const width = Math.max(1, ...rows.map((row) => row.length));
    const full = rows.map((row) => Array.from({ length: width }, (_, c) => row[c] ?? null));
    return full.length === 1 && width === 1 ? full[0][0] : grid(full);
  }

  const get = function get(key) {
    try { return valueOf(key); } catch (e) { if (e instanceof FormulaError) return errorValue(e); throw e; }
  };
  get.cell = valueOf; // for formulas on other sheets (these throw)
  /** The formula cell whose array fills this (empty) cell, if one does. */
  /** Where a HYPERLINK cell leads, and what a SPARKLINE cell draws ({ type, values }), once worked out. */
  get.linkOf = (key) => { get(key); return links.get(key) || null; };
  get.sparkOf = (key) => { get(key); return sparks.get(key) || null; };
  /** The picture an IMAGE cell shows ({ id, mode, h, w }), once worked out. */
  get.imageOf = (key) => { get(key); return images.get(key) || null; };
  get.spilledFrom = (key) => { if (pending === null) findSpills(); return spillFrom.get(key)?.anchor ?? null; };
  get.spilledKeys = () => { if (pending === null) findSpills(); return [...spillFrom.keys()]; };
  get.named = namedValue;
  get.range = range;
  /** A formula worked out as if it were in cell `key` (ROW() is that row): its value, or { error }. For custom formula rules. */
  const tried = new Map();
  get.formulaAt = (src, key) => {
    const text = String(src).replace(/^=/, '');
    try {
      let ast = tried.get(text);
      if (!ast) { ast = parse(text); if (tried.size < 500) tried.set(text, ast); }
      const outer = here; here = key;
      try { const v = evaluate(ast); return Array.isArray(v) ? (v.length ? v[0] : null) : v; } finally { here = outer; }
    } catch (e) { if (e instanceof FormulaError) return errorValue(e); throw e; }
  };
  return get;
}

/** The evaluator of a sheet in the book (by name, any case), made once and shared. */
function sheetEvaluator(book, name) {
  const key = String(name).toUpperCase();
  if (!book.open.has(key)) {
    const s = book.sheets.find((x) => String(x.name).toUpperCase() === key);
    book.open.set(key, s ? createEvaluator(s.cells || {}, s.names, book, s.name) : null);
  }
  return book.open.get(key);
}

/** An evaluator for one sheet of a spreadsheet whose formulas can refer to the other sheets. */
export function bookEvaluator(sheets, index, imports = null, functions = null, hiddenRowsOf = null) {
  const book = { sheets: sheets || [], open: new Map(), imports, functions: namedFunctions(functions), hiddenRowsOf };
  const s = book.sheets[index];
  if (!s) return createEvaluator({}, null, book);
  const ev = createEvaluator(s.cells || {}, s.names, book, s.name);
  book.open.set(String(s.name).toUpperCase(), ev); // the same one, so loops across sheets are caught
  return ev;
}

const scalar = (v) => (Array.isArray(v) ? err('#VALUE!') : v);

/** An operator cell by cell over one or two arrays (a single row or column stretches to fit). */
function elementwise(a, b, fn) {
  const sa = shapeOf(a), sb = b === null ? { rows: 1, cols: 1, at: () => null } : shapeOf(b);
  const rows = Math.max(sa.rows, sb.rows), cols = Math.max(sa.cols, sb.cols);
  const pick = (s, r, c) => {
    if ((s.rows !== 1 && r >= s.rows) || (s.cols !== 1 && c >= s.cols)) err('#VALUE!');
    return s.at(s.rows === 1 ? 0 : r, s.cols === 1 ? 0 : c);
  };
  // Each cell on its own: one that can't be worked out shows its error, the others their values.
  const cell = (r, c) => { try { const v = fn(pick(sa, r, c), pick(sb, r, c)); if (typeof v === 'number' && !Number.isFinite(v)) err('#NUM!'); return v; } catch (e) { if (e instanceof FormulaError) return errorValue(e); throw e; } };
  return grid(Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => cell(r, c))));
}

/** Whether a formula can give back several cells (and so may spill). */
function mayArray(n) {
  if (!n) return false;
  switch (n.k) {
    case 'range': case 'name': case 'xname': case 'array': return true;
    case 'xref': return !n.one;
    case 'neg': return mayArray(n.e);
    case 'bin': return mayArray(n.left) || mayArray(n.right);
    case 'call': return ARRAY_FUNCS.has(n.name) || liftsArray(n);
    default: return false;
  }
}

function compare(op, l, r) {
  const bothNum = (typeof l === 'number' || l === null) && (typeof r === 'number' || r === null);
  const a = bothNum ? toNum(l) : toStr(l).toLowerCase();
  const b = bothNum ? toNum(r) : toStr(r).toLowerCase();
  switch (op) {
    case '=': return a === b;
    case '<>': return a !== b;
    case '<': return a < b;
    case '>': return a > b;
    case '<=': return a <= b;
    default: return a >= b;
  }
}

/** Display formatting for an evaluated value. */
export function display(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && v.error) return v.error;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e10) / 1e10);
  return v;
}

/** Shift relative references in a formula by (dc, dr) — used for copy/paste and fill. */
export function shiftFormula(raw, dc, dr) {
  if (typeof raw !== 'string' || !raw.startsWith('=')) return raw;
  return raw.replace(/("(?:[^"]|"")*")|(?<![A-Z0-9_.$])(\$?)([A-Z]+)(\$?)(\d+)(?![A-Z0-9_(])/gi, (m, s, cAbs, col, rAbs, row) => {
    if (s) return s;
    const c = cAbs ? colIndex(col) : colIndex(col) + dc;
    const r = rAbs ? Number(row) - 1 : Number(row) - 1 + dr;
    if (c < 0 || r < 0) return '#REF!';
    return `${cAbs}${colName(c)}${rAbs}${r + 1}`;
  });
}

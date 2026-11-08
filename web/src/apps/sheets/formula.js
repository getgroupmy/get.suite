// Small spreadsheet formula engine: arithmetic, comparisons, text, cell refs, ranges, common functions.

export class FormulaError extends Error {
  constructor(code) { super(code); this.code = code; }
}
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
const TOKEN_RE = /\s*(?:(\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+)|("(?:[^"]|"")*")|(\$?[A-Z]+\$?\d+(?::\$?[A-Z]+\$?\d+)?)(?![A-Z0-9_(])|([A-Z_][A-Z0-9_.]*)|(<=|>=|<>|[-+*/^&=<>(),:%]))/iy;

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
function parse(src) {
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
    err('#ERROR!');
  }

  const ast = comparison();
  if (i < toks.length) err('#ERROR!');
  return ast;
}

// ---------- evaluation ----------
const toNum = (v) => {
  if (v === null || v === '' || v === undefined) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = Number(v);
  if (Number.isNaN(n)) err('#VALUE!');
  return n;
};
const toStr = (v) => (v === null || v === undefined ? '' : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v));
const toBool = (v) => (typeof v === 'string' ? v.toUpperCase() === 'TRUE' || (v !== '' && v.toUpperCase() !== 'FALSE' && toNum(v) !== 0) : !!toNum(v));
const flat = (args) => args.flat(Infinity);
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
const roundTo = (v, d, how) => { const f = 10 ** toNum(d ?? 0); const x = toNum(v) * f; return how(Math.abs(x) + 1e-9 * (how === Math.floor ? 1 : -1)) * Math.sign(x) / f; };

// ---- helpers for statistics, TEXT, working days and loans
function variance(a, sample) {
  const n = nums(a);
  if (n.length < (sample ? 2 : 1)) err('#DIV/0!');
  const mean = n.reduce((s, x) => s + x, 0) / n.length;
  return n.reduce((s, x) => s + (x - mean) ** 2, 0) / (n.length - (sample ? 1 : 0));
}
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
const isWorkday = (ms, hol) => { const w = new Date(ms).getUTCDay(); return w !== 0 && w !== 6 && !hol.has(ms); };
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
const ARRAY_FUNCS = new Set(['FILTER', 'UNIQUE', 'SORT', 'SEQUENCE', 'TRANSPOSE', 'IMPORTRANGE', 'XLOOKUP']);

const FUNCS = {
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
  MIN: (a) => { const n = nums(a); return n.length ? Math.min(...n) : 0; },
  MAX: (a) => { const n = nums(a); return n.length ? Math.max(...n) : 0; },
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
  TODAY: () => new Date().toISOString().slice(0, 10),
  // lookups
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
  TEXTJOIN: ([sep, skipEmpty, ...a]) => flat(a).map(toStr).filter((x) => !toBool(skipEmpty) || x !== '').join(toStr(sep)),
  ISBLANK: ([v]) => v === null || v === undefined || v === '',
  ISNUMBER: ([v]) => typeof v === 'number',
  ISTEXT: ([v]) => typeof v === 'string' && v !== '',
  NA: () => err('#N/A'),
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
// Lazily evaluated (short-circuit) functions receive thunks.
const LAZY = {
  IFS: (a) => { for (let i = 0; i + 1 < a.length; i += 2) if (toBool(a[i]())) return a[i + 1](); return err('#N/A'); },
  SWITCH: ([x, ...a]) => { const v = x(); for (let i = 0; i + 1 < a.length; i += 2) if (same(v, a[i]())) return a[i + 1](); return a.length % 2 ? a[a.length - 1]() : err('#N/A'); },
  IFNA: ([v, fallback]) => { try { return v(); } catch (e) { if (e instanceof FormulaError && e.code === '#N/A') return fallback ? fallback() : ''; throw e; } },
  ISERROR: ([v]) => { try { v(); return false; } catch (e) { if (e instanceof FormulaError) return true; throw e; } },
  IF: ([cond, a, b]) => (toBool(cond()) ? (a ? a() : true) : (b ? b() : false)),
  IFERROR: ([v, fallback]) => { try { return v(); } catch (e) { if (e instanceof FormulaError) return fallback ? fallback() : ''; throw e; } },
};

/** Every function a formula can call. */
export const FUNCTION_NAMES = [...Object.keys(FUNCS), ...Object.keys(LAZY), 'IMPORTRANGE', 'HYPERLINK', 'SPARKLINE'];

/** A link a cell may open: web addresses and email (mailto:), nothing else. */
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
export function createEvaluator(cells, names = null, book = null) {
  const memo = new Map();
  // The other sheets (for Sheet2!A1): { sheets: [{ name, cells, names }], open: Map(name -> evaluator) }, shared by them all.
  // Named ranges: { Tax: 'B1', Sales: 'A2:A10' }, matched whatever the case.
  const named = new Map(Object.entries(names || {}).map(([k, v]) => [k.toUpperCase(), String(v).toUpperCase().split(':')]));
  const visiting = new Set();
  const asts = new Map();
  const links = new Map(), sparks = new Map(); // HYPERLINK and SPARKLINE cells
  // Spilling: a formula that gives back several cells (=SEQUENCE(5), =FILTER(…), =A1:A5*2) fills the
  // empty cells beside and below it. Those formulas are worked out first, so the cells they fill are
  // known; a cell they'd fill that has something in it shows #SPILL! in the formula's cell instead.
  const spillFrom = new Map(); // filled cell -> { anchor, value }
  let pending = null; // formulas that may spill and haven't been worked out yet (while finding spills)
  const isEmpty = (raw) => raw === undefined || raw === null || raw === '';

  function findSpills() {
    pending = [];
    for (const [k, raw] of Object.entries(cells)) {
      if (typeof raw !== 'string' || !raw.startsWith('=')) continue;
      try { const ast = asts.get(k) || parse(raw.slice(1)); asts.set(k, ast); if (mayArray(ast)) pending.push(k); } catch { /* shows its error when asked */ }
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
      if (v && typeof v === 'object' && v.error) throw new FormulaError(v.error);
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
      if (!ast) { ast = parse(raw.slice(1)); asts.set(key, ast); }
      let v;
      if (ast.k === 'call' && ast.name === 'HYPERLINK') { // a link: the cell shows its label, and opens it
        const [url, label] = ast.args.map((a) => scalar(evaluate(a)));
        const href = safeLink(url);
        if (!href) err('#VALUE!');
        links.set(key, href);
        v = label === undefined || label === null || label === '' ? href : label;
      } else if (ast.k === 'call' && ast.name === 'SPARKLINE') { // a little chart drawn in the cell
        const [range, opts] = ast.args.map(evaluate);
        const values = (Array.isArray(range) ? range : [range]).map((x) => (typeof x === 'number' ? x : null));
        const type = String(Array.isArray(opts) ? opts[0] ?? '' : opts ?? '').toLowerCase() === 'column' ? 'column' : 'line';
        if (!values.some((x) => x !== null)) err('#VALUE!');
        sparks.set(key, { type, values: values.slice(0, 200) });
        v = '';
      } else v = evaluate(ast);
      if (typeof v === 'number' && !Number.isFinite(v)) err('#NUM!');
      if (Array.isArray(v)) v = spill(key, v);
      memo.set(key, v);
      return v;
    } catch (e) {
      if (!(e instanceof FormulaError)) throw e;
      memo.set(key, { error: e.code });
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

  function evaluate(n) {
    switch (n.k) {
      case 'num': case 'str': case 'bool': return n.v;
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
      case 'name': return namedValue(n.v);
      case 'neg': { const v = evaluate(n.e); return Array.isArray(v) ? elementwise(v, null, (x) => -toNum(x)) : -toNum(v); }
      case 'call': {
        if (n.name === 'IMPORTRANGE') return importRange(n.args.map((a) => scalar(evaluate(a))));
        if (LAZY[n.name]) return LAZY[n.name](n.args.map((a) => () => scalar(evaluate(a))));
        const f = FUNCS[n.name];
        if (!f) err('#NAME?');
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

  function operate(op, l, r) {
    switch (op) {
      case '+': return toNum(l) + toNum(r);
      case '-': return toNum(l) - toNum(r);
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

  const get = function get(key) {
    try { return valueOf(key); } catch (e) { if (e instanceof FormulaError) return { error: e.code }; throw e; }
  };
  get.cell = valueOf; // for formulas on other sheets (these throw)
  /** The formula cell whose array fills this (empty) cell, if one does. */
  /** Where a HYPERLINK cell leads, and what a SPARKLINE cell draws ({ type, values }), once worked out. */
  get.linkOf = (key) => { get(key); return links.get(key) || null; };
  get.sparkOf = (key) => { get(key); return sparks.get(key) || null; };
  get.spilledFrom = (key) => { if (pending === null) findSpills(); return spillFrom.get(key)?.anchor ?? null; };
  get.spilledKeys = () => { if (pending === null) findSpills(); return [...spillFrom.keys()]; };
  get.named = namedValue;
  get.range = range;
  return get;
}

/** The evaluator of a sheet in the book (by name, any case), made once and shared. */
function sheetEvaluator(book, name) {
  const key = String(name).toUpperCase();
  if (!book.open.has(key)) {
    const s = book.sheets.find((x) => String(x.name).toUpperCase() === key);
    book.open.set(key, s ? createEvaluator(s.cells || {}, s.names, book) : null);
  }
  return book.open.get(key);
}

/** An evaluator for one sheet of a spreadsheet whose formulas can refer to the other sheets. */
export function bookEvaluator(sheets, index, imports = null) {
  const book = { sheets: sheets || [], open: new Map(), imports };
  const s = book.sheets[index];
  if (!s) return createEvaluator({}, null, book);
  const ev = createEvaluator(s.cells || {}, s.names, book);
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
  return grid(Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => fn(pick(sa, r, c), pick(sb, r, c)))));
}

/** Whether a formula can give back several cells (and so may spill). */
function mayArray(n) {
  if (!n) return false;
  switch (n.k) {
    case 'range': case 'name': case 'xname': return true;
    case 'xref': return !n.one;
    case 'neg': return mayArray(n.e);
    case 'bin': return mayArray(n.left) || mayArray(n.right);
    case 'call': return ARRAY_FUNCS.has(n.name);
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

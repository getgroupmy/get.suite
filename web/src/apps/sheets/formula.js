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

function tokenize(src) {
  const out = [];
  TOKEN_RE.lastIndex = 0;
  while (TOKEN_RE.lastIndex < src.length) {
    if (/^\s*$/.test(src.slice(TOKEN_RE.lastIndex))) break;
    const refErr = /^\s*#REF!/i.exec(src.slice(TOKEN_RE.lastIndex)); // a reference to cells that were deleted
    if (refErr) { out.push({ t: 'referr' }); TOKEN_RE.lastIndex += refErr[0].length; continue; }
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
      err('#NAME?');
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

const FUNCS = {
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
export const FUNCTION_NAMES = [...Object.keys(FUNCS), ...Object.keys(LAZY)];

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
export function createEvaluator(cells) {
  const memo = new Map();
  const visiting = new Set();
  const asts = new Map();

  function valueOf(key) {
    if (memo.has(key)) {
      const v = memo.get(key);
      if (v && typeof v === 'object' && v.error) throw new FormulaError(v.error);
      return v;
    }
    const raw = cells[key];
    if (typeof raw !== 'string' || !raw.startsWith('=')) {
      const v = literal(raw);
      memo.set(key, v);
      return v;
    }
    if (visiting.has(key)) err('#CIRC!');
    visiting.add(key);
    try {
      let ast = asts.get(key);
      if (!ast) { ast = parse(raw.slice(1)); asts.set(key, ast); }
      let v = evaluate(ast);
      if (typeof v === 'number' && !Number.isFinite(v)) err('#NUM!');
      if (Array.isArray(v)) v = v.flat(Infinity)[0] ?? null;
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
      case 'neg': return -toNum(evaluate(n.e));
      case 'call': {
        if (LAZY[n.name]) return LAZY[n.name](n.args.map((a) => () => scalar(evaluate(a))));
        const f = FUNCS[n.name];
        if (!f) err('#NAME?');
        return f(n.args.map(evaluate));
      }
      case 'bin': {
        const l = scalar(evaluate(n.left));
        const r = scalar(evaluate(n.right));
        switch (n.op) {
          case '+': return toNum(l) + toNum(r);
          case '-': return toNum(l) - toNum(r);
          case '*': return toNum(l) * toNum(r);
          case '/': { const d = toNum(r); if (d === 0) err('#DIV/0!'); return toNum(l) / d; }
          case '^': return toNum(l) ** toNum(r);
          case '&': return toStr(l) + toStr(r);
          default: return compare(n.op, l, r);
        }
      }
    }
    err('#ERROR!');
  }

  return function get(key) {
    try { return valueOf(key); } catch (e) { if (e instanceof FormulaError) return { error: e.code }; throw e; }
  };
}

const scalar = (v) => (Array.isArray(v) ? err('#VALUE!') : v);

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
  return raw.replace(/("(?:[^"]|"")*")|(\$?)([A-Z]+)(\$?)(\d+)(?![A-Z0-9_(])/gi, (m, s, cAbs, col, rAbs, row) => {
    if (s) return s;
    const c = cAbs ? colIndex(col) : colIndex(col) + dc;
    const r = rAbs ? Number(row) - 1 : Number(row) - 1 + dr;
    if (c < 0 || r < 0) return '#REF!';
    return `${cAbs}${colName(c)}${rAbs}${r + 1}`;
  });
}

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
        if (!isOp(')')) { do { args.push(comparison()); } while (isOp(',') && ++i); }
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

function criteria(c) {
  const m = /^(<=|>=|<>|<|>|=)?(.*)$/.exec(toStr(c));
  const op = m[1] || '=';
  const rhs = m[2] !== '' && !Number.isNaN(Number(m[2])) ? Number(m[2]) : m[2].toLowerCase();
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
  NOW: () => new Date().toISOString().slice(0, 16).replace('T', ' '),
};
// Lazily evaluated (short-circuit) functions receive thunks.
const LAZY = {
  IF: ([cond, a, b]) => (toBool(cond()) ? (a ? a() : true) : (b ? b() : false)),
  IFERROR: ([v, fallback]) => { try { return v(); } catch (e) { if (e instanceof FormulaError) return fallback ? fallback() : ''; throw e; } },
};

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
    return out;
  }

  function evaluate(n) {
    switch (n.k) {
      case 'num': case 'str': case 'bool': return n.v;
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

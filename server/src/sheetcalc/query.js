// QUERY(data, "select … where … group by … pivot … order by … limit … offset … label …", [headers])
// The Google Sheets query language over a range: columns are named by their letters in the sheet (A, B…)
// or, for data that isn't a plain range, Col1, Col2… Text comparisons match case, as in Google Sheets.
// Dates are text in this spreadsheet ("2026-11-09"), so date '2026-11-09' is that text and compares in order.

export class QueryError extends Error {}
const fail = (msg) => { throw new QueryError(msg); };

const KEYWORDS = ['select', 'where', 'group', 'pivot', 'order', 'limit', 'offset', 'label', 'format', 'options'];
const AGGREGATES = new Set(['sum', 'avg', 'count', 'min', 'max']);
const SCALARS = new Set(['upper', 'lower', 'year', 'month', 'day', 'abs', 'round', 'len', 'trim']);

function tokenize(text) {
  const toks = [];
  const re = /\s*(?:(\d+(?:\.\d+)?)|'([^']*)'|"([^"]*)"|`([^`]*)`|([A-Za-z_][A-Za-z0-9_]*)|(<=|>=|<>|!=|[=<>(),*+\-/]))/y;
  let i = 0;
  while (i < text.length) {
    if (/^\s*$/.test(text.slice(i))) break;
    re.lastIndex = i;
    const m = re.exec(text);
    if (!m) fail(`Can't read the query at "${text.slice(i, i + 12).trim()}"`);
    i = re.lastIndex;
    if (m[1] !== undefined) toks.push({ t: 'num', v: Number(m[1]) });
    else if (m[2] !== undefined || m[3] !== undefined) toks.push({ t: 'str', v: m[2] ?? m[3] });
    else if (m[4] !== undefined) toks.push({ t: 'id', v: m[4], quoted: true });
    else if (m[5] !== undefined) toks.push({ t: 'id', v: m[5] });
    else toks.push({ t: 'op', v: m[6] });
  }
  return toks;
}

/** Parses a query into { select, where, groupBy, pivot, orderBy, limit, offset, labels }. */
export function parseQuery(text) {
  const toks = tokenize(String(text ?? ''));
  let i = 0;
  const peek = (k = 0) => toks[i + k];
  const isWord = (w, k = 0) => peek(k)?.t === 'id' && !peek(k).quoted && peek(k).v.toLowerCase() === w;
  const isOp = (o) => peek()?.t === 'op' && peek().v === o;
  const word = (w) => { if (!isWord(w)) fail(`Expected "${w}"`); i++; };
  const op = (o) => { if (!isOp(o)) fail(`Expected "${o}"`); i++; };
  const atClause = () => !peek() || KEYWORDS.some((k) => isWord(k));

  function primary() {
    const tk = peek();
    if (!tk) fail('The query ends too soon');
    if (tk.t === 'num') { i++; return { k: 'lit', v: tk.v }; }
    if (tk.t === 'str') { i++; return { k: 'lit', v: tk.v }; }
    if (tk.t === 'op' && tk.v === '(') { i++; const e = expr(); op(')'); return e; }
    if (tk.t === 'op' && tk.v === '-') { i++; const e = primary(); return { k: 'neg', e }; }
    if (tk.t !== 'id') fail(`Unexpected "${tk.v}"`);
    const name = tk.v.toLowerCase();
    if (!tk.quoted && (name === 'true' || name === 'false')) { i++; return { k: 'lit', v: name === 'true' }; }
    if (!tk.quoted && (name === 'date' || name === 'datetime' || name === 'timeofday') && peek(1)?.t === 'str') { i += 2; return { k: 'lit', v: toks[i - 1].v.trim() }; }
    if (!tk.quoted && peek(1)?.t === 'op' && peek(1).v === '(') {
      i += 2;
      if (AGGREGATES.has(name)) { const e = expr(); op(')'); if (e.k === 'agg') fail('An aggregate inside an aggregate'); return { k: 'agg', fn: name, e }; }
      if (SCALARS.has(name)) { const args = [expr()]; while (isOp(',')) { i++; args.push(expr()); } op(')'); return { k: 'fn', fn: name, args }; }
      fail(`QUERY has no function "${tk.v}"`);
    }
    i++;
    return { k: 'col', id: tk.quoted ? tk.v : tk.v.toUpperCase() };
  }
  function term() {
    let l = primary();
    while (isOp('*') || isOp('/')) { const o = toks[i++].v; l = { k: 'bin', op: o, l, r: primary() }; }
    return l;
  }
  function expr() {
    let l = term();
    while (isOp('+') || isOp('-')) { const o = toks[i++].v; l = { k: 'bin', op: o, l, r: term() }; }
    return l;
  }
  function comparison() {
    if (isOp('(')) {
      // A bracketed condition, or a bracketed sum that a comparison follows: try the condition first.
      const at = i;
      try { i++; const c = orCond(); op(')'); if (!isCmp()) return c; } catch (e) { if (!(e instanceof QueryError)) throw e; }
      i = at;
    }
    if (isWord('not')) { i++; return { k: 'not', e: comparison() }; }
    const l = expr();
    if (isWord('is')) {
      i++;
      const neg = isWord('not') ? (i++, true) : false;
      word('null');
      return { k: 'null', e: l, neg };
    }
    if (isWord('contains')) { i++; return { k: 'contains', l, r: expr() }; }
    if (isWord('starts')) { i++; word('with'); return { k: 'starts', l, r: expr() }; }
    if (isWord('ends')) { i++; word('with'); return { k: 'ends', l, r: expr() }; }
    if (isWord('matches')) { i++; return { k: 'matches', l, r: expr() }; }
    if (isWord('like')) { i++; return { k: 'like', l, r: expr() }; }
    if (isCmp()) { const o = toks[i++].v; return { k: 'cmp', op: o === '!=' ? '<>' : o, l, r: expr() }; }
    return { k: 'truthy', e: l };
  }
  function isCmp() { return ['=', '<>', '!=', '<', '>', '<=', '>='].some(isOp); }
  function andCond() { let l = comparison(); while (isWord('and')) { i++; l = { k: 'and', l, r: comparison() }; } return l; }
  function orCond() { let l = andCond(); while (isWord('or')) { i++; l = { k: 'or', l, r: andCond() }; } return l; }
  const list = (item) => { const out = [item()]; while (isOp(',')) { i++; out.push(item()); } return out; };

  const q = { select: null, where: null, groupBy: null, pivot: null, orderBy: null, limit: null, offset: 0, labels: new Map() };
  const seen = new Set();
  const clause = (name) => { if (seen.has(name)) fail(`"${name}" is in the query twice`); seen.add(name); };
  while (peek()) {
    if (isWord('select')) {
      clause('select'); i++;
      if (isOp('*')) { i++; q.select = null; } else q.select = list(expr);
    } else if (isWord('where')) { clause('where'); i++; q.where = orCond(); }
    else if (isWord('group')) { clause('group'); i++; word('by'); q.groupBy = list(expr); }
    else if (isWord('pivot')) { clause('pivot'); i++; q.pivot = list(expr); }
    else if (isWord('order')) {
      clause('order'); i++; word('by');
      q.orderBy = list(() => { const e = expr(); let desc = false; if (isWord('desc')) { i++; desc = true; } else if (isWord('asc')) i++; return { e, desc }; });
    } else if (isWord('limit') || isWord('offset')) {
      const which = peek().v.toLowerCase(); clause(which); i++;
      const n = peek();
      if (n?.t !== 'num' || !Number.isInteger(n.v)) fail(`"${which}" needs a whole number`);
      i++; q[which] = n.v;
    } else if (isWord('label')) {
      clause('label'); i++;
      list(() => { const e = expr(); const s = peek(); if (s?.t !== 'str') fail('A label needs its text in quotes'); i++; q.labels.set(keyOf(e), s.v); });
    } else if (isWord('format') || isWord('options')) {
      // Number formats and options are about display; the cells' own formats do that here, so they're read and left.
      i++; while (peek() && !atClause()) i++;
    } else fail(`Unexpected "${peek().v}"`);
    if (peek() && !atClause()) fail(`Unexpected "${peek().v}"`);
  }
  return q;
}

/** A canonical text for an expression, so "sum(B)" in select matches "sum(B)" in label or order by. */
function keyOf(e) {
  switch (e.k) {
    case 'col': return e.id;
    case 'lit': return typeof e.v === 'string' ? `'${e.v}'` : String(e.v);
    case 'agg': return `${e.fn}(${keyOf(e.e)})`;
    case 'fn': return `${e.fn}(${e.args.map(keyOf).join(', ')})`;
    case 'neg': return `-${keyOf(e.e)}`;
    case 'bin': return `${keyOf(e.l)}${e.op}${keyOf(e.r)}`;
    default: return '?';
  }
}
const hasAgg = (e) => e.k === 'agg' || (e.k === 'bin' && (hasAgg(e.l) || hasAgg(e.r))) || (e.k === 'neg' && hasAgg(e.e)) || (e.k === 'fn' && e.args.some(hasAgg));
const empty = (v) => v === null || v === undefined || v === '';
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})/;

function compare(a, b) {
  if (empty(a) || empty(b)) return null;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  const x = String(a), y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}
/** Sorting: blanks first going up (as Google Sheets does), numbers before text. */
function sortOrder(a, b) {
  const rank = (v) => (empty(v) ? 0 : typeof v === 'number' ? 1 : typeof v === 'boolean' ? 3 : 2);
  const ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return 0;
  return compare(a, b);
}
const numOf = (v) => { if (empty(v)) return null; if (typeof v === 'number') return v; if (typeof v === 'boolean') return Number(v); const n = Number(v); if (Number.isNaN(n)) fail(`"${v}" isn't a number`); return n; };

function scalarFn(fn, args) {
  const v = args[0];
  if (empty(v)) return null;
  switch (fn) {
    case 'upper': return String(v).toUpperCase();
    case 'lower': return String(v).toLowerCase();
    case 'len': return String(v).length;
    case 'trim': return String(v).trim();
    case 'abs': return Math.abs(numOf(v));
    case 'round': { const p = 10 ** (args[1] === undefined ? 0 : numOf(args[1])); return Math.round(numOf(v) * p) / p; }
    default: {
      const m = DATE_RE.exec(String(v));
      if (!m) fail(`${fn}() needs a date`);
      // month() counts from 0, as in Google Sheets' query language.
      return fn === 'year' ? +m[1] : fn === 'month' ? +m[2] - 1 : +m[3];
    }
  }
}
function aggregate(fn, values) {
  const vals = values.filter((v) => !empty(v));
  if (fn === 'count') return vals.length;
  if (!vals.length) return null;
  if (fn === 'min' || fn === 'max') return vals.reduce((a, b) => (sortOrder(a, b) * (fn === 'min' ? 1 : -1) <= 0 ? a : b));
  const nums = vals.map(numOf);
  const sum = nums.reduce((a, b) => a + b, 0);
  return fn === 'sum' ? sum : sum / nums.length;
}
function likeRe(pattern) {
  let src = '';
  for (const ch of String(pattern)) src += ch === '%' ? '[\\s\\S]*' : ch === '_' ? '[\\s\\S]' : ch.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
  return new RegExp(`^${src}$`);
}

/**
 * Runs a query over rows of values. `firstCol` is the sheet column (0 = A) the data starts at, or null
 * for data with no place on the sheet (columns are then Col1, Col2…). `headers` is how many rows at the
 * top are headings; left out, the first row is taken as headings when it's all text and the row under
 * it isn't. Gives back rows, headings first when there are any.
 */
export function runQuery(rows, text, headers, firstCol = 0) {
  const q = parseQuery(text);
  // Whole columns (A:C) run on past the data: rows that are empty all the way along at the end are left off.
  let end = rows.length;
  while (end > 0 && rows[end - 1].every(empty)) end--;
  rows = rows.slice(0, end);
  const width = rows[0]?.length ?? 0;
  const letter = (n) => { let s = ''; for (n += 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
  const ids = Array.from({ length: width }, (_, c) => (firstCol === null ? `COL${c + 1}` : letter(firstCol + c)));
  let h = headers;
  if (h === undefined || h === null || h < 0) {
    const textRow = (r) => r && r.some((v) => !empty(v)) && r.every((v) => empty(v) || typeof v === 'string');
    h = rows.length > 1 && textRow(rows[0]) && !textRow(rows[1]) ? 1 : 0;
  }
  h = Math.min(Math.trunc(h), rows.length);
  const heads = ids.map((_, c) => rows.slice(0, h).map((r) => r[c]).filter((v) => !empty(v)).join(' '));
  let data = rows.slice(h);
  const colIndex = (id) => { const c = ids.indexOf(id.toUpperCase()); if (c < 0) fail(`There's no column ${id} in the data`); return c; };

  // Values of an expression for one row (aggregates aren't allowed here).
  function value(e, row) {
    switch (e.k) {
      case 'col': return row[colIndex(e.id)] ?? null;
      case 'lit': return e.v;
      case 'neg': { const v = value(e.e, row); return empty(v) ? null : -numOf(v); }
      case 'fn': return scalarFn(e.fn, e.args.map((a) => value(a, row)));
      case 'bin': {
        const l = value(e.l, row), r = value(e.r, row);
        if (empty(l) || empty(r)) return null;
        const a = numOf(l), b = numOf(r);
        if (e.op === '/' && b === 0) return null;
        return e.op === '+' ? a + b : e.op === '-' ? a - b : e.op === '*' ? a * b : a / b;
      }
      case 'agg': return fail('Aggregates like sum() go with "group by" or alone in "select"');
      default: return fail('Something in the query can\'t be worked out');
    }
  }
  function test(c, row) {
    switch (c.k) {
      case 'and': return test(c.l, row) && test(c.r, row);
      case 'or': return test(c.l, row) || test(c.r, row);
      case 'not': return !test(c.e, row);
      case 'null': return empty(value(c.e, row)) !== c.neg;
      case 'truthy': { const v = value(c.e, row); return v === true || (typeof v === 'number' && v !== 0) || v === 'TRUE'; }
      case 'cmp': {
        const d = compare(value(c.l, row), value(c.r, row));
        if (d === null) return c.op === '<>' ? !(empty(value(c.l, row)) && empty(value(c.r, row))) : c.op === '=' && empty(value(c.l, row)) && empty(value(c.r, row));
        return c.op === '=' ? d === 0 : c.op === '<>' ? d !== 0 : c.op === '<' ? d < 0 : c.op === '>' ? d > 0 : c.op === '<=' ? d <= 0 : d >= 0;
      }
      default: {
        const l = value(c.l, row), r = value(c.r, row);
        if (empty(l)) return false;
        const s = String(l), p = String(r ?? '');
        if (c.k === 'contains') return s.includes(p);
        if (c.k === 'starts') return s.startsWith(p);
        if (c.k === 'ends') return s.endsWith(p);
        if (c.k === 'like') return likeRe(p).test(s);
        if (p.length > 500) fail('That pattern is too long');
        let re; try { re = new RegExp(`^(?:${p})$`); } catch { fail(`"${p}" isn't a pattern QUERY can use`); }
        return re.test(s);
      }
    }
  }
  // Values of an expression over a group of rows (aggregates over the group, plain columns from its first row).
  function groupValue(e, group) {
    switch (e.k) {
      case 'agg': return aggregate(e.fn, group.map((row) => value(e.e, row)));
      case 'neg': { const v = groupValue(e.e, group); return empty(v) ? null : -numOf(v); }
      case 'fn': return scalarFn(e.fn, e.args.map((a) => groupValue(a, group)));
      case 'bin': {
        const l = groupValue(e.l, group), r = groupValue(e.r, group);
        if (empty(l) || empty(r)) return null;
        const a = numOf(l), b = numOf(r);
        if (e.op === '/' && b === 0) return null;
        return e.op === '+' ? a + b : e.op === '-' ? a - b : e.op === '*' ? a * b : a / b;
      }
      default: return group.length ? value(e, group[0]) : null;
    }
  }
  const labelOf = (e) => {
    const k = keyOf(e);
    if (q.labels.has(k)) return q.labels.get(k);
    if (e.k === 'col') return heads[colIndex(e.id)] || '';
    if (e.k === 'agg' && e.e.k === 'col') return `${e.fn} ${heads[colIndex(e.e.id)] || e.e.id}`;
    return k;
  };

  if (q.where) data = data.filter((row) => test(q.where, row));
  const select = q.select || ids.map((id) => ({ k: 'col', id }));
  for (const k of q.labels.keys()) if (!select.some((e) => keyOf(e) === k) && !q.pivot) fail(`The label for ${k} isn't for anything in "select"`);
  const aggregated = !!(q.groupBy || q.pivot || select.some(hasAgg));
  if (q.pivot && !select.some(hasAgg)) fail('"pivot" needs an aggregate like sum() in "select"');

  let header, out;
  if (!aggregated) {
    if (q.orderBy) data = data.map((row, n) => [row, n]).sort((a, b) => {
      for (const { e, desc } of q.orderBy) { const d = sortOrder(value(e, a[0]), value(e, b[0])); if (d) return desc ? -d : d; }
      return a[1] - b[1];
    }).map(([row]) => row);
    header = select.map(labelOf);
    out = data.map((row) => select.map((e) => value(e, row)));
  } else {
    const groupBy = q.groupBy || [];
    for (const e of select) if (!hasAgg(e) && !groupBy.some((g) => keyOf(g) === keyOf(e))) fail(`${keyOf(e)} needs to be in "group by", or inside an aggregate like sum()`);
    const keyFor = (row, exprs) => JSON.stringify(exprs.map((e) => value(e, row)));
    const groups = new Map();
    for (const row of data) { const k = keyFor(row, groupBy); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(row); }
    if (!groupBy.length && !groups.size) groups.set('[]', []);
    let list = [...groups.values()];
    // Groups come out in order of their group-by values (as Google Sheets does) unless "order by" says otherwise.
    const orderBy = q.orderBy || groupBy.map((e) => ({ e, desc: false }));
    list.sort((a, b) => { for (const { e, desc } of orderBy) { const d = sortOrder(groupValue(e, a), groupValue(e, b)); if (d) return desc ? -d : d; } return 0; });
    const plain = select.filter((e) => !hasAgg(e)), aggs = select.filter(hasAgg);
    if (!q.pivot) {
      header = select.map(labelOf);
      out = list.map((g) => select.map((e) => groupValue(e, g)));
    } else {
      const pivotKeys = new Map();
      for (const row of data) { const k = keyFor(row, q.pivot); if (!pivotKeys.has(k)) pivotKeys.set(k, q.pivot.map((e) => value(e, row))); }
      const pk = [...pivotKeys.entries()].sort((a, b) => { for (let j = 0; j < a[1].length; j++) { const d = sortOrder(a[1][j], b[1][j]); if (d) return d; } return 0; });
      if (pk.length * aggs.length > 500) fail('That pivot makes too many columns');
      header = [...plain.map(labelOf), ...pk.flatMap(([, vals]) => aggs.map((e) => [vals.map((v) => (empty(v) ? '' : String(v))).join(', '), ...(aggs.length > 1 ? [labelOf(e)] : [])].join(' ').trim()))];
      out = list.map((g) => [...plain.map((e) => groupValue(e, g)), ...pk.flatMap(([k]) => { const sub = g.filter((row) => keyFor(row, q.pivot) === k); return aggs.map((e) => (sub.length ? groupValue(e, sub) : null)); })]);
      if (!groupBy.length && !out.length) out = [header.map(() => null)];
    }
  }
  if (q.offset) out = out.slice(q.offset);
  if (q.limit !== null) out = out.slice(0, q.limit);
  const showHeader = h > 0 || aggregated || q.labels.size > 0;
  const result = showHeader ? [header, ...out] : out;
  return result.length ? result : null;
}

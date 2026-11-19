// Sheets' validation rules (number, whole number, date, text length, email and web address, custom formula) as
// OpenDocument content validations' conditions, both ways, written as LibreOffice writes them:
//   of:cell-content-is-decimal-number() and cell-content-is-between(1,99)
//   of:cell-content-is-date() and cell-content()<46568        (dates as day numbers)
//   of:cell-content-text-length()<=10, of:cell-content-text-length-is-between(1,10)
//   of:is-true-formula([.G2]<=[.H2])                           (for the range's first cell)
import { formulaToOds, formulaFromOds } from './ods.js';

const OPS = { gt: '>', gte: '>=', lt: '<', lte: '<=', eq: '=', ne: '!=' };
const KIND_TEST = { number: 'decimal-number', whole: 'whole-number', date: 'date' };
const DAY = 864e5, EPOCH = Date.UTC(1899, 11, 30);
const serial = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').trim()); return m ? String(Math.round((Date.UTC(+m[1], +m[2] - 1, +m[3]) - EPOCH) / DAY)) : null; };
const num = (t) => (String(t ?? '').trim() !== '' && Number.isFinite(Number(t)) ? String(Number(t)) : null);
const isoOf = (n) => new Date(EPOCH + Math.floor(Number(n)) * DAY).toISOString().slice(0, 10);

// As the Excel download writes them (excel.js): how an email or web address rule is told from any other formula.
export const emailFormula = (cell) => `ISNUMBER(MATCH("*@?*.?*",${cell},0))`;
export const urlFormula = (cell) => `OR(LEFT(${cell},7)="http://",LEFT(${cell},8)="https://",ISNUMBER(SEARCH(".",${cell})))`;
const EMAIL_RE = /^ISNUMBER\(MATCH\("\*@\?\*\.\?\*",\$?[A-Z]+\$?\d+,0\)\)$/i;
const URL_RE = /^OR\(LEFT\(\$?[A-Z]+\$?\d+,7\)="http:\/\/",LEFT/i;

/** A rule validation as a content validation's condition, or null when it can't be one. */
export function ruleToOdsCondition(v) {
  const c = v.check || {};
  const first = String(v.range || '').split(':')[0];
  const formula = (f) => `of:is-true-formula(${formulaToOds(f).replace(/^of:=/, '')})`;
  if (c.kind === 'email') return formula(emailFormula(first));
  if (c.kind === 'url') return formula(urlFormula(first));
  if (c.kind === 'formula') { const f = String(c.a || '').trim().replace(/^=/, ''); return f ? formula(f) : null; }
  const conv = c.kind === 'date' ? serial : num;
  const a = conv(c.a), b = conv(c.b);
  const between = c.op === 'between' || c.op === 'notBetween';
  if (a === null || (between && b === null) || (!between && !OPS[c.op])) return null;
  if (c.kind === 'length') {
    if (between) return `of:cell-content-text-length-is-${c.op === 'notBetween' ? 'not-' : ''}between(${a},${b})`;
    return `of:cell-content-text-length()${OPS[c.op]}${a}`;
  }
  const test = KIND_TEST[c.kind];
  if (!test) return null;
  return `of:cell-content-is-${test}() and ${between ? `cell-content-is-${c.op === 'notBetween' ? 'not-' : ''}between(${a},${b})` : `cell-content()${OPS[c.op]}${a}`}`;
}

/**
 * A content validation's condition as a rule validation, or null. `strict`: refused (an error message of type
 * stop, shown); `message`: its text.
 */
export function ruleFromOdsCondition(cond, { strict = false, message = '' } = {}) {
  const s = String(cond || '').trim().replace(/^(?:of|oooc):/i, '');
  const extra = { strict: !!strict, ...(message && { message: String(message).slice(0, 200) }) };
  const opOf = (sym) => ({ '>': 'gt', '>=': 'gte', '<': 'lt', '<=': 'lte', '=': 'eq', '!=': 'ne', '<>': 'ne' })[sym];
  const two = (args) => args.split(/[,;]/).map((t) => t.trim());
  const t = /^is-true-formula\(([\s\S]*)\)$/i.exec(s);
  if (t) {
    const f = formulaFromOds(`of:=${t[1]}`).replace(/^=/, '');
    if (EMAIL_RE.test(f)) return { type: 'rule', check: { kind: 'email' }, ...extra };
    if (URL_RE.test(f)) return { type: 'rule', check: { kind: 'url' }, ...extra };
    return { type: 'rule', check: { kind: 'formula', a: `=${f}` }, ...extra };
  }
  const len = /^cell-content-text-length\(\)\s*(<=|>=|!=|<>|=|<|>)\s*(-?[\d.]+)$/i.exec(s);
  if (len) return { type: 'rule', check: { kind: 'length', op: opOf(len[1]), a: num(len[2]) }, ...extra };
  const lenB = /^cell-content-text-length-is-(not-)?between\(([^)]*)\)$/i.exec(s);
  if (lenB) { const [a, b] = two(lenB[2]).map(num); return a !== null && b !== null ? { type: 'rule', check: { kind: 'length', op: lenB[1] ? 'notBetween' : 'between', a, b }, ...extra } : null; }
  const typed = /^cell-content-is-(decimal-number|whole-number|date)\(\)\s+and\s+(?:(?:of|oooc):)?([\s\S]+)$/i.exec(s);
  if (!typed) return null;
  const kind = { 'decimal-number': 'number', 'whole-number': 'whole', date: 'date' }[typed[1].toLowerCase()];
  const val = (x) => (kind === 'date' ? (/^-?\d+(\.\d+)?$/.test(x) ? isoOf(x) : (/^"?(\d{4}-\d{2}-\d{2})"?$/.exec(x) || [])[1] || null) : num(x));
  const between = /^cell-content-is-(not-)?between\(([^)]*)\)$/i.exec(typed[2].trim());
  if (between) { const [a, b] = two(between[2]).map(val); return a && b ? { type: 'rule', check: { kind, op: between[1] ? 'notBetween' : 'between', a, b }, ...extra } : null; }
  const cmp = /^cell-content\(\)\s*(<=|>=|!=|<>|=|<|>)\s*(.+)$/i.exec(typed[2].trim());
  const a = cmp && val(cmp[2].trim());
  return cmp && a ? { type: 'rule', check: { kind, op: opOf(cmp[1]), a }, ...extra } : null;
}

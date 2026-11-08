// Response validation (Forms): rules a question's answer must follow, checked on the form as people
// type and again by the server. web/src/apps/forms/formcheck.js is a copy (a test keeps them alike).
// A rule is { kind, op, a?, b?, msg? }:
//   short answers:  number (isnum, whole, gt, gte, lt, lte, eq, ne, between, notbetween),
//                   text (contains, notcontains, email, url), length, pattern
//   paragraphs:     length (minlen, maxlen), pattern (matches, notmatches)
//   tick boxes:     count (atleast, atmost, exactly)

export const CHECKS = {
  short: ['number', 'text', 'length', 'pattern'],
  paragraph: ['length', 'pattern'],
  checkbox: ['count'],
};
export const OPS = {
  number: [['isnum', 'Is a number'], ['whole', 'Is a whole number'], ['gt', 'Greater than'], ['gte', 'Greater than or equal to'], ['lt', 'Less than'], ['lte', 'Less than or equal to'], ['eq', 'Equal to'], ['ne', 'Not equal to'], ['between', 'Between'], ['notbetween', 'Not between']],
  text: [['contains', 'Contains'], ['notcontains', 'Doesn\'t contain'], ['email', 'Is an email address'], ['url', 'Is a web address']],
  length: [['maxlen', 'At most this many characters'], ['minlen', 'At least this many characters']],
  pattern: [['matches', 'Matches the pattern'], ['notmatches', 'Doesn\'t match the pattern']],
  count: [['atleast', 'Choose at least'], ['atmost', 'Choose at most'], ['exactly', 'Choose exactly']],
};
export const KIND_NAMES = { number: 'Number', text: 'Text', length: 'Length', pattern: 'Pattern', count: 'Number of choices' };
const NEEDS_A = new Set(['gt', 'gte', 'lt', 'lte', 'eq', 'ne', 'between', 'notbetween', 'contains', 'notcontains', 'maxlen', 'minlen', 'matches', 'notmatches', 'atleast', 'atmost', 'exactly']);
const NUMERIC_A = new Set(['gt', 'gte', 'lt', 'lte', 'eq', 'ne', 'between', 'notbetween', 'maxlen', 'minlen', 'atleast', 'atmost', 'exactly']);

/** Patterns that could take very long to check (a repeated group that itself repeats) aren't allowed. */
export function patternProblem(p) {
  if (typeof p !== 'string' || !p || p.length > 200) return 'Type a pattern of up to 200 characters';
  if (/\([^)]*[+*}][^)]*\)\s*[+*{]/.test(p) || /\\\d/.test(p)) return 'That pattern is too complicated';
  try { new RegExp(p); } catch { return 'That isn\'t a valid pattern'; }
  return null;
}

/** A tidy rule for this question type from what was sent, or null (no rule). Throws a message for a bad one. */
export function cleanCheck(type, raw) {
  if (!raw || typeof raw !== 'object' || !CHECKS[type]?.includes(raw.kind)) return null;
  const op = OPS[raw.kind].some(([o]) => o === raw.op) ? raw.op : OPS[raw.kind][0][0];
  const out = { kind: raw.kind, op };
  if (NEEDS_A.has(op)) {
    if (NUMERIC_A.has(op)) {
      const a = Number(raw.a);
      if (raw.a === '' || raw.a == null || !Number.isFinite(a)) throw new Error('Enter a number for the rule');
      out.a = a;
      if (['maxlen', 'minlen', 'atleast', 'atmost', 'exactly'].includes(op) && (!Number.isInteger(a) || a < 0)) throw new Error('Enter a whole number for the rule');
      if (op === 'between' || op === 'notbetween') {
        const b = Number(raw.b);
        if (raw.b === '' || raw.b == null || !Number.isFinite(b)) throw new Error('Enter both numbers for the rule');
        out.a = Math.min(a, b); out.b = Math.max(a, b);
      }
    } else if (raw.kind === 'pattern') {
      const problem = patternProblem(String(raw.a ?? ''));
      if (problem) throw new Error(problem);
      out.a = String(raw.a);
    } else {
      const a = String(raw.a ?? '');
      if (!a) throw new Error('Enter the text for the rule');
      out.a = a.slice(0, 200);
    }
  }
  const msg = String(raw.msg ?? '').trim().slice(0, 200);
  if (msg) out.msg = msg;
  return out;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(:\d+)?(\/\S*)?$/i;
const n = (x) => String(x);
const plural = (k, word) => `${k} ${word}${k === 1 ? '' : 's'}`;

/** What's wrong with this answer under the rule (a message), or null. An empty answer is left to "Required". */
export function checkProblem(rule, answer) {
  if (!rule) return null;
  const say = (m) => rule.msg || m;
  if (rule.kind === 'count') {
    const k = Array.isArray(answer) ? answer.length : 0;
    if (!k) return null;
    if (rule.op === 'atleast' && k < rule.a) return say(`Choose at least ${rule.a}`);
    if (rule.op === 'atmost' && k > rule.a) return say(`Choose at most ${rule.a}`);
    if (rule.op === 'exactly' && k !== rule.a) return say(`Choose exactly ${rule.a}`);
    return null;
  }
  const s = answer == null ? '' : String(answer).trim();
  if (!s) return null;
  if (rule.kind === 'number') {
    const v = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s.replace(/,/g, '')) ? Number(s.replace(/,/g, '')) : NaN;
    if (!Number.isFinite(v)) return say('Enter a number');
    const { a, b } = rule;
    const bad = { whole: !Number.isInteger(v), gt: !(v > a), gte: !(v >= a), lt: !(v < a), lte: !(v <= a), eq: v !== a, ne: v === a, between: v < a || v > b, notbetween: v >= a && v <= b }[rule.op];
    if (!bad) return null;
    return say({ whole: 'Enter a whole number', gt: `Enter a number greater than ${n(a)}`, gte: `Enter a number of at least ${n(a)}`, lt: `Enter a number less than ${n(a)}`, lte: `Enter a number of at most ${n(a)}`, eq: `Enter ${n(a)}`, ne: `Enter a number other than ${n(a)}`, between: `Enter a number from ${n(a)} to ${n(b)}`, notbetween: `Enter a number below ${n(a)} or above ${n(b)}` }[rule.op]);
  }
  if (rule.kind === 'text') {
    const has = s.toLowerCase().includes(String(rule.a || '').toLowerCase());
    if (rule.op === 'contains' && !has) return say(`Your answer must contain “${rule.a}”`);
    if (rule.op === 'notcontains' && has) return say(`Your answer can't contain “${rule.a}”`);
    if (rule.op === 'email' && !EMAIL.test(s)) return say('Enter an email address');
    if (rule.op === 'url' && !URL_RE.test(s)) return say('Enter a web address');
    return null;
  }
  if (rule.kind === 'length') {
    if (rule.op === 'maxlen' && s.length > rule.a) return say(`Use at most ${plural(rule.a, 'character')} (now ${s.length})`);
    if (rule.op === 'minlen' && s.length < rule.a) return say(`Use at least ${plural(rule.a, 'character')} (now ${s.length})`);
    return null;
  }
  if (rule.kind === 'pattern') {
    let ok;
    try { ok = new RegExp(rule.a).test(s); } catch { return null; }
    if (rule.op === 'matches' && !ok) return say('Your answer isn\'t in the expected form');
    if (rule.op === 'notmatches' && ok) return say('Your answer isn\'t in the expected form');
  }
  return null;
}

// A company's password rules: a minimum length, letters and numbers, a symbol, no well-known
// passwords (or ones made of the person's own name or address), and passwords that expire after a
// number of days (people then choose a new one before going on). Set in Admin → Company settings.
import { q } from './db.js';

for (const [col, type] of [['pw_min', 'INTEGER NOT NULL DEFAULT 8'], ['pw_mix', 'INTEGER NOT NULL DEFAULT 0'], ['pw_symbol', 'INTEGER NOT NULL DEFAULT 0'], ['pw_common', 'INTEGER NOT NULL DEFAULT 0'], ['pw_max_days', 'INTEGER NOT NULL DEFAULT 0']]) {
  if (!q('PRAGMA table_info(orgs)').all().some((c) => c.name === col)) q(`ALTER TABLE orgs ADD COLUMN ${col} ${type}`).run();
}
if (!q('PRAGMA table_info(users)').all().some((c) => c.name === 'password_set_at')) q('ALTER TABLE users ADD COLUMN password_set_at INTEGER').run();

export const DEFAULT_RULES = { min: 8, mix: false, symbol: false, common: false, max_days: 0 };
export const EXPIRY_CHOICES = [0, 30, 60, 90, 180, 365];

// Among the most used (and most guessed) passwords; compared ignoring case and trailing digits/symbols.
const COMMON = new Set(['password', 'passw0rd', 'p@ssword', 'p@ssw0rd', 'qwerty', 'qwertyuiop', 'asdfgh', 'asdfghjkl', 'zxcvbnm', 'abc', 'abcdef', 'abcdefg', 'abcdefgh',
  'letmein', 'welcome', 'admin', 'administrator', 'login', 'iloveyou', 'monkey', 'dragon', 'football', 'baseball', 'sunshine', 'princess', 'shadow', 'master',
  'superman', 'batman', 'trustno', 'starwars', 'whatever', 'freedom', 'hello', 'secret', 'changeme', 'default', 'test', 'guest', 'qazwsx', 'zaq1zaq',
  'company', 'office', 'summer', 'winter', 'spring', 'autumn', 'january', 'february', 'march', 'april', 'june', 'july', 'august', 'september', 'october',
  'november', 'december', 'malaysia', 'kualalumpur', 'workspace', 'computer', 'internet', 'samsung', 'google', 'microsoft', 'apple', 'facebook']);
const SEQUENCES = /^(0123456789|1234567890|987654321|11111111|00000000|12345678|123456789|87654321)/;

/** A company's rules. */
export function rulesOf(orgId) {
  const o = orgId && q('SELECT pw_min, pw_mix, pw_symbol, pw_common, pw_max_days FROM orgs WHERE id = ?').get(orgId);
  if (!o) return { ...DEFAULT_RULES };
  return { min: o.pw_min || 8, mix: !!o.pw_mix, symbol: !!o.pw_symbol, common: !!o.pw_common, max_days: o.pw_max_days || 0 };
}

/** What's wrong with a password under these rules (a sentence), or null when it's fine. */
export function passwordProblem(pw, rules = DEFAULT_RULES, { email = '', name = '' } = {}) {
  if (typeof pw !== 'string' || pw.length < rules.min) return `Password must be at least ${rules.min} characters`;
  if (pw.length > 200) return 'Password is too long';
  if (rules.mix && !(/\p{L}/u.test(pw) && /\d/.test(pw))) return 'Password must have both letters and numbers';
  if (rules.symbol && !/[^\p{L}\d]/u.test(pw)) return 'Password must have a symbol (like ! # or -)';
  if (rules.common) {
    const core = pw.toLowerCase().replace(/[\d\W_]+$/u, '').replace(/^[\d\W_]+/u, '');
    if (COMMON.has(core) || SEQUENCES.test(pw) || /^(.)\1+$/.test(pw)) return 'That password is too easy to guess. Choose another';
    const own = [String(email).split('@')[0], ...String(name).split(/\s+/)].map((x) => x.toLowerCase()).filter((x) => x.length >= 3);
    // Made mostly of your own name or address (with a few numbers or letters around it).
    const lower = pw.toLowerCase();
    if (own.some((x) => lower.includes(x))) {
      const rest = own.reduce((t, x) => t.split(x).join(''), lower).replace(/[^\p{L}]/gu, '');
      if (rest.length < 4) return 'Don’t use your own name or address as your password';
    }
  }
  return null;
}

/** Whether a password set at `setAt` has expired under these rules. */
export const isExpired = (rules, setAt, t = Date.now()) => !!rules.max_days && !!setAt && t - setAt > rules.max_days * 864e5;

/** Describe the rules in a line, for the forms where a password is chosen. */
export function rulesText(rules) {
  const extras = [rules.mix && 'letters and numbers', rules.symbol && 'a symbol'].filter(Boolean);
  return `Use at least ${rules.min} characters${extras.length ? `, with ${extras.join(' and ')}` : ''}${rules.common ? ', and nothing easy to guess' : ''}.`;
}

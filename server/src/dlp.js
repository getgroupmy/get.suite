// Data protection rules (Admin → Data protection): what may not leave the company by email. Each rule
// looks for something (credit card numbers, bank account numbers (IBAN), words, or a pattern of the
// admin's own) in messages sent from Workspace, to people outside the company or to anyone, and either
// warns the sender (who can still send, which is logged) or stops the message. Card numbers and IBANs
// must pass their check digits, so ordinary long numbers don't trip them.
import { q } from './db.js';
import { uid, bad, notFound } from './util.js';

export const DETECTORS = ['card', 'iban', 'words', 'pattern'];
export const MAX_RULES = 30;
const MAX_TEXT = 500000; // looked at per message

/** Luhn check digit, as on every payment card. */
export function luhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}
/** IBAN check digits (mod 97). */
export function ibanOk(iban) {
  const s = iban.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rest = 0;
  for (const ch of moved) {
    const v = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rest = (rest * 10 + Number(d)) % 97;
  }
  return rest === 1;
}
/** Shown in place of what was found: the last four characters only. */
const masked = (s) => { const t = s.replace(/[\s-]/g, ''); return `…${t.slice(-4)}`; };

/** What a rule finds in a text: up to 5 masked matches. */
export function findIn(rule, text) {
  const t = String(text || '').slice(0, MAX_TEXT);
  const found = [];
  if (rule.detector === 'card') {
    for (const m of t.matchAll(/(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/g)) {
      const digits = m[0].replace(/\D/g, '');
      if (digits.length >= 13 && digits.length <= 19 && /^[2-6]/.test(digits) && luhn(digits)) found.push(masked(m[0]));
      if (found.length >= 5) break;
    }
  } else if (rule.detector === 'iban') {
    for (const m of t.matchAll(/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{1,4}){3,8}\b/g)) {
      // The pattern can run on into a following word or number: try it shorter until the check digits fit.
      const parts = m[0].split(' ');
      for (let n = parts.length; n >= 1; n--) {
        const cand = parts.slice(0, n).join(' ');
        if (cand.replace(/\s/g, '').length < 15) break;
        if (ibanOk(cand)) { found.push(masked(cand)); break; }
      }
      if (found.length >= 5) break;
    }
  } else if (rule.detector === 'words') {
    const low = t.toLowerCase().replace(/\s+/g, ' '); // a phrase split over lines or tags still counts
    for (const w of rule.words || []) {
      const re = new RegExp(`(?<![\\p{L}\\p{N}])${w.toLowerCase().replace(/\s+/g, ' ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'u');
      if (re.test(low)) found.push(w);
      if (found.length >= 5) break;
    }
  } else if (rule.detector === 'pattern') {
    let re;
    try { re = new RegExp(rule.pattern, 'giu'); } catch { return []; }
    for (const m of t.matchAll(re)) { if (m[0]) found.push(masked(m[0])); if (found.length >= 5) break; }
  }
  return found;
}

const out = (r) => ({ id: r.id, name: r.name, detector: r.detector, words: r.words ? JSON.parse(r.words) : [], pattern: r.pattern || '', action: r.action, scope: r.scope, enabled: !!r.enabled });
export const rulesOf = (orgId) => q('SELECT * FROM dlp_rules WHERE org_id = ? ORDER BY created_at').all(orgId).map(out);

/** A rule as the admin gave it, checked: { name, detector, words?, pattern?, action, scope, enabled }. */
export function cleanRule(b = {}) {
  const name = String(b.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!name) throw bad('Give the rule a name');
  if (!DETECTORS.includes(b.detector)) throw bad('Choose what to look for');
  const action = b.action === 'block' ? 'block' : 'warn';
  const scope = b.scope === 'all' ? 'all' : 'outside';
  let words = null, pattern = null;
  if (b.detector === 'words') {
    const list = (Array.isArray(b.words) ? b.words : String(b.words || '').split(/[,\n]/)).map((w) => String(w).trim()).filter(Boolean);
    const unique = [...new Set(list.map((w) => w.slice(0, 60)))].slice(0, 100);
    if (!unique.length) throw bad('List at least one word or phrase');
    words = JSON.stringify(unique);
  }
  if (b.detector === 'pattern') {
    pattern = String(b.pattern || '').trim();
    if (!pattern || pattern.length > 200) throw bad('Give a pattern of up to 200 characters');
    try { new RegExp(pattern, 'giu'); } catch { throw bad('That pattern isn’t valid'); }
    if (/(\([^)]*[+*][^)]*\))[+*{]/.test(pattern)) throw bad('Nested repeats like (a+)+ are too slow to check');
    if (new RegExp(pattern, 'giu').test('')) throw bad('The pattern matches nothing at all: make it more specific');
  }
  return { name, detector: b.detector, words, pattern, action, scope, enabled: b.enabled === false ? 0 : 1 };
}

export function addRule(orgId, body) {
  if (q('SELECT COUNT(*) AS n FROM dlp_rules WHERE org_id = ?').get(orgId).n >= MAX_RULES) throw bad(`At most ${MAX_RULES} rules`);
  const r = cleanRule(body);
  const id = uid();
  q('INSERT INTO dlp_rules (id, org_id, name, detector, words, pattern, action, scope, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, orgId, r.name, r.detector, r.words, r.pattern, r.action, r.scope, r.enabled, Date.now());
  return out(q('SELECT * FROM dlp_rules WHERE id = ?').get(id));
}
export function changeRule(orgId, id, body) {
  const old = q('SELECT * FROM dlp_rules WHERE id = ? AND org_id = ?').get(id, orgId);
  if (!old) throw notFound('Rule not found');
  const r = cleanRule({ ...out(old), ...body });
  q('UPDATE dlp_rules SET name = ?, detector = ?, words = ?, pattern = ?, action = ?, scope = ?, enabled = ? WHERE id = ?').run(r.name, r.detector, r.words, r.pattern, r.action, r.scope, r.enabled, id);
  return out(q('SELECT * FROM dlp_rules WHERE id = ?').get(id));
}
export function removeRule(orgId, id) {
  if (!q('DELETE FROM dlp_rules WHERE id = ? AND org_id = ?').run(id, orgId).changes) throw notFound('Rule not found');
}

/** Text of an HTML body, near enough to look through. */
export const textOfHtml = (html) => String(html || '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)));

/**
 * The rules a message breaks: { block: [hits], warn: [hits] }, each hit { rule, found }. `outside` says
 * whether any recipient is outside the company (rules for outside only don't apply otherwise).
 */
export function checkMessage(orgId, { subject = '', text = '', html = '', names = [] }, outside) {
  const body = [subject, text, textOfHtml(html), ...names].join('\n');
  const res = { block: [], warn: [] };
  for (const r of rulesOf(orgId)) {
    if (!r.enabled || (r.scope === 'outside' && !outside)) continue;
    const found = findIn(r, body);
    if (found.length) res[r.action].push({ rule: { id: r.id, name: r.name, detector: r.detector }, found });
  }
  return res;
}

const WHAT = { card: 'a credit card number', iban: 'a bank account number (IBAN)', words: 'words your company protects', pattern: 'protected information' };
/** One line for the sender: what the rules found. */
export const describeHits = (hits) => hits.map((h) => `${WHAT[h.rule.detector]} (${h.rule.name}: ${h.found.join(', ')})`).join('; ');

// ---- files: a public link, publishing to the web, or sharing with someone in another company
const MAX_FILES = 200;
/** A file, or the files inside a folder (and its folders), up to 200. */
export function filesFor(given) {
  const f = q('SELECT * FROM files WHERE id = ?').get(given.id) || given; // the whole row, whatever the caller had
  if (f.kind !== 'folder') return [f];
  const out = [], queue = [f.id];
  while (queue.length && out.length < MAX_FILES) {
    for (const c of q('SELECT * FROM files WHERE parent_id = ? AND trashed = 0').all(queue.shift())) {
      if (c.kind === 'folder') queue.push(c.id); else out.push(c);
      if (out.length >= MAX_FILES) break;
    }
  }
  return out;
}
/** The rules files break when they leave the company: { block: [hits], warn: [hits] }, each hit with its file's name. */
export async function checkFiles(orgId, files) {
  const rules = rulesOf(orgId).filter((r) => r.enabled);
  const res = { block: [], warn: [] };
  if (!rules.length) return res;
  const { textOf } = await import('./search.js');
  for (const f of files) {
    const text = `${f.name || ''}\n${await textOf(f)}`;
    for (const r of rules) {
      const found = findIn(r, text);
      if (found.length) res[r.action].push({ rule: { id: r.id, name: r.name, detector: r.detector }, found, file: f.name });
    }
  }
  return res;
}
/**
 * For routes: stop a file leaving the company when a rule says so (400 to block; 409 with what was found to
 * warn, until the request says dlpConfirmed). Logs blocks and confirmed warnings. True when it answered.
 */
export async function fileRulesStop(req, res, files, what, audit, asked = null) {
  const hits = await checkFiles(req.user.org_id, files);
  const name = asked || (files.length === 1 ? files[0].name : `${files.length} files`);
  const where = (h) => `${describeHits([h])}${h.file !== name ? ` in “${h.file}”` : ''}`;
  if (hits.block.length) {
    audit(req, 'dlp.blocked', { target: name, details: { what, rules: [...new Set(hits.block.map((h) => h.rule.name))] } });
    res.status(400).json({ error: `This can’t be ${what}: it contains ${hits.block.slice(0, 3).map(where).join('; ')}. Your company doesn’t allow that outside the company.`, dlp: { block: hits.block } });
    return true;
  }
  if (hits.warn.length && req.body?.dlpConfirmed !== true) {
    res.status(409).json({ error: `It contains ${hits.warn.slice(0, 3).map(where).join('; ')}.`, dlp: { warn: hits.warn } });
    return true;
  }
  if (hits.warn.length) audit(req, 'dlp.sent_anyway', { target: name, details: { what, rules: [...new Set(hits.warn.map((h) => h.rule.name))] } });
  return false;
}

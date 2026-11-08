// The company signature: one an admin writes for everyone, with {name}, {job_title}, {department},
// {work_phone}, {email} and {company} filled in for each person and address. It's either what people
// get until they write their own ('default'), or what everyone uses ('always').
import { q } from '../db.js';

for (const c of ['signature_template TEXT', "signature_mode TEXT NOT NULL DEFAULT 'off'"]) {
  if (!q('PRAGMA table_info(orgs)').all().some((x) => x.name === c.split(' ')[0])) q(`ALTER TABLE orgs ADD COLUMN ${c}`).run();
}
export const SIGNATURE_MODES = ['off', 'default', 'always'];
export const FIELDS = ['name', 'job_title', 'department', 'work_phone', 'email', 'company'];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * The template (plain text, one line per line; or HTML from the signature editor) filled in. A line
 * whose placeholders are all empty is left out, so "{job_title} · {department}" disappears for
 * someone with neither.
 */
export function fillSignature(template, values) {
  const t = String(template || '');
  const isHtml = /<[a-z][\s\S]*>/i.test(t);
  const fillLine = (line, escapeText) => {
    const used = [...line.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((k) => FIELDS.includes(k));
    if (used.length && used.every((k) => !values[k])) return null;
    const out = (escapeText ? esc(line) : line).replace(/\{(\w+)\}/g, (m, k) => (FIELDS.includes(k) ? esc(values[k] || '') : m));
    return out;
  };
  if (!isHtml) return t.split(/\r?\n/).map((l) => fillLine(l, true)).filter((l) => l !== null).map((l) => `<p>${l || '<br>'}</p>`).join('');
  // HTML: each paragraph (and each line within one) on its own.
  return t.replace(/<p([^>]*)>([\s\S]*?)<\/p>/gi, (m, attrs, inner) => {
    const parts = inner.split(/<br\s*\/?>/i).map((l) => fillLine(l, false)).filter((l) => l !== null);
    return parts.length ? `<p${attrs}>${parts.join('<br>')}</p>` : '';
  });
}

/** The company's signature settings: { mode, template }. */
export const companySignature = (orgId) => {
  const o = q('SELECT signature_template, signature_mode, name FROM orgs WHERE id = ?').get(orgId);
  return { mode: o?.signature_template ? o.signature_mode : 'off', template: o?.signature_template || '', company: o?.name || '' };
};

/** Someone's company signature for one of their addresses (HTML), or null when there isn't one. */
export function companySignatureFor(user, address) {
  const c = companySignature(user.org_id);
  if (c.mode === 'off') return null;
  const u = q('SELECT name, job_title, department, work_phone FROM users WHERE id = ?').get(user.id) || {};
  return fillSignature(c.template, { ...u, email: address, company: c.company });
}

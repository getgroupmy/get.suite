// Finding and merging duplicate contacts: the same email address, the same phone number (ignoring
// spaces and the country prefix) or the same name (ignoring case and spacing) puts contacts in one
// group. Merging keeps one of them, fills its empty fields from the others, adds their other email
// addresses and numbers to its own, and notes anything else that differs, so nothing is lost.
import { cleanMore } from './contactmore.js';

const norm = {
  email: (v) => String(v || '').trim().toLowerCase() || null,
  phone: (v) => { const d = String(v || '').replace(/\D/g, ''); return d.length >= 7 ? d.slice(-9) : null; },
  name: (v) => { const n = String(v || '').trim().toLowerCase().replace(/\s+/g, ' '); return n.length >= 2 ? n : null; },
};

/** Groups of contacts that look like the same person: [[contact, …], …], each with 2 or more, largest first. */
export function duplicateGroups(contacts) {
  const parent = contacts.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const seen = new Map();
  contacts.forEach((c, i) => {
    for (const [k, f] of Object.entries(norm)) {
      const v = f(c[k]);
      if (!v) continue;
      const key = `${k}:${v}`;
      if (seen.has(key)) parent[find(i)] = find(seen.get(key)); else seen.set(key, i);
    }
  });
  const groups = new Map();
  contacts.forEach((c, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(c); });
  return [...groups.values()].filter((g) => g.length > 1)
    .map((g) => g.sort((a, b) => filled(b) - filled(a) || String(a.name).localeCompare(String(b.name))))
    .sort((a, b) => b.length - a.length || String(a[0].name).localeCompare(String(b[0].name)));
}

const FIELDS = ['name', 'email', 'phone', 'company', 'title', 'address', 'website', 'birthday'];
const filled = (c) => FIELDS.filter((k) => c[k]).length + (c.notes ? 1 : 0);
const NOTED = { address: 'Also address', company: 'Also company', title: 'Also title', website: 'Also website' };

/**
 * The fields of `keep` merged with the others: empty ones filled, other email addresses and phone numbers
 * added to its lists of them (more_emails, more_phones), other differing details noted, notes joined.
 */
export function mergedFields(keep, others) {
  const out = Object.fromEntries([...FIELDS, 'notes'].map((k) => [k, keep[k] ?? null]));
  const more = { email: [...cleanMore(keep.more_emails, 'emails')], phone: [...cleanMore(keep.more_phones, 'phones')] };
  const extra = [];
  for (const o of others) {
    more.email.push(...cleanMore(o.more_emails, 'emails'));
    more.phone.push(...cleanMore(o.more_phones, 'phones'));
    for (const k of FIELDS) {
      if (!o[k]) continue;
      if (!out[k]) { out[k] = o[k]; continue; }
      const same = k in norm ? norm[k](out[k]) === norm[k](o[k]) : String(out[k]).trim().toLowerCase() === String(o[k]).trim().toLowerCase();
      if (same) continue;
      if (k === 'email' || k === 'phone') more[k].push({ type: 'other', value: o[k] });
      else if (NOTED[k]) extra.push(`${NOTED[k]}: ${o[k]}`);
    }
  }
  const samePhone = (a, b) => norm.phone(a) && norm.phone(a) === norm.phone(b);
  out.more_emails = cleanMore(more.email, 'emails', { main: out.email });
  out.more_phones = cleanMore(more.phone, 'phones', { main: out.phone }).filter((p, i, all) => !samePhone(p.value, out.phone) && all.findIndex((x) => samePhone(x.value, p.value)) === i);
  const notes = [out.notes, ...others.map((o) => o.notes)].map((n) => String(n || '').trim()).filter(Boolean);
  const all = [...new Set([...notes, ...new Set(extra)])];
  out.notes = all.length ? all.join('\n').slice(0, 5000) : null;
  return out;
}

// Companies among your contacts: their names (for filling in the same company the same way), and
// who else is at one.
import { fold } from '../../fold.js';

const key = (company) => fold(String(company || '').trim()).replace(/\s+/g, ' ');

/** The companies your contacts are at, each once (as most often written), A to Z. */
export function companyNames(contacts) {
  const seen = new Map(); // folded name → Map(spelling → how often)
  for (const c of contacts || []) {
    const name = String(c.company || '').trim();
    if (!name) continue;
    const k = key(name);
    if (!seen.has(k)) seen.set(k, new Map());
    seen.get(k).set(name, (seen.get(k).get(name) || 0) + 1);
  }
  return [...seen.values()].map((spellings) => [...spellings.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0])
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

/** Your other contacts at the same company (capitals, accents and spacing aside), by name. */
export function othersAt(contacts, contact) {
  const k = key(contact?.company);
  if (!k) return [];
  return (contacts || []).filter((c) => c.id !== contact.id && key(c.company) === k)
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' }));
}

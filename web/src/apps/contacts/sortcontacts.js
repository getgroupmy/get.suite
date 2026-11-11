// Sorting contacts: by first name, last name (the last word of the name), company, or recently added.
// Starred ones come first in any order, as they always have.

export const CONTACT_SORTS = [['first', 'First name'], ['last', 'Last name'], ['company', 'Company'], ['added', 'Recently added']];

const lastName = (name) => { const w = String(name || '').trim().split(/\s+/); return w.length > 1 ? `${w[w.length - 1]} ${w.slice(0, -1).join(' ')}` : w[0] || ''; };
const cmp = (a, b) => String(a || '').localeCompare(String(b || ''), undefined, { sensitivity: 'base' });

/** The contacts in that order (a new list); those without a company go after those with one. */
export function sortContacts(list, sort) {
  const by = {
    first: (a, b) => cmp(a.name, b.name),
    last: (a, b) => cmp(lastName(a.name), lastName(b.name)),
    company: (a, b) => (!a.company - !b.company) || cmp(a.company, b.company) || cmp(a.name, b.name),
    added: (a, b) => (b.created_at || 0) - (a.created_at || 0),
  }[sort] || ((a, b) => cmp(a.name, b.name));
  return [...list].sort((a, b) => (!!b.starred - !!a.starred) || by(a, b));
}

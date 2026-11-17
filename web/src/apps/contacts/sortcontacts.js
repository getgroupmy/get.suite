// Sorting contacts: by first name, last name (the last word of the name), company, recently added, or when you
// were last in touch (emailed them from Workspace, or logged a call or meeting): most recent first, never last.
// Starred ones come first in any order, as they always have.

export const CONTACT_SORTS = [['first', 'First name'], ['last', 'Last name'], ['company', 'Company'], ['added', 'Recently added'], ['touch', 'Last in touch']];

const lastName = (name) => { const w = String(name || '').trim().split(/\s+/); return w.length > 1 ? `${w[w.length - 1]} ${w.slice(0, -1).join(' ')}` : w[0] || ''; };
const cmp = (a, b) => String(a || '').localeCompare(String(b || ''), undefined, { sensitivity: 'base' });

/** The contacts in that order (a new list); those without a company go after those with one. */
export function sortContacts(list, sort) {
  const by = {
    first: (a, b) => cmp(a.name, b.name),
    last: (a, b) => cmp(lastName(a.name), lastName(b.name)),
    company: (a, b) => (!a.company - !b.company) || cmp(a.company, b.company) || cmp(a.name, b.name),
    added: (a, b) => (b.created_at || 0) - (a.created_at || 0),
    touch: (a, b) => (b.last_contact || 0) - (a.last_contact || 0) || cmp(a.name, b.name),
  }[sort] || ((a, b) => cmp(a.name, b.name));
  return [...list].sort((a, b) => (!!b.starred - !!a.starred) || by(a, b));
}

/** "In touch today", "In touch 3 days ago", "In touch 5 weeks ago"; "Not in touch yet". */
export function touchAgo(at, now = Date.now()) {
  if (!at) return 'Not in touch yet';
  const days = Math.floor((now - at) / 864e5);
  if (days < 1) return 'In touch today';
  if (days === 1) return 'In touch yesterday';
  if (days < 14) return `In touch ${days} days ago`;
  if (days < 60) return `In touch ${Math.round(days / 7)} weeks ago`;
  if (days < 730) return `In touch ${Math.round(days / 30)} months ago`;
  return `In touch ${Math.round(days / 365)} years ago`;
}

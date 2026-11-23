// What a colleague or a contact says under their name in search results.

/** A colleague: their job title and department, and their status when they've set one (🌴 On holiday), then address. */
export function personSub(p) {
  const status = p.status && [p.status.emoji, p.status.text].filter(Boolean).join(' ');
  return [p.job_title, p.department, status, p.username].filter(Boolean).join(' · ');
}

/** What a colleague is found by: name, address, job title and department (so "finance" finds the finance people). */
export const personFields = (p) => ({ name: p.name, username: p.username, job_title: p.job_title || '', department: p.department || '' });

/** A contact: their job title at their company, then their address. */
export function contactSub(c) {
  const job = c.title && c.company ? `${c.title} at ${c.company}` : c.title || c.company;
  return [job, c.email].filter(Boolean).join(' · ');
}

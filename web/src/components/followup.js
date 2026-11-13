// A follow-up email after a meeting: to everyone who joined (not you, not guests without an address), with the
// meeting's name and, when there are some, a link to its meeting notes.
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function followUpEmail({ title, people = [], me = '', notesLink = '' }) {
  const mine = String(me).toLowerCase();
  const seen = new Set();
  const to = people.filter((p) => p.email && p.email.toLowerCase() !== mine && !seen.has(p.email.toLowerCase()) && seen.add(p.email.toLowerCase()))
    .map((p) => (p.name && p.name !== p.email ? `"${p.name.replace(/"/g, '')}" <${p.email}>` : p.email)).join(', ');
  const html = `<p>Thanks for joining ${esc(title || 'the meeting')}.</p><p></p>${notesLink ? `<p><a href="${esc(notesLink)}">Meeting notes</a></p>` : ''}`;
  return { to, subject: `Follow-up: ${title || 'our meeting'}`, html };
}

// "Email guests": an event as a new email to everyone on it (the organizer and the guests, but not you),
// with its title as the subject and when, where and a link to it in the message.
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** { to, subject, html } for the event; `when` is how its time reads ("Tue 10 Nov, 14:00 – 15:00"), `link` its address. */
export function eventEmail(event, me, { when = '', link = '', skipDeclined = false } = {}) {
  const mine = String(me || '').toLowerCase();
  const people = [...(event.organizer?.email ? [{ email: event.organizer.email, name: event.organizer.name }] : []), ...(event.guests || [])]
    .filter((g) => g.email && g.email.toLowerCase() !== mine && !(skipDeclined && g.status === 'no'));
  const seen = new Set();
  const to = people.filter((g) => !seen.has(g.email.toLowerCase()) && seen.add(g.email.toLowerCase()))
    .map((g) => (g.name && g.name !== g.email ? `"${g.name.replace(/"/g, '')}" <${g.email}>` : g.email)).join(', ');
  const lines = [
    when && `<p><strong>When:</strong> ${esc(when)}</p>`,
    event.location && `<p><strong>Where:</strong> ${esc(event.location)}</p>`,
    link && `<p><a href="${esc(link)}">${esc(event.title || 'The event')} in Calendar</a></p>`,
  ].filter(Boolean);
  return { to, subject: event.title || 'Our event', html: `<p></p>${lines.join('')}` };
}

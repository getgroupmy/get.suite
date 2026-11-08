// Meeting notes (Calendar): a document for an event, with its title, when it is, who's coming (as
// @mention chips for colleagues, addresses for people outside), and places for the agenda, notes and
// action items. Built here so the server can make, attach and share it in one step.

const text = (t, marks) => ({ type: 'text', text: t, ...(marks && { marks }) });
const para = (...content) => ({ type: 'paragraph', ...(content.filter(Boolean).length && { content: content.filter(Boolean) }) });
const heading = (level, t) => ({ type: 'heading', attrs: { level }, content: [text(t)] });

/** "Tuesday 10 March 2026, 14:00–15:00 (Europe/London)" in the event's time zone. */
export function whenText(ev, tz = 'UTC') {
  const zone = (() => { try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return tz; } catch { return 'UTC'; } })();
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(ev.start);
  if (ev.all_day) return day;
  const time = (t) => new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(t);
  return `${day}, ${time(ev.start)}–${time(ev.end)} (${zone})`;
}

/** The name of the notes document: "Notes – Weekly sync (10 Mar 2026)". */
export function notesName(ev, tz = 'UTC') {
  let zone = tz;
  try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); } catch { zone = 'UTC'; }
  const d = new Intl.DateTimeFormat('en-GB', { timeZone: zone, day: 'numeric', month: 'short', year: 'numeric' }).format(ev.start);
  return `Notes – ${(ev.title || 'Event').slice(0, 150)} (${d})`;
}

/** The document: organizer and colleagues as mentions, outside guests as addresses. */
export function notesContent(ev, { organizer, guests = [], outside = [], tz = 'UTC' }) {
  const people = [organizer, ...guests.filter((g) => g.id !== organizer.id)];
  const attendees = [];
  for (const p of people) {
    if (attendees.length) attendees.push(text(', '));
    attendees.push({ type: 'mention', attrs: { id: p.id, name: p.name, email: p.email } });
  }
  for (const o of outside) { if (attendees.length) attendees.push(text(', ')); attendees.push(text(o.email)); }
  const lines = [
    heading(1, ev.title || 'Meeting notes'),
    para(text('When: ', [{ type: 'bold' }]), text(whenText(ev, tz))),
    ev.location ? para(text('Where: ', [{ type: 'bold' }]), text(ev.location)) : null,
    para(text('Attendees: ', [{ type: 'bold' }]), ...attendees),
    heading(2, 'Agenda'),
    ...(ev.description ? String(ev.description).split(/\r?\n/).filter((l) => l.trim()).slice(0, 50).map((l) => para(text(l.slice(0, 2000)))) : []),
    { type: 'bulletList', content: [{ type: 'listItem', content: [para()] }] },
    heading(2, 'Notes'),
    para(),
    heading(2, 'Action items'),
    { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: false }, content: [para()] }] },
  ];
  return { type: 'doc', content: lines.filter(Boolean) };
}

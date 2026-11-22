// Calendar → Print or save as PDF → Copy to a document: the agenda as a document to keep and add to (a heading a day, a
// table of the times and what's on, with where), for a week's plan or a trip itinerary.

/** The document (TipTap JSON) for an agenda: `days` is [{ day: Date, items: [{ title, start, end, all_day, location, kind }] }]. */
export function agendaDoc(title, days, { dayName = (d) => d.toDateString(), time = (ms) => new Date(ms).toISOString().slice(11, 16) } = {}) {
  const T = (text, marks) => ({ type: 'text', text: String(text), ...(marks && { marks }) });
  const P = (...parts) => ({ type: 'paragraph', ...(parts.length && { content: parts }) });
  const cell = (head, ...parts) => ({ type: head ? 'tableHeader' : 'tableCell', content: [P(...parts)] });
  const content = [{ type: 'heading', attrs: { level: 1 }, content: [T(title)] }];
  if (!days.length) content.push(P(T('Nothing scheduled.', [{ type: 'italic' }])));
  for (const { day, items } of days) {
    content.push({ type: 'heading', attrs: { level: 2 }, content: [T(dayName(day))] });
    content.push({ type: 'table', content: [
      { type: 'tableRow', content: [cell(true, T('When')), cell(true, T('What'))] },
      ...items.map((ev) => ({ type: 'tableRow', content: [
        cell(false, T(ev.all_day ? 'All day' : `${time(ev.start)} – ${time(ev.end)}`)),
        cell(false, T(ev.title || '(No title)', [{ type: 'bold' }]), ...(ev.location ? [T(` · ${ev.location}`)] : []), ...(ev.kind === 'ooo' ? [T(' (out of office)', [{ type: 'italic' }])] : [])),
      ] })),
    ] });
  }
  return { type: 'doc', content };
}

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

/**
 * The agenda as rows for a spreadsheet (Open in Sheets): the heading row, then an event a row with its day, start and
 * end (24-hour), how many hours, title and where; an all-day event without times. `day` and `hhmm` give local text.
 */
export function agendaRows(days, { day = (d) => d.toISOString().slice(0, 10), hhmm = (ms) => new Date(ms).toISOString().slice(11, 16) } = {}) {
  const rows = [['Date', 'Start', 'End', 'Hours', 'What', 'Where']];
  for (const { day: d, items } of days) {
    for (const ev of items) {
      const hours = ev.all_day ? '' : String(Math.round(((ev.end - ev.start) / 36e5) * 100) / 100);
      rows.push([day(d), ev.all_day ? 'All day' : hhmm(ev.start), ev.all_day ? '' : hhmm(ev.end), hours, ev.title || '(No title)', ev.location || '']);
    }
  }
  return rows;
}

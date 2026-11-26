import { parseQuickEvent } from '../calendar/quickevent.js';
// Printing one note: its title, then its text or checklist (ticked items struck through, sub-items indented), and labels.
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function notePrintHtml(n) {
  const items = n.items ? `<ul>${n.items.map((i) => `<li class="${i.done ? 'done' : ''}${i.indent ? ' sub' : ''}"><span>${i.done ? '☑' : '☐'}</span> ${esc(i.text)}</li>`).join('')}</ul>` : '';
  const body = !n.items && n.body ? `<p>${esc(n.body).replace(/\n/g, '<br>')}</p>` : '';
  const labels = n.labels?.length ? `<p class="labels">${n.labels.map(esc).join(' · ')}</p>` : '';
  // Its pictures, from this server (the print frame loads them before printing).
  const pics = n.id && n.pictures?.length ? `<div class="pics">${n.pictures.map((p) => `<img src="/api/notes/${encodeURIComponent(n.id)}/pictures/${encodeURIComponent(p.id || p)}" alt="">`).join('')}</div>` : '';
  // Its comments (a shared note's), when given: [{ text, at, by: { name } }], under it.
  const comments = n.commentList?.length ? `<section class="comments"><h2>Comments</h2><ul>${n.commentList.map((c) => `<li><b>${esc(c.by?.name || 'Someone')}</b> <span class="when">${esc(new Date(c.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }))}${c.edited_at ? ' (edited)' : ''}</span><br>${esc(c.text).replace(/\n/g, '<br>')}</li>`).join('')}</ul></section>` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(n.title || 'Note')}</title><style>
    body { font: 14px/1.5 system-ui, sans-serif; color: #202124; margin: 24px; } h1 { font-size: 20px; margin: 0 0 10px; }
    ul { list-style: none; padding: 0; margin: 0; } li { padding: 2px 0; } li.sub { padding-left: 24px; } li.done { text-decoration: line-through; color: #5f6368; }
    .labels { color: #5f6368; font-size: 12px; margin-top: 16px; }
    .pics img { display: block; max-width: 100%; max-height: 60vh; margin: 12px 0 0; break-inside: avoid; }
    .comments { margin-top: 20px; border-top: 1px solid #dadce0; } .comments h2 { font-size: 14px; margin: 12px 0 6px; }
    .comments li { padding: 4px 0; break-inside: avoid; } .comments .when { color: #5f6368; font-size: 12px; }
  </style></head><body>${n.title ? `<h1>${esc(n.title)}</h1>` : ''}${pics}${body}${items}${labels}${comments}</body></html>`;
}

/**
 * A note as a new email: its title as the subject (or the first words of its text), and its text or
 * checklist (☑ / ☐, sub-items indented) as the message, with a link back to the note.
 */
export function noteEmail(n, link = '') {
  const first = (n.body || n.items?.[0]?.text || '').trim().split('\n')[0];
  const subject = (n.title || '').trim() || (first.length > 60 ? `${first.slice(0, 57)}…` : first) || 'Note';
  const items = n.items?.length
    ? `<ul style="list-style:none;padding:0">${n.items.map((i) => `<li${i.indent ? ' style="padding-left:24px"' : ''}>${i.done ? '☑' : '☐'} ${i.done ? `<s>${esc(i.text)}</s>` : esc(i.text)}</li>`).join('')}</ul>` : '';
  const body = !n.items && n.body ? `<p>${esc(n.body).replace(/\n/g, '<br>')}</p>` : '';
  const back = link ? `<p style="color:#5f6368;font-size:12px">From my notes: <a href="${esc(link)}">${esc(link)}</a></p>` : '';
  return { subject, html: `${body}${items}${back}` };
}

/**
 * A note as a new calendar event, to set aside time for it: its title (or first words) as the event's, and its text
 * or checklist (☑ / ☐, sub-items indented) with a link back as the description. { title, description }
 */
export function noteEvent(n, link = '') {
  const text = n.items?.length ? n.items.map((i) => `${i.indent ? '  ' : ''}${i.done ? '☑' : '☐'} ${i.text}`).join('\n') : (n.body || '').trim();
  return { title: noteEmail(n).subject.slice(0, 200), description: [text, link && `From my notes: ${link}`].filter(Boolean).join('\n\n').slice(0, 5000) };
}

/**
 * The whole new event for "Schedule time for it…": noteEvent, an hour from the next full hour, unless the note's title
 * (or first words) names a day or a time ("Dentist friday 9am"), which then sets when, as Calendar's quick add reads it.
 */
export function noteEventAt(n, link = '', now = Date.now()) {
  const ev = noteEvent(n, link);
  const d = new Date(now), pad = (x) => String(x).padStart(2, '0');
  const q = parseQuickEvent(ev.title, { today: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` });
  if (q) return { ...ev, title: q.title || ev.title, start: q.start, end: q.end, all_day: q.all_day, location: '' };
  const t = new Date(now); t.setMinutes(0, 0, 0); t.setHours(t.getHours() + 1);
  return { ...ev, start: t.getTime(), end: t.getTime() + 36e5, all_day: 0, location: '' };
}

/** Several notes on one printout, each starting on its own page (its body as notePrintHtml makes it). */
export function notesPrintHtml(notes) {
  const bodies = notes.map((n) => /<body>([\s\S]*)<\/body>/.exec(notePrintHtml(n))[1]);
  const style = /<style>([\s\S]*?)<\/style>/.exec(notePrintHtml(notes[0] || {}))[1];
  return `<!doctype html><html><head><meta charset="utf-8"><title>Notes (${notes.length})</title><style>${style}
    section.note + section.note { break-before: page; }</style></head><body>${bodies.map((b) => `<section class="note">${b}</section>`).join('')}</body></html>`;
}

/** Several notes as one new email: each under its title (with a link back), the subject the one title they share or "3 notes". */
export function notesEmail(notes, linkOf = () => '') {
  if (notes.length === 1) return noteEmail(notes[0], linkOf(notes[0]));
  // Titles in bold (Mail's editor keeps that; not headings or rules), a note after another.
  const parts = notes.map((n) => { const e = noteEmail(n, linkOf(n)); return `<p><strong>${esc(n.title || e.subject)}</strong></p>${e.html}`; });
  const titles = [...new Set(notes.map((n) => (n.title || '').trim()).filter(Boolean))];
  return { subject: titles.length === 1 ? titles[0] : `${notes.length} notes`, html: parts.join('<p></p>') };
}

/** The notes with their comments fetched (for those that have any), to print them; a note whose comments can't be had prints without. */
export const withComments = (notes, get) => Promise.all(notes.map(async (n) => (n.comments > 0 ? { ...n, commentList: await get(`/notes/${n.id}/comments`).catch(() => []) } : n)));

// Building blocks in documents (email and event drafts): what's offered after "@", and what Mail and Calendar open with.
export const DRAFT_KEY = 'nw.composeFromDoc';

/** Building blocks offered for what's typed after "@": an email draft, an event draft. */
const BLOCKS = [['email draft mail', 'Email draft', 'block:email'], ['event draft meeting calendar', 'Event draft', 'block:event']];
export function matchBlocks(query) {
  const q = String(query || '').toLowerCase();
  if (q.length < 2) return [];
  return BLOCKS.filter(([words]) => words.split(' ').some((w) => w.startsWith(q)))
    .map(([, label, id]) => ({ kind: 'block', id, label }));
}

/** The draft's body as HTML for Mail: links made full (a chip's "/docs/…" works from an inbox too). */
export function bodyHtml(html, origin) {
  return String(html || '').replace(/(<a\b[^>]*\bhref=")(\/[^"]*)"/g, (m, a, href) => `${a}${origin}${href}"`)
    .replace(/\s+class="doc-filechip"/g, '');
}

/** A message for Mail from a draft's fields and body HTML. */
export function draftMessage(attrs, html, origin) {
  const clean = (s) => String(s || '').replace(/[\r\n]+/g, ' ').trim();
  return { to: clean(attrs.to), cc: clean(attrs.cc), subject: clean(attrs.subject), html: bodyHtml(html, origin) || '<p></p>' };
}

export const EVENT_KEY = 'nw.eventFromDoc';
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/, TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
/** Guests typed in a draft ("kim@acme.com, bo@acme.com; …") as a list of addresses. */
export const guestList = (s) => [...new Set(String(s || '').split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter((x) => x.includes('@')))];

/**
 * A new event for Calendar from an event draft's fields, its notes (text) and the document it's in:
 * { title, start, end (ms, local time), all_day, location, guests, description, attachments }, or { error }.
 * No start time: all day. No end: an hour after the start.
 */
export function eventFromDraft(a, notes, doc, origin) {
  const title = String(a.title || '').replace(/\s+/g, ' ').trim();
  if (!title) return { error: 'Give the event a title' };
  if (!DAY_RE.test(a.date || '') || Number.isNaN(new Date(`${a.date}T00:00`).getTime())) return { error: 'Pick a day for the event' };
  const [y, m, d] = a.date.split('-').map(Number);
  const at = (t) => { const [h, min] = t.split(':').map(Number); return new Date(y, m - 1, d, h, min).getTime(); };
  let start, end, allDay = false;
  if (TIME_RE.test(a.start || '')) {
    start = at(a.start);
    end = TIME_RE.test(a.end || '') ? at(a.end) : start + 3600000;
    if (end <= start) return { error: 'The end is before the start' };
  } else { allDay = true; start = new Date(y, m - 1, d).getTime(); end = new Date(y, m - 1, d + 1).getTime(); }
  const link = doc?.id ? `${origin}/docs/${doc.id}` : '';
  const description = [String(notes || '').trim(), link && `From “${doc.name || 'a document'}”: ${link}`].filter(Boolean).join('\n\n').slice(0, 5000);
  return {
    title: title.slice(0, 200), start, end, all_day: allDay ? 1 : 0, location: String(a.location || '').trim().slice(0, 300),
    guests: guestList(a.guests).map((email) => ({ email })), description,
    attachments: doc?.id ? [{ id: doc.id, name: doc.name || 'Document', kind: 'doc', mime: null }] : [],
  };
}

/** How a draft's time reads ("2026-11-12 · 10:00–11:00", or the day alone for an all-day one). */
export function whenText(a) {
  if (!a.date) return '';
  return a.start ? `${a.date} · ${a.start}${a.end ? `–${a.end}` : ''}` : a.date;
}

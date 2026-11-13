// Printing one note: its title, then its text or checklist (ticked items struck through, sub-items indented), and labels.
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function notePrintHtml(n) {
  const items = n.items ? `<ul>${n.items.map((i) => `<li class="${i.done ? 'done' : ''}${i.indent ? ' sub' : ''}"><span>${i.done ? '☑' : '☐'}</span> ${esc(i.text)}</li>`).join('')}</ul>` : '';
  const body = !n.items && n.body ? `<p>${esc(n.body).replace(/\n/g, '<br>')}</p>` : '';
  const labels = n.labels?.length ? `<p class="labels">${n.labels.map(esc).join(' · ')}</p>` : '';
  // Its pictures, from this server (the print frame loads them before printing).
  const pics = n.id && n.pictures?.length ? `<div class="pics">${n.pictures.map((p) => `<img src="/api/notes/${encodeURIComponent(n.id)}/pictures/${encodeURIComponent(p.id || p)}" alt="">`).join('')}</div>` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(n.title || 'Note')}</title><style>
    body { font: 14px/1.5 system-ui, sans-serif; color: #202124; margin: 24px; } h1 { font-size: 20px; margin: 0 0 10px; }
    ul { list-style: none; padding: 0; margin: 0; } li { padding: 2px 0; } li.sub { padding-left: 24px; } li.done { text-decoration: line-through; color: #5f6368; }
    .labels { color: #5f6368; font-size: 12px; margin-top: 16px; }
    .pics img { display: block; max-width: 100%; max-height: 60vh; margin: 12px 0 0; break-inside: avoid; }
  </style></head><body>${n.title ? `<h1>${esc(n.title)}</h1>` : ''}${pics}${body}${items}${labels}</body></html>`;
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

/** Several notes on one printout, each starting on its own page (its body as notePrintHtml makes it). */
export function notesPrintHtml(notes) {
  const bodies = notes.map((n) => /<body>([\s\S]*)<\/body>/.exec(notePrintHtml(n))[1]);
  const style = /<style>([\s\S]*?)<\/style>/.exec(notePrintHtml(notes[0] || {}))[1];
  return `<!doctype html><html><head><meta charset="utf-8"><title>Notes (${notes.length})</title><style>${style}
    section.note + section.note { break-before: page; }</style></head><body>${bodies.map((b) => `<section class="note">${b}</section>`).join('')}</body></html>`;
}

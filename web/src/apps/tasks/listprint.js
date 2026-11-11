// A task list on paper: open tasks (with tick boxes to tick by hand, due dates, who they're for, notes and
// steps), then what's done. Plain HTML for the print frame.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** A due date the way people say it: "Tue 1 Dec 2026", with the time when there is one. */
export function dueText(t, locale) {
  if (!t.due) return '';
  const [y, m, d] = t.due.split('-').map(Number);
  const day = new Date(y, m - 1, d).toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  return t.due_time ? `${day}, ${t.due_time}` : day;
}

export function listPrintHtml(name, open, done, { locale, printedOn = new Date() } = {}) {
  const item = (t, isDone) => `<li class="${isDone ? 'done' : ''}"><span class="box">${isDone ? '☑' : '☐'}</span><div>
    <div class="title">${t.important ? '★ ' : ''}${esc(t.title)}</div>
    <div class="meta">${[dueText(t, locale) && `Due ${esc(dueText(t, locale))}`, t.assignee_name && `For ${esc(t.assignee_name)}`, (t.tags || []).map((x) => `#${esc(x)}`).join(' ')].filter(Boolean).join(' · ')}</div>
    ${t.notes ? `<div class="notes">${esc(t.notes).replace(/\n/g, '<br>')}</div>` : ''}
    ${t.steps?.length ? `<ul class="steps">${t.steps.map((x) => `<li>${x.done ? '☑' : '☐'} ${esc(x.title)}</li>`).join('')}</ul>` : ''}
  </div></li>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(name)}</title><style>
    body { font: 13px/1.45 system-ui, sans-serif; color: #202124; margin: 24px; }
    h1 { font-size: 20px; margin: 0 0 2px; } .printed { color: #5f6368; font-size: 11px; margin-bottom: 16px; }
    h2 { font-size: 14px; margin: 18px 0 6px; color: #5f6368; text-transform: uppercase; letter-spacing: .04em; }
    ol { list-style: none; padding: 0; margin: 0; } ol > li { display: flex; gap: 8px; padding: 6px 0; border-bottom: 1px solid #e0e0e0; break-inside: avoid; }
    .box { font-size: 16px; line-height: 1.1; } .title { font-weight: 600; } .done .title { text-decoration: line-through; color: #5f6368; font-weight: 400; }
    .meta, .notes { color: #5f6368; font-size: 12px; } .steps { list-style: none; padding: 0; margin: 4px 0 0; font-size: 12px; }
  </style></head><body><h1>${esc(name)}</h1><div class="printed">${open.length} to do${done.length ? `, ${done.length} done` : ''} · printed ${esc(printedOn.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' }))}</div>
  ${open.length ? `<ol>${open.map((t) => item(t, false)).join('')}</ol>` : '<p>Nothing to do.</p>'}
  ${done.length ? `<h2>Completed</h2><ol>${done.map((t) => item(t, true)).join('')}</ol>` : ''}</body></html>`;
}

/**
 * A task list as a new email: the list's name as the subject, its open tasks as a checklist (with due
 * dates, who they're for and steps), and, if asked, what's done; a link back to the list at the end.
 */
export function listEmail(name, open, done = [], { locale, link = '', withDone = false } = {}) {
  const item = (t, isDone) => {
    const meta = [dueText(t, locale) && `due ${esc(dueText(t, locale))}`, t.assignee_name && `for ${esc(t.assignee_name)}`].filter(Boolean).join(', ');
    const steps = t.steps?.length ? `<ul style="list-style:none;padding-left:24px;margin:0">${t.steps.map((x) => `<li>${x.done ? '☑' : '☐'} ${esc(x.title)}</li>`).join('')}</ul>` : '';
    return `<li>${isDone ? '☑' : '☐'} ${t.important ? '★ ' : ''}${isDone ? `<s>${esc(t.title)}</s>` : esc(t.title)}${meta ? ` <span style="color:#5f6368">(${meta})</span>` : ''}${steps}</li>`;
  };
  const ul = (ts, isDone) => `<ul style="list-style:none;padding:0">${ts.map((t) => item(t, isDone)).join('')}</ul>`;
  const html = [
    open.length ? ul(open, false) : '<p>Nothing left to do.</p>',
    withDone && done.length ? `<p><strong>Done</strong></p>${ul(done, true)}` : '',
    link ? `<p style="color:#5f6368;font-size:12px">The list in Tasks: <a href="${esc(link)}">${esc(link)}</a></p>` : '',
  ].join('');
  return { subject: name, html };
}

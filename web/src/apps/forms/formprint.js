// Printing a form's responses: each response on its own page (when it came, who sent it, the score of a quiz), then
// every question with the answer as the Individual view shows it, for paper records or a PDF.
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const GRIDS = new Set(['grid', 'checkgrid']);

/** One answer as text: grids row by row, rankings numbered, files by name, lists joined. */
export function answerText(q, a) {
  if (a === undefined || a === null || a === '') return null;
  if (GRIDS.has(q.type)) return (q.rows || []).filter((row) => a[row] !== undefined).map((row) => `${row}: ${[a[row]].flat().join(', ')}`).join('\n');
  if (q.type === 'file' && Array.isArray(a)) return a.map((f) => `📎 ${f.name}`).join(', ');
  if (q.type === 'rank' && Array.isArray(a)) return a.map((o, k) => `${k + 1}. ${o}`).join('\n');
  return Array.isArray(a) ? a.join(', ') : String(a);
}

/** The page to print: the form's title, then each response as a page. */
export function responsesPrintHtml(form, responses, { when = (t) => new Date(t).toLocaleString() } = {}) {
  const qs = (form.questions || []).filter((q) => q.type !== 'section');
  const page = (r, i) => {
    const who = r.user ? `${r.user.name} (${r.user.email})` : r.email || '';
    const score = r.max > 0 ? ` · ${r.score} / ${r.max}` : '';
    const rows = qs.map((q) => {
      const t = answerText(q, r.answers?.[q.id]);
      const mark = r.right && q.id in r.right ? (r.right[q.id] ? ' ✓' : ' ✗') : '';
      return `<div class="q"><div class="t">${esc(q.title || 'Untitled question')}${mark}</div><div class="a${t === null ? ' none' : ''}">${t === null ? 'No answer' : esc(t).replace(/\n/g, '<br>')}</div></div>`;
    }).join('');
    return `<section class="r"><h1>${esc(form.title || 'Form')}</h1><p class="meta">Response ${i + 1} of ${responses.length} · ${esc(when(r.created_at))}${who ? ` · ${esc(who)}` : ''}${esc(score)}</p>${rows}</section>`;
  };
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(form.title || 'Form')}: responses</title><style>
    body { font: 13px/1.5 system-ui, sans-serif; color: #000; margin: 24px; } h1 { font-size: 18px; margin: 0; } .meta { color: #555; margin: 2px 0 14px; }
    .q { margin: 0 0 12px; break-inside: avoid; } .t { font-weight: 600; } .a { white-space: normal; overflow-wrap: anywhere; } .none { color: #777; font-style: italic; }
    section.r + section.r { break-before: page; }
  </style></head><body>${responses.map(page).join('')}</body></html>`;
}

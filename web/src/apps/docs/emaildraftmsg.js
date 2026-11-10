// Email drafts in documents: what's offered after "@", and the message Mail opens with (see emaildraft.jsx).
export const DRAFT_KEY = 'nw.composeFromDoc';

/** Building blocks offered for what's typed after "@". */
export function matchBlocks(query) {
  const q = String(query || '').toLowerCase();
  if (q.length < 2) return [];
  return [['email draft', 'Email draft']].filter(([words]) => words.split(' ').some((w) => w.startsWith(q)) || words.startsWith(q))
    .map(([, label]) => ({ kind: 'block', id: 'block:email', label }));
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

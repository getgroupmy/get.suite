// A copy of the plain-JSON helpers in web/src/apps/docs/doctabs.js (document tabs), for downloads.
export const isTabbed = (doc) => (doc?.content || []).some((n) => n.type === 'docTab');

/** The tabs of a document (TipTap JSON): [{ id, title, index }]; [] when it has none. */
export function tabsOf(doc) {
  return (doc?.content || []).filter((n) => n.type === 'docTab').map((n, index) => ({ id: n.attrs?.id, title: n.attrs?.title || `Tab ${index + 1}`, index }));
}

/** A tab's title as typed: one line, at most 60 characters ("" means the default "Tab n"). */
export const cleanTitle = (t) => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);

/**
 * The document with its tabs laid end to end, for downloads (Word, Markdown, HTML) and anything that
 * reads it from top to bottom: each tab starts with its title as a heading, and a new page after the first.
 */
export function flattenTabs(doc) {
  if (!isTabbed(doc)) return doc;
  const out = [];
  (doc.content || []).forEach((tab, i) => {
    if (tab.type !== 'docTab') { out.push(tab); return; }
    if (i > 0) out.push({ type: 'pageBreak' });
    out.push({ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: tab.attrs?.title || `Tab ${i + 1}` }] });
    out.push(...(tab.content || []));
  });
  return { ...doc, content: out };
}


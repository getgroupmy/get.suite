// Document tabs: a document can be split into tabs (like chapters, or a tab per meeting), each with
// its own content, listed beside the document; only the open tab is shown. In the document they're
// top-level `docTab` nodes ({ attrs: { id, title } }, holding blocks): a document is either all tabs or
// none, so the whole of it is still one document for editing together, comments, history and search.
// These are the plain-JSON helpers (the server has a copy for downloads: server/src/office/doctabs.js).

export const MAX_TABS = 50;
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

export const newTabId = () => Math.random().toString(36).slice(2, 10);

/** The editor's HTML with each tab's name as a heading at its start (for "Download as HTML"). */
export const htmlWithTabTitles = (html) => String(html).replace(/(<section\b[^>]*\bdata-tab-title="([^"]*)"[^>]*>)/g, (m, open, title) => `${open}<h1 class="tab-title">${title}</h1>`);

// Copying a tab of one document into another (Docs: a tab's ⋮ → Copy to another document…).
import { withoutSuggestions } from './office/suggestions.js';

export const MAX_TABS = 50;
const tabTitle = (n, i) => String(n.attrs?.title || '') || `Tab ${i + 1}`;
const tabsOf = (json) => (json?.content || []).filter((n) => n.type === 'docTab');

/** A tab title free among `titles` (any capitals): its own, else "Copy of …", "Copy of … 2", … (60 characters at most). */
export function freeTabTitle(title, titles) {
  const taken = new Set(titles.map((x) => String(x).toLowerCase()));
  const own = String(title || 'Tab').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Tab';
  if (!taken.has(own.toLowerCase())) return own;
  const base = `Copy of ${own}`.slice(0, 56);
  if (!taken.has(base.toLowerCase())) return base;
  for (let k = 2; ; k++) if (!taken.has(`${base} ${k}`.toLowerCase())) return `${base} ${k}`;
}

/**
 * What a tab copy holds: the tab's text as it stands (pending suggestions left out), without the
 * original's comment highlights (its comments stay there), and pictures pointing at their copies
 * (`files`: old id -> new; a picture with no copy is left out).
 */
export function tabContentCopy(tab, files = new Map()) {
  const walk = (n) => {
    if (!n || typeof n !== 'object') return n;
    if (n.type === 'image' && n.attrs?.fileId) return files.has(n.attrs.fileId) ? { ...n, attrs: { ...n.attrs, fileId: files.get(n.attrs.fileId) } } : null;
    const out = { ...n };
    if (n.marks) { const marks = n.marks.filter((m) => m.type !== 'comment'); if (marks.length) out.marks = marks; else delete out.marks; }
    if (Array.isArray(n.content)) out.content = n.content.map(walk).filter(Boolean);
    return out;
  };
  const content = walk(withoutSuggestions(tab)).content || [];
  return content.length ? content : [{ type: 'paragraph' }];
}

/**
 * Document `json` with `tab` (a docTab node) added at its end, given a free title; one without tabs
 * first has what it holds become "Tab 1". Returns { json, title } or null when it has as many tabs as it can.
 */
export function withTabAdded(json, tab, newId) {
  let content = [...(json?.content || [])];
  if (!tabsOf(json).length) {
    content = [{ type: 'docTab', attrs: { id: newId(), title: 'Tab 1' }, content: content.length ? content : [{ type: 'paragraph' }] }];
  }
  const tabs = content.filter((n) => n.type === 'docTab');
  if (tabs.length >= MAX_TABS) return null;
  const title = freeTabTitle(tab.attrs?.title, tabs.map(tabTitle));
  return { json: { ...json, type: 'doc', content: [...content, { ...tab, attrs: { ...tab.attrs, id: newId(), title } }] }, title, at: tabs.length + 1 };
}

/** The tab with id `id` in document `json` (or undefined). */
export const tabOf = (json, id) => tabsOf(json).find((n) => n.attrs?.id === id);

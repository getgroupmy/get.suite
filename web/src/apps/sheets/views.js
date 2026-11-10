// Filter views: named filters kept with a sheet that each person opens for themselves, so rows are
// hidden only on their screen (the sheet's own filter hides them for everyone). Kept per sheet as
// views: { id: { name, range, hidden, cond } } — the same shape as a filter (filter.js), plus a name.
// Someone who can't edit (or who isn't saving) gets a temporary view: the same, kept on their screen only.
import { adjustFilter } from './filter.js';

/** The next free "Filter N" name. */
export function nextViewName(views) {
  const taken = new Set(Object.values(views || {}).map((v) => String(v?.name || '').toLowerCase()));
  for (let n = 1; ; n++) if (!taken.has(`filter ${n}`)) return `Filter ${n}`;
}

/** A tidy name for a view (one line, at most 60 characters; empty → null). */
export function cleanViewName(name) {
  const t = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return t || null;
}

/** The views after rows or columns are inserted or deleted (a view whose headings went is dropped). */
export function adjustViews(views, change) {
  if (!views) return views;
  const out = {};
  for (const [id, v] of Object.entries(views)) {
    const f = adjustFilter(v, change);
    if (f) out[id] = { name: v.name, ...f };
  }
  return out;
}

/** The index of the sheet holding view `id` (-1 if none does). */
export function viewSheet(sheets, id) {
  return (sheets || []).findIndex((s) => !!s?.views?.[id]);
}

/** Views in name order, as [id, view]. */
export function viewList(views) {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  return Object.entries(views || {}).sort(([, a], [, b]) => collator.compare(a.name || '', b.name || ''));
}

/** A link that opens the spreadsheet with view `id` on. */
export function viewLink(origin, fileId, id) {
  return `${origin}/sheets/${encodeURIComponent(fileId)}?fv=${encodeURIComponent(id)}`;
}

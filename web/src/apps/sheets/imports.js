// Spreadsheets that formulas bring cells in from (IMPORTRANGE): each loaded once in the background
// with the reader's own access, kept for the page, and fetched again every minute while in use.
import { get } from '../../api.js';

const loaded = new Map(); // id -> { sheets } | { error }
const loading = new Set();
const listeners = new Set();
const used = new Set();
const tell = () => { for (const fn of listeners) fn(); };

async function load(id) {
  if (loading.has(id)) return;
  loading.add(id);
  try {
    const r = await get(`/files/${encodeURIComponent(id)}/content`);
    loaded.set(id, r.file?.kind === 'sheet' && Array.isArray(r.content?.sheets) ? { sheets: r.content.sheets } : { error: 'not a spreadsheet' });
  } catch (e) {
    loaded.set(id, { error: e.message || 'not found' });
  } finally {
    loading.delete(id);
    tell();
  }
}

/** For bookEvaluator: what's loaded of a spreadsheet, or null while it loads (starting that). */
export const importBook = (id) => {
  used.add(id);
  if (!loaded.has(id)) { load(id); return null; }
  return loaded.get(id);
};

/** Call fn when an imported spreadsheet arrives or changes; returns the unsubscribe. */
export function onImports(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Fetch again the spreadsheets formulas have used. */
export function refreshImports() {
  for (const id of used) load(id);
}

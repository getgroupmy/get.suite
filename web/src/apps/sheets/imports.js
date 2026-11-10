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

// IMPORTDATA / IMPORTHTML: pages on the internet, fetched by the server (/api/sheets-web), kept here
// for the page and fetched again with the spreadsheets above (the server keeps each for 5 minutes).
const web = new Map(); // key -> { rows } | { error }
const webLoading = new Set();
const webUsed = new Set();
async function loadWeb(key) {
  if (webLoading.has(key)) return;
  webLoading.add(key);
  const [url, type, index, extra] = JSON.parse(key);
  try {
    const r = await get(`/sheets-web?${new URLSearchParams({ url, type, index: String(index), ...(extra || {}) })}`);
    web.set(key, { rows: r.rows });
  } catch (e) {
    web.set(key, { error: e.message || 'Couldn\'t load that page' });
  } finally {
    webLoading.delete(key);
    tell();
  }
}
/** For bookEvaluator: a page's rows ({ rows } or { error }), or null while it loads (starting that). */
export const importWeb = (url, type = 'data', index = 1, extra = null) => {
  const key = JSON.stringify(extra ? [String(url), type, index, extra] : [String(url), type, index]);
  webUsed.add(key);
  if (!web.has(key)) { loadWeb(key); return null; }
  return web.get(key);
};
export function refreshWeb() {
  for (const key of webUsed) loadWeb(key);
}

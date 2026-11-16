// Documents kept in this browser so they open and can be edited without a connection: each one's shared state (Yjs),
// its generation (see server/src/collab.js genOf), whether it has changes the server hasn't had yet, and its details.
// The 30 most recently opened are kept. Nothing here is sent anywhere by itself: the editor does that when it connects.
const DB = 'nw-offline', STORE = 'docs', KEEP = 30;

function open() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('no IndexedDB'));
    const r = indexedDB.open(DB, 2);
    // docs: kept files; api: the last answers to a few lists (calendar, tasks, contacts, notes), read when offline.
    r.onupgradeneeded = () => { for (const s of [STORE, 'api']) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function run(mode, fn, store = STORE) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const out = fn(t.objectStore(store));
      t.oncomplete = () => resolve(out?.result);
      t.onerror = () => reject(t.error);
    });
  } finally { db.close(); }
}

/** The kept copy of a file: { gen, state: Uint8Array, dirty, file, at } or null. */
export const keptDoc = (id) => run('readonly', (s) => s.get(id)).then((x) => x || null).catch(() => null);

/** Keep (or update) a file's copy; the oldest beyond 30 are let go, except any with unsent changes. */
export async function keepDoc(id, rec) {
  try {
    await run('readwrite', (s) => s.put({ ...rec, at: Date.now() }, id));
    const all = [];
    await run('readonly', (s) => { const c = s.openCursor(); c.onsuccess = () => { const cur = c.result; if (cur) { all.push([cur.key, cur.value.at, cur.value.dirty]); cur.continue(); } }; return c; });
    const extra = all.sort((a, b) => b[1] - a[1]).slice(KEEP).filter(([, , dirty]) => !dirty);
    if (extra.length) await run('readwrite', (s) => { for (const [k] of extra) s.delete(k); });
  } catch { /* private mode or storage full: the document still works online */ }
}

export const forgetDoc = (id) => run('readwrite', (s) => s.delete(id)).catch(() => {});

/** Whether an error means the server couldn't be reached (rather than an answer from it). */
export const unreachable = (e) => !e?.status;

/** A Uint8Array as base64 (for sending a copy to the server). */
export function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Signing out: everything kept on this device goes (a shared computer keeps nothing of yours). */
export const forgetAll = () => new Promise((resolve) => {
  try { const r = indexedDB.deleteDatabase(DB); r.onsuccess = r.onerror = r.onblocked = () => resolve(); } catch { resolve(); }
});

/** Everything kept on this device, the most recently opened first: [{ id, file, at, dirty }]. */
export async function keptList() {
  try {
    const out = [];
    await run('readonly', (s) => { const c = s.openCursor(); c.onsuccess = () => { const cur = c.result; if (cur) { if (cur.value?.file) out.push({ id: cur.key, file: cur.value.file, at: cur.value.at, dirty: !!cur.value.dirty }); cur.continue(); } }; return c; });
    return out.sort((a, b) => b.at - a.at);
  } catch { return []; }
}

// The last answers to the lists people look at on the go (calendar, tasks, contacts, notes), kept for reading
// without a connection (api.js). Cleared on signing out with the rest.
export const OFFLINE_READS = [/^\/events(\?|$)/, /^\/tasks\/lists(\/[\w-]+\/tasks)?(\?|$)/, /^\/tasks\/(today|assigned|upcoming)(\?|$)/, /^\/contacts(\?|$)/, /^\/contacts\/groups$/, /^\/notes(\?|$)/, /^\/users\/directory$/, /^\/time-off(\?|$)/];
export const keepAnswer = (url, data) => run('readwrite', (s) => s.put({ data, at: Date.now() }, url), 'api').catch(() => {});
export const keptAnswer = (url) => run('readonly', (s) => s.get(url), 'api').then((x) => x || null).catch(() => null);

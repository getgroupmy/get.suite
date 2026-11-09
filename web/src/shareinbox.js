// Things shared to Workspace from other apps (the phone's Share menu, once Workspace is installed):
// the service worker (public/sw.js) keeps them here, on this device, and Drive offers to save them.
// The same small store is opened by both, so the names below must match sw.js.
export const DB = 'nw-share', STORE = 'pending', KEY = 'last';

function open() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
const run = async (mode, fn) => { const db = await open(); return new Promise((resolve, reject) => { const t = db.transaction(STORE, mode); const r = fn(t.objectStore(STORE)); t.oncomplete = () => resolve(r?.result); t.onerror = () => reject(t.error); }); };

/** { files: [File], title, text, url, at } or null. */
export const readShared = () => run('readonly', (s) => s.get(KEY)).then((v) => v || null).catch(() => null);
export const clearShared = () => run('readwrite', (s) => s.delete(KEY)).catch(() => {});
export const putShared = (v) => run('readwrite', (s) => s.put(v, KEY));

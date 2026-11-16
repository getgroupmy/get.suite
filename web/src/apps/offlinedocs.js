// Documents kept in this browser so they open and can be edited without a connection: each one's shared state (Yjs),
// its generation (see server/src/collab.js genOf), whether it has changes the server hasn't had yet, and its details.
// The 30 most recently opened are kept. Nothing here is sent anywhere by itself: the editor does that when it connects.
const DB = 'nw-offline', STORE = 'docs', KEEP = 30;

function open() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('no IndexedDB'));
    const r = indexedDB.open(DB, 4);
    // docs: kept files; api: the last answers to a few lists, read when offline; outbox: email sent while offline.
    r.onupgradeneeded = () => { for (const s of [STORE, 'api', 'outbox', 'changes']) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s); };
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
/**
 * Sending what was kept offline: answers that mean "not now" rather than "no" (signed out, the server restarting or busy).
 * What got one stays on the device for the next try instead of being dropped.
 */
export const tryLater = (e) => unreachable(e) || [401, 408, 425, 429].includes(e.status) || e.status >= 500;

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

// The last answers to the lists people look at on the go (calendar, tasks, contacts, notes, mail), kept for reading
// without a connection (api.js). Cleared on signing out with the rest.
export const OFFLINE_READS = [/^\/events(\?|$)/, /^\/tasks\/lists(\/[\w-]+\/tasks)?(\?|$)/, /^\/tasks\/(today|assigned|upcoming|myday|completed|important|planned|tags)(\?|$)/, /^\/contacts(\?|$)/, /^\/contacts\/groups$/, /^\/notes(\?|$)/, /^\/users\/directory$/, /^\/time-off(\?|$)/,
  // Mail: whether it's set up, the folders, the messages listed and those opened (the shared mailbox open is part of the key).
  /^\/chat\/channels(\?|$)/, /^\/chat\/channels\/[\w-]+\/messages$/,
  /^\/mail\/(status|folders|labels)(\?|$)/, /^\/mail\/messages\?folder=/, /^\/mail\/messages\/\d+\?folder=/, /^\/mail\/folder-state\?folder=/];
export const keepAnswer = (url, data) => run('readwrite', (s) => s.put({ data, at: Date.now() }, url), 'api').catch(() => {});
export const keptAnswer = (url) => run('readonly', (s) => s.get(url), 'api').then((x) => x || null).catch(() => null);

// Email sent without a connection: kept here, and sent by itself when the connection is back (App.jsx SendUnsent).
// { body (as for /mail/send), mailbox (shared mailbox id or null), user, at, error? }
export const outboxAdd = (item) => run('readwrite', (s) => s.put({ ...item, at: Date.now() }, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`), 'outbox')
  .then(() => window.dispatchEvent(new Event('nw:outbox')));
export async function outboxList(user) {
  try {
    const out = [];
    await run('readonly', (s) => { const c = s.openCursor(); c.onsuccess = () => { const cur = c.result; if (cur) { if (!user || cur.value.user === user) out.push({ id: cur.key, ...cur.value }); cur.continue(); } }; return c; }, 'outbox');
    return out.sort((a, b) => a.at - b.at);
  } catch { return []; }
}
export const outboxRemove = (id) => run('readwrite', (s) => s.delete(id), 'outbox').then(() => window.dispatchEvent(new Event('nw:outbox'))).catch(() => {});
export const outboxNote = (id, item, error) => run('readwrite', (s) => s.put({ ...item, error }, id), 'outbox').catch(() => {});

// Changes made offline to things kept for reading (a task ticked, renamed, given a date): kept here in order and sent
// when the connection is back (App.jsx), the kept lists showing them meanwhile. { method, url, body, user, label, at }
export const changeAdd = (c) => run('readwrite', (s) => s.put({ ...c, at: Date.now() }, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`), 'changes');
export async function changeList(user) {
  try {
    const out = [];
    await run('readonly', (s) => { const c = s.openCursor(); c.onsuccess = () => { const cur = c.result; if (cur) { if (!user || cur.value.user === user) out.push({ id: cur.key, ...cur.value }); cur.continue(); } }; return c; }, 'changes');
    return out.sort((a, b) => (a.id < b.id ? -1 : 1));
  } catch { return []; }
}
export const changeRemove = (id) => run('readwrite', (s) => s.delete(id), 'changes').catch(() => {});
/** Something changed offline (a task, a note): the kept lists it's in show the change (until the server's answer replaces them). */
export async function patchKeptItem(taskId, changes) {
  try {
    const hits = [];
    await run('readonly', (s) => { const c = s.openCursor(); c.onsuccess = () => { const cur = c.result; if (cur) { if (Array.isArray(cur.value?.data) && cur.value.data.some((t) => t?.id === taskId)) hits.push([cur.key, cur.value]); cur.continue(); } }; return c; }, 'api');
    if (hits.length) await run('readwrite', (s) => { for (const [k, v] of hits) s.put({ ...v, data: v.data.map((t) => (t?.id === taskId ? { ...t, ...changes } : t)) }, k); }, 'api');
  } catch { /* kept lists just show the old state */ }
}
export const patchKeptTask = patchKeptItem;

/**
 * Mail triaged offline (read, starred, archived, moved, deleted): the kept message lists of that folder (and the
 * messages opened) show it. `change` is merged into the messages, or `null` takes them out of the folder's lists.
 */
export async function patchKeptMail({ user, mailbox, folder, uids, change }) {
  const pre = `${user}:${mailbox || ''}:/mail/messages`;
  const inList = `${pre}?folder=${encodeURIComponent(folder)}&`;
  const opened = new Set(uids.map((u) => `${pre}/${u}?folder=${encodeURIComponent(folder)}`));
  const want = new Set(uids.map(Number));
  try {
    const hits = [];
    await run('readonly', (s) => { const c = s.openCursor(); c.onsuccess = () => { const cur = c.result; if (cur) { const k = String(cur.key); if ((k.startsWith(inList) && Array.isArray(cur.value?.data?.messages)) || opened.has(k)) hits.push([k, cur.value]); cur.continue(); } }; return c; }, 'api');
    if (!hits.length) return;
    await run('readwrite', (s) => {
      for (const [k, v] of hits) {
        const of = (m) => (typeof change === 'function' ? change(m) : change); // a function: the change for that message (labels add to its own)
        if (opened.has(k)) { if (change) s.put({ ...v, data: { ...v.data, ...of(v.data) } }, k); else s.delete(k); continue; }
        const messages = change ? v.data.messages.map((m) => (want.has(Number(m.uid)) ? { ...m, ...of(m) } : m)) : v.data.messages.filter((m) => !want.has(Number(m.uid)));
        s.put({ ...v, data: { ...v.data, messages, ...(typeof v.data.total === 'number' && !change && { total: Math.max(0, v.data.total - (v.data.messages.length - messages.length)) }) } }, k);
      }
    }, 'api');
  } catch { /* the kept lists show it as it was */ }
}

/** Something deleted offline: taken out of every kept list it's in. */
export async function removeKeptItem(id) {
  try {
    const hits = [];
    await run('readonly', (s) => { const c = s.openCursor(); c.onsuccess = () => { const cur = c.result; if (cur) { if (Array.isArray(cur.value?.data) && cur.value.data.some((t) => t?.id === id)) hits.push([cur.key, cur.value]); cur.continue(); } }; return c; }, 'api');
    if (hits.length) await run('readwrite', (s) => { for (const [k, v] of hits) s.put({ ...v, data: v.data.filter((t) => t?.id !== id) }, k); }, 'api');
  } catch { /* kept lists still show it */ }
}
/** A delete that couldn't reach the server: made when the connection is back; gone from the kept lists meanwhile. */
export async function keepDelete({ url, user, label, id }) {
  await changeAdd({ method: 'DELETE', url, user, label });
  await removeKeptItem(id);
  window.dispatchEvent(new Event('nw:changes'));
}

/** A change that couldn't reach the server: kept to make later, shown in the kept lists meanwhile. */
export async function keepChange({ method, url, body, user, label, id, shown = body }) {
  await changeAdd({ method, url, body, user, label });
  if (id) await patchKeptItem(id, { ...shown, offline: true }); // `shown`: what the kept lists take of it (when the body's form differs from the answer's)
  window.dispatchEvent(new Event('nw:changes'));
}

/** An id for something made offline: the server makes it with this id when the connection is back (a repeat send makes nothing twice). */
export const offlineId = () => `off${(crypto.randomUUID?.() || `${Date.now()}${Math.random()}`).replace(/[^\w]/g, '').slice(0, 32)}`;

/** Picks the kept Calendar lists (/events?from=…&to=…) whose dates take in an event from `start` to `end`. */
export const eventsCovering = (start, end) => (key) => {
  const m = /\/events\?from=(-?\d+)&to=(-?\d+)$/.exec(key);
  return !!m && start <= Number(m[2]) && end >= Number(m[1]);
};

/** How many lists' last answers are kept (Settings → This device). */
export const apiCount = () => run('readonly', (s) => s.count(), 'api').then((n) => n || 0).catch(() => 0);

/** Something added offline (a chat message waiting to be sent): added to the end of the kept lists whose address ends so (or that `urlEnd(key)` picks). */
export async function appendKept(urlEnd, item, { first = false } = {}) {
  try {
    const hits = [];
    await run('readonly', (s) => { const c = s.openCursor(); c.onsuccess = () => { const cur = c.result; if (cur) { if ((typeof urlEnd === 'function' ? urlEnd(String(cur.key)) : String(cur.key).endsWith(urlEnd)) && Array.isArray(cur.value?.data)) hits.push([cur.key, cur.value]); cur.continue(); } }; return c; }, 'api');
    if (hits.length) await run('readwrite', (s) => { for (const [k, v] of hits) s.put({ ...v, data: first ? [item, ...v.data] : [...v.data, item] }, k); }, 'api');
  } catch { /* the kept list just doesn't show it */ }
}

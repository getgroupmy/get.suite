// Editing without a connection, for Docs, Sheets and Slides: the file's shared state kept on this device (offlinedocs.js)
// goes in first, then the connection, saying which generation it is (see server/src/collab.js genOf). What's written while
// not connected is marked unsent; if the file was rebuilt meanwhile, the server turns the old copy away (4001) and unsent
// changes become an "(offline copy)" file instead of being mixed in.
import { useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { post, patch } from '../api.js';
import { keptDoc, keepDoc, forgetDoc, toBase64, unreachable, changeAdd, patchKeptItem } from './offlinedocs.js';

/**
 * `provider` must be made with connect: false: this connects it once the kept copy is in. Returns { fromDevice, rebuilt }:
 * fromDevice while what's shown came from this device and the server hasn't been reached; rebuilt: { copy } after the
 * file turned out to have been changed elsewhere (copy: the offline copy file, if there were unsent changes).
 */
export function useKeptCopy(file, ydoc, provider) {
  const genRef = useRef(null), freshRef = useRef(false), dirtyRef = useRef(false), copyingRef = useRef(false), keptRef = useRef(null);
  const [rebuilt, setRebuilt] = useState(null);
  const [fromDevice, setFromDevice] = useState(!!file?.offline);
  const fileRef = useRef(file); // the latest details (renamed, say), kept with the copy
  fileRef.current = file;
  const fileId = file?.id;
  useEffect(() => { if (file?.offline) setFromDevice(true); }, [file?.offline]);
  useEffect(() => {
    if (!fileId || !ydoc || !provider) return undefined;
    let live = true, timer = null;
    let kept = null, applied = false, fallback = null; // the copy kept on this device, and whether it's in the document
    const file = fileRef.current;
    const meta = () => { const { offline, ...m } = fileRef.current; return m; }; // eslint-disable-line no-unused-vars
    // (A document made offline has no generation until the server makes it: kept all the same.)
    const save = () => { timer = null; if (genRef.current || freshRef.current) keepDoc(fileId, { gen: genRef.current, ...(!genRef.current && { fresh: true }), state: Y.encodeStateAsUpdate(ydoc), dirty: dirtyRef.current, file: meta() }); };
    const keep = () => { clearTimeout(timer); timer = setTimeout(save, 800); };
    const onUpdate = (u, origin) => {
      // Not sent yet: written while not connected, or while the browser says it's offline (a dropped connection can
      // look open for a while before it times out).
      if (origin !== provider && origin !== 'kept' && (!navigator.onLine || !(provider.wsconnected && provider.synced))) dirtyRef.current = true;
      keep();
    };
    const onSync = (synced) => {
      if (!synced || !provider.wsconnected) return;
      keptRef.current?.(); // changes kept from offline go in now (to the same generation: the server checked)
      genRef.current = ydoc.getMap('meta').get('gen') || genRef.current;
      provider.params = genRef.current ? { gen: genRef.current } : {};
      dirtyRef.current = false; // on syncing, what was made here has gone to the server
      setFromDevice(false);
      clearTimeout(timer); save(); // kept at once on opening, not only after the next change
    };
    const onClose = async (e) => {
      if (e?.code !== 4001 || copyingRef.current) return; // once (a second close can arrive while the copy is made)
      copyingRef.current = true;
      provider.disconnect();
      // A kept copy with unsent changes not shown yet (the refusal came before it went in): it goes in now, to be kept.
      if (kept?.dirty && !applied) { applied = true; Y.applyUpdate(ydoc, kept.state, 'kept'); dirtyRef.current = true; genRef.current = genRef.current || kept.gen; }
      // Nothing written here that the server hasn't had (a version was restored, say): just open the latest.
      if (!dirtyRef.current) { await forgetDoc(file.id); window.location.reload(); return; }
      let copy = null;
      try { copy = await post(`/files/${file.id}/offline-copy`, { state: toBase64(Y.encodeStateAsUpdate(ydoc)), gen: genRef.current }); } catch { copyingRef.current = false; return; /* kept on the device for another try */ }
      await forgetDoc(file.id);
      if (live) setRebuilt({ copy });
    };
    markOpen(fileId, true);
    const flush = () => { if (timer) { clearTimeout(timer); save(); } }; // the tab closing or the page changing
    window.addEventListener('pagehide', flush);
    ydoc.on('update', onUpdate);
    provider.on('sync', onSync);
    provider.on('connection-close', onClose);
    // With a connection, what the server has is shown (the kept copy may be a moment behind it); the kept copy only goes in
    // after syncing, when it holds changes the server hasn't had. Without one (or with no answer for a moment), it's shown.
    const putKept = () => {
      if (applied || !kept?.state || !live) return;
      applied = true;
      Y.applyUpdate(ydoc, kept.state, 'kept');
      genRef.current = genRef.current || kept.gen;
      if (kept.dirty && !(provider.wsconnected && provider.synced)) dirtyRef.current = true;
    };
    keptRef.current = () => { clearTimeout(fallback); if (kept?.dirty) putKept(); };
    keptDoc(file.id).then((k) => {
      if (!live) return;
      kept = k;
      freshRef.current = !!k?.fresh && !k?.gen;
      if (k?.gen) provider.params = { gen: k.gen };
      if (k?.state) { if (!navigator.onLine) putKept(); else fallback = setTimeout(putKept, 1500); }
      provider.connect();
    });
    return () => { live = false; clearTimeout(fallback); keptRef.current = null; markOpen(fileId, false); window.removeEventListener('pagehide', flush); flush(); /* leaving: keep what's waiting now */ ydoc.off('update', onUpdate); provider.off('sync', onSync); provider.off('connection-close', onClose); };
  }, [provider, ydoc, fileId]);
  return { fromDevice, rebuilt };
}

/** The note shown when offline changes couldn't go into the file (it changed elsewhere meanwhile). */
export function RebuiltNote({ rebuilt, path }) {
  if (!rebuilt) return null;
  return (
    <div className="banner warn" role="alert">This file was changed elsewhere while you were offline, so your offline changes couldn’t be added to it.
      {rebuilt.copy ? <> They’re saved in <a href={`/${path}/${rebuilt.copy.id}`}>{rebuilt.copy.name}</a>.</> : ''} <button type="button" className="link-btn" onClick={() => window.location.reload()}>Open the latest version</button></div>
  );
}

/** Opening a file: its details from the server, or, without a connection, those kept with its copy on this device. */
export async function openFileDetails(get, id) {
  try { return await get(`/files/${id}?open`); } catch (e) {
    if (e?.status) throw e;
    const kept = await keptDoc(id);
    if (kept?.file) return { ...kept.file, offline: true };
    throw Object.assign(new Error('You’re offline, and this file hasn’t been opened on this device before'), { offline: true });
  }
}

// Files with changes made offline that aren't open in an editor: sent in the background once there's a connection
// (the editor does it for the file it has open, so those are left to it).
const openNow = new Set();
export const markOpen = (id, open) => { if (open) openNow.add(id); else openNow.delete(id); };

/** Send one kept file's unsent changes: { sent: true }, { copy } (it was rebuilt meanwhile), or null (no answer). */
async function sendKept(id, WebsocketProvider) {
  const kept = await keptDoc(id);
  if (!kept?.state || !kept.dirty) return null;
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, kept.state, 'kept');
  const url = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws/collab`;
  const provider = new WebsocketProvider(url, id, ydoc, { connect: false, params: kept.gen ? { gen: kept.gen } : {}, maxBackoffTime: 5000 });
  return new Promise((resolve) => {
    let over = false;
    const done = (r) => { if (over) return; over = true; clearTimeout(limit); provider.destroy(); ydoc.destroy(); resolve(r); };
    const limit = setTimeout(() => done(null), 20000);
    provider.on('sync', (synced) => {
      if (!synced || !provider.wsconnected) return;
      // What the server lacked went with the sync; give it a moment to leave, then it's no longer unsent.
      const wait = () => (provider.ws && provider.ws.bufferedAmount > 0 ? setTimeout(wait, 100) : setTimeout(async () => {
        await keepDoc(id, { ...kept, gen: ydoc.getMap('meta').get('gen') || kept.gen, state: Y.encodeStateAsUpdate(ydoc), dirty: false });
        done({ sent: true });
      }, 300));
      wait();
    });
    provider.on('connection-close', async (e) => {
      if (e?.code !== 4001) return;
      provider.disconnect();
      try { const copy = await post(`/files/${id}/offline-copy`, { state: toBase64(Y.encodeStateAsUpdate(ydoc)), gen: kept.gen }); await forgetDoc(id); done({ copy }); } catch { done(null); }
    });
    provider.connect();
  });
}

let sending = null;
/** Send every kept file's unsent changes (not those open in an editor). Resolves with { sent, copies: [file] }. */
export function sendUnsent(WebsocketProvider) {
  if (sending) return sending;
  sending = (async () => {
    const out = { sent: 0, copies: [] };
    const { keptList } = await import('./offlinedocs.js');
    for (const k of await keptList()) {
      if (!k.dirty || openNow.has(k.id)) continue;
      const r = await sendKept(k.id, WebsocketProvider);
      if (r?.sent) out.sent++;
      if (r?.copy) out.copies.push(r.copy);
    }
    return out;
  })().finally(() => { sending = null; });
  return sending;
}

/**
 * Renaming a document, spreadsheet or presentation. Without a connection the new name is kept on the device (with the
 * file's copy and in Drive's kept lists) and given to the file when the connection is back. Resolves with the file.
 */
export async function renameFile(file, name) {
  try { return await patch(`/files/${file.id}`, { name }); } catch (e) {
    if (!unreachable(e)) throw e;
    let user = null;
    try { user = JSON.parse(localStorage.getItem('nw-last-user') || 'null')?.id || null; } catch { /* no storage */ }
    await changeAdd({ method: 'PATCH', url: `/files/${file.id}`, body: { name }, user, label: name });
    const kept = await keptDoc(file.id);
    if (kept) await keepDoc(file.id, { ...kept, file: { ...kept.file, name } });
    await patchKeptItem(file.id, { name, offline: true });
    window.dispatchEvent(new Event('nw:changes'));
    return { ...file, name };
  }
}

/**
 * "Make available offline" (Drive): the file's latest is fetched and kept on this device without opening it, and stays
 * kept (it isn't let go among the 30 last opened). Resolves true once kept.
 */
export async function keepOffline(file, { refresh = false } = {}) {
  const { WebsocketProvider } = await import('y-websocket');
  const ydoc = new Y.Doc();
  const url = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws/collab`;
  const provider = new WebsocketProvider(url, file.id, ydoc, { connect: false, maxBackoffTime: 5000 });
  return new Promise((resolve) => {
    let over = false;
    const done = (ok) => { if (over) return; over = true; clearTimeout(limit); provider.destroy(); ydoc.destroy(); resolve(ok); };
    const limit = setTimeout(() => done(false), 20000);
    provider.on('sync', async (synced) => {
      if (!synced) return;
      const had = await keptDoc(file.id);
      if (had?.dirty) { await keepDoc(file.id, { ...had, pinned: true }); done(true); return; } // its unsent changes stay as they are
      if (refresh && (!had || !had.pinned)) { done(false); return; } // let go meanwhile
      await keepDoc(file.id, { gen: ydoc.getMap('meta').get('gen') || null, state: Y.encodeStateAsUpdate(ydoc), dirty: false, file, pinned: true, fetched: Date.now(), ...(refresh && had && { at: had.at }) });
      done(true);
    });
    provider.connect();
  });
}
/** No longer kept on purpose: it stays only while it's among the files last opened here. */
export async function unpinOffline(id) {
  const had = await keptDoc(id);
  if (had) await keepDoc(id, { ...had, pinned: false });
}

/**
 * Files made available offline are brought up to date in the background while connected (at most hourly each, not
 * those open now or with unsent changes), so what opens offline is recent. Resolves with how many were refreshed.
 */
export async function refreshPinned({ every = 3600e3 } = {}) {
  const { keptList } = await import('./offlinedocs.js');
  let n = 0;
  for (const k of await keptList()) {
    if (!k.pinned || k.dirty || openNow.has(k.id) || Date.now() - k.fetched < every) continue;
    if (await keepOffline(k.file, { refresh: true })) n++;
  }
  return n;
}

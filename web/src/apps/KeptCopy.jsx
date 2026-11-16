// Editing without a connection, for Docs, Sheets and Slides: the file's shared state kept on this device (offlinedocs.js)
// goes in first, then the connection, saying which generation it is (see server/src/collab.js genOf). What's written while
// not connected is marked unsent; if the file was rebuilt meanwhile, the server turns the old copy away (4001) and unsent
// changes become an "(offline copy)" file instead of being mixed in.
import { useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { post } from '../api.js';
import { keptDoc, keepDoc, forgetDoc, toBase64 } from './offlinedocs.js';

/**
 * `provider` must be made with connect: false: this connects it once the kept copy is in. Returns { fromDevice, rebuilt }:
 * fromDevice while what's shown came from this device and the server hasn't been reached; rebuilt: { copy } after the
 * file turned out to have been changed elsewhere (copy: the offline copy file, if there were unsent changes).
 */
export function useKeptCopy(file, ydoc, provider) {
  const genRef = useRef(null), dirtyRef = useRef(false), copyingRef = useRef(false);
  const [rebuilt, setRebuilt] = useState(null);
  const [fromDevice, setFromDevice] = useState(!!file?.offline);
  const fileRef = useRef(file); // the latest details (renamed, say), kept with the copy
  fileRef.current = file;
  const fileId = file?.id;
  useEffect(() => { if (file?.offline) setFromDevice(true); }, [file?.offline]);
  useEffect(() => {
    if (!fileId || !ydoc || !provider) return undefined;
    let live = true, timer = null;
    const file = fileRef.current;
    const meta = () => { const { offline, ...m } = fileRef.current; return m; }; // eslint-disable-line no-unused-vars
    const keep = () => { clearTimeout(timer); timer = setTimeout(() => { if (genRef.current) keepDoc(fileId, { gen: genRef.current, state: Y.encodeStateAsUpdate(ydoc), dirty: dirtyRef.current, file: meta() }); }, 800); };
    const onUpdate = (u, origin) => {
      // Not sent yet: written while not connected, or while the browser says it's offline (a dropped connection can
      // look open for a while before it times out).
      if (origin !== provider && origin !== 'kept' && (!navigator.onLine || !(provider.wsconnected && provider.synced))) dirtyRef.current = true;
      keep();
    };
    const onSync = (synced) => {
      if (!synced || !provider.wsconnected) return;
      genRef.current = ydoc.getMap('meta').get('gen') || genRef.current;
      provider.params = genRef.current ? { gen: genRef.current } : {};
      dirtyRef.current = false; // on syncing, what was made here has gone to the server
      setFromDevice(false);
      keep();
    };
    const onClose = async (e) => {
      if (e?.code !== 4001 || copyingRef.current) return; // once (a second close can arrive while the copy is made)
      copyingRef.current = true;
      provider.disconnect();
      // Nothing written here that the server hasn't had (a version was restored, say): just open the latest.
      if (!dirtyRef.current) { await forgetDoc(file.id); window.location.reload(); return; }
      let copy = null;
      try { copy = await post(`/files/${file.id}/offline-copy`, { state: toBase64(Y.encodeStateAsUpdate(ydoc)) }); } catch { copyingRef.current = false; return; /* kept on the device for another try */ }
      await forgetDoc(file.id);
      if (live) setRebuilt({ copy });
    };
    ydoc.on('update', onUpdate);
    provider.on('sync', onSync);
    provider.on('connection-close', onClose);
    keptDoc(file.id).then((kept) => {
      if (!live) return;
      if (kept?.state) {
        Y.applyUpdate(ydoc, kept.state, 'kept');
        genRef.current = kept.gen;
        dirtyRef.current = !!kept.dirty;
        provider.params = kept.gen ? { gen: kept.gen } : {};
      }
      provider.connect();
    });
    return () => { live = false; clearTimeout(timer); ydoc.off('update', onUpdate); provider.off('sync', onSync); provider.off('connection-close', onClose); };
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

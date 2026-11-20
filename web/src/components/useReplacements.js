// Your own replacements (Docs → Preferences), for Mail and Chat: read from the server (again after a minute,
// so ones just added in Docs apply), none when autocorrect is turned off there.
import { useEffect, useRef } from 'react';
import { get } from '../api.js';

let loading = null, loadedAt = 0, latest = [];
/** The replacements loaded last (for boxes that don't keep their own). */
export const currentReplacements = () => latest;
export function loadReplacements() {
  if (!loading || Date.now() - loadedAt > 60000) {
    loadedAt = Date.now();
    loading = get('/doc-prefs').then((p) => { latest = p.autocorrect === false ? [] : p.subs || []; return latest; }).catch(() => { loading = null; return []; });
  }
  return loading;
}

/** A ref holding your replacements (empty until they've loaded). */
export function useReplacements() {
  const ref = useRef([]);
  useEffect(() => {
    let live = true;
    const load = () => loadReplacements().then((s) => { if (live) ref.current = s; });
    load();
    window.addEventListener('focus', load);
    return () => { live = false; window.removeEventListener('focus', load); };
  }, []);
  return ref;
}

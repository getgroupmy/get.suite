// A Docs choice kept with your account (doc-prefs), not just in this browser: outline open, typewriter
// scrolling, dimming other paragraphs, sprint options, the voice typing language. Until it's chosen there,
// what this browser chose before is used, and kept for the account the first time. The browser keeps a
// copy too, so what reads it straight away (voice typing in Meet, Slides captions) has it.
import { useEffect, useState } from 'react';
import { get, put } from '../../api.js';

let loading = null, loadedAt = 0;
/** Your Docs preferences, read once for everything that opens together. */
export const docPrefs = () => {
  if (!loading || Date.now() - loadedAt > 5000) { loading = get('/doc-prefs'); loadedAt = Date.now(); }
  return loading;
};
const readLocal = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
const writeLocal = (key, v) => { try { localStorage.setItem(key, v); } catch { /* private window */ } };

/** [value, set] for `prefKey`; `localKey` is where this browser kept it before; `fromLocal`/`toLocal` convert. */
export function useKeptPref(prefKey, localKey, { fromLocal = (s) => s === '1', toLocal = (v) => (v ? '1' : '0'), fallback = false } = {}) {
  const [value, setValue] = useState(() => { const s = readLocal(localKey); return s === null ? fallback : fromLocal(s); });
  useEffect(() => {
    let live = true;
    docPrefs().then((p) => {
      if (!live) return;
      if (p[prefKey] !== null && p[prefKey] !== undefined) { setValue(p[prefKey]); writeLocal(localKey, toLocal(p[prefKey])); }
      else if (readLocal(localKey) !== null) put('/doc-prefs', { [prefKey]: fromLocal(readLocal(localKey)) }).catch(() => {}); // kept for the account
    }).catch(() => {});
    return () => { live = false; };
  }, [prefKey, localKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (v) => { setValue(v); writeLocal(localKey, toLocal(v)); loading = null; put('/doc-prefs', { [prefKey]: v }).catch(() => {}); };
  return [value, set];
}

/** At sign-in: the voice typing language kept with your account, where Meet's and Slides' captions read it. */
export function syncVoiceLang() {
  docPrefs().then((p) => { if (typeof p.voice_lang === 'string') writeLocal('nw-voice-typing-lang', p.voice_lang); }).catch(() => {});
}

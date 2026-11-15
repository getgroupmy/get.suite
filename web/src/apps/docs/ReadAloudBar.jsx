// The Read aloud bar above a document (⋮ → Read aloud, or Ctrl+Alt+R): reads from the cursor on, a sentence
// at a time, highlighting each; pause, go on, stop, and choose the speed and the voice (kept in this browser).
import { useEffect, useRef, useState } from 'react';
import { readKey, sentencesFrom, SPEEDS } from './readaloud.js';
import { revealTabAt } from './doctabsext.js';

const PREF = 'nw-read-aloud';
const loadPref = () => { try { return JSON.parse(localStorage.getItem(PREF) || '{}'); } catch { return {}; } };
const savePref = (p) => { try { localStorage.setItem(PREF, JSON.stringify(p)); } catch { /* private window */ } };

export const canReadAloud = () => typeof window !== 'undefined' && 'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance === 'function';

export function ReadAloudBar({ editor, onClose }) {
  const synth = window.speechSynthesis;
  const [pref, setPref] = useState(loadPref);
  const [voices, setVoices] = useState(() => synth.getVoices());
  const [state, setState] = useState('reading'); // reading | paused | done
  const [at, setAt] = useState(0);
  const list = useRef(sentencesFrom(editor.state.doc, editor.state.selection.empty ? editor.state.selection.from : editor.state.selection.from));
  const run = useRef(0); // which reading the callbacks belong to (a new one starts on each speed or voice change)

  useEffect(() => {
    const f = () => setVoices(synth.getVoices());
    synth.addEventListener?.('voiceschanged', f);
    return () => synth.removeEventListener?.('voiceschanged', f);
  }, [synth]);

  const highlight = (s) => {
    editor.view.dispatch(editor.state.tr.setMeta(readKey, s ? { from: s.from, to: s.to } : null));
    if (s) {
      revealTabAt(editor, s.from);
      try { editor.view.domAtPos(s.from).node?.parentElement?.scrollIntoView?.({ block: 'nearest' }); } catch { /* not shown */ }
    }
  };
  const speakFrom = (i) => {
    const me = ++run.current;
    synth.cancel();
    const s = list.current[i];
    if (!s) { setState('done'); highlight(null); return; }
    setAt(i); highlight(s);
    const u = new window.SpeechSynthesisUtterance(s.text);
    u.rate = pref.rate || 1;
    const v = voices.find((x) => x.voiceURI === pref.voice);
    if (v) { u.voice = v; u.lang = v.lang; } else u.lang = document.documentElement.lang || navigator.language || 'en';
    u.onend = () => { if (run.current === me) speakFrom(i + 1); };
    u.onerror = (e) => { if (run.current === me && e.error !== 'interrupted' && e.error !== 'canceled') speakFrom(i + 1); };
    synth.speak(u);
  };
  // Start, and stop everything when the bar closes.
  useEffect(() => {
    if (!list.current.length) setState('done'); else speakFrom(0);
    return () => { run.current++; synth.cancel(); editor.view.dispatch(editor.state.tr.setMeta(readKey, null)); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const change = (p) => { const next = { ...pref, ...p }; setPref(next); savePref(next); };
  // A new speed or voice applies from the sentence being read.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (state === 'reading' && list.current.length) speakFrom(at);
  }, [pref.rate, pref.voice]); // eslint-disable-line react-hooks/exhaustive-deps

  const pause = () => { synth.pause(); setState('paused'); };
  const resume = () => { if (synth.paused) synth.resume(); else speakFrom(at); setState('reading'); };
  const stop = () => { onClose(); };
  const total = list.current.length;

  return (
    <div className="find-bar read-aloud-bar" role="region" aria-label="Read aloud" onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); stop(); } }}>
      <span className="small" aria-live="polite">{state === 'done' ? (total ? 'Finished reading' : 'Nothing to read from here') : `Reading aloud: sentence ${at + 1} of ${total}`}</span>
      {state === 'reading' && <button type="button" className="btn small" onClick={pause} autoFocus>⏸ Pause</button>}
      {state === 'paused' && <button type="button" className="btn small primary" onClick={resume} autoFocus>▶ Go on</button>}
      {state === 'done' && total > 0 && <button type="button" className="btn small" onClick={() => { setState('reading'); speakFrom(0); }}>Read again</button>}
      <button type="button" className="btn small" aria-label="Previous sentence" title="Previous sentence" disabled={state === 'done' || at === 0} onClick={() => { setState('reading'); speakFrom(at - 1); }}>⏮</button>
      <button type="button" className="btn small" aria-label="Next sentence" title="Next sentence" disabled={state === 'done' || at >= total - 1} onClick={() => { setState('reading'); speakFrom(at + 1); }}>⏭</button>
      <label className="row small">Speed
        <select aria-label="Reading speed" value={pref.rate || 1} onChange={(e) => change({ rate: Number(e.target.value) })}>
          {SPEEDS.map((r) => <option key={r} value={r}>{r === 1 ? 'Normal' : `${r}×`}</option>)}
        </select></label>
      {voices.length > 1 && (
        <label className="row small">Voice
          <select aria-label="Voice" value={pref.voice || ''} onChange={(e) => change({ voice: e.target.value || null })} style={{ maxWidth: 200 }}>
            <option value="">Default</option>
            {voices.map((v) => <option key={v.voiceURI} value={v.voiceURI}>{v.name} ({v.lang})</option>)}
          </select></label>
      )}
      <button type="button" className="btn small" onClick={stop}>Stop</button>
    </div>
  );
}

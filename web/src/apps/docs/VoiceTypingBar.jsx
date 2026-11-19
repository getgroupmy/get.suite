// The Voice typing bar above a document (⋮ → Voice typing, or Ctrl+Alt+V): listens and types what's said
// where the cursor is, showing the words still being worked out. The browser does the recognising (Chrome
// and Edge send the sound to Google's or Microsoft's service for it; Safari does it on the device).
import { useKeptPref } from './keptpref.js';
import { useEffect, useRef, useState } from 'react';
import { spokenToText } from './voicetyping.js';

const Recognition = () => (typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition)) || null;
export const canVoiceType = () => !!Recognition();
const LANGS = [['en-GB', 'English (UK)'], ['en-US', 'English (US)'], ['en-AU', 'English (Australia)'], ['en-IN', 'English (India)'], ['ms-MY', 'Bahasa Melayu'], ['id-ID', 'Bahasa Indonesia'],
  ['zh-CN', '中文 (普通话)'], ['ta-IN', 'தமிழ்'], ['hi-IN', 'हिन्दी'], ['fr-FR', 'Français'], ['de-DE', 'Deutsch'], ['es-ES', 'Español'], ['pt-BR', 'Português (Brasil)'], ['it-IT', 'Italiano'],
  ['nl-NL', 'Nederlands'], ['ja-JP', '日本語'], ['ko-KR', '한국어'], ['ar-SA', 'العربية']];
const PREF = 'nw-voice-typing-lang';

/** Put recognised text in at the cursor: "\n\n" starts a new paragraph, "\n" a new line. */
function typeInto(editor, phrase) {
  const { $from } = editor.state.selection;
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '\n');
  const text = spokenToText(phrase, before);
  if (!text) return;
  let chain = editor.chain().focus();
  for (const part of text.split(/(\n\n|\n)/)) {
    if (part === '\n\n') chain = chain.splitBlock();
    else if (part === '\n') chain = chain.setHardBreak();
    else if (part) chain = chain.insertContent({ type: 'text', text: part });
  }
  chain.run();
}

export function VoiceTypingBar({ editor, onClose }) {
  const [lang, setLang] = useKeptPref('voice_lang', PREF, { fromLocal: (v) => v, toLocal: (v) => v, fallback: '' }); // '' = the browser's
  const [heard, setHeard] = useState('');
  const [state, setState] = useState('starting'); // starting | listening | error
  const [error, setError] = useState('');
  const on = useRef(true);
  const rec = useRef(null);

  useEffect(() => {
    on.current = true;
    const R = Recognition();
    const r = new R();
    rec.current = r;
    r.continuous = true;
    r.interimResults = true;
    r.lang = lang || document.documentElement.lang || navigator.language || 'en-GB';
    r.onstart = () => setState((s) => (s === 'error' ? s : 'listening'));
    r.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) typeInto(editor, res[0].transcript);
        else interim += res[0].transcript;
      }
      setHeard(interim);
    };
    r.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      on.current = false;
      setState('error');
      setError(e.error === 'not-allowed' || e.error === 'service-not-allowed' ? 'The microphone isn’t allowed for this page: allow it in the browser’s address bar, then start again.'
        : e.error === 'network' ? 'The browser’s speech service can’t be reached.' : e.error === 'audio-capture' ? 'No microphone was found.' : `Voice typing stopped (${e.error}).`);
    };
    // Browsers stop listening after a pause: carry on until it's turned off.
    r.onend = () => { if (on.current) { try { r.start(); } catch { /* already starting */ } } };
    try { r.start(); } catch { setState('error'); setError('Voice typing couldn’t start.'); }
    return () => { on.current = false; r.onend = null; try { r.stop(); } catch { /* not started */ } };
  }, [editor, lang]);

  const pick = (v) => setLang(v);
  return (
    <div className="find-bar read-aloud-bar voice-bar" role="region" aria-label="Voice typing" onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } }}>
      <span className="small" aria-live="polite">{state === 'error' ? <span className="error">{error}</span> : state === 'listening' ? <><span className="mic-dot" aria-hidden="true" /> Listening: speak, and it’s typed where the cursor is</> : 'Starting…'}</span>
      <label className="row small">Language
        <select aria-label="Language" value={lang} onChange={(e) => pick(e.target.value)}>
          <option value="">The browser’s</option>
          {LANGS.map(([v, n]) => <option key={v} value={v}>{n}</option>)}
        </select></label>
      <button type="button" className="btn small primary" onClick={onClose}>Stop</button>
      {heard && <q className="reading-text small" aria-label="Still hearing">{heard}</q>}
      <span className="muted small reading-help">Say “comma”, “full stop”, “question mark”, “new line” or “new paragraph” for punctuation.</span>
    </div>
  );
}

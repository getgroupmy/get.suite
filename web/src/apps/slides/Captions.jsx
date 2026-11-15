// Captions along the bottom of the slide while presenting (CC, or the C key): the browser hears the
// presenter (Chrome and Edge send the sound to Google's or Microsoft's service; Safari works on the device),
// in the language chosen for voice typing. They fade after a few seconds of quiet.
import { useEffect, useRef, useState } from 'react';
import { captionText, keepRecent } from './captions.js';

const Recognition = () => (typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition)) || null;
export const canCaption = () => !!Recognition();
const QUIET_MS = 7000;

export default function Captions() {
  const [finals, setFinals] = useState([]);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState('');
  const on = useRef(true);
  const quiet = useRef(null);

  useEffect(() => {
    on.current = true;
    const R = Recognition();
    const r = new R();
    r.continuous = true;
    r.interimResults = true;
    let lang = '';
    try { lang = localStorage.getItem('nw-voice-typing-lang') || ''; } catch { /* private window */ }
    r.lang = lang || document.documentElement.lang || navigator.language || 'en-GB';
    r.onresult = (e) => {
      let heard = '';
      const done = [];
      for (let k = e.resultIndex; k < e.results.length; k++) {
        const res = e.results[k];
        if (res.isFinal) done.push(res[0].transcript); else heard += res[0].transcript;
      }
      if (done.length) setFinals((f) => keepRecent([...f, ...done]));
      setInterim(heard);
      clearTimeout(quiet.current);
      quiet.current = setTimeout(() => { setFinals([]); setInterim(''); }, QUIET_MS); // clear after a pause
    };
    r.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      on.current = false;
      setError(e.error === 'not-allowed' || e.error === 'service-not-allowed' ? 'Captions need the microphone: allow it in the browser’s address bar, then turn captions on again.'
        : e.error === 'network' ? 'Captions stopped: the browser’s speech service can’t be reached.' : e.error === 'audio-capture' ? 'Captions stopped: no microphone was found.' : `Captions stopped (${e.error}).`);
    };
    r.onend = () => { if (on.current) { try { r.start(); } catch { /* already starting */ } } }; // it stops after a silence: listen again
    try { r.start(); } catch { /* started */ }
    return () => { on.current = false; clearTimeout(quiet.current); try { r.stop(); } catch { /* stopped */ } };
  }, []);

  const text = captionText(finals, interim);
  return (
    <div className="presenter-captions" onClick={(e) => e.stopPropagation()}>
      {error ? <span role="alert">{error}</span> : text ? <span aria-label="Captions">{text}</span> : null}
    </div>
  );
}

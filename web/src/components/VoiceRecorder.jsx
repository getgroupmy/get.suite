// Recording with the microphone (Chat's voice messages, Notes' recordings): 🎙 starts, the time shows
// while it records, ■ stops and hands over the recording as a file (with how long it ran), × throws it away.
import { useEffect, useState } from 'react';
import { useToast } from './ui.jsx';
import Icon from './Icon.jsx';

/** Record a voice message with the microphone: 🎙, then ■ to stop; it's added like an attached file. */
export default function VoiceRecorder({ onDone, maxSecs = 5 * 60, what = 'a voice message', name = 'Voice message' }) {
  const toast = useToast();
  const [rec, setRec] = useState(null); // { recorder, started }
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    if (!rec) return undefined;
    const t = setInterval(() => setSecs(Math.floor((Date.now() - rec.started) / 1000)), 250);
    const max = setTimeout(() => rec.recorder.state === 'recording' && rec.recorder.stop(), maxSecs * 1000); // five minutes at most (Chat), ten (Notes)
    return () => { clearInterval(t); clearTimeout(max); };
  }, [rec]);
  if (typeof window === 'undefined' || !window.MediaRecorder || !navigator.mediaDevices?.getUserMedia) return null;
  const start = async () => {
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { toast(`Allow the microphone to record ${what}`, 'error'); return; }
    const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
    const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const chunks = [];
    const started = Date.now();
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      setRec(null);
      const kind = (recorder.mimeType || type || 'audio/webm').split(';')[0];
      const blob = new Blob(chunks, { type: kind });
      const s = Math.max(1, Math.round((Date.now() - started) / 1000));
      if (!blob.size || recorder.cancelled) return;
      const ext = kind === 'audio/mp4' ? 'm4a' : kind === 'audio/ogg' ? 'ogg' : 'weba';
      onDone(new File([blob], `${name} ${Math.floor(s / 60)}.${String(s % 60).padStart(2, '0')}.${ext}`, { type: kind }), Date.now() - started);
    };
    recorder.start(250);
    setSecs(0);
    setRec({ recorder, started });
  };
  const stop = (cancel = false) => { if (rec) { rec.recorder.cancelled = cancel; rec.recorder.stop(); } };
  if (!rec) return <button type="button" className="icon-btn" aria-label={`Record ${what}`} title={`Record ${what}`} onClick={start}>🎙</button>;
  return (
    <span className="voice-rec" role="status" aria-label="Recording">
      <span className="rec-dot" aria-hidden="true" /> {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}
      <button type="button" className="icon-btn" aria-label="Stop recording" title="Stop and add it" onClick={() => stop(false)}>■</button>
      <button type="button" className="icon-btn" aria-label="Cancel recording" title="Throw it away" onClick={() => stop(true)}><Icon name="close" size={14} /></button>
    </span>
  );
}

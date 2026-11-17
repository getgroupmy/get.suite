import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { get, post, onLive } from '../api.js';
import { useToast, Modal } from './ui.jsx';
import { timerText } from './timertext.js';
import { awaySpan, awayText, AWAY_MS } from './idle.js';

// When you last typed, clicked or moved the mouse, in any tab (so time spent in another tab isn't "away").
const ACTIVE_KEY = 'nw-active';
const lastActive = () => { try { return Number(localStorage.getItem(ACTIVE_KEY)) || 0; } catch { return 0; } };
const markActive = (t) => { try { localStorage.setItem(ACTIVE_KEY, String(t)); } catch { /* private window */ } };
// Tests set a few seconds instead of ten minutes.
const awayMs = () => { try { return Number(localStorage.getItem('nw-away-seconds')) * 1000 || AWAY_MS; } catch { return AWAY_MS; } };

/** Top bar: your running task timer (or focus session), from any app: open the task, or stop it. */
export default function TimerChip() {
  const navigate = useNavigate();
  const toast = useToast();
  const [run, setRun] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [away, setAway] = useState(null); // { from, to } while asking what to do with time away
  const runRef = useRef(null);
  runRef.current = run;
  useEffect(() => {
    let wrote = 0;
    const active = () => {
      const t = Date.now();
      if (t - wrote < 5e3) return; // a few writes a minute at most
      const span = awaySpan(runRef.current, lastActive(), t, awayMs());
      if (span) setAway((a) => a || span);
      wrote = t; markActive(t);
    };
    if (!lastActive()) markActive(Date.now());
    const evs = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'];
    for (const e of evs) window.addEventListener(e, active, { passive: true, capture: true });
    return () => { for (const e of evs) window.removeEventListener(e, active, { capture: true }); };
  }, []);
  useEffect(() => {
    let live = true;
    const load = () => get('/tasks/timer').then((r) => { if (live) setRun(r); }).catch(() => {});
    load();
    const tick = setInterval(() => { setNow(Date.now()); }, 15e3);
    // A focus session past its end: the server stops it within half a minute; asked again until it says so.
    const due = setInterval(() => { setRun((r) => { if (r?.until && Date.now() >= r.until) load(); return r; }); }, 10e3);
    const again = setInterval(load, 60e3);
    const off = onLive((m) => { if (m.type === 'tasks-changed' || m.type === 'live-connected' || (m.type === 'notification' && m.kind === 'task')) load(); });
    return () => { live = false; clearInterval(tick); clearInterval(due); clearInterval(again); off(); };
  }, []);
  if (!run) return null;
  const leaveOut = async (resume) => {
    const span = away;
    setAway(null);
    try {
      await post('/tasks/timer/stop', { at: span.from, resume });
      if (resume) setRun({ ...run, since: Date.now() }); else setRun(null);
      toast(resume ? 'Time away left out; the timer carries on' : 'Time away left out; the timer stopped');
    } catch (e) { toast(e.message, 'error'); }
  };
  const stop = async () => {
    try { await post('/tasks/timer/stop'); setRun(null); toast('Timer stopped'); } catch (e) { toast(e.message, 'error'); }
  };
  const text = timerText(run, now);
  return (
    <div className="timer-chip" role="status" aria-label={`${run.title}: ${text}`}>
      <button type="button" className="link-btn timer-chip-title" title="Open the task" onClick={() => navigate(`/tasks/${run.list_id}?task=${run.task_id}`)}>
        {run.until ? '◎' : '⏱'} <span className="ellipsis">{run.title}</span> <span className="muted">{text}</span>
      </button>
      <button type="button" className="icon-btn small" aria-label="Stop the timer" title="Stop" onClick={stop}>■</button>
      {away && (
        <Modal title="You were away" onClose={() => setAway(null)} footer={<>
          <button type="button" onClick={() => setAway(null)}>Keep the time</button>
          <button type="button" onClick={() => leaveOut(false)}>Leave it out and stop</button>
          <button type="button" className="primary" onClick={() => leaveOut(true)}>Leave it out and carry on</button>
        </>}>
          <p style={{ margin: 0 }}>Nothing happened here {awayText(away)} while the timer ran on <strong>{run.title}</strong>. Count that time?</p>
        </Modal>
      )}
    </div>
  );
}

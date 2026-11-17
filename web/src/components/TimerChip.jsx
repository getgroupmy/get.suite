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
// A break after a focus session: five minutes, counted down in the top bar (kept across reloads).
const BREAK_KEY = 'nw-break';
const breakMs = () => { try { return Number(localStorage.getItem('nw-break-seconds')) * 1000 || 5 * 60e3; } catch { return 5 * 60e3; } };
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
  // After a focus session ends by itself: { task_id, list_id, title, minutes } to offer another one or a break.
  const [ended, setEnded] = useState(null);
  const [onBreak, setOnBreak] = useState(() => { try { const b = JSON.parse(localStorage.getItem(BREAK_KEY) || 'null'); return b && b.until > Date.now() ? b : null; } catch { return null; } });
  useEffect(() => {
    let live = true;
    // A focus session whose time is up counts as over here at once (the server stops it within half a minute).
    // skew: how far this computer's clock is from the server's (the ends are the server's times).
    const load = () => get('/tasks/timer').then((r) => {
      if (!live) return;
      const run = r && { ...r, skew: r.now ? Date.now() - r.now : 0 };
      setRun(run?.until && Date.now() - run.skew >= run.until ? null : run);
    }).catch(() => {});
    load();
    const tick = setInterval(() => { setNow(Date.now()); }, 15e3);
    const due = setInterval(() => {
      setRun((r) => {
        if (!r?.until || Date.now() - (r.skew || 0) < r.until) return r;
        setEnded({ task_id: r.task_id, list_id: r.list_id, title: r.title, minutes: Math.max(5, Math.round((r.until - r.since) / 60e3)) });
        return null;
      });
    }, 1000);
    const again = setInterval(load, 60e3);
    const off = onLive((m) => { if (m.type === 'tasks-changed' || m.type === 'live-connected' || (m.type === 'notification' && m.kind === 'task')) load(); });
    return () => { live = false; clearInterval(tick); clearInterval(due); clearInterval(again); off(); };
  }, []);
  // The break: counted down here; when it's over, a nudge back to work.
  useEffect(() => {
    if (!onBreak) return undefined;
    const t = setInterval(() => {
      setNow(Date.now());
      if (Date.now() < onBreak.until) return;
      setOnBreak(null); try { localStorage.removeItem(BREAK_KEY); } catch { /* private window */ }
      toast('Break’s over', 'info', { duration: 20000, ...(onBreak.task && { action: { label: `Focus on ${onBreak.task.title}`, onClick: () => focusAgain(onBreak.task) } }) });
    }, 1000);
    return () => clearInterval(t);
  }, [onBreak]); // eslint-disable-line react-hooks/exhaustive-deps
  const focusAgain = async (t) => {
    try {
      await post(`/tasks/tasks/${t.task_id}/timer`, { minutes: t.minutes });
      const r = await get('/tasks/timer');
      setEnded(null); setRun(r && { ...r, skew: r.now ? Date.now() - r.now : 0 }); toast(`Focus for ${t.minutes} minutes on ${t.title}`);
    } catch (e) { toast(e.message, 'error'); }
  };
  const takeBreak = (t) => {
    const b = { until: Date.now() + breakMs(), task: t };
    setEnded(null); setOnBreak(b); setNow(Date.now());
    try { localStorage.setItem(BREAK_KEY, JSON.stringify(b)); } catch { /* private window */ }
  };
  if (!run && onBreak) {
    const left = Math.max(0, Math.ceil((onBreak.until - now) / 60e3));
    return (
      <div className="timer-chip" role="status" aria-label={`Break: ${left} min left`}>
        <span className="timer-chip-title">☕ Break <span className="muted">{left} min left</span></span>
        <button type="button" className="icon-btn small" aria-label="End the break" title="End the break" onClick={() => { setOnBreak(null); try { localStorage.removeItem(BREAK_KEY); } catch { /* private window */ } }}>■</button>
      </div>
    );
  }
  if (!run && ended) {
    return (
      <div className="timer-chip" role="status" aria-label={`Focus session done: ${ended.title}`}>
        <span className="timer-chip-title">🎯 <span className="ellipsis">{ended.title}</span> <span className="muted">done</span></span>
        <button type="button" className="btn small" onClick={() => focusAgain(ended)}>Another {ended.minutes} min</button>
        <button type="button" className="btn small" onClick={() => takeBreak(ended)}>5-min break</button>
        <button type="button" className="icon-btn small" aria-label="Dismiss" title="Dismiss" onClick={() => setEnded(null)}>✕</button>
      </div>
    );
  }
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
  const text = timerText(run, now - (run.skew || 0));
  return (
    <div className="timer-chip" role="status" aria-label={`${run.title}: ${text}`}>
      <button type="button" className="link-btn timer-chip-title" title="Open the task" onClick={() => navigate(`/tasks/${run.list_id}?task=${run.task_id}`)}>
        {run.until ? '◎' : '⏱'} <span className="ellipsis">{run.title}</span> <span className="muted">{text}</span>
      </button>
      <button type="button" className="icon-btn small" aria-label="Stop the timer" title="Stop" onClick={stop}>■</button>
      {away && (
        <Modal title="You were away" onClose={() => setAway(null)} footer={<>
          <button type="button" className="btn" onClick={() => setAway(null)}>Keep the time</button>
          <button type="button" className="btn" onClick={() => leaveOut(false)}>Leave it out and stop</button>
          <button type="button" className="btn primary" onClick={() => leaveOut(true)}>Leave it out and carry on</button>
        </>}>
          <p style={{ margin: 0 }}>Nothing happened here {awayText(away)} while the timer ran on <strong>{run.title}</strong>. Count that time?</p>
        </Modal>
      )}
    </div>
  );
}

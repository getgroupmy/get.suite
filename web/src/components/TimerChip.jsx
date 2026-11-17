import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { get, post, onLive } from '../api.js';
import { useToast } from './ui.jsx';
import { timerText } from './timertext.js';

/** Top bar: your running task timer (or focus session), from any app: open the task, or stop it. */
export default function TimerChip() {
  const navigate = useNavigate();
  const toast = useToast();
  const [run, setRun] = useState(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let live = true;
    const load = () => get('/tasks/timer').then((r) => { if (live) setRun(r); }).catch(() => {});
    load();
    const tick = setInterval(() => { setNow(Date.now()); }, 15e3);
    const again = setInterval(load, 60e3);
    const off = onLive((m) => { if (m.type === 'tasks-changed' || m.type === 'live-connected' || (m.type === 'notification' && m.kind === 'task')) load(); });
    return () => { live = false; clearInterval(tick); clearInterval(again); off(); };
  }, []);
  if (!run) return null;
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
    </div>
  );
}

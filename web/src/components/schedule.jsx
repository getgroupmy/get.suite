// Choosing a time for later (sending, snoozing): the usual choices, a date-and-time window, and
// "tomorrow at 9:00"-style text. Shared by Mail and Chat.
import { useState } from 'react';
import { Modal } from './ui.jsx';

/** "today at 3:00 PM", "tomorrow at 8:00 AM" or "Monday 9 Nov at 8:00 AM". */
export function whenText(at, now = Date.now()) {
  const d = new Date(at), today = new Date(now);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(today.getFullYear(), today.getMonth(), today.getDate())) / 864e5);
  if (days === 0) return `today at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  return `${d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' })} at ${time}`;
}

/** The usual "send later" times: tomorrow morning and afternoon, and Monday morning. */
export function laterChoices(now = new Date()) {
  const at = (days, h) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, h, 0).getTime();
  const out = [['Tomorrow morning', at(1, 8)], ['Tomorrow afternoon', at(1, 13)]];
  const toMonday = ((8 - now.getDay()) % 7) || 7;
  if (toMonday > 1) out.push(['Monday morning', at(toMonday, 8)]);
  return out;
}

/** Pick a date and time in the future (within a year, if asked). */
export function ScheduleDialog({ onClose, onPick, title = 'Schedule send', confirm = 'Schedule send', note = (at) => `It will be sent ${whenText(at)}, even if Workspace isn’t open then.`, withinYear = false }) {
  const pad = (n) => String(n).padStart(2, '0');
  const t = new Date(Date.now() + 36e5);
  const [date, setDate] = useState(`${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`);
  const [time, setTime] = useState(`${pad(t.getHours())}:00`);
  const at = new Date(`${date}T${time || '00:00'}`).getTime();
  const tooFar = withinYear && at > Date.now() + 365 * 864e5;
  const ok = Number.isFinite(at) && at > Date.now() + 60e3 && !tooFar;
  return (
    <Modal title={title} onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" disabled={!ok} onClick={() => onPick(at)}>{confirm}</button></>}>
      <div className="row" style={{ gap: 12 }}>
        <label className="field"><span>Date</span><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <label className="field"><span>Time</span><input type="time" value={time} onChange={(e) => setTime(e.target.value)} /></label>
      </div>
      <p className="muted small">{ok ? note(at) : tooFar ? 'Choose a time within a year.' : 'Choose a time in the future.'}</p>
    </Modal>
  );
}

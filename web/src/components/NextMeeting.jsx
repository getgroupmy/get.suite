import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { get, post, onLive, refreshOn } from '../api.js';
import { Menu, useToast } from './ui.jsx';
import { expandAll } from '../apps/calendar/calmath.js';
import { nextMeeting } from './nextmeeting.js';

/** Top bar: "Design review in 5 min · Join", for a meeting of yours starting soon or going on (checked each minute). */
export default function NextMeeting() {
  const navigate = useNavigate();
  const toast = useToast();
  const [events, setEvents] = useState([]);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let live = true;
    const load = () => {
      // (Whole hours: the same address for an hour, so it's kept for offline once, not anew on every page.)
      const hour = Math.floor(Date.now() / 3600e3) * 3600e3, from = hour - 6 * 3600e3, to = hour + 2 * 3600e3;
      get(`/events?from=${from}&to=${to}`).then((list) => { if (live) setEvents(expandAll(list, from, to)); }).catch(() => {});
    };
    load();
    const tick = setInterval(() => setNow(Date.now()), 30e3);
    const again = setInterval(load, 5 * 60e3);
    const off = onLive((m) => { if (refreshOn(m, 'events-changed')) load(); });
    return () => { live = false; clearInterval(tick); clearInterval(again); off(); };
  }, []);
  const next = nextMeeting(events, now);
  if (!next) return null;
  const { ev, label } = next;
  // Running late, said from here: the others on it are told (as from the event's own window).
  const withOthers = ev.role === 'guest' || ev.guests?.length > 0;
  const late = (minutes) => post(`/events/${ev.id}/late`, { minutes, at: ev.occurrence ?? ev.start })
    .then(() => toast(`Told the others you’re running ${minutes} minutes late`)).catch((e) => toast(e.message, 'error'));
  return (
    <div className="next-meeting" role="status" aria-label={`${ev.title || 'Meeting'} ${label}`}>
      <button type="button" className="link-btn next-meeting-title" title="Open in Calendar" onClick={() => navigate(`/calendar?event=${encodeURIComponent(ev.id)}`)}>
        📅 <span className="ellipsis">{ev.title || 'Meeting'}</span> <span className="muted">{label}</span>
      </button>
      {withOthers && <Menu align="right" trigger={(p) => <button type="button" className="icon-btn small" aria-label="Running late" title="Running late: tell the others" {...p}>⏱</button>}
        items={[5, 10, 15, 30].map((minutes) => ({ label: `${minutes} minutes late`, onClick: () => late(minutes) }))} />}
      {ev.meet_code && <a className="btn small primary" href={`/meet/${ev.meet_code}`} target="_blank" rel="noopener noreferrer">Join</a>}
    </div>
  );
}

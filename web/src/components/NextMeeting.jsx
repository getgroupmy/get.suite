import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { get, onLive, refreshOn } from '../api.js';
import { expandAll } from '../apps/calendar/calmath.js';
import { nextMeeting } from './nextmeeting.js';

/** Top bar: "Design review in 5 min · Join", for a meeting of yours starting soon or going on (checked each minute). */
export default function NextMeeting() {
  const navigate = useNavigate();
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
  return (
    <div className="next-meeting" role="status" aria-label={`${ev.title || 'Meeting'} ${label}`}>
      <button type="button" className="link-btn next-meeting-title" title="Open in Calendar" onClick={() => navigate(`/calendar?event=${encodeURIComponent(ev.id)}`)}>
        📅 <span className="ellipsis">{ev.title || 'Meeting'}</span> <span className="muted">{label}</span>
      </button>
      {ev.meet_code && <a className="btn small primary" href={`/meet/${ev.meet_code}`} target="_blank" rel="noopener noreferrer">Join</a>}
    </div>
  );
}

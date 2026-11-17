import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { get, post, onLive, refreshOn } from '../api.js';
import { Menu, useToast } from './ui.jsx';
import { expandAll } from '../apps/calendar/calmath.js';
import { nextMeeting, meetingKey, keepDismissed } from './nextmeeting.js';

const DISMISSED = 'nw-meeting-dismissed';
const readDismissed = () => { try { return JSON.parse(localStorage.getItem(DISMISSED) || '[]'); } catch { return []; } };

/** Top bar: "Design review in 5 min · Join", for a meeting of yours starting soon or going on (checked each minute). */
export default function NextMeeting() {
  const navigate = useNavigate();
  const toast = useToast();
  const [events, setEvents] = useState([]);
  const [now, setNow] = useState(Date.now());
  const [dismissed, setDismissed] = useState(readDismissed); // waved away (×), remembered in this browser
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
  const next = nextMeeting(events, now, undefined, dismissed);
  if (!next) return null;
  const { ev, label } = next;
  // Running late, said from here: the others on it are told (as from the event's own window).
  const withOthers = ev.role === 'guest' || ev.guests?.length > 0;
  // Meeting notes: yours made (or opened) as from the event's window; someone else's opened.
  const notes = async () => {
    const tab = window.open('', '_blank');
    try {
      const id = ev.role === 'organizer' ? (await post(`/events/${ev.id}/notes`, { tz: Intl.DateTimeFormat().resolvedOptions().timeZone })).id : ev.notes_id;
      if (tab) tab.location.href = `/docs/${id}`; else navigate(`/docs/${id}`);
      if (!ev.notes_id) setEvents((list) => list.map((x) => (x.id === ev.id ? { ...x, notes_id: id } : x)));
    } catch (e) { tab?.close(); toast(e.message, 'error'); }
  };
  const late = (minutes) => post(`/events/${ev.id}/late`, { minutes, at: ev.occurrence ?? ev.start })
    .then(() => toast(`Told the others you’re running ${minutes} minutes late`)).catch((e) => toast(e.message, 'error'));
  return (
    <div className="next-meeting" role="status" aria-label={`${ev.title || 'Meeting'} ${label}`}>
      <button type="button" className="link-btn next-meeting-title" title="Open in Calendar" onClick={() => navigate(`/calendar?event=${encodeURIComponent(ev.id)}`)}>
        📅 <span className="ellipsis">{ev.title || 'Meeting'}</span> <span className="muted">{label}</span>
      </button>
      {(ev.role === 'organizer' || ev.notes_id) && <button type="button" className="icon-btn small" aria-label={ev.notes_id ? 'Open meeting notes' : 'Take meeting notes'} title={ev.notes_id ? 'Open meeting notes' : 'Take meeting notes'} onClick={notes}>📝</button>}
      {withOthers && <Menu align="right" trigger={(p) => <button type="button" className="icon-btn small" aria-label="Running late" title="Running late: tell the others" {...p}>⏱</button>}
        items={[5, 10, 15, 30].map((minutes) => ({ label: `${minutes} minutes late`, onClick: () => late(minutes) }))} />}
      {ev.meet_code && <a className="btn small primary" href={`/meet/${ev.meet_code}`} target="_blank" rel="noopener noreferrer">Join</a>}
      <button type="button" className="icon-btn small" aria-label="Hide this meeting here" title="Hide (until the next meeting)" onClick={() => {
        const keys = keepDismissed([...dismissed, meetingKey(ev)]);
        setDismissed(keys);
        try { localStorage.setItem(DISMISSED, JSON.stringify(keys)); } catch { /* not remembered */ }
      }}>×</button>
    </div>
  );
}

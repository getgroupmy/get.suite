// What you've had to do with someone: recent emails with them (Inbox, Sent, Archive) and your past
// and upcoming meetings with them. On a contact's history and a colleague's card.
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { get } from '../api.js';
import { useMailStatus } from '../mailStatus.js';

const day = (t) => new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short', year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });

export default function WithPerson({ email, onOpen }) {
  const mail = useMailStatus();
  const [msgs, setMsgs] = useState(null);
  const [events, setEvents] = useState(null);
  useEffect(() => {
    if (!email) return;
    get(`/events/with?email=${encodeURIComponent(email)}`).then(setEvents).catch(() => setEvents({ upcoming: [], past: [] }));
  }, [email]);
  useEffect(() => {
    if (!email || !mail?.enabled) return;
    get(`/mail/with?address=${encodeURIComponent(email)}`).then(setMsgs).catch(() => setMsgs([]));
  }, [email, mail?.enabled]);
  if (!email) return null;
  const meetings = events ? [...events.upcoming.map((e) => ({ ...e, next: true })), ...events.past] : null;
  return (
    <div className="with-person stack">
      {mail?.enabled && (
        <section aria-label="Recent emails">
          <h3 className="small">Recent emails</h3>
          {!msgs ? <p className="muted small">Looking…</p> : !msgs.length ? <p className="muted small">No emails with {email} yet.</p> : (
            <ul className="with-list">{msgs.map((m) => (
              <li key={`${m.folder}${m.uid}`}><Link to={`/mail/${encodeURIComponent(m.folder)}/${m.uid}`} onClick={onOpen} className={`grow ellipsis ${m.seen ? '' : 'unread'}`}>
                <span className="muted small">{m.sent ? 'You → ' : ''}</span>{m.subject || '(no subject)'}</Link>
                <span className="muted small nowrap">{m.date ? day(m.date) : ''}</span></li>
            ))}</ul>
          )}
        </section>
      )}
      <section aria-label="Meetings">
        <h3 className="small">Meetings</h3>
        {!meetings ? <p className="muted small">Looking…</p> : !meetings.length ? <p className="muted small">No meetings with them.</p> : (
          <ul className="with-list">{meetings.map((e) => (
            <li key={`${e.id}${e.start}`}><Link to="/calendar" state={{ openEvent: { id: e.id, start: e.start, end: e.end } }} onClick={onOpen} className="grow ellipsis">{e.title}{e.repeats ? ' ⟳' : ''}</Link>
              <span className={`small nowrap ${e.next ? '' : 'muted'}`}>{e.next ? 'Next: ' : ''}{day(e.start)}</span></li>
          ))}</ul>
        )}
      </section>
    </div>
  );
}

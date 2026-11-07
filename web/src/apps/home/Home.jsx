// Home: the day at a glance. Today's events, tasks due (and overdue), unread mail and chat, files you
// worked on lately and your pinned notes, each linking to where it lives. It updates as things change.
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { get, onLive, formatDate } from '../../api.js';
import Icon from '../../components/Icon.jsx';
import { useAuth } from '../../App.jsx';
import { useMailStatus } from '../../mailStatus.js';
import { expandAll } from '../calendar/calmath.js';
import { dueLabel, localToday } from '../tasks/taskmath.js';

const FILE_LINK = { doc: (f) => `/docs/${f.id}`, sheet: (f) => `/sheets/${f.id}`, slides: (f) => `/slides/${f.id}`, folder: (f) => `/drive/folder/${f.id}` };
const time = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

import { greeting } from './greeting.js';

export default function Home() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const mail = useMailStatus();
  const [data, setData] = useState(null);
  const load = useCallback(async () => {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const from = start.getTime(), to = from + 864e5 - 1;
    const safe = (p, empty) => p.catch(() => empty);
    const [events, due, channels, recent, notes, unread, approvals] = await Promise.all([
      safe(get(`/events?from=${from}&to=${to}`), []), safe(get(`/tasks/due?from=2000-01-01&to=${localToday()}`), []),
      safe(get('/chat/channels'), { channels: [] }), safe(get('/files?view=recent'), []), safe(get('/notes'), []),
      mail?.enabled ? safe(get('/mail/unread'), null) : Promise.resolve(null), safe(get('/approvals'), { waiting: [] }),
    ]);
    setData({
      events: expandAll(events, from, to).filter((e) => e.my_status !== 'no'),
      due,
      chats: channels.channels.filter((c) => (c.muted ? c.mentions : c.unread) > 0).sort((a, b) => (b.last_at || 0) - (a.last_at || 0)),
      recent: (Array.isArray(recent) ? recent : []).filter((f) => f.kind !== 'folder').slice(0, 6),
      notes: notes.filter((n) => n.pinned).slice(0, 4),
      approvals: approvals.waiting,
      unread: unread?.unseen ?? null,
    });
  }, [mail?.enabled]);
  useEffect(() => { if (mail) load(); }, [load, mail]);
  useEffect(() => onLive((m) => {
    if (['events-changed', 'tasks-changed', 'message', 'chat-read', 'notes-changed', 'files-changed', 'mail-new', 'mail-unread', 'approvals-changed', 'live-connected'].includes(m.type)) load();
  }), [load]);
  useEffect(() => { document.title = 'Home'; return () => { document.title = 'Workspace'; }; }, []);

  const now = Date.now();
  const first = user.name.split(' ')[0];
  return (
    <div className="page home">
      <div className="home-hello">
        <h1>{greeting()}, {first}</h1>
        <p className="muted" style={{ margin: 0 }}>{new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</p>
      </div>
      {!data ? <p className="muted">Loading…</p> : (
        <div className="home-grid">
          <section className="card home-card" aria-label="Today's events">
            <h2><Link to="/calendar"><Icon name="calendar" size={18} /> Today</Link></h2>
            {!data.events.length ? <p className="muted small">Nothing on your calendar today.</p> : (
              <ul className="home-list">
                {data.events.map((e) => {
                  const nowOn = !e.all_day && e.start <= now && now < e.end;
                  return (
                    <li key={`${e.id}:${e.start}`} className={e.end < now && !e.all_day ? 'past' : ''}>
                      <span className="home-dot" style={{ background: e.color || 'var(--accent)' }} />
                      <span className="home-when">{e.all_day ? 'All day' : time(e.start)}</span>
                      <button type="button" className="link-btn grow home-item" onClick={() => navigate('/calendar', { state: { openEvent: e } })}>{e.title}</button>
                      {nowOn && <span className="pill doing">Now</span>}
                      {e.meet_code && <a className="btn small" href={`/meet/${e.meet_code}`} target="_blank" rel="noreferrer" aria-label={`Join ${e.title}`}>Join</a>}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
          <section className="card home-card" aria-label="Tasks due">
            <h2><Link to="/tasks"><Icon name="check" size={18} /> Tasks due</Link></h2>
            {!data.due.length ? <p className="muted small">Nothing due today. 🎉</p> : (
              <ul className="home-list">
                {data.due.slice(0, 8).map((t) => {
                  const d = dueLabel(t.due, new Date(), t.due_time);
                  return <li key={t.id}><Link className="grow home-item" to={`/tasks/${t.list_id}?task=${t.id}`}>{t.title}</Link><span className={`pill due ${d.tone}`}>{d.text}</span></li>;
                })}
                {data.due.length > 8 && <li className="muted small">and {data.due.length - 8} more</li>}
              </ul>
            )}
          </section>
          <section className="card home-card" aria-label="Unread">
            <h2><Icon name="bell" size={18} /> Unread</h2>
            <ul className="home-list">
              {mail?.enabled && <li><Icon name="mail" size={16} /><Link className="grow home-item" to="/mail">{data.unread ? `${data.unread} unread ${data.unread === 1 ? 'email' : 'emails'}` : 'No unread email'}</Link></li>}
              {!data.chats.length && <li className="muted small">No unread chat messages.</li>}
              {data.chats.slice(0, 6).map((c) => (
                <li key={c.id}><Icon name="chat" size={16} /><Link className="grow home-item" to={`/chat/${c.id}`}>{c.dm_key ? c.dm_name || 'Notes to self' : `#${c.name}`}</Link>
                  <span className="count">{c.muted ? c.mentions : c.unread}</span></li>
              ))}
            </ul>
          </section>
          {data.approvals.length > 0 && (
            <section className="card home-card" aria-label="Waiting for your approval">
              <h2><Link to="/drive/approvals"><Icon name="check" size={18} /> Waiting for your approval</Link></h2>
              <ul className="home-list">
                {data.approvals.slice(0, 6).map((a) => (
                  <li key={a.id}><Icon name={{ doc: 'doc', sheet: 'sheet', slides: 'slides' }[a.file.kind] || 'file'} size={16} />
                    <Link className="grow home-item" to={FILE_LINK[a.file.kind]?.(a.file) || '/drive/approvals'}>{a.file.name}</Link>
                    <span className="muted small nowrap">{a.requested_by?.name}{a.due ? ` · by ${a.due}` : ''}</span></li>
                ))}
              </ul>
            </section>
          )}
          <section className="card home-card" aria-label="Recent files">
            <h2><Link to="/drive/recent"><Icon name="folder" size={18} /> Recent files</Link></h2>
            {!data.recent.length ? <p className="muted small">Files you open or change show up here.</p> : (
              <ul className="home-list">
                {data.recent.map((f) => (
                  <li key={f.id}><Icon name={{ doc: 'doc', sheet: 'sheet', slides: 'slides' }[f.kind] || 'file'} size={16} />
                    <Link className="grow home-item ellipsis" to={FILE_LINK[f.kind]?.(f) || '/drive/recent'}>{f.name}</Link><span className="muted small nowrap">{formatDate(f.updated_at)}</span></li>
                ))}
              </ul>
            )}
          </section>
          {data.notes.length > 0 && (
            <section className="card home-card" aria-label="Pinned notes">
              <h2><Link to="/notes"><Icon name="note" size={18} /> Pinned notes</Link></h2>
              <div className="home-notes">
                {data.notes.map((n) => (
                  <button key={n.id} type="button" className="home-note" style={n.color ? { background: n.color, color: '#202124' } : undefined} onClick={() => navigate('/notes', { state: { openNote: n.id } })}>
                    {n.title && <strong>{n.title}</strong>}
                    <span className="small">{(n.body || (n.items || []).filter((i) => !i.done).map((i) => `☐ ${i.text}`).join('\n')).slice(0, 140)}</span>
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

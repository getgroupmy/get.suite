// Home: the day at a glance. Today's events, tasks due (and overdue), unread mail and chat, files you
// worked on lately and your pinned notes, each linking to where it lives. It updates as things change.
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { get, post, put, patch, onLive, formatDate } from '../../api.js';
import Icon from '../../components/Icon.jsx';
import { Avatar, Modal, useToast } from '../../components/ui.jsx';
import { useAuth } from '../../App.jsx';
import { useMailStatus } from '../../mailStatus.js';
import { expandAll } from '../calendar/calmath.js';
import { dueLabel, localToday } from '../tasks/taskmath.js';

const FILE_LINK = { doc: (f) => `/docs/${f.id}`, sheet: (f) => `/sheets/${f.id}`, slides: (f) => `/slides/${f.id}`, folder: (f) => `/drive/folder/${f.id}` };
const time = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

import { placeText } from '../../components/workloc.js';
import { greeting } from './greeting.js';
import { upcoming, addDays, sinceText } from './dates.js';

/** "tomorrow", "Mon 16 Nov" for a YYYY-MM-DD. */
function dayText(d) {
  const t = new Date(`${d}T00:00:00`), today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((t - today) / 864e5);
  return diff === 1 ? 'tomorrow' : t.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
}

/** Home's cards, by key, as the Customize window names them. */
export const CARD_NAMES = { events: "Today's events", tasks: 'Tasks for today', unread: 'Unread', approvals: 'Waiting for your approval', out: "Who's out",
  signing: 'Waiting for your signature', apps: 'Company apps', recent: 'Recent files', notes: 'Pinned notes', dates: 'Birthdays and dates', touch: 'Keep in touch', office: 'In the office today' };
const DEFAULT_LAYOUT = { order: Object.keys(CARD_NAMES), hidden: [] };

export default function Home() {
  const { user, setUser } = useAuth();
  const [layout, setLayout] = useState(() => user.home_layout || DEFAULT_LAYOUT);
  const [customizing, setCustomizing] = useState(false);
  // Each card takes its place in your order (CSS order in the grid), or stays out when hidden.
  const cardProps = (key) => ({ style: { order: Math.max(0, layout.order.indexOf(key)) }, hidden: layout.hidden.includes(key), 'data-card': key });
  const saveLayout = async (next) => {
    setLayout(next);
    try { const saved = await put('/users/me/home-layout', next.reset ? { reset: true } : { order: next.order, hidden: next.hidden }); setLayout(saved); setUser?.({ ...user, home_layout: saved }); } catch { /* kept here */ }
  };
  const navigate = useNavigate();
  const toast = useToast();
  const mail = useMailStatus();
  const [data, setData] = useState(null);
  const load = useCallback(async () => {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const from = start.getTime(), to = from + 864e5 - 1;
    const safe = (p, empty) => p.catch(() => empty);
    const [events, due, channels, recent, notes, unread, approvals, where, signing, away, apps, dates, touch, office] = await Promise.all([
      safe(get(`/events?from=${from}&to=${to}`), []), safe(get(`/tasks/today?today=${localToday()}`), []),
      safe(get('/chat/channels'), { channels: [] }), safe(get('/files?view=recent'), []), safe(get('/notes'), []),
      mail?.enabled ? safe(get('/mail/unread'), null) : Promise.resolve(null), safe(get('/approvals'), { waiting: [] }),
      safe(get(`/location?from=${localToday()}&to=${localToday()}`), { days: {} }), safe(get('/signatures'), { waiting: [] }),
      safe(get(`/time-off/out?date=${localToday()}`), { out: [], holiday: null, waiting: 0 }),
      safe(get('/oauth/launcher'), []),
      safe(get(`/contacts/birthdays?from=${localToday()}&to=${addDays(localToday(), 13)}`), []),
      safe(get('/contacts/keep-in-touch'), []),
      safe(get(`/location/office?date=${localToday()}`), []),
    ]);
    setData({
      events: expandAll(events, from, to).filter((e) => e.my_status !== 'no'),
      due,
      chats: channels.channels.filter((c) => (c.muted ? c.mentions : c.unread) > 0).sort((a, b) => (b.last_at || 0) - (a.last_at || 0)),
      recent: (Array.isArray(recent) ? recent : []).filter((f) => f.kind !== 'folder').slice(0, 6),
      notes: notes.filter((n) => n.pinned).slice(0, 4),
      approvals: approvals.waiting,
      signing: signing.waiting,
      where: where.days?.[localToday()] || null,
      unread: unread?.unseen ?? null,
      away,
      apps,
      dates: upcoming(dates, localToday()).slice(0, 6),
      touch: touch.slice(0, 5), touchMore: Math.max(0, touch.length - 5),
      office,
    });
  }, [mail?.enabled]);
  useEffect(() => { if (mail) load(); }, [load, mail]);
  // Ticking a task off right here (with Undo).
  const tickOff = async (t) => {
    setData((d) => ({ ...d, due: d.due.filter((x) => x.id !== t.id) }));
    try {
      await patch(`/tasks/tasks/${t.id}`, { done: true, today: localToday() });
      toast(`“${t.title}” done`, 'info', { action: { label: 'Undo', onClick: () => patch(`/tasks/tasks/${t.id}`, { done: false }).then(load).catch(() => {}) } });
    } catch (e) { toast(e.message, 'error'); load(); }
  };
  useEffect(() => onLive((m) => {
    if (['events-changed', 'tasks-changed', 'message', 'chat-read', 'notes-changed', 'files-changed', 'mail-new', 'mail-unread', 'approvals-changed', 'signatures-changed', 'location-changed', 'live-connected'].includes(m.type) || m.type === 'notification') load();
  }), [load]);
  useEffect(() => { document.title = 'Home'; return () => { document.title = 'Workspace'; }; }, []);

  const now = Date.now();
  const first = user.name.split(' ')[0];
  return (
    <div className="page home">
      <div className="home-hello">
        <button type="button" className="btn small home-customize" onClick={() => setCustomizing(true)}><Icon name="settings" size={16} /> Customize</button>
        <h1>{greeting()}, {first}</h1>
        <p className="muted" style={{ margin: 0 }}>{new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}{data?.where && ` · ${placeText(data.where)} today`}</p>
      </div>
      {!data ? <p className="muted">Loading…</p> : (
        <div className="home-grid">
          <section className="card home-card" aria-label="Today's events" {...cardProps('events')}>
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
                      {e.meet_live?.length > 0 && <span className="meet-live small" title={e.meet_live.join(', ')}><span className="chat-live-dot" aria-hidden="true" /> {e.meet_live.length} in it</span>}
                      {e.meet_code && <a className="btn small" href={`/meet/${e.meet_code}`} target="_blank" rel="noreferrer" aria-label={`Join ${e.title}`}>Join</a>}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
          <section className="card home-card" aria-label="Tasks for today" {...cardProps('tasks')}>
            <h2><Link to="/tasks/myday"><Icon name="check" size={18} /> Tasks for today</Link></h2>
            {!data.due.length ? <p className="muted small">Nothing in My Day or due today. 🎉</p> : (
              <ul className="home-list">
                {data.due.slice(0, 8).map((t) => {
                  const d = t.due ? dueLabel(t.due, new Date(), t.due_time) : null;
                  return (
                    <li key={t.id}>
                      <input type="checkbox" aria-label={`Done: ${t.title}`} onChange={() => tickOff(t)} />
                      <Link className="grow home-item" to={`/tasks/${t.list_id}?task=${t.id}`}>{t.my_day && <span className="home-sun" title="In My Day" aria-label="In My Day">☀ </span>}{t.title}</Link>
                      {d && <span className={`pill due ${d.tone}`}>{d.text}</span>}
                    </li>
                  );
                })}
                {data.due.length > 8 && <li className="muted small">and {data.due.length - 8} more</li>}
              </ul>
            )}
          </section>
          <section className="card home-card" aria-label="Unread" {...cardProps('unread')}>
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
            <section className="card home-card" aria-label="Waiting for your approval" {...cardProps('approvals')}>
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
          {(data.away.out.length > 0 || data.away.holiday || data.away.waiting > 0) && (
            <section className="card home-card" aria-label="Who's out" {...cardProps('out')}>
              <h2><Link to="/calendar?timeoff=1">🏖 Who's out</Link></h2>
              <ul className="home-list">
                {data.away.waiting > 0 && <li><Link className="grow home-item" to="/calendar?timeoff=1"><strong>{data.away.waiting} time-off request{data.away.waiting === 1 ? '' : 's'} waiting for your answer</strong></Link></li>}
                {data.away.out.map((p) => (
                  <li key={p.user_id}><Avatar name={p.name} userId={p.user_id} size={20} /><span className="grow home-item">{p.name}</span>
                    <span className="muted small nowrap">{p.half ? `${p.half === 'am' ? 'morning' : 'afternoon'} off` : p.back ? `back ${dayText(p.back)}` : `out until ${dayText(p.until)}`}</span></li>
                ))}
                {data.away.out.length === 0 && data.away.waiting === 0 && <li className="muted small">Everyone's in today.</li>}
                {data.away.holiday && <li className="small">🏳 {data.away.holiday.date === localToday() ? 'Today' : dayText(data.away.holiday.date)}: {data.away.holiday.name}</li>}
              </ul>
            </section>
          )}
          {data.signing?.length > 0 && (
            <section className="card home-card" aria-label="Waiting for your signature" {...cardProps('signing')}>
              <h2><Link to="/drive/signatures">✍️ Waiting for your signature</Link></h2>
              <ul className="home-list">
                {data.signing.slice(0, 6).map((s) => (
                  <li key={s.id}><Icon name="doc" size={16} />
                    <a className="grow home-item" href={s.link}>{s.title}</a>
                    <span className="muted small nowrap">{s.requested_by?.name}</span></li>
                ))}
              </ul>
            </section>
          )}
          {data.apps.length > 0 && (
            <section className="card home-card" aria-label="Company apps" {...cardProps('apps')}>
              <h2><Icon name="apps" size={18} /> Company apps</h2>
              <ul className="home-apps">
                {data.apps.map((a) => (
                  <li key={a.id}><a href={a.url} target="_blank" rel="noopener noreferrer" title={`Open ${a.name} (you sign in with Workspace)`}>
                    <span className="home-app-icon" aria-hidden="true">{a.name.trim()[0]?.toUpperCase()}</span><span className="ellipsis">{a.name}</span></a></li>
                ))}
              </ul>
            </section>
          )}
          <section className="card home-card" aria-label="Recent files" {...cardProps('recent')}>
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
          {data.dates.length > 0 && (
            <section className="card home-card" aria-label="Birthdays and dates" {...cardProps('dates')}>
              <h2><Link to="/contacts"><span aria-hidden="true">🎂</span> Birthdays and dates</Link></h2>
              <ul className="home-list home-dates">
                {data.dates.map((b) => (
                  <li key={b.key} className={b.today ? 'today' : ''}>
                    <span className={`nowrap small ${b.today ? 'home-date-today' : 'muted'}`}>{b.when}</span>
                    <span className="grow ellipsis"><strong>{b.name}</strong> <span className="muted small">{b.what}</span></span>
                    {b.email && mail?.enabled && <button type="button" className="btn small" aria-label={`Email ${b.name}`} title={`Write to ${b.email}`} onClick={() => navigate(`/mail?compose=${encodeURIComponent(b.email)}`)}>✉ Email</button>}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {data.office.length > 0 && (
            <section className="card home-card" aria-label="In the office today" {...cardProps('office')}>
              <h2><Link to="/contacts?tab=dir"><span aria-hidden="true">🏢</span> In the office today</Link></h2>
              <p className="muted small" style={{ margin: '0 0 8px' }}>{data.where?.place === 'office' ? `You’ll see ${data.office.length === 1 ? 'one colleague' : `${data.office.length} colleagues`} there.` : `${data.office.length === 1 ? 'One colleague is' : `${data.office.length} colleagues are`} in today.`}</p>
              <ul className="home-office" aria-label="Colleagues in the office">
                {data.office.slice(0, 12).map((u) => <li key={u.id} title={u.name}><Avatar name={u.name} userId={u.id} size={28} /><span className="ellipsis small">{u.name}</span></li>)}
              </ul>
              {data.office.length > 12 && <Link className="small" to="/contacts?tab=dir">and {data.office.length - 12} more</Link>}
            </section>
          )}
          {data.touch.length > 0 && (
            <section className="card home-card" aria-label="Keep in touch" {...cardProps('touch')}>
              <h2><Link to="/contacts?tab=touch"><span aria-hidden="true">🤝</span> Keep in touch</Link></h2>
              <ul className="home-list">
                {data.touch.map((c) => (
                  <li key={c.id}>
                    <span className="grow ellipsis"><strong>{c.name}</strong> <span className="muted small">last in touch {sinceText(c.last_contact)}</span></span>
                    {c.email && mail?.enabled && <button type="button" className="btn small" aria-label={`Email ${c.name}`} onClick={() => navigate(`/mail?compose=${encodeURIComponent(c.email)}`)}>✉ Email</button>}
                    <button type="button" className="btn small" aria-label={`In touch with ${c.name}`} title="You've talked another way: start the clock again"
                      onClick={async () => { try { await post(`/contacts/${c.id}/contacted`, {}); load(); } catch (e) { toast(e.message, 'error'); } }}>✓</button>
                  </li>
                ))}
              </ul>
              {data.touchMore > 0 && <Link className="small" to="/contacts?tab=touch">and {data.touchMore} more</Link>}
            </section>
          )}
          {data.notes.length > 0 && (
            <section className="card home-card" aria-label="Pinned notes" {...cardProps('notes')}>
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
      {customizing && <CustomizeHome layout={layout} onChange={saveLayout} onClose={() => setCustomizing(false)} />}
    </div>
  );
}

/** Tick the cards to show on Home, and move them up or down. */
function CustomizeHome({ layout, onChange, onClose }) {
  const move = (i, d) => { const order = [...layout.order]; [order[i], order[i + d]] = [order[i + d], order[i]]; onChange({ ...layout, order }); };
  const shownCount = layout.order.length - layout.hidden.length;
  return (
    <Modal title="Customize Home" onClose={onClose}
      footer={<><button type="button" className="btn" onClick={() => onChange({ ...DEFAULT_LAYOUT, reset: true })}>Reset</button><button type="button" className="btn primary" onClick={onClose}>Done</button></>}>
      <p className="muted small" style={{ marginTop: 0 }}>Choose what Home shows, and in what order. Some cards only appear when there's something in them.</p>
      <ul className="customize-cards">
        {layout.order.map((key, i) => {
          const on = !layout.hidden.includes(key);
          return (
            <li key={key}>
              <label className="check grow"><input type="checkbox" checked={on} disabled={on && shownCount === 1}
                onChange={() => onChange({ ...layout, hidden: on ? [...layout.hidden, key] : layout.hidden.filter((k) => k !== key) })} /> {CARD_NAMES[key]}</label>
              <button type="button" className="icon-btn" aria-label={`Move ${CARD_NAMES[key]} up`} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
              <button type="button" className="icon-btn" aria-label={`Move ${CARD_NAMES[key]} down`} disabled={i === layout.order.length - 1} onClick={() => move(i, 1)}>↓</button>
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}

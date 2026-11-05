import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { get, post, patch, del } from '../../api.js';
import Icon from '../../components/Icon.jsx';
import { Modal, useToast } from '../../components/ui.jsx';
import { DAY, VIEWS, startOfDay, visibleDays, shift, title, onDay, layoutDay } from './calmath.js';

const COLORS = ['#1a73e8', '#0b8043', '#d50000', '#f4511e', '#8e24aa', '#616161'];
const HOUR_PX = 48; // height of one hour in the week/day grid
const pad = (n) => String(n).padStart(2, '0');
const toDateInput = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const toTimeInput = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fromInputs = (date, time = '00:00') => new Date(`${date}T${time}`).getTime();
const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const VIEW_NAMES = { month: 'Month', week: 'Week', day: 'Day' };
const savedView = () => { try { return VIEWS.includes(localStorage.getItem('nw.calView')) ? localStorage.getItem('nw.calView') : 'month'; } catch { return 'month'; } };

export default function Calendar() {
  const toast = useToast();
  const [view, setViewState] = useState(savedView);
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const [events, setEvents] = useState([]);
  const [editing, setEditing] = useState(null);
  const setView = (v) => { setViewState(v); try { localStorage.setItem('nw.calView', v); } catch { /* private window */ } };

  const days = useMemo(() => visibleDays(view, anchor), [view, anchor]);
  // The upcoming list (next 30 days) doesn't depend on the period on screen.
  const [upcomingList, setUpcoming] = useState([]);
  const load = useCallback(() => {
    const from = days[0].getTime();
    const to = days[days.length - 1].getTime() + DAY;
    get(`/events?from=${from}&to=${to}`).then(setEvents).catch((e) => toast(e.message, 'error'));
    const now = Date.now();
    get(`/events?from=${now}&to=${now + 30 * DAY}`).then(setUpcoming).catch(() => {});
  }, [days, toast]);
  useEffect(load, [load]);

  const today = startOfDay(new Date()).getTime();
  const upcoming = upcomingList.filter((e) => e.end >= Date.now()).slice(0, 8);
  const unit = view === 'day' ? 'day' : view === 'week' ? 'week' : 'month';

  function newEvent(day, minutes) {
    const base = day ? new Date(day) : new Date();
    const start = day
      ? new Date(base.getFullYear(), base.getMonth(), base.getDate(), 0, minutes ?? 9 * 60)
      : new Date(Math.ceil(Date.now() / 18e5) * 18e5);
    setEditing({ title: '', start: start.getTime(), end: start.getTime() + 36e5, all_day: 0, color: COLORS[0], location: '', description: '' });
  }
  const openDay = (d) => { setAnchor(startOfDay(d)); setView('day'); };

  // Arrow keys move between periods in the week and day views (when nothing else has focus).
  useEffect(() => {
    const onKey = (e) => {
      if (editing || view === 'month' || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.target !== document.body && !e.target.closest?.('.timegrid')) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); setAnchor((a) => shift(view, a, e.key === 'ArrowLeft' ? -1 : 1)); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view, editing]);

  return (
    <div className="calendar">
      <aside className="subnav">
        <button className="btn new-btn" onClick={() => newEvent()}><Icon name="plus" /> Create</button>
        <h3 className="subnav-title">Upcoming</h3>
        {upcoming.length === 0 && <p className="muted small">Nothing scheduled</p>}
        {upcoming.map((e) => (
          <button key={e.id} className="upcoming" onClick={() => setEditing(e)}>
            <span className="dot" style={{ background: e.color || COLORS[0] }} />
            <span>
              <strong>{e.title}</strong>
              <span className="muted small">{new Date(e.start).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}{!e.all_day && ` · ${fmtTime(e.start)}`}</span>
            </span>
          </button>
        ))}
      </aside>
      <section className="cal-main">
        <div className="cal-head">
          <button className="btn" onClick={() => setAnchor(startOfDay(new Date()))}>Today</button>
          <button className="icon-btn" aria-label={`Previous ${unit}`} onClick={() => setAnchor(shift(view, anchor, -1))}><Icon name="left" /></button>
          <button className="icon-btn" aria-label={`Next ${unit}`} onClick={() => setAnchor(shift(view, anchor, 1))}><Icon name="right" /></button>
          <h1 aria-live="polite">{title(view, anchor)}</h1>
          <div className="grow" />
          <div className="seg" role="radiogroup" aria-label="View">
            {VIEWS.map((v) => <button key={v} type="button" role="radio" aria-checked={view === v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>{VIEW_NAMES[v]}</button>)}
          </div>
        </div>
        {view === 'month' ? (
          <div className="month">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => <div key={d} className="dow">{d}</div>)}
            {days.map((d) => {
              const list = onDay(events, d).sort((a, b) => b.all_day - a.all_day || a.start - b.start);
              return (
                <div key={d.toISOString()} className={`day ${d.getMonth() !== anchor.getMonth() ? 'other' : ''} ${d.getTime() === today ? 'today' : ''}`}
                  onClick={(e) => e.target === e.currentTarget && newEvent(d)}>
                  <button type="button" className="daynum" aria-label={`Open ${d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}`} onClick={() => openDay(d)}>{d.getDate()}</button>
                  {list.slice(0, 3).map((ev) => (
                    <button key={ev.id} className={`chip ${ev.all_day ? 'allday' : ''}`} style={{ '--c': ev.color || COLORS[0] }} onClick={() => setEditing(ev)}>
                      {!ev.all_day && <span className="t">{fmtTime(ev.start)}</span>} {ev.title}
                    </button>
                  ))}
                  {list.length > 3 && <button type="button" className="more small muted link-btn" onClick={() => openDay(d)}>+{list.length - 3} more</button>}
                </div>
              );
            })}
          </div>
        ) : (
          <TimeGrid days={days} events={events} today={today} onOpen={setEditing} onNew={newEvent} onDay={view === 'week' ? openDay : null} />
        )}
      </section>
      {editing && <EventDialog event={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </div>
  );
}

/** Week / day view: an all-day row, then hours with timed events placed by their real times. */
function TimeGrid({ days, events, today, onOpen, onNew, onDay: openDay }) {
  const scroller = useRef();
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 60e3); return () => clearInterval(t); }, []);
  // Start scrolled to the working day (or to now, when today is shown and it's later).
  const showsToday = days.some((d) => d.getTime() === today);
  useEffect(() => {
    const minutes = showsToday ? Math.max(7 * 60, (Date.now() - today) / 6e4 - 60) : 7 * 60;
    if (scroller.current) scroller.current.scrollTop = (minutes / 60) * HOUR_PX;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days[0].getTime(), days.length]);
  const cols = { gridTemplateColumns: `56px repeat(${days.length}, minmax(0, 1fr))` };
  const dayLabel = (d) => d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });

  return (
    <div className="timegrid" data-days={days.length}>
      <div className="tg-head" style={cols}>
        <div />
        {days.map((d) => {
          const isToday = d.getTime() === today;
          const inner = <><span className="tg-dow">{d.toLocaleDateString([], { weekday: 'short' })}</span><span className={`tg-num ${isToday ? 'today' : ''}`}>{d.getDate()}</span></>;
          return openDay
            ? <button key={d.getTime()} type="button" className="tg-day" aria-label={`Open ${dayLabel(d)}`} onClick={() => openDay(d)}>{inner}</button>
            : <div key={d.getTime()} className="tg-day">{inner}</div>;
        })}
      </div>
      <div className="tg-allday" style={cols}>
        <div className="tg-gutter small muted">all day</div>
        {days.map((d) => (
          <div key={d.getTime()} className="tg-allday-cell">
            {onDay(events, d).filter((ev) => ev.all_day).map((ev) => (
              <button key={ev.id} className="chip allday" style={{ '--c': ev.color || COLORS[0] }} onClick={() => onOpen(ev)}>{ev.title}</button>
            ))}
          </div>
        ))}
      </div>
      <div className="tg-scroll" ref={scroller}>
        <div className="tg-body" style={{ ...cols, height: 24 * HOUR_PX }}>
          <div className="tg-hours">
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} className="tg-hour small muted" style={{ top: h * HOUR_PX }}>{h ? new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' }) : ''}</div>
            ))}
          </div>
          {days.map((d) => (
            <div key={d.getTime()} className={`tg-col ${d.getTime() === today ? 'today' : ''}`} aria-label={dayLabel(d)} role="group"
              onClick={(e) => {
                if (e.target !== e.currentTarget) return;
                const y = e.clientY - e.currentTarget.getBoundingClientRect().top;
                onNew(d, Math.min(23 * 60 + 30, Math.floor(y / HOUR_PX * 2) * 30)); // the half hour clicked
              }}>
              {layoutDay(events, d).map(({ ev, top, height, col, cols: n }) => (
                <button key={ev.id} className="tg-event" title={`${ev.title} · ${fmtTime(ev.start)} – ${fmtTime(ev.end)}`}
                  style={{ '--c': ev.color || COLORS[0], top: (top / 60) * HOUR_PX, height: (height / 60) * HOUR_PX - 2, left: `calc(${(col / n) * 100}% + 2px)`, width: `calc(${100 / n}% - 4px)` }}
                  onClick={() => onOpen(ev)}>
                  <strong>{ev.title}</strong>
                  {height >= 40 && <span>{fmtTime(ev.start)} – {fmtTime(ev.end)}</span>}
                  {height >= 60 && ev.location && <span>{ev.location}</span>}
                </button>
              ))}
              {d.getTime() === today && now >= today && now < today + DAY && (
                <div className="tg-now" style={{ top: ((now - today) / 36e5) * HOUR_PX }} aria-hidden="true" />
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function EventDialog({ event, onClose, onSaved }) {
  const toast = useToast();
  const [f, setF] = useState({
    title: event.title, location: event.location || '', description: event.description || '', color: event.color || COLORS[0],
    all_day: !!event.all_day,
    startDate: toDateInput(event.start), startTime: toTimeInput(event.start),
    endDate: toDateInput(event.end), endTime: toTimeInput(event.end),
  });
  const [error, setError] = useState('');
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  async function submit(e) {
    e.preventDefault();
    const start = f.all_day ? fromInputs(f.startDate) : fromInputs(f.startDate, f.startTime);
    const end = f.all_day ? fromInputs(f.endDate) + DAY - 1 : fromInputs(f.endDate, f.endTime);
    if (end < start) return setError('The event ends before it starts');
    const body = { title: f.title, location: f.location, description: f.description, color: f.color, all_day: f.all_day, start, end };
    try {
      if (event.id) await patch(`/events/${event.id}`, body); else await post('/events', body);
      onSaved();
    } catch (err) { setError(err.message); }
  }

  return (
    <Modal title={event.id ? 'Edit event' : 'New event'} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <label className="field"><span>Title</span><input autoFocus required value={f.title} onChange={set('title')} /></label>
        <label className="check"><input type="checkbox" checked={f.all_day} onChange={set('all_day')} /> All day</label>
        <div className="row wrap">
          <label className="field"><span>Starts</span><input type="date" required value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value, endDate: e.target.value > f.endDate ? e.target.value : f.endDate })} /></label>
          {!f.all_day && <label className="field"><span>&nbsp;</span><input type="time" required value={f.startTime} onChange={set('startTime')} aria-label="Start time" /></label>}
        </div>
        <div className="row wrap">
          <label className="field"><span>Ends</span><input type="date" required value={f.endDate} onChange={set('endDate')} /></label>
          {!f.all_day && <label className="field"><span>&nbsp;</span><input type="time" required value={f.endTime} onChange={set('endTime')} aria-label="End time" /></label>}
        </div>
        <label className="field"><span>Location</span><input value={f.location} onChange={set('location')} /></label>
        <label className="field"><span>Description</span><textarea rows={3} value={f.description} onChange={set('description')} /></label>
        <div className="colors" role="radiogroup" aria-label="Color">
          {COLORS.map((c) => (
            <button type="button" key={c} role="radio" aria-checked={f.color === c} aria-label={c} className={`swatch ${f.color === c ? 'on' : ''}`} style={{ background: c }} onClick={() => setF({ ...f, color: c })} />
          ))}
        </div>
        {error && <p className="error">{error}</p>}
        <div className="row">
          {event.id && <button type="button" className="btn danger" onClick={async () => {
            try { await del(`/events/${event.id}`); onSaved(); } catch (err) { toast(err.message, 'error'); }
          }}>Delete</button>}
          <div className="grow" />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary">Save</button>
        </div>
      </form>
    </Modal>
  );
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import { get, post, patch, del } from '../../api.js';
import Icon from '../../components/Icon.jsx';
import { Modal, useToast } from '../../components/ui.jsx';

const COLORS = ['#1a73e8', '#0b8043', '#d50000', '#f4511e', '#8e24aa', '#616161'];
const DAY = 864e5;

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const pad = (n) => String(n).padStart(2, '0');
const toDateInput = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const toTimeInput = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fromInputs = (date, time = '00:00') => new Date(`${date}T${time}`).getTime();
const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export default function Calendar() {
  const toast = useToast();
  const [cursor, setCursor] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [events, setEvents] = useState([]);
  const [editing, setEditing] = useState(null);

  // 6-week grid starting on the Sunday on/before the 1st.
  const days = useMemo(() => {
    const first = new Date(cursor);
    first.setDate(1 - first.getDay());
    return Array.from({ length: 42 }, (_, i) => new Date(first.getFullYear(), first.getMonth(), first.getDate() + i));
  }, [cursor]);

  const load = useCallback(() => {
    const from = days[0].getTime();
    const to = days[41].getTime() + DAY;
    get(`/events?from=${from}&to=${to}`).then(setEvents).catch((e) => toast(e.message, 'error'));
  }, [days, toast]);
  useEffect(load, [load]);

  const today = startOfDay(new Date()).getTime();
  const eventsOn = (d) => {
    const s = d.getTime(), e = s + DAY;
    return events.filter((ev) => ev.start < e && (ev.end > s || (ev.end === ev.start && ev.start >= s)))
      .sort((a, b) => b.all_day - a.all_day || a.start - b.start);
  };
  const upcoming = events.filter((e) => e.end >= Date.now()).slice(0, 8);

  function newEvent(day) {
    const base = day ? new Date(day) : new Date();
    const start = day ? new Date(base.getFullYear(), base.getMonth(), base.getDate(), 9) : new Date(Math.ceil(Date.now() / 18e5) * 18e5);
    setEditing({ title: '', start: start.getTime(), end: start.getTime() + 36e5, all_day: 0, color: COLORS[0], location: '', description: '' });
  }

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
          <button className="btn" onClick={() => { const d = new Date(); setCursor(new Date(d.getFullYear(), d.getMonth(), 1)); }}>Today</button>
          <button className="icon-btn" aria-label="Previous month" onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}><Icon name="left" /></button>
          <button className="icon-btn" aria-label="Next month" onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}><Icon name="right" /></button>
          <h1>{cursor.toLocaleDateString([], { month: 'long', year: 'numeric' })}</h1>
        </div>
        <div className="month">
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => <div key={d} className="dow">{d}</div>)}
          {days.map((d) => {
            const list = eventsOn(d);
            return (
              <div key={d.toISOString()} className={`day ${d.getMonth() !== cursor.getMonth() ? 'other' : ''} ${d.getTime() === today ? 'today' : ''}`}
                onClick={(e) => e.target === e.currentTarget && newEvent(d)}>
                <span className="daynum" onClick={() => newEvent(d)}>{d.getDate()}</span>
                {list.slice(0, 3).map((ev) => (
                  <button key={ev.id} className={`chip ${ev.all_day ? 'allday' : ''}`} style={{ '--c': ev.color || COLORS[0] }} onClick={() => setEditing(ev)}>
                    {!ev.all_day && <span className="t">{fmtTime(ev.start)}</span>} {ev.title}
                  </button>
                ))}
                {list.length > 3 && <span className="more small muted">+{list.length - 3} more</span>}
              </div>
            );
          })}
        </div>
      </section>
      {editing && <EventDialog event={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
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

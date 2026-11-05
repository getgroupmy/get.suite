import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { get, post, patch, del, onLive } from '../../api.js';
import Icon from '../../components/Icon.jsx';
import { Modal, useToast } from '../../components/ui.jsx';
import { DAY, VIEWS, startOfDay, visibleDays, shift, title, onDay, layoutDay, expandAll, occurrenceIndex, describeRule } from './calmath.js';

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
    // Repeating events come back once; each occurrence is worked out here, in local time.
    get(`/events?from=${from}&to=${to}`).then((list) => setEvents(expandAll(list, from, to))).catch((e) => toast(e.message, 'error'));
    const now = Date.now();
    get(`/events?from=${now}&to=${now + 30 * DAY}`).then((list) => setUpcoming(expandAll(list, now, now + 30 * DAY))).catch(() => {});
  }, [days, toast]);
  useEffect(load, [load]);
  // Someone changed an event you organise or are invited to.
  useEffect(() => onLive((m) => { if (m.type === 'events-changed') load(); }), [load]);

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
          <button key={e.key || e.id} className="upcoming" onClick={() => setEditing(e)}>
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
                    <button key={ev.key || ev.id} className={`chip ${ev.all_day ? 'allday' : ''} ${inviteClass(ev)}`} style={{ '--c': ev.color || COLORS[0] }} onClick={() => setEditing(ev)}>
                      {!ev.all_day && <span className="t">{fmtTime(ev.start)}</span>} {ev.title}{ev.rrule && <span className="rep" aria-label="(repeats)" title="Repeats"> ↻</span>}
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
      {editing && (editing.role === 'guest'
        ? <InvitationDialog event={editing} onClose={() => setEditing(null)} onAnswered={() => { setEditing(null); load(); }} />
        : <EventDialog event={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />)}
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
              <button key={ev.key || ev.id} className={`chip allday ${inviteClass(ev)}`} style={{ '--c': ev.color || COLORS[0] }} onClick={() => onOpen(ev)}>{ev.title}{ev.rrule && <span aria-label="(repeats)"> ↻</span>}</button>
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
                <button key={ev.key || ev.id} className={`tg-event ${inviteClass(ev)}`} title={`${ev.title} · ${fmtTime(ev.start)} – ${fmtTime(ev.end)}${ev.rrule ? ' · repeats' : ''}`}
                  style={{ '--c': ev.color || COLORS[0], top: (top / 60) * HOUR_PX, height: (height / 60) * HOUR_PX - 2, left: `calc(${(col / n) * 100}% + 2px)`, width: `calc(${100 / n}% - 4px)` }}
                  onClick={() => onOpen(ev)}>
                  <strong>{ev.title}{ev.rrule && <span aria-label="(repeats)"> ↻</span>}</strong>
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

// Invitations you haven't answered look tentative; declined ones are faded.
const inviteClass = (ev) => (ev.role !== 'guest' ? '' : ev.my_status === 'no' ? 'declined' : ev.my_status === 'yes' ? '' : 'tentative');
const ANSWER_LABELS = { yes: 'Yes', maybe: 'Maybe', no: 'No', needs: 'Not answered' };
const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; } })();
const whenLabel = (ev) => {
  const d = new Date(ev.start).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return ev.all_day ? `${d}, all day` : `${d}, ${fmtTime(ev.start)} – ${fmtTime(ev.end)}`;
};

/** An event you're invited to: details, who's coming, and your answer. */
function InvitationDialog({ event, onClose, onAnswered }) {
  const toast = useToast();
  const answer = async (status) => {
    try { await post(`/events/${event.id}/rsvp`, { status }); toast(`Answered ${ANSWER_LABELS[status]}`); onAnswered(); } catch (e) { toast(e.message, 'error'); }
  };
  return (
    <Modal title={event.title} onClose={onClose}>
      <div className="stack">
        <p style={{ margin: 0 }}>{whenLabel(event)}{event.rrule && <><br /><span className="muted small">{describeRule(event.rrule, event.seriesStart ?? event.start)}</span></>}</p>
        {event.location && <p style={{ margin: 0 }}><span className="muted">Where:</span> {event.location}</p>}
        {event.description && <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{event.description}</p>}
        <p style={{ margin: 0 }}><span className="muted">Organizer:</span> {event.organizer?.name} <span className="muted small">{event.organizer?.email}</span></p>
        <GuestList guests={event.guests} />
        <div className="stack" style={{ gap: 6 }}>
          <span className="muted small">Going?{event.rrule ? ' (for the whole series)' : ''}</span>
          <div className="row" role="group" aria-label="Your answer">
            {['yes', 'maybe', 'no'].map((s) => (
              <button key={s} type="button" className={`btn ${event.my_status === s ? 'primary' : ''}`} aria-pressed={event.my_status === s} onClick={() => answer(s)}>{ANSWER_LABELS[s]}</button>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}

function GuestList({ guests }) {
  if (!guests?.length) return null;
  const counts = ['yes', 'maybe', 'no', 'needs'].map((s) => [s, guests.filter((g) => g.status === s).length]).filter(([, n]) => n);
  return (
    <div className="stack" style={{ gap: 4 }}>
      <span className="muted small">{guests.length} guest{guests.length === 1 ? '' : 's'}: {counts.map(([s, n]) => `${n} ${ANSWER_LABELS[s].toLowerCase()}`).join(', ')}</span>
      <ul className="guest-list" aria-label="Guests">
        {guests.map((g) => <li key={g.email}><span className={`rsvp ${g.status}`} aria-hidden="true" />{g.name} <span className="muted small">{g.email} · {ANSWER_LABELS[g.status]}</span></li>)}
      </ul>
    </div>
  );
}

const WEEKDAY_LETTERS = Array.from({ length: 7 }, (_, d) => new Date(2026, 10, 1 + d)); // a Sunday-first week
const ruleFromForm = (r, start) => {
  if (r.freq === 'none') return null;
  const out = { freq: r.freq };
  if (Number(r.interval) > 1) out.interval = Number(r.interval);
  if (r.freq === 'weekly') out.byday = r.byday.length ? r.byday : [new Date(start).getDay()];
  if (r.ends === 'on' && r.until) out.until = fromInputs(r.until, '23:59') + 59999;
  if (r.ends === 'after') out.count = Math.max(1, Math.min(999, Number(r.count) || 1));
  return out;
};

function EventDialog({ event, onClose, onSaved }) {
  const toast = useToast();
  const recurring = !!(event.id && event.rrule);
  const [f, setF] = useState({
    title: event.title, location: event.location || '', description: event.description || '', color: event.color || COLORS[0],
    all_day: !!event.all_day,
    startDate: toDateInput(event.start), startTime: toTimeInput(event.start),
    endDate: toDateInput(event.end), endTime: toTimeInput(event.end),
  });
  const r0 = event.rrule;
  const [rep, setRep] = useState({
    freq: r0?.freq || 'none', interval: r0?.interval || 1, byday: r0?.byday || [new Date(event.start).getDay()],
    ends: r0?.until !== undefined ? 'on' : r0?.count ? 'after' : 'never',
    until: r0?.until !== undefined ? toDateInput(r0.until) : toDateInput(event.start + 30 * DAY), count: r0?.count || 10,
  });
  const [guests, setGuests] = useState((event.guests || []).map((g) => g.email));
  const [guestInput, setGuestInput] = useState('');
  const [directory, setDirectory] = useState([]);
  useEffect(() => { get('/users/directory').then(setDirectory).catch(() => {}); }, []);
  const addGuests = (text) => {
    const found = String(text).split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter((x) => x.includes('@'));
    if (found.length) setGuests((g) => [...new Set([...g, ...found])]);
    setGuestInput('');
  };
  const [scopeFor, setScopeFor] = useState(null); // 'save' | 'delete': asking which occurrences
  const [scope, setScope] = useState('this');
  const [error, setError] = useState('');
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const setR = (k) => (e) => setRep({ ...rep, [k]: e.target.value });

  const read = () => {
    const start = f.all_day ? fromInputs(f.startDate) : fromInputs(f.startDate, f.startTime);
    const end = f.all_day ? fromInputs(f.endDate) + DAY - 1 : fromInputs(f.endDate, f.endTime);
    const all = guestInput.trim() ? [...new Set([...guests, ...guestInput.split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter((x) => x.includes('@'))])] : guests;
    return { start, end, body: { title: f.title, location: f.location, description: f.description, color: f.color, all_day: f.all_day, start, end, rrule: ruleFromForm(rep, start), guests: all, tz: TZ } };
  };

  async function save(which) {
    const { start, end, body } = read();
    if (end < start) return setError('The event ends before it starts');
    if (!event.id) { await post('/events', body); return onSaved(); }
    if (!recurring || which === 'all' || (which === 'following' && event.occurrence === event.seriesStart)) {
      if (!recurring) { await patch(`/events/${event.id}`, body); return onSaved(); }
      // The whole series moves by as much as this occurrence was moved.
      const delta = start - event.occurrence;
      await patch(`/events/${event.id}`, { ...body, start: event.seriesStart + delta, end: event.seriesStart + delta + (end - start) });
      return onSaved();
    }
    if (which === 'this') {
      // Skip this date in the series and put a one-off event in its place.
      await patch(`/events/${event.id}`, { exdates: [...(event.exdates || []), event.occurrence] });
      await post('/events', { ...body, rrule: null });
      return onSaved();
    }
    // This and following: end the series the day before, and start a new one here.
    const old = event.rrule;
    let rule = body.rrule;
    if (rule?.count && old.count && rule.count === old.count) rule = { ...rule, count: Math.max(1, old.count - occurrenceIndex(event, event.occurrence)) };
    await patch(`/events/${event.id}`, { rrule: { ...Object.fromEntries(Object.entries(old).filter(([k]) => k !== 'count')), until: event.occurrence - 1 } });
    await post('/events', { ...body, rrule: rule });
    onSaved();
  }
  async function remove(which) {
    if (!recurring || which === 'all' || (which === 'following' && event.occurrence === event.seriesStart)) await del(`/events/${event.id}?tz=${encodeURIComponent(TZ)}`);
    else if (which === 'this') await patch(`/events/${event.id}`, { exdates: [...(event.exdates || []), event.occurrence] });
    else await patch(`/events/${event.id}`, { rrule: { ...Object.fromEntries(Object.entries(event.rrule).filter(([k]) => k !== 'count')), until: event.occurrence - 1 } });
    onSaved();
  }
  const run = (fn) => async (...a) => { setError(''); try { await fn(...a); } catch (err) { setError(err.message); toast(err.message, 'error'); } };
  const submit = (e) => { e.preventDefault(); if (recurring) setScopeFor('save'); else run(save)(); };

  if (scopeFor) {
    return (
      <Modal title={scopeFor === 'save' ? 'Change repeating event' : 'Delete repeating event'} onClose={() => setScopeFor(null)}>
        <form className="stack" onSubmit={(e) => { e.preventDefault(); run(scopeFor === 'save' ? save : remove)(scope); }}>
          <div className="stack" role="radiogroup" aria-label="Which events">
            {[['this', 'This event'], ['following', 'This and following events'], ['all', 'All events']].map(([v, label]) => (
              <label key={v} className="check"><input type="radio" name="scope" checked={scope === v} onChange={() => setScope(v)} /> {label}</label>
            ))}
          </div>
          {error && <p className="error">{error}</p>}
          <div className="row end">
            <button type="button" className="btn" onClick={() => setScopeFor(null)}>Cancel</button>
            <button className={`btn ${scopeFor === 'delete' ? 'danger' : 'primary'}`}>{scopeFor === 'save' ? 'Save' : 'Delete'}</button>
          </div>
        </form>
      </Modal>
    );
  }

  const ruleNow = ruleFromForm(rep, read().start);
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
        <div className="repeat-box stack">
          <div className="row wrap">
            <label className="field"><span>Repeat</span>
              <select value={rep.freq} onChange={setR('freq')} aria-label="Repeat">
                <option value="none">Does not repeat</option><option value="daily">Daily</option><option value="weekly">Weekly</option>
                <option value="monthly">Monthly (same date)</option><option value="yearly">Yearly</option>
              </select></label>
            {rep.freq !== 'none' && <label className="field"><span>Every</span>
              <input type="number" min="1" max="99" value={rep.interval} onChange={setR('interval')} aria-label="Repeat every" style={{ width: 80 }} /></label>}
          </div>
          {rep.freq === 'weekly' && (
            <div className="weekdays" role="group" aria-label="On these days">
              {WEEKDAY_LETTERS.map((d, i) => {
                const on = rep.byday.includes(i);
                return <button key={i} type="button" className={`wd ${on ? 'on' : ''}`} aria-pressed={on} aria-label={d.toLocaleDateString([], { weekday: 'long' })}
                  onClick={() => setRep({ ...rep, byday: on ? rep.byday.filter((x) => x !== i) : [...rep.byday, i].sort() })}>{d.toLocaleDateString([], { weekday: 'narrow' })}</button>;
              })}
            </div>
          )}
          {rep.freq !== 'none' && (
            <div className="row wrap" role="radiogroup" aria-label="Ends">
              <label className="check"><input type="radio" name="ends" checked={rep.ends === 'never'} onChange={() => setRep({ ...rep, ends: 'never' })} /> Never ends</label>
              <label className="check"><input type="radio" name="ends" checked={rep.ends === 'on'} onChange={() => setRep({ ...rep, ends: 'on' })} /> Until
                <input type="date" value={rep.until} onChange={setR('until')} aria-label="Repeat until" disabled={rep.ends !== 'on'} /></label>
              <label className="check"><input type="radio" name="ends" checked={rep.ends === 'after'} onChange={() => setRep({ ...rep, ends: 'after' })} /> After
                <input type="number" min="1" max="999" value={rep.count} onChange={setR('count')} aria-label="Number of times" disabled={rep.ends !== 'after'} style={{ width: 70 }} /> times</label>
            </div>
          )}
          {rep.freq !== 'none' && <p className="muted small" aria-live="polite" style={{ margin: 0 }}>{describeRule(ruleNow, read().start)}</p>}
        </div>
        <div className="field">
          <label htmlFor="guest-input"><span>Guests</span></label>
          {event.guests?.length > 0 && (
            <span className="muted small" aria-live="polite">{event.guests.length} guest{event.guests.length === 1 ? '' : 's'}: {
              ['yes', 'maybe', 'no', 'needs'].map((k) => [k, event.guests.filter((g) => g.status === k).length]).filter(([, n]) => n).map(([k, n]) => `${n} ${ANSWER_LABELS[k].toLowerCase()}`).join(', ')}</span>
          )}
          {guests.length > 0 && (
            <ul className="guest-chips" aria-label="Invited guests">
              {guests.map((g) => {
                const known = (event.guests || []).find((x) => x.email === g);
                return <li key={g}>{directory.find((d) => d.username === g)?.name || g}{known && <span className="muted small"> · {ANSWER_LABELS[known.status]}</span>}
                  <button type="button" className="icon-btn" aria-label={`Remove ${g}`} onClick={() => setGuests(guests.filter((x) => x !== g))}>×</button></li>;
              })}
            </ul>
          )}
          <input id="guest-input" list="guest-directory" value={guestInput} placeholder="Add people by email address" autoComplete="off"
            onChange={(e) => { const v = e.target.value; if (/[,;\s]$/.test(v) || directory.some((d) => d.username === v.trim().toLowerCase())) addGuests(v); else setGuestInput(v); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (guestInput.trim()) addGuests(guestInput); } }} /* Enter adds a guest, never saves */ />
          <datalist id="guest-directory">{directory.map((d) => <option key={d.id} value={d.username}>{d.name}</option>)}</datalist>
          {guests.length > 0 && <span className="muted small">They'll see it in their calendar{event.id ? '' : ' and get an email'} and can answer Yes, Maybe or No.</span>}
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
          {event.id && <button type="button" className="btn danger" onClick={() => (recurring ? setScopeFor('delete') : run(remove)())}>Delete</button>}
          <div className="grow" />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary">Save</button>
        </div>
      </form>
    </Modal>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useAuth } from '../../App.jsx';
import { get, post, put, patch, del, onLive, postText } from '../../api.js';
import { localToday } from '../tasks/taskmath.js';
import Icon from '../../components/Icon.jsx';
import DrivePicker, { openUrl } from '../../components/DrivePicker.jsx';
import { Modal, useToast, Empty } from '../../components/ui.jsx';
import { scheduleOf, DAY, VIEWS, startOfDay, visibleDays, shift, title, onDay, layoutDay, expandAll, occurrenceIndex, describeRule, daysBetween, moveTimes, resizeEnd, shiftWeekdays, snapMinutes } from './calmath.js';

const OTHER_COLOURS = ['#e37400', '#8e24aa', '#0b8043', '#d93025', '#00796b', '#3949ab'];
const COLORS = ['#1a73e8', '#0b8043', '#d50000', '#f4511e', '#8e24aa', '#616161'];
const HOUR_PX = 48; // height of one hour in the week/day grid
const pad = (n) => String(n).padStart(2, '0');
const toDateInput = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const toTimeInput = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fromInputs = (date, time = '00:00') => new Date(`${date}T${time}`).getTime();
const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const VIEW_NAMES = { month: 'Month', week: 'Week', day: 'Day', schedule: 'Schedule' };
const savedTasks = () => { try { return localStorage.getItem('nw.calTasks') !== '0'; } catch { return true; } };
/** Open tasks with a due date, as all-day items (they can't be dragged; ticking one off completes it). */
const taskItems = (tasks) => tasks.map((t) => {
  const [y, m, d] = t.due.split('-').map(Number);
  const start = new Date(y, m - 1, d).getTime();
  return { key: `task:${t.id}`, task: t, title: t.title, start, end: start + DAY - 1, all_day: 1 };
});

const savedBirthdays = () => { try { return localStorage.getItem('nw.calBirthdays') !== '0'; } catch { return true; } };
/** Contacts' birthdays as all-day items (with the age they turn, when the year is known). */
const birthdayItems = (list) => list.map((b) => {
  const [y, m, d] = b.date.split('-').map(Number);
  const start = new Date(y, m - 1, d).getTime();
  return { key: `bday:${b.contact_id}:${b.date}`, birthday: b, title: `🎂 ${b.name}${b.age ? ` (${b.age})` : ''}`, start, end: start + DAY - 1, all_day: 1 };
});
function BirthdayChip({ ev }) {
  const navigate = useNavigate();
  return (
    <button type="button" className="chip allday birthday-chip" title={`${ev.birthday.name}'s birthday${ev.birthday.age ? ` · turns ${ev.birthday.age}` : ''}`}
      onClick={(e) => { e.stopPropagation(); navigate(`/contacts?q=${encodeURIComponent(ev.birthday.name)}`); }}>{ev.title}</button>
  );
}

/** A task on the calendar: the box ticks it off, the title opens it in Tasks. */
function TaskChip({ ev, onDone }) {
  const navigate = useNavigate();
  return (
    <div className="chip allday task-chip" title={`Task on ${ev.task.list_name}${ev.task.assignee_name ? ` · for ${ev.task.assignee_name}` : ''}`}>
      <button type="button" className="task-tick" aria-label={`Mark done: ${ev.title}`} onClick={(e) => { e.stopPropagation(); onDone(ev.task); }}>☐</button>
      <button type="button" className="task-open" onClick={(e) => { e.stopPropagation(); navigate(`/tasks/${ev.task.list_id}?task=${ev.task.id}`); }}>{ev.task.due_time ? `${ev.task.due_time} ` : ''}{ev.title}</button>
    </div>
  );
}

const savedView = () => { try { return VIEWS.includes(localStorage.getItem('nw.calView')) ? localStorage.getItem('nw.calView') : 'month'; } catch { return 'month'; } };

export default function Calendar() {
  const toast = useToast();
  const [view, setViewState] = useState(savedView);
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const [events, setEvents] = useState([]);
  const [editing, setEditing] = useState(null);
  // "Create event" on an email comes here with the event to start from.
  const location = useLocation();
  const navigateTo = useNavigate();
  useEffect(() => {
    const ev = location.state?.newEvent;
    if (!ev) return;
    setAnchor(startOfDay(new Date(ev.start)));
    setEditing({ color: COLORS[0], ...ev });
    navigateTo(location.pathname, { replace: true, state: null }); // a reload doesn't open it again
  }, [location.state]); // eslint-disable-line react-hooks/exhaustive-deps
  const [showTasks, setShowTasksState] = useState(savedTasks);
  const [bookingOpen, setBookingOpen] = useState(false);
  const [hoursOpen, setHoursOpen] = useState(false);
  // Import a calendar file from Google Calendar, Outlook or Apple Calendar.
  const importInput = useRef();
  const importIcs = async (file) => {
    if (!file) return;
    try {
      const r = await postText(`/events/import?tz=${encodeURIComponent(TZ)}`, await file.text());
      toast([`${r.added} event${r.added === 1 ? '' : 's'} imported`, r.skipped && `${r.skipped} already here`, r.failed && `${r.failed} couldn’t be read`].filter(Boolean).join(', '));
      load();
    } catch (e) { toast(e.message, 'error'); }
  };

  const [tasks, setTasks] = useState([]);
  const [showBirthdays, setShowBirthdaysState] = useState(savedBirthdays);
  const setShowBirthdays = (on) => { setShowBirthdaysState(on); try { localStorage.setItem('nw.calBirthdays', on ? '1' : '0'); } catch { /* private window */ } };
  const [birthdays, setBirthdays] = useState([]);
  const setShowTasks = (on) => { setShowTasksState(on); try { localStorage.setItem('nw.calTasks', on ? '1' : '0'); } catch { /* private window */ } };
  const setView = (v) => { setViewState(v); try { localStorage.setItem('nw.calView', v); } catch { /* private window */ } };

  const days = useMemo(() => visibleDays(view, anchor), [view, anchor]);
  // Other people's calendars (busy times only), chosen on this device.
  const [others, setOthersState] = useState(() => { try { return JSON.parse(localStorage.getItem('nw.calOthers') || '[]'); } catch { return []; } });
  const setOthers = (list) => { setOthersState(list); try { localStorage.setItem('nw.calOthers', JSON.stringify(list)); } catch { /* private window */ } };
  const [busy, setBusy] = useState([]);
  const { user: me } = useAuth();
  const [people, setPeople] = useState([]);
  useEffect(() => { get('/users/directory').then(setPeople).catch(() => {}); }, []);
  const loadBusy = useCallback(() => {
    if (!others.length) { setBusy([]); return; }
    const from = days[0].getTime(), to = days[days.length - 1].getTime() + DAY;
    const people = others.filter((o) => !o.room), places = others.filter((o) => o.room);
    Promise.all([
      people.length ? get(`/freebusy?users=${people.map((o) => o.id).join(',')}&from=${from}&to=${to}`)
        .then((r) => people.flatMap((o) => (r[o.id]?.busy || []).map((b) => ({ ...b, key: `${o.id}@${b.start}`, name: o.name, color: o.color })))) : [],
      // A room's bookings, with what each is and who booked it.
      ...places.map((o) => get(`/rooms/${o.id}/busy?from=${from}&to=${to}`)
        .then((list) => list.map((b) => ({ ...b, key: `${o.id}@${b.start}`, name: o.name, color: o.color, room: true }))).catch(() => [])),
    ]).then((parts) => setBusy(parts.flat())).catch(() => setBusy([]));
  }, [others, days]);
  const [roomList, setRoomList] = useState([]);
  useEffect(() => { get('/rooms').then(setRoomList).catch(() => {}); }, []);
  useEffect(loadBusy, [loadBusy]);
  useEffect(() => { const t = setInterval(loadBusy, 60e3); return () => clearInterval(t); }, [loadBusy]);
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
  const loadTasks = useCallback(() => {
    if (!showTasks) { setTasks([]); return; }
    const last = new Date(days[days.length - 1]);
    get(`/tasks/due?from=${toDateInput(days[0].getTime())}&to=${toDateInput(last.getTime())}`).then(setTasks).catch(() => setTasks([]));
  }, [days, showTasks]);
  useEffect(loadTasks, [loadTasks]);
  useEffect(() => {
    if (!showBirthdays) { setBirthdays([]); return; }
    const last = new Date(days[days.length - 1]);
    get(`/contacts/birthdays?from=${toDateInput(days[0].getTime())}&to=${toDateInput(last.getTime())}`).then(setBirthdays).catch(() => setBirthdays([]));
  }, [days, showBirthdays]);
  useEffect(() => onLive((m) => { if (m.type === 'tasks-changed') loadTasks(); }), [loadTasks]);
  const taskDone = async (t) => {
    setTasks((list) => list.filter((x) => x.id !== t.id));
    try {
      const done = await patch(`/tasks/tasks/${t.id}`, { done: true, today: localToday() });
      if (done?.next_id) loadTasks(); // a repeating task: the next one shows
      toast(`“${t.title}” done`, 'info', { action: { label: 'Undo', onClick: async () => { await patch(`/tasks/tasks/${t.id}`, { done: false }); loadTasks(); } } });
    } catch (e) { toast(e.message, 'error'); loadTasks(); }
  };

  // Searching: the results replace Upcoming; opening one goes to its day and opens it.
  const [found, setFound] = useState(null); // { q, list }
  const runSearch = async (q) => {
    const text = String(q || '').trim();
    if (!text) { setFound(null); return; }
    try { setFound({ q: text, list: await get(`/events/search?q=${encodeURIComponent(text)}`) }); } catch (e) { toast(e.message, 'error'); }
  };
  const openFound = async (r) => {
    setAnchor(startOfDay(new Date(r.start)));
    try {
      const around = await get(`/events?from=${r.start - 1}&to=${r.end + 1}`);
      const occ = expandAll(around, r.start - 1, r.end + 1).find((x) => x.id === r.id && x.start === r.start);
      if (occ) setEditing(occ);
    } catch { /* the day is shown anyway */ }
  };

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

  // Dragging: drop moves the event at once (repeating ones ask which occurrences first).
  const [pendingMove, setPendingMove] = useState(null); // { ev, start, end }
  async function commitMove(ev, start, end, which) {
    const keyOf = (e) => e.key || e.id;
    if (!ev.rrule) setEvents((list) => list.map((e) => (keyOf(e) === keyOf(ev) ? { ...e, start, end } : e)));
    try {
      const dayDelta = daysBetween(new Date(ev.start), new Date(start));
      const rule = shiftWeekdays(ev.rrule, dayDelta);
      await applyEdit(ev, { start, end, ...(rule !== ev.rrule && { rrule: rule }) }, which);
      toast(start === ev.start ? `Now ends at ${fmtTime(end)}` : `Moved to ${new Date(start).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}${ev.all_day ? '' : `, ${fmtTime(start)}`}`);
    } catch (e) { toast(e.message, 'error'); }
    load();
  }
  const drag = useEventDrag((ev, start, end) => (ev.rrule ? setPendingMove({ ev, start, end }) : commitMove(ev, start, end)));
  const moving = drag.drag || pendingMove;
  const shown = useMemo(() => [...(moving
    ? events.map((e) => ((e.key || e.id) === (moving.ev.key || moving.ev.id) ? { ...e, start: moving.start, end: moving.end, dragging: true } : e))
    : events), ...taskItems(tasks), ...birthdayItems(birthdays)], [events, moving, tasks, birthdays]);

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
        <button type="button" className="subnav-item" onClick={() => { const d = startOfDay(new Date()).getTime(); setEditing({ title: 'Out of office', kind: 'ooo', start: d, end: d + DAY - 1, all_day: 1, color: '#5f6368', location: '', description: '' }); }}><span aria-hidden="true" style={{ width: 24, textAlign: 'center' }}>🌴</span><span className="grow">Out of office…</span></button>
        <button type="button" className="subnav-item" onClick={() => setBookingOpen(true)}><Icon name="link" /><span className="grow">Booking pages</span></button>
        <button type="button" className="subnav-item" onClick={() => setHoursOpen(true)}><Icon name="clock" /><span className="grow">Working hours</span></button>
        <button type="button" className="subnav-item" onClick={() => importInput.current.click()}><Icon name="upload" /><span className="grow">Import (.ics)</span></button>
        <input ref={importInput} type="file" accept=".ics,text/calendar" hidden aria-label="Calendar file to import" onChange={(e) => { importIcs(e.target.files[0]); e.target.value = ''; }} />
        <a className="subnav-item" href="/api/events/export" download><Icon name="download" /><span className="grow">Export (.ics)</span></a>
        <div className="subnav-title">Other calendars</div>
        {others.map((o) => (
          <div key={o.id} className="row other-cal"><span className="dot" style={{ background: o.color }} /><span className="grow ellipsis small">{o.name}</span>
            <button type="button" className="icon-btn" style={{ width: 24, height: 24 }} aria-label={`Hide ${o.name}`} onClick={() => setOthers(others.filter((x) => x.id !== o.id))}><Icon name="close" size={14} /></button></div>
        ))}
        {others.length < 10 && (
          <select className="dm-pick" value="" aria-label="Show a colleague's calendar" onChange={(e) => {
            const p = people.find((x) => x.id === e.target.value);
            if (p) setOthers([...others, { id: p.id, name: p.name, color: OTHER_COLOURS[others.length % OTHER_COLOURS.length] }]);
          }}>
            <option value="">+ See a colleague’s calendar…</option>
            {people.filter((p) => p.id !== me.id && !others.some((o) => o.id === p.id)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
        {others.length < 10 && roomList.some((r) => !others.some((o) => o.id === r.id)) && (
          <select className="dm-pick" value="" aria-label="Show a room's bookings" onChange={(e) => {
            const r = roomList.find((x) => x.id === e.target.value);
            if (r) setOthers([...others, { id: r.id, name: r.name, room: true, color: OTHER_COLOURS[others.length % OTHER_COLOURS.length] }]);
          }}>
            <option value="">+ See a room’s bookings…</option>
            {roomList.filter((r) => !others.some((o) => o.id === r.id)).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        )}
        {others.length > 0 && view !== 'week' && view !== 'day' && <p className="muted small" style={{ margin: '4px 12px' }}>Their busy times (and rooms' bookings) show in the week and day views.</p>}
        <label className="check cal-show-tasks"><input type="checkbox" checked={showTasks} onChange={(e) => setShowTasks(e.target.checked)} /> Show tasks with due dates</label>
        <label className="check cal-show-tasks"><input type="checkbox" checked={showBirthdays} onChange={(e) => setShowBirthdays(e.target.checked)} /> Show contacts’ birthdays</label>
        <form className="cal-search" role="search" onSubmit={(e) => { e.preventDefault(); runSearch(new FormData(e.currentTarget).get('q')); }}>
          <input name="q" type="search" placeholder="Search events" aria-label="Search events" onChange={(e) => { if (!e.target.value) setFound(null); }} />
        </form>
        {found ? <>
          <h3 className="subnav-title row">Results<span className="grow" /><button type="button" className="link-btn small" onClick={() => setFound(null)}>Clear</button></h3>
          {found.list.length === 0 && <p className="muted small">No events match “{found.q}”</p>}
          <ul className="cal-results" aria-label="Search results">
            {found.list.map((r) => (
              <li key={`${r.id}:${r.start}`}>
                <button type="button" className={`upcoming ${r.upcoming ? '' : 'past'}`} onClick={() => openFound(r)}>
                  <span className="dot" style={{ background: r.color || COLORS[0] }} />
                  <span>
                    <strong>{r.title}</strong>
                    <span className="muted small">{new Date(r.start).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', ...(new Date(r.start).getFullYear() !== new Date().getFullYear() && { year: 'numeric' }) })}{!r.all_day && ` · ${fmtTime(r.start)}`}{r.repeats && ' · repeats'}{r.location && ` · ${r.location}`}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </> : <>
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
        </>}
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
              const list = onDay(shown, d).sort((a, b) => b.all_day - a.all_day || a.start - b.start);
              return (
                <div key={d.toISOString()} data-day={d.getTime()} className={`day ${d.getMonth() !== anchor.getMonth() ? 'other' : ''} ${d.getTime() === today ? 'today' : ''}`}
                  onClick={drag.click((e) => e.target === e.currentTarget && newEvent(d))}>
                  <button type="button" className="daynum" aria-label={`Open ${d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}`} onClick={() => openDay(d)}>{d.getDate()}</button>
                  {list.slice(0, 3).map((ev) => (ev.task ? <TaskChip key={ev.key} ev={ev} onDone={taskDone} /> : ev.birthday ? <BirthdayChip key={ev.key} ev={ev} /> : (
                    <button key={ev.key || ev.id} className={`chip ${ev.all_day ? 'allday' : ''} ${inviteClass(ev)} ${ev.dragging ? 'dragging' : ''}`} style={{ '--c': ev.color || COLORS[0] }}
                      onPointerDown={drag.dayHandler(ev, d)} onClick={drag.click(() => setEditing(ev))}>
                      {!ev.all_day && <span className="t">{fmtTime(ev.start)}</span>} {ev.title}{ev.rrule && <span className="rep" aria-label="(repeats)" title="Repeats"> ↻</span>}
                    </button>
                  )))}
                  {list.length > 3 && <button type="button" className="more small muted link-btn" onClick={() => openDay(d)}>+{list.length - 3} more</button>}
                </div>
              );
            })}
          </div>
        ) : view === 'schedule' ? (
          <Schedule days={days} events={shown} today={today} onOpen={setEditing} onTaskDone={taskDone} onDay={openDay} />
        ) : (
          <TimeGrid days={days} events={shown} busy={busy} today={today} onOpen={setEditing} onNew={newEvent} onDay={view === 'week' ? openDay : null} drag={drag} onTaskDone={taskDone} />
        )}
      </section>
      {bookingOpen && <BookingPagesDialog onClose={() => setBookingOpen(false)} />}
      {hoursOpen && <WorkHoursDialog onClose={() => setHoursOpen(false)} />}
      {editing && (editing.role === 'guest'
        ? <InvitationDialog event={editing} onClose={() => setEditing(null)} onAnswered={() => { setEditing(null); load(); }} />
        : <EventDialog key={editing.id ? `${editing.id}:${editing.start}` : `new:${editing.duplicateOf || ''}:${editing.start}`} event={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }}
          onDuplicate={(copy) => { setEditing(copy); toast('Duplicated: change what you need, then Save'); }} />)}
      {pendingMove && (
        <ScopeDialog title="Move repeating event" confirm="Move" onClose={() => setPendingMove(null)}
          onConfirm={async (which) => { const m = pendingMove; setPendingMove(null); await commitMove(m.ev, m.start, m.end, which); }} />
      )}
    </div>
  );
}

/** Week / day view: an all-day row, then hours with timed events placed by their real times. */
/** Four weeks as a list: each day with something on it, its events, tasks and birthdays in order. */
function Schedule({ days, events, today, onOpen, onTaskDone, onDay: openDay }) {
  const list = scheduleOf(events, days);
  if (!list.length) return <Empty icon="calendar" title="Nothing scheduled">Nothing in these four weeks. The arrows move to the next four.</Empty>;
  return (
    <ol className="schedule" aria-label="Schedule">
      {list.map(({ day, items }) => (
        <li key={day.getTime()} className={`schedule-day ${day.getTime() === today ? 'today' : ''}`}>
          <button type="button" className="schedule-date" onClick={() => openDay(day)} aria-label={`Open ${day.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}`}>
            <span className="num">{day.getDate()}</span>
            <span className="muted small">{day.toLocaleDateString([], { weekday: 'short' })}, {day.toLocaleDateString([], { month: 'short' })}</span>
          </button>
          <ul className="schedule-items">
            {items.map((ev) => (
              <li key={ev.key || `${ev.id}:${ev.start}`}>
                {ev.task ? <TaskChip ev={ev} onDone={onTaskDone} /> : ev.birthday ? <BirthdayChip ev={ev} /> : (
                  <button type="button" className={`schedule-item ${inviteClass(ev)}`} style={{ '--c': ev.color || COLORS[0] }} onClick={() => onOpen(ev)}>
                    <span className="dot" aria-hidden="true" />
                    <span className="when">{ev.all_day ? 'All day' : `${fmtTime(ev.start)} – ${fmtTime(ev.end)}`}</span>
                    <span className="what">{ev.title}{ev.rrule && <span className="rep" aria-label="(repeats)" title="Repeats"> ↻</span>}{ev.location && <span className="muted small"> · {ev.location}</span>}</span>
                  </button>
                )}
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}

function TimeGrid({ days, events, busy = [], today, onOpen, onNew, onDay: openDay, drag, onTaskDone }) {
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
          <div key={d.getTime()} className="tg-allday-cell" data-day={d.getTime()}>
            {onDay(events, d).filter((ev) => ev.all_day).map((ev) => (ev.task ? <TaskChip key={ev.key} ev={ev} onDone={onTaskDone} /> : ev.birthday ? <BirthdayChip key={ev.key} ev={ev} /> : (
              <button key={ev.key || ev.id} className={`chip allday ${inviteClass(ev)} ${ev.dragging ? 'dragging' : ''}`} style={{ '--c': ev.color || COLORS[0] }}
                onPointerDown={drag.dayHandler(ev, d)} onClick={drag.click(() => onOpen(ev))}>{ev.title}{ev.rrule && <span aria-label="(repeats)"> ↻</span>}</button>
            )))}
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
            <div key={d.getTime()} data-day={d.getTime()} className={`tg-col ${d.getTime() === today ? 'today' : ''}`} aria-label={dayLabel(d)} role="group"
              onClick={drag.click((e) => {
                if (e.target !== e.currentTarget) return;
                const y = e.clientY - e.currentTarget.getBoundingClientRect().top;
                onNew(d, Math.min(23 * 60 + 30, Math.floor(y / HOUR_PX * 2) * 30)); // the half hour clicked
              })}>
              {busy.filter((b) => b.start < d.getTime() + DAY && b.end > d.getTime()).map((b) => {
                const s = Math.max(b.start, d.getTime()), e = Math.min(b.end, d.getTime() + DAY);
                return <div key={b.key} className="tg-busy" style={{ '--c': b.color, top: ((s - d.getTime()) / 36e5) * HOUR_PX, height: Math.max(12, ((e - s) / 36e5) * HOUR_PX - 2) }}
                  title={b.room ? `${b.name}: ${b.title} (${b.organizer}), ${fmtTime(b.start)} – ${fmtTime(b.end)}` : `${b.name} is ${b.ooo ? 'out of office' : 'busy'} ${fmtTime(b.start)} – ${fmtTime(b.end)}`}
                  aria-label={b.room ? `${b.name} booked: ${b.title} by ${b.organizer}, ${fmtTime(b.start)} to ${fmtTime(b.end)}` : `${b.name} ${b.ooo ? 'out of office' : 'busy'} ${fmtTime(b.start)} to ${fmtTime(b.end)}`}><span>{b.name}{b.room ? ` · ${b.title}` : b.ooo ? ' · out of office' : ''}</span></div>;
              })}
              {layoutDay(events, d).map(({ ev, top, height, col, cols: n }) => (
                <button key={ev.key || ev.id} className={`tg-event ${inviteClass(ev)} ${ev.dragging ? 'dragging' : ''} ${ev.role !== 'guest' ? 'movable' : ''}`} title={`${ev.title} · ${fmtTime(ev.start)} – ${fmtTime(ev.end)}${ev.rrule ? ' · repeats' : ''}`}
                  style={{ '--c': ev.color || COLORS[0], top: (top / 60) * HOUR_PX, height: (height / 60) * HOUR_PX - 2, left: `calc(${(col / n) * 100}% + 2px)`, width: `calc(${100 / n}% - 4px)` }}
                  onPointerDown={drag.timeHandler(ev, d, 'move')} onClick={drag.click(() => onOpen(ev))}>
                  <strong>{ev.title}{ev.rrule && <span aria-label="(repeats)"> ↻</span>}</strong>
                  {height >= 40 && <span>{fmtTime(ev.start)} – {fmtTime(ev.end)}</span>}
                  {height >= 60 && ev.location && <span>{ev.location}</span>}
                  {ev.role !== 'guest' && ev.end <= d.getTime() + DAY && <span className="tg-resize" aria-hidden="true" onPointerDown={drag.timeHandler(ev, d, 'resize')} />}
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

// ---- reminders: each person's own, in minutes before the start ----
const REMINDER_CHOICES = [[0, 'At the start'], [5, '5 minutes before'], [10, '10 minutes before'], [15, '15 minutes before'], [30, '30 minutes before'],
  [60, '1 hour before'], [120, '2 hours before'], [1440, '1 day before'], [2880, '2 days before'], [10080, '1 week before']];
export const reminderLabel = (m) => REMINDER_CHOICES.find(([v]) => v === m)?.[1]
  || (m % 1440 === 0 ? `${m / 1440} days before` : m % 60 === 0 ? `${m / 60} hours before` : `${m} minutes before`);

/** The reminders of one event: a choice per reminder, and a button to add another (up to five). */
function RemindersField({ value, onChange }) {
  const set = (i, m) => onChange([...new Set(value.map((x, j) => (j === i ? m : x)))].sort((a, b) => a - b));
  return (
    <div className="field reminders" role="group" aria-label="Reminders">
      <span>Reminders</span>
      {value.map((m, i) => (
        <div key={m} className="row">
          <select aria-label={`Reminder ${i + 1}`} value={m} onChange={(e) => set(i, Number(e.target.value))}>
            {[...REMINDER_CHOICES.map(([v]) => v), ...(REMINDER_CHOICES.some(([v]) => v === m) ? [] : [m])].sort((a, b) => a - b)
              .map((v) => <option key={v} value={v} disabled={v !== m && value.includes(v)}>{reminderLabel(v)}</option>)}
          </select>
          <button type="button" className="icon-btn" aria-label={`Remove reminder ${reminderLabel(m)}`} onClick={() => onChange(value.filter((x) => x !== m))}><Icon name="close" size={16} /></button>
        </div>
      ))}
      {value.length < 5 && (
        <button type="button" className="link-btn" onClick={() => { const next = REMINDER_CHOICES.map(([v]) => v).find((v) => !value.includes(v) && v >= 10) ?? 0; onChange([...value, next].sort((a, b) => a - b)); }}>
          {value.length ? 'Add another reminder' : 'Add a reminder'}
        </button>
      )}
    </div>
  );
}

// Invitations you haven't answered look tentative; declined ones are faded.
const inviteClass = (ev) => (ev.kind === 'ooo' ? 'ooo' : ev.role !== 'guest' ? '' : ev.my_status === 'no' ? 'declined' : ev.my_status === 'yes' ? '' : 'tentative');
const ANSWER_LABELS = { yes: 'Yes', maybe: 'Maybe', no: 'No', needs: 'Not answered' };
const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; } })();
const whenLabel = (ev) => {
  const d = new Date(ev.start).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return ev.all_day ? `${d}, all day` : `${d}, ${fmtTime(ev.start)} – ${fmtTime(ev.end)}`;
};

/** An event you're invited to: details, who's coming, and your answer. */
/** Files attached to an event: open the ones you can; the others are named, marked as not shared with you. */
function Attachments({ list = [], onRemove }) {
  if (!list.length) return null;
  return (
    <ul className="event-attachments" aria-label="Attachments">
      {list.map((a) => (
        <li key={a.id}>
          <Icon name={['doc', 'sheet', 'slides'].includes(a.kind) ? a.kind : 'file'} size={16} />
          {a.can_open === false ? <span className="muted" title="Not shared with you">{a.name} (no access)</span>
            : <a href={openUrl(a)} target="_blank" rel="noreferrer">{a.name}</a>}
          {onRemove && <button type="button" className="icon-btn" aria-label={`Remove ${a.name}`} onClick={() => onRemove(a)}><Icon name="close" size={14} /></button>}
        </li>
      ))}
    </ul>
  );
}

/** The event's video meeting: Join (in a new tab, so the calendar stays open), its link, and Remove while editing. */
function MeetLine({ code, onRemove }) {
  const toast = useToast();
  const link = `${location.origin}/meet/${code}`;
  return (
    <div className="row wrap meet-line" role="group" aria-label="Video meeting">
      <a className="btn primary" href={`/meet/${code}`} target="_blank" rel="noreferrer"><Icon name="video" size={18} /> Join video meeting</a>
      <span className="muted small grow">{code}</span>
      <button type="button" className="link-btn small" onClick={async () => { try { await navigator.clipboard.writeText(link); toast('Meeting link copied'); } catch { toast(link); } }}>Copy link</button>
      {onRemove && <button type="button" className="link-btn small" onClick={onRemove}>Remove</button>}
    </div>
  );
}

function InvitationDialog({ event, onClose, onAnswered }) {
  const toast = useToast();
  const [reminders, setReminders] = useState(event.reminders || []);
  const saveReminders = async (list) => {
    setReminders(list);
    try { await put(`/events/${event.id}/reminders`, { reminders: list }); } catch (e) { toast(e.message, 'error'); }
  };
  const answer = async (status) => {
    try { await post(`/events/${event.id}/rsvp`, { status }); toast(`Answered ${ANSWER_LABELS[status]}`); onAnswered(); } catch (e) { toast(e.message, 'error'); }
  };
  return (
    <Modal title={event.title} onClose={onClose}>
      <div className="stack">
        <p style={{ margin: 0 }}>{whenLabel(event)}{event.rrule && <><br /><span className="muted small">{describeRule(event.rrule, event.seriesStart ?? event.start)}</span></>}</p>
        {event.location && <p style={{ margin: 0 }}><span className="muted">Where:</span> {event.location}</p>}
        {event.meet_code && <MeetLine code={event.meet_code} />}
        {event.description && <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{event.description}</p>}
        <Attachments list={event.attachments} />
        <p style={{ margin: 0 }}><span className="muted">Organizer:</span> {event.organizer?.name} <span className="muted small">{event.organizer?.email}</span></p>
        <GuestList guests={event.guests} />
        {event.rooms?.length > 0 && <p className="muted small">Room: {event.rooms.map((r) => `${r.name}${r.status === 'no' ? ' (declined: taken)' : ''}`).join(', ')}</p>}
        <RemindersField value={reminders} onChange={saveReminders} />
        {!event.rrule && <ProposeTime event={event} onDone={onAnswered} />}
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

const proposalText = (g) => `${new Date(g.proposed_start).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}, ${fmtTime(g.proposed_start)} – ${fmtTime(g.proposed_end)}`;

/** A guest suggests another time (and answers Maybe), or takes the suggestion back. */
function ProposeTime({ event, onDone }) {
  const toast = useToast();
  const { user } = useAuth();
  const me = (event.guests || []).find((g) => g.email === user.username);
  const [open, setOpen] = useState(false);
  const [v, setV] = useState({ date: toDateInput(event.start), start: toTimeInput(event.start), end: toTimeInput(event.end), note: '' });
  const send = async (body) => { try { await post(`/events/${event.id}/propose`, { ...body, tz: TZ }); toast(body.start === null ? 'Suggestion taken back' : 'New time proposed to the organizer'); onDone(); } catch (e) { toast(e.message, 'error'); } };
  if (me?.proposed_start) {
    return <p className="muted small" style={{ margin: 0 }}>You proposed {proposalText(me)}. <button type="button" className="link-btn small" onClick={() => send({ start: null })}>Take it back</button></p>;
  }
  if (!open) return <div><button type="button" className="btn small" onClick={() => setOpen(true)}>Propose a new time</button></div>;
  return (
    <form className="stack propose-time" onSubmit={(e) => { e.preventDefault(); send({ start: fromInputs(v.date, v.start), end: fromInputs(v.date, v.end), note: v.note }); }}>
      <div className="row wrap">
        <label className="field"><span>Day</span><input type="date" required value={v.date} onChange={(e) => setV({ ...v, date: e.target.value })} /></label>
        <label className="field"><span>From</span><input type="time" required value={v.start} onChange={(e) => setV({ ...v, start: e.target.value })} /></label>
        <label className="field"><span>To</span><input type="time" required value={v.end} onChange={(e) => setV({ ...v, end: e.target.value })} /></label>
      </div>
      <label className="field"><span>Note to the organizer (optional)</span><input value={v.note} maxLength={500} onChange={(e) => setV({ ...v, note: e.target.value })} /></label>
      <div className="row end"><button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button><button className="btn primary">Propose</button></div>
    </form>
  );
}

function GuestList({ guests }) {
  if (!guests?.length) return null;
  const counts = ['yes', 'maybe', 'no', 'needs'].map((s) => [s, guests.filter((g) => g.status === s).length]).filter(([, n]) => n);
  return (
    <div className="stack" style={{ gap: 4 }}>
      <span className="muted small">{guests.length} guest{guests.length === 1 ? '' : 's'}: {counts.map(([s, n]) => `${n} ${ANSWER_LABELS[s].toLowerCase()}`).join(', ')}</span>
      <ul className="guest-list" aria-label="Guests">
        {guests.map((g) => <li key={g.email}><span className={`rsvp ${g.status}`} aria-hidden="true" />{g.name || g.email} <span className="muted small">{g.name ? `${g.email} · ` : ''}{g.external ? 'by email · ' : ''}{ANSWER_LABELS[g.status]}</span></li>)}
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

/** Rooms for the event: the company's rooms, marked free or taken at the event's time. */
function RoomPicker({ eventId, chosen, booked, onChange, when }) {
  const [rooms, setRooms] = useState(null);
  const [start, end] = when || [];
  useEffect(() => {
    get(`/rooms${start ? `?start=${start}&end=${end}${eventId ? `&event=${eventId}` : ''}` : ''}`).then(setRooms).catch(() => setRooms([]));
  }, [start, end, eventId]);
  if (!rooms?.length) return null;
  const label = (r) => `${r.name}${r.capacity ? ` (${r.capacity})` : ''}`;
  return (
    <div className="field">
      <span>Room</span>
      {chosen.length > 0 && (
        <ul className="guest-chips" aria-label="Rooms">
          {chosen.map((id) => {
            const r = rooms.find((x) => x.id === id);
            if (!r) return null;
            const was = booked.find((x) => x.id === id);
            // (This event's own booking doesn't count against it.)
            const taken = r.free === false;
            const state = taken ? 'Taken then' : was?.status === 'yes' ? 'Booked' : 'Free: booked when you save';
            return <li key={id} className={taken || was?.status === 'no' ? 'room-taken' : ''}>{label(r)} <span className="muted small">· {state}</span>
              <button type="button" className="icon-btn" aria-label={`Remove ${r.name}`} onClick={() => onChange(chosen.filter((x) => x !== id))}>×</button></li>;
          })}
        </ul>
      )}
      <select value="" aria-label="Add a room" onChange={(e) => { if (e.target.value) onChange([...chosen, e.target.value]); }}>
        <option value="">+ Add a room…</option>
        {rooms.filter((r) => !chosen.includes(r.id)).map((r) => <option key={r.id} value={r.id}>{label(r)}{r.free === false ? ' — taken then' : r.free ? ' — free' : ''}</option>)}
      </select>
    </div>
  );
}

/** Find a time when you and the colleagues invited are all free (working hours, the next two weeks). */
const WORK_DAYS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']];
const toHHMM = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const fromHHMM = (v, end) => { const [h, m] = v.split(':').map(Number); const x = h * 60 + m; return end && x === 0 ? 1440 : x; };

/** Your working hours: the days and times you work, kept to by Find a time (in your time zone). */
function WorkHoursDialog({ onClose }) {
  const toast = useToast();
  const [h, setH] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { get(`/users/me/work-hours?tz=${encodeURIComponent(TZ)}`).then(setH).catch((e) => setError(e.message)); }, []);
  const save = async (hours) => {
    setError('');
    try { const r = await put('/users/me/work-hours', { hours }); toast(r.own ? `Working hours: ${r.text}` : 'Back to the usual hours'); onClose(); } catch (e) { setError(e.message); }
  };
  return (
    <Modal title="Working hours" onClose={onClose}>
      {!h ? <p className="muted">{error || 'Loading…'}</p> : (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); save({ days: h.days, start: h.start, end: h.end, tz: TZ }); }}>
          <p className="muted small" style={{ margin: 0 }}>When colleagues use <strong>Find a time</strong>, they're only offered times inside these hours ({TZ}).</p>
          <div className="row wrap" role="group" aria-label="Working days">
            {WORK_DAYS.map(([d, name]) => (
              <label key={d} className="check"><input type="checkbox" checked={h.days.includes(d)} onChange={(e) => setH({ ...h, days: e.target.checked ? [...h.days, d] : h.days.filter((x) => x !== d) })} /> {name}</label>
            ))}
          </div>
          <div className="row wrap">
            <label className="field"><span>From</span><input type="time" step={1800} required value={toHHMM(h.start)} onChange={(e) => setH({ ...h, start: fromHHMM(e.target.value) })} /></label>
            <label className="field"><span>To</span><input type="time" step={1800} required value={toHHMM(h.end)} onChange={(e) => setH({ ...h, end: fromHHMM(e.target.value, true) })} /></label>
          </div>
          {error && <p className="error">{error}</p>}
          <div className="row end">
            {h.own && <button type="button" className="btn" onClick={() => save(null)}>Use the usual (Mon–Fri, 9–5)</button>}
            <button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">Save</button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function FindATime({ guests, directory, minutes, onPick }) {
  const [slots, setSlots] = useState(null);
  const [hours, setHours] = useState([]); // people whose own working hours were kept to
  const [error, setError] = useState('');
  const ids = guests.map((g) => directory.find((d) => d.username === g)?.id).filter(Boolean);
  const outside = guests.length - ids.length;
  const find = async () => {
    setError('');
    try { const r = await get(`/freebusy/suggest?users=${ids.join(',')}&duration=${minutes}&tz=${encodeURIComponent(TZ)}`); setSlots(r.slots); setHours(r.hours || []); } catch (e) { setError(e.message); }
  };
  const label = (s) => `${new Date(s.start).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}, ${fmtTime(s.start)} – ${fmtTime(s.end)}`;
  return (
    <div className="find-time">
      <button type="button" className="btn small" onClick={find}><Icon name="search" size={16} /> Find a time{ids.length ? ` with ${ids.length} guest${ids.length === 1 ? '' : 's'}` : ''}</button>
      {error && <span className="error small">{error}</span>}
      {slots && (slots.length ? (
        <div className="find-time-slots" role="group" aria-label="Free times">
          {slots.map((s) => <button key={s.start} type="button" className="chip-btn" onClick={() => { onPick(s.start, s.end); setSlots(null); }}>{label(s)}</button>)}
          <span className="muted small">{minutes} min, within working hours ({hours.length ? `${hours.map((x) => `${x.name}: ${x.hours}${x.tz !== TZ ? ` ${x.tz}` : ''}`).join('; ')}; anyone else 9–5, Mon–Fri` : '9–5, Mon–Fri'}), when {ids.length ? 'everyone invited from your company is' : 'you are'} free{outside ? `; ${outside} guest${outside === 1 ? '' : 's'} outside it not checked` : ''}.</span>
        </div>
      ) : <span className="muted small">No time in the next two weeks suits everyone.</span>)}
    </div>
  );
}

function EventDialog({ event, onClose, onSaved, onDuplicate }) {
  const toast = useToast();
  const recurring = !!(event.id && event.rrule);
  const [f, setF] = useState({
    title: event.title, location: event.location || '', description: event.description || '', color: event.color || COLORS[0],
    all_day: !!event.all_day, ooo: event.kind === 'ooo',
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
  const [roomIds, setRoomIds] = useState((event.rooms || []).map((r) => r.id));
  // New timed events remind you 10 minutes before, as in other calendars.
  const [reminders, setReminders] = useState(event.reminders ?? (event.id || event.all_day ? [] : [10]));
  const [meet, setMeet] = useState(event.meet_code || null);
  const addMeet = async () => {
    try { setMeet((await post('/meet', { title: f.title })).code); } catch (e) { toast(e.message, 'error'); }
  };
  const [attachments, setAttachments] = useState(event.attachments || []);
  const [pickingFile, setPickingFile] = useState(false);
  const [guestInput, setGuestInput] = useState('');
  const [directory, setDirectory] = useState([]);
  useEffect(() => { get('/users/directory').then(setDirectory).catch(() => {}); }, []);
  const addGuests = (text) => {
    const found = String(text).split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter((x) => x.includes('@'));
    if (found.length) setGuests((g) => [...new Set([...g, ...found])]);
    setGuestInput('');
  };
  const [scopeFor, setScopeFor] = useState(null); // 'save' | 'delete': asking which occurrences
  const [error, setError] = useState('');
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const setR = (k) => (e) => setRep({ ...rep, [k]: e.target.value });

  const read = () => {
    const start = f.all_day ? fromInputs(f.startDate) : fromInputs(f.startDate, f.startTime);
    const end = f.all_day ? fromInputs(f.endDate) + DAY - 1 : fromInputs(f.endDate, f.endTime);
    const all = guestInput.trim() ? [...new Set([...guests, ...guestInput.split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter((x) => x.includes('@'))])] : guests;
    return { start, end, body: { title: f.title, location: f.ooo ? '' : f.location, description: f.description, color: f.color, all_day: f.all_day, start, end, rrule: ruleFromForm(rep, start),
      guests: f.ooo ? [] : all, reminders, tz: TZ, attachments: attachments.map((a) => a.id), kind: f.ooo ? 'ooo' : null, meet_code: f.ooo ? null : meet, ...(event.id && !event.rooms?.length && !roomIds.length ? {} : { rooms: f.ooo ? [] : roomIds }) } };
  };

  async function save(which) {
    const { start, end, body } = read();
    if (end < start) return setError('The event ends before it starts');
    await applyEdit(event, body, which);
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
    return <ScopeDialog title={scopeFor === 'save' ? 'Change repeating event' : 'Delete repeating event'} confirm={scopeFor === 'save' ? 'Save' : 'Delete'}
      danger={scopeFor === 'delete'} onClose={() => setScopeFor(null)} onConfirm={(which) => run(scopeFor === 'save' ? save : remove)(which)} error={error} />;
  }

  const ruleNow = ruleFromForm(rep, read().start);
  return (
    <Modal title={event.id ? 'Edit event' : event.duplicateOf !== undefined ? 'Copy of event' : 'New event'} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <label className="field"><span>Title</span><input autoFocus required value={f.title} onChange={set('title')} /></label>
        <label className="check"><input type="checkbox" checked={f.all_day} onChange={set('all_day')} /> All day</label>
        <label className="check"><input type="checkbox" checked={f.ooo} onChange={set('ooo')} /> Out of office</label>
        {f.ooo && <p className="muted small" style={{ margin: 0 }}>While you're away, new invitations for this time are declined for you, and whoever sent them sees the description below as your message. Colleagues see you as out of office.</p>}
        <div className="row wrap">
          <label className="field"><span>Starts</span><input type="date" required value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value, endDate: e.target.value > f.endDate ? e.target.value : f.endDate })} /></label>
          {!f.all_day && <label className="field"><span>&nbsp;</span><input type="time" required value={f.startTime} onChange={set('startTime')} aria-label="Start time" /></label>}
        </div>
        <div className="row wrap">
          <label className="field"><span>Ends</span><input type="date" required value={f.endDate} onChange={set('endDate')} /></label>
          {!f.all_day && <label className="field"><span>&nbsp;</span><input type="time" required value={f.endTime} onChange={set('endTime')} aria-label="End time" /></label>}
        </div>
        {!f.ooo && <FindATime guests={guests} directory={directory} minutes={(() => { const { start, end } = read(); return f.all_day || !(end > start) ? 60 : Math.min(480, Math.max(15, Math.round((end - start) / 6e4))); })()}
          onPick={(s, e) => setF({ ...f, all_day: false, startDate: toDateInput(s), startTime: toTimeInput(s), endDate: toDateInput(e), endTime: toTimeInput(e) })} />}
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
        {!f.ooo && <div className="field">
          <label htmlFor="guest-input"><span>Guests</span></label>
          {event.guests?.length > 0 && (
            <span className="muted small" aria-live="polite">{event.guests.length} guest{event.guests.length === 1 ? '' : 's'}: {
              ['yes', 'maybe', 'no', 'needs'].map((k) => [k, event.guests.filter((g) => g.status === k).length]).filter(([, n]) => n).map(([k, n]) => `${n} ${ANSWER_LABELS[k].toLowerCase()}`).join(', ')}</span>
          )}
          {guests.length > 0 && (
            <ul className="guest-chips" aria-label="Invited guests">
              {guests.map((g) => {
                const known = (event.guests || []).find((x) => x.email === g);
                const outside = known ? known.external : !directory.some((d) => d.username === g);
                return <li key={g} className={outside ? 'outside' : ''}>{directory.find((d) => d.username === g)?.name || known?.name || g}
                  {outside && <span className="muted small" title="Invited by email: they answer on a web page"> · by email</span>}
                  {known && <span className="muted small"> · {ANSWER_LABELS[known.status]}</span>}
                  <button type="button" className="icon-btn" aria-label={`Remove ${g}`} onClick={() => setGuests(guests.filter((x) => x !== g))}>×</button></li>;
              })}
            </ul>
          )}
          {!event.rrule && (event.guests || []).filter((g) => g.proposed_start).map((g) => (
            <p key={g.email} className="proposal small" style={{ margin: 0 }}>
              <strong>{g.name || g.email}</strong> proposes {proposalText(g)}{g.proposal_note && <span className="muted"> · “{g.proposal_note}”</span>}{' '}
              <button type="button" className="link-btn small" onClick={() => setF({ ...f, all_day: false, startDate: toDateInput(g.proposed_start), startTime: toTimeInput(g.proposed_start), endDate: toDateInput(g.proposed_end), endTime: toTimeInput(g.proposed_end) })}>Use this time</button>
            </p>
          ))}
          <input id="guest-input" list="guest-directory" value={guestInput} placeholder="Add people by email address" autoComplete="off"
            onChange={(e) => { const v = e.target.value; if (/[,;\s]$/.test(v) || directory.some((d) => d.username === v.trim().toLowerCase())) addGuests(v); else setGuestInput(v); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (guestInput.trim()) addGuests(guestInput); } }} /* Enter adds a guest, never saves */ />
          <datalist id="guest-directory">{directory.map((d) => <option key={d.id} value={d.username}>{d.name}</option>)}</datalist>
          {guests.length > 0 && <span className="muted small">They'll see it in their calendar{event.id ? '' : ' and get an email'} and can answer Yes, Maybe or No.
            {guests.some((g) => { const k = (event.guests || []).find((x) => x.email === g); return k ? k.external : !directory.some((d) => d.username === g); })
              && ' People outside Workspace get an email invitation for their own calendar (Outlook, Gmail, phone) and a link to answer; they also get changes and cancellations.'}</span>}
        </div>}
        {!f.ooo && <RoomPicker eventId={event.id} chosen={roomIds} booked={event.rooms || []} onChange={setRoomIds} when={(() => { const r = read(); return r.end > r.start ? [r.start, r.end] : null; })()} />}
        <RemindersField value={reminders} onChange={setReminders} />
        {!f.ooo && <label className="field"><span>Location</span><input value={f.location} onChange={set('location')} /></label>}
        {!f.ooo && (meet ? <MeetLine code={meet} onRemove={() => setMeet(null)} />
          : <div><button type="button" className="btn" onClick={addMeet}><Icon name="video" size={18} /> Add video meeting</button></div>)}
        <label className="field"><span>{f.ooo ? 'Message for people who invite you' : 'Description'}</span><textarea rows={3} value={f.description} onChange={set('description')} placeholder={f.ooo ? 'e.g. On holiday until Monday 9th; for anything urgent, ask Kim.' : undefined} /></label>
        {!f.ooo && (
          <div className="field"><span>Attachments</span>
            <Attachments list={attachments} onRemove={(a) => setAttachments(attachments.filter((x) => x.id !== a.id))} />
            <span className="row"><button type="button" className="btn small" onClick={() => setPickingFile(true)}><Icon name="attach" size={16} /> Attach from Drive</button></span>
            {attachments.length > 0 && (guests.length > 0 || guestInput.trim()) && <span className="muted small">Guests can view the files you own. They see the others only if they can already open them.</span>}
          </div>
        )}
        {pickingFile && <DrivePicker title="Attach to the event" accept={(x) => x.kind !== 'folder'} onClose={() => setPickingFile(false)}
          onPick={(x) => { if (!attachments.some((a) => a.id === x.id)) setAttachments([...attachments, { id: x.id, name: x.name, kind: x.kind, can_open: true }]); setPickingFile(false); }} />}
        <div className="colors" role="radiogroup" aria-label="Color">
          {COLORS.map((c) => (
            <button type="button" key={c} role="radio" aria-checked={f.color === c} aria-label={c} className={`swatch ${f.color === c ? 'on' : ''}`} style={{ background: c }} onClick={() => setF({ ...f, color: c })} />
          ))}
        </div>
        {error && <p className="error">{error}</p>}
        <div className="row">
          {event.id && <button type="button" className="btn danger" onClick={() => (recurring ? setScopeFor('delete') : run(remove)())}>Delete</button>}
          {event.id && onDuplicate && <button type="button" className="btn" title="A new event like this one (as it is in this window), to change and save" onClick={() => {
            // The new event starts where this one (or this occurrence) is; it doesn't repeat, and it's yours to change before saving.
            const { start, end, body } = read();
            onDuplicate({ title: body.title, location: body.location, description: body.description, color: body.color, all_day: f.all_day ? 1 : 0, start, end,
              guests: body.guests.map((email) => ({ email })), reminders: body.reminders, duplicateOf: event.title });
          }}>Duplicate</button>}
          <div className="grow" />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary">Save</button>
        </div>
      </form>
    </Modal>
  );
}

/** Which occurrences of a repeating event a change applies to. */
function ScopeDialog({ title, confirm, danger, onConfirm, onClose, error }) {
  const [scope, setScope] = useState('this');
  return (
    <Modal title={title} onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); onConfirm(scope); }}>
        <div className="stack" role="radiogroup" aria-label="Which events">
          {[['this', 'This event'], ['following', 'This and following events'], ['all', 'All events']].map(([v, label]) => (
            <label key={v} className="check"><input type="radio" name="scope" checked={scope === v} onChange={() => setScope(v)} /> {label}</label>
          ))}
        </div>
        {error && <p className="error">{error}</p>}
        <div className="row end">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className={`btn ${danger ? 'danger' : 'primary'}`}>{confirm}</button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Save a change to an event. For a repeating one, `which` says what changes: 'this' (skip the date
 * and add a one-off copy), 'following' (end the series and start a new one), or 'all' (the series
 * moves by as much as this occurrence moved).
 */
async function applyEdit(event, body, which) {
  const { start, end } = body;
  if (!event.id) return post('/events', body);
  if (!event.rrule) return patch(`/events/${event.id}`, body);
  if (which === 'all' || (which === 'following' && event.occurrence === event.seriesStart)) {
    const delta = start - event.occurrence;
    return patch(`/events/${event.id}`, { ...body, start: event.seriesStart + delta, end: event.seriesStart + delta + (end - start) });
  }
  // Everything the new event copies from the series (the dialog sends all of it; a drag only the times).
  const copy = { title: event.title, location: event.location || '', description: event.description || '', color: event.color, all_day: !!event.all_day, kind: event.kind || null,
    guests: (event.guests || []).map((g) => g.email), tz: TZ, rrule: event.rrule, ...body };
  if (which === 'this') {
    await patch(`/events/${event.id}`, { exdates: [...(event.exdates || []), event.occurrence] });
    return post('/events', { ...copy, rrule: null, recurrence_of: { id: event.id, occurrence: event.occurrence } }); // phones see it as part of the series
  }
  const old = event.rrule;
  let rule = copy.rrule;
  if (rule?.count && old.count && rule.count === old.count) rule = { ...rule, count: Math.max(1, old.count - occurrenceIndex(event, event.occurrence)) };
  await patch(`/events/${event.id}`, { rrule: { ...Object.fromEntries(Object.entries(old).filter(([k]) => k !== 'count')), until: event.occurrence - 1 } });
  return post('/events', { ...copy, rrule: rule });
}

/**
 * Mouse dragging of events (touch keeps scrolling). `dayHandler` moves by whole days (month view,
 * all-day row); `timeHandler` moves by days and 15-minute steps, or changes the end ('resize').
 * Escape cancels. A drag never counts as a click.
 */
function useEventDrag(onDrop) {
  const [drag, setDrag] = useState(null); // { ev, start, end }
  const dragged = useRef(false);
  const begin = (e, ev, compute) => {
    if (e.button !== 0 || e.pointerType === 'touch') return;
    // Someone else's event doesn't move, but the gesture still isn't a click on the grid below.
    const locked = ev.role === 'guest';
    e.stopPropagation();
    const x0 = e.clientX, y0 = e.clientY;
    let cur = null;
    dragged.current = false;
    const move = (m) => {
      if (!dragged.current && Math.hypot(m.clientX - x0, m.clientY - y0) < 5) return;
      dragged.current = true;
      m.preventDefault();
      const next = locked ? null : compute(m);
      if (next) { cur = next; setDrag({ ev, ...next }); }
    };
    const stop = (drop) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('keydown', esc, true);
      setDrag(null);
      if (drop && cur && (cur.start !== ev.start || cur.end !== ev.end)) onDrop(ev, cur.start, cur.end);
      setTimeout(() => { dragged.current = false; }); // after the click that follows
    };
    const up = () => stop(true);
    // Esc cancels; the mouse is still down, so its release (and the click after it) must not count either.
    const esc = (k) => {
      if (k.key !== 'Escape' || !dragged.current) return;
      k.preventDefault(); k.stopPropagation();
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('keydown', esc, true);
      setDrag(null);
      window.addEventListener('pointerup', () => setTimeout(() => { dragged.current = false; }), { once: true });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('keydown', esc, true);
  };
  const dayAt = (m) => Number(document.elementFromPoint(m.clientX, m.clientY)?.closest('[data-day]')?.dataset.day) || null;
  return {
    drag,
    click: (fn) => (e) => { if (dragged.current) { e.preventDefault(); return; } fn(e); },
    dayHandler: (ev, day) => (e) => begin(e, ev, (m) => {
      const target = dayAt(m);
      return target === null ? null : moveTimes(ev, daysBetween(day, new Date(target)), 0);
    }),
    timeHandler: (ev, day, mode) => (e) => {
      const col = e.currentTarget.closest('.tg-col');
      const top0 = col.getBoundingClientRect().top, y0 = e.clientY - top0;
      const cols = [...col.parentElement.querySelectorAll('.tg-col')];
      begin(e, ev, (m) => {
        const rects = cols.map((c) => c.getBoundingClientRect());
        const minutes = snapMinutes(m.clientY - rects[0].top - y0, HOUR_PX);
        if (mode === 'resize') return resizeEnd(ev, minutes);
        // The column under the pointer (or the nearest one at the edges).
        let i = rects.findIndex((r) => m.clientX >= r.left && m.clientX < r.right);
        if (i < 0) i = m.clientX < rects[0].left ? 0 : rects.length - 1;
        return moveTimes(ev, daysBetween(day, new Date(Number(cols[i].dataset.day))), minutes);
      });
    },
  };
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const LENGTHS = [15, 20, 30, 45, 60, 90, 120];
const hhmm = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
const fromHhmm = (v) => { const [h, m] = String(v).split(':').map(Number); return h * 60 + (m || 0); };

/** Your booking pages: links people use to book a free time with you. */
function BookingPagesDialog({ onClose }) {
  const toast = useToast();
  const [pages, setPages] = useState(null);
  const [editing, setEditing] = useState(null);
  const load = () => get('/bookings').then(setPages).catch((e) => toast(e.message, 'error'));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const fresh = () => ({ title: 'Meeting', description: '', duration: 30, days: [1, 2, 3, 4, 5], from_min: 540, to_min: 1020, notice_hours: 4, days_ahead: 30, enabled: true });
  async function save(p) {
    try {
      const body = { ...p, tz: TZ };
      if (p.id) await patch(`/bookings/${p.id}`, body); else await post('/bookings', body);
      toast(p.id ? 'Booking page saved' : 'Booking page made: copy its link to share it');
      setEditing(null); load();
    } catch (e) { toast(e.message, 'error'); }
  }
  const copy = async (p) => { try { await navigator.clipboard.writeText(p.url); toast('Link copied'); } catch { toast(p.url); } };
  return (
    <Modal wide title="Booking pages" onClose={onClose}>
      {editing ? <BookingForm page={editing} onSave={save} onCancel={() => setEditing(null)} /> : (
        <div className="stack">
          <p className="muted small" style={{ margin: 0 }}>Share a link, and people (with or without an account) can book a free time in the hours you choose. Your events count as busy. Each booking goes on your calendar, and they get an invitation by email.</p>
          {pages?.length === 0 && <p className="muted">No booking pages yet.</p>}
          <ul className="rule-list">
            {(pages || []).map((p) => (
              <li key={p.id}>
                <span className="grow"><strong>{p.title}</strong> <span className="muted small">· {p.duration} min · {p.days.map((d) => WEEKDAYS[d]).join(', ')} {hhmm(p.from_min)}–{hhmm(p.to_min)}{p.bookings ? ` · ${p.bookings} booked` : ''}{p.enabled ? '' : ' · off'}</span></span>
                <button type="button" className="btn small" onClick={() => copy(p)}>Copy link</button>
                <a className="btn small" href={p.url} target="_blank" rel="noreferrer">Open</a>
                <button type="button" className="icon-btn" aria-label={`Change ${p.title}`} onClick={() => setEditing(p)}><Icon name="edit" size={16} /></button>
                <button type="button" className="icon-btn" aria-label={`Delete ${p.title}`} onClick={async () => { await del(`/bookings/${p.id}`); load(); }}><Icon name="trash" size={16} /></button>
              </li>
            ))}
          </ul>
          <div className="row"><button type="button" className="btn primary" onClick={() => setEditing(fresh())}><Icon name="plus" size={16} /> New booking page</button></div>
        </div>
      )}
    </Modal>
  );
}

function BookingForm({ page, onSave, onCancel }) {
  const [p, setP] = useState(page);
  const set = (k, v) => setP({ ...p, [k]: v });
  const ok = p.title.trim() && p.days.length && p.to_min - p.from_min >= p.duration;
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); if (ok) onSave(p); }}>
      <label className="field"><span>Title</span><input value={p.title} maxLength={100} onChange={(e) => set('title', e.target.value)} /></label>
      <label className="field"><span>Description (optional)</span><input value={p.description || ''} maxLength={1000} onChange={(e) => set('description', e.target.value)} placeholder="A short call to get to know each other" /></label>
      <div className="row wrap" style={{ gap: 12 }}>
        <label className="field"><span>Length</span><select value={p.duration} onChange={(e) => set('duration', Number(e.target.value))}>{LENGTHS.map((m) => <option key={m} value={m}>{m < 60 ? `${m} minutes` : `${m / 60} hour${m > 60 ? 's' : ''}`}</option>)}</select></label>
        <label className="field"><span>From</span><input type="time" value={hhmm(p.from_min)} onChange={(e) => set('from_min', fromHhmm(e.target.value))} /></label>
        <label className="field"><span>To</span><input type="time" value={hhmm(p.to_min === 1440 ? 1439 : p.to_min)} onChange={(e) => set('to_min', fromHhmm(e.target.value))} /></label>
      </div>
      <fieldset className="booking-weekdays"><legend className="muted small">Days</legend>
        {WEEKDAYS.map((d, i) => (
          <label key={d} className="check"><input type="checkbox" checked={p.days.includes(i)} onChange={(e) => set('days', e.target.checked ? [...p.days, i].sort() : p.days.filter((x) => x !== i))} /> {d}</label>
        ))}
      </fieldset>
      <div className="row wrap" style={{ gap: 12 }}>
        <label className="field"><span>At least this much notice</span><select value={p.notice_hours} onChange={(e) => set('notice_hours', Number(e.target.value))}>
          {[[0, 'None'], [1, '1 hour'], [4, '4 hours'], [12, '12 hours'], [24, '1 day'], [48, '2 days'], [168, '1 week']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        <label className="field"><span>Up to this far ahead</span><select value={p.days_ahead} onChange={(e) => set('days_ahead', Number(e.target.value))}>
          {[[7, '1 week'], [14, '2 weeks'], [30, '30 days'], [60, '60 days'], [90, '90 days']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
      </div>
      <label className="check"><input type="checkbox" checked={p.enabled} onChange={(e) => set('enabled', e.target.checked)} /> Taking bookings</label>
      <p className="muted small" style={{ margin: 0 }}>Hours are in your time zone ({TZ}). Visitors see the times in theirs.</p>
      {!ok && <p className="error small" style={{ margin: 0 }}>Pick at least one day, with hours long enough for one booking.</p>}
      <div className="row end">
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        <button className="btn primary" disabled={!ok}>{page.id ? 'Save' : 'Create'}</button>
      </div>
    </form>
  );
}

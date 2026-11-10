import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { createPortal } from 'react-dom';
import { useAuth } from '../../App.jsx';
import { get, post, put, patch, del, onLive, postText, setCalendarOwner } from '../../api.js';
import { localToday } from '../tasks/taskmath.js';
import Icon from '../../components/Icon.jsx';
import DrivePicker, { openUrl } from '../../components/DrivePicker.jsx';
import { Modal, useToast, Empty, Menu, PromptModal } from '../../components/ui.jsx';
import { PLACES, placeText, isoDay } from '../../components/workloc.js';
import { useMailStatus } from '../../mailStatus.js';
import { insights, hoursText } from './insights.js';
import TimeOff, { waitingFor } from './TimeOff.jsx';
import { timeIn, zoneName, cityOf } from '../../components/zones.js';
import { printRange, daysFromTo, scheduleOf, DAY, VIEWS, startOfDay, visibleDays, shift, title, onDay, layoutDay, expandAll, occurrenceIndex, describeRule, daysBetween, moveTimes, resizeEnd, shiftWeekdays, snapMinutes, moveStart, weekdayInMonth, eventsPerDay, isoWeek, daysShown, weekOrder } from './calmath.js';

const OTHER_COLOURS = ['#e37400', '#8e24aa', '#0b8043', '#d93025', '#00796b', '#3949ab'];
const COLORS = ['#1a73e8', '#0b8043', '#d50000', '#f4511e', '#8e24aa', '#616161'];
const HOUR_PX = 48; // height of one hour in the week/day grid
const pad = (n) => String(n).padStart(2, '0');
const toDateInput = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const toTimeInput = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fromInputs = (date, time = '00:00') => new Date(`${date}T${time}`).getTime();
const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const VIEW_NAMES = { year: 'Year', month: 'Month', week: 'Week', day: 'Day', schedule: 'Schedule' };
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
  // Their other dates (an anniversary…) come with a label, and the years since when the year is known.
  const title = b.label ? `🗓 ${b.label}: ${b.name}${b.years ? ` (${b.years})` : ''}` : `🎂 ${b.name}${b.age ? ` (${b.age})` : ''}`;
  return { key: `bday:${b.contact_id}:${b.date}:${b.label || ''}`, birthday: b, title, start, end: start + DAY - 1, all_day: 1 };
});
/** Company holidays as all-day items. */
const holidayItems = (list) => list.map((h) => {
  const [y, m, d] = h.date.split('-').map(Number);
  const start = new Date(y, m - 1, d).getTime();
  return { key: `hol:${h.id}`, holiday: h, title: `🏳 ${h.name}`, start, end: start + DAY - 1, all_day: 1 };
});
function HolidayChip({ ev }) {
  return <span className="chip allday holiday-chip" title={`Company holiday: ${ev.holiday.name}`}>{ev.title}</span>;
}
function BirthdayChip({ ev }) {
  const navigate = useNavigate();
  return (
    <button type="button" className="chip allday birthday-chip" title={ev.birthday.label ? `${ev.birthday.label}: ${ev.birthday.name}${ev.birthday.years ? ` · ${ev.birthday.years} years` : ''}` : `${ev.birthday.name}'s birthday${ev.birthday.age ? ` · turns ${ev.birthday.age}` : ''}`}
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

// Your calendar, or a colleague's that they let you manage (an assistant): the choice is kept for this
// tab, and Calendar starts afresh on it (events made, changed and deleted there are theirs).
export default function CalendarPage() {
  const [managed, setManaged] = useState([]);
  const [acting, setActing] = useState(() => { try { return sessionStorage.getItem('nw-calendar') || null; } catch { return null; } });
  useEffect(() => { get('/freebusy/shares').then((s) => setManaged(s.from.filter((u) => u.can_edit))).catch(() => {}); }, []);
  const known = managed.find((m) => m.id === acting) || null;
  setCalendarOwner(known ? known.id : null); // before the view's requests below
  useEffect(() => () => setCalendarOwner(null), []); // leaving Calendar: back to your own
  const pick = (id) => { try { if (id) sessionStorage.setItem('nw-calendar', id); else sessionStorage.removeItem('nw-calendar'); } catch { /* private mode */ } setActing(id || null); };
  return <Calendar key={known?.id || 'own'} acting={known} managed={managed} onPick={pick} />;
}

function Calendar({ acting = null, managed = [], onPick }) {
  const toast = useToast();
  const [view, setViewState] = useState(savedView);
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const [events, setEvents] = useState([]);
  const [editing, setEditing] = useState(null);
  // Your own calendars besides the main one; the hidden ones' events stay off the views.
  const [myCals, setMyCals] = useState([]);
  const loadCals = useCallback(() => { if (acting) { setMyCals([]); return; } get('/events/calendars').then(setMyCals).catch(() => {}); }, [acting]);
  useEffect(() => { loadCals(); }, [loadCals]);
  const hiddenKey = myCals.filter((c) => c.hidden).map((c) => c.id).join(',');
  // "Create event" on an email comes here with the event to start from.
  const location = useLocation();
  // Time off: the window (opened from the sidebar, or a notification's link), and how many wait for your answer.
  const [timeOff, setTimeOff] = useState(() => new URLSearchParams(location.search).has('timeoff'));
  const [timeOffWaiting, setTimeOffWaiting] = useState(0);
  const refreshTimeOff = useCallback(() => get('/time-off').then((d) => setTimeOffWaiting(waitingFor(d))).catch(() => {}), []);
  useEffect(() => { refreshTimeOff(); }, [refreshTimeOff]);
  useEffect(() => { if (new URLSearchParams(location.search).has('timeoff')) setTimeOff(true); }, [location.search]);
  const navigateTo = useNavigate();
  // A result from the search box in the top bar: open that event.
  useEffect(() => {
    const r = location.state?.openEvent;
    if (!r) return;
    navigateTo(location.pathname, { replace: true, state: null });
    openFound(r);
  }, [location.state]); // eslint-disable-line react-hooks/exhaustive-deps
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
  const [sharingOpen, setSharingOpen] = useState(false);
  const [printOpen, setPrintOpen] = useState(false);
  // Import a calendar file from Google Calendar, Outlook or Apple Calendar.
  const importInput = useRef();
  const importIcs = async (file, calendar = null) => {
    if (!file) return;
    try {
      const r = await postText(`/events/import?tz=${encodeURIComponent(TZ)}${calendar ? `&calendar=${calendar}` : ''}`, await file.text());
      toast([`${r.added} event${r.added === 1 ? '' : 's'} imported`, r.skipped && `${r.skipped} already here`, r.failed && `${r.failed} couldn’t be read`].filter(Boolean).join(', '));
      load();
    } catch (e) { toast(e.message, 'error'); }
  };

  const [tasks, setTasks] = useState([]);
  const [showBirthdays, setShowBirthdaysState] = useState(savedBirthdays);
  const setShowBirthdays = (on) => { setShowBirthdaysState(on); try { localStorage.setItem('nw.calBirthdays', on ? '1' : '0'); } catch { /* private window */ } };
  const [birthdays, setBirthdays] = useState([]);
  const [holidays, setHolidays] = useState([]); // the company's holidays in view
  const setShowTasks = (on) => { setShowTasksState(on); try { localStorage.setItem('nw.calTasks', on ? '1' : '0'); } catch { /* private window */ } };
  const setView = (v) => { setViewState(v); try { localStorage.setItem('nw.calView', v); } catch { /* private window */ } };

  const [weekStart, setWeekStartState] = useState(() => { try { const v = Number(localStorage.getItem('nw.calWeekStart')); return [0, 1, 6].includes(v) ? v : 0; } catch { return 0; } });
  const setWeekStart = (v) => { setWeekStartState(v); try { localStorage.setItem('nw.calWeekStart', String(v)); } catch { /* private window */ } };
  const days = useMemo(() => visibleDays(view, anchor, weekStart), [view, anchor, weekStart]);
  // View options, remembered in this browser: weekends in the week and month views, and week numbers.
  const flag = (k, dflt) => { try { const v = localStorage.getItem(k); return v === null ? dflt : v === '1'; } catch { return dflt; } };
  const [weekends, setWeekendsState] = useState(() => flag('nw.calWeekends', true));
  const [weekNums, setWeekNumsState] = useState(() => flag('nw.calWeekNums', false));
  const keep = (k, set) => (on) => { set(on); try { localStorage.setItem(k, on ? '1' : '0'); } catch { /* private window */ } };
  const setWeekends = keep('nw.calWeekends', setWeekendsState), setWeekNums = keep('nw.calWeekNums', setWeekNumsState);
  const gridDays = useMemo(() => daysShown(view, days, weekends), [view, days, weekends]);
  // Other people's calendars (busy times only), chosen on this device.
  const [others, setOthersState] = useState(() => { try { return JSON.parse(localStorage.getItem('nw.calOthers') || '[]'); } catch { return []; } });
  const setOthers = (list) => { setOthersState(list); try { localStorage.setItem('nw.calOthers', JSON.stringify(list)); } catch { /* private window */ } };
  const [busy, setBusy] = useState([]);
  // Working location for the days shown (week and day views).
  const [locations, setLocations] = useState({});
  const [otherFor, setOtherFor] = useState(null); // a date whose "elsewhere" is being named
  const [insightsOpen, setInsightsOpen] = useState(false);
  const loadLocations = useCallback(() => {
    if (view === 'month' || !days.length) return;
    get(`/location?from=${isoDay(days[0])}&to=${isoDay(days[days.length - 1])}`).then((r) => setLocations(r.days)).catch(() => {});
  }, [view, days]);
  useEffect(() => { loadLocations(); }, [loadLocations]);
  useEffect(() => onLive((m) => { if (m.type === 'location-changed') loadLocations(); }), [loadLocations]);
  const setLocation = async (date, place, label = null) => {
    try { const r = await put('/location/day', { date, place, label }); setLocations((l) => ({ ...l, [date]: r.place ? r : null })); }
    catch (e) { toast(e.message, 'error'); }
  };
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
  useEffect(() => onLive((m) => { if (m.type === 'calendar-shares') loadBusy(); }), [loadBusy]); // someone shared theirs with you (or stopped)
  useEffect(() => { const t = setInterval(loadBusy, 60e3); return () => clearInterval(t); }, [loadBusy]);
  // The upcoming list (next 30 days) doesn't depend on the period on screen.
  const [upcomingList, setUpcoming] = useState([]);
  const load = useCallback(() => {
    const from = days[0].getTime();
    const to = days[days.length - 1].getTime() + DAY;
    // Repeating events come back once; each occurrence is worked out here, in local time.
    const hidden = new Set(hiddenKey ? hiddenKey.split(',') : []);
    const shown = (list) => list.filter((e) => !((e.role === 'organizer' || e.role === 'shared') && e.calendar_id && hidden.has(e.calendar_id)));
    get(`/events?from=${from}&to=${to}`).then((list) => setEvents(expandAll(shown(list), from, to))).catch((e) => toast(e.message, 'error'));
    const now = Date.now();
    get(`/events?from=${now}&to=${now + 30 * DAY}`).then((list) => setUpcoming(expandAll(shown(list), now, now + 30 * DAY))).catch(() => {});
  }, [days, toast, hiddenKey]);
  useEffect(load, [load]);
  // Someone changed an event you organise or are invited to.
  useEffect(() => onLive((m) => { if (m.type === 'events-changed') { load(); loadCals(); } }), [load, loadCals]);
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
  const loadHolidays = useCallback(() => {
    const last = new Date(days[days.length - 1]);
    get(`/time-off/holidays?from=${toDateInput(days[0].getTime())}&to=${toDateInput(last.getTime())}`).then(setHolidays).catch(() => setHolidays([]));
  }, [days]);
  useEffect(() => { loadHolidays(); }, [loadHolidays]);
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
  const unit = view === 'day' ? 'day' : view === 'week' ? 'week' : view === 'year' ? 'year' : 'month';

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
      const rule = shiftWeekdays(ev.rrule, dayDelta, start);
      await applyEdit(ev, { start, end, ...(rule !== ev.rrule && { rrule: rule }) }, which);
      toast(start === ev.start ? `Now ends at ${fmtTime(end)}` : `Moved to ${new Date(start).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}${ev.all_day ? '' : `, ${fmtTime(start)}`}`);
    } catch (e) { toast(e.message, 'error'); }
    load();
  }
  const drag = useEventDrag((ev, start, end) => (ev.rrule ? setPendingMove({ ev, start, end }) : commitMove(ev, start, end)));
  const moving = drag.drag || pendingMove;
  const shown = useMemo(() => [...(moving
    ? events.map((e) => ((e.key || e.id) === (moving.ev.key || moving.ev.id) ? { ...e, start: moving.start, end: moving.end, dragging: true } : e))
    : events), ...taskItems(tasks), ...birthdayItems(birthdays), ...holidayItems(holidays)], [events, moving, tasks, birthdays, holidays]);

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
        {managed.length > 0 && (
          <label className="field mailbox-pick"><span className="small muted">Calendar</span>
            <select aria-label="Calendar" value={acting?.id || ''} onChange={(e) => onPick(e.target.value || null)}>
              <option value="">My calendar</option>
              {managed.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </label>
        )}
        {acting && <div className="banner small" role="status"><strong>{acting.name}</strong>’s calendar: events you add, change or delete here are theirs (they’re told).</div>}
        <button className="btn new-btn" onClick={() => newEvent()}><Icon name="plus" /> Create</button>
        {!acting && <>
        <button type="button" className="subnav-item" onClick={() => setTimeOff(true)}><span aria-hidden="true" style={{ width: 24, textAlign: 'center' }}>🏖</span><span className="grow">Time off</span>{timeOffWaiting > 0 && <span className="timeoff-count" aria-label={`${timeOffWaiting} waiting for your answer`}>{timeOffWaiting}</span>}</button>
        {timeOff && <TimeOff onClose={() => { setTimeOff(false); refreshTimeOff(); loadHolidays(); }} onChanged={() => { load(); refreshTimeOff(); loadHolidays(); }} />}
        <button type="button" className="subnav-item" onClick={() => { const d = startOfDay(new Date()).getTime(); setEditing({ title: 'Out of office', kind: 'ooo', start: d, end: d + DAY - 1, all_day: 1, color: '#5f6368', location: '', description: '' }); }}><span aria-hidden="true" style={{ width: 24, textAlign: 'center' }}>🌴</span><span className="grow">Out of office…</span></button>
        <button type="button" className="subnav-item" onClick={() => { const t = new Date(); t.setMinutes(0, 0, 0); t.setHours(t.getHours() + 1); setEditing({ title: 'Focus time', kind: 'focus', start: t.getTime(), end: t.getTime() + 2 * 36e5, all_day: 0, color: '#7b61ff', location: '', description: '' }); }}><span aria-hidden="true" style={{ width: 24, textAlign: 'center' }}>🎯</span><span className="grow">Focus time…</span></button>
        <button type="button" className="subnav-item" onClick={() => setInsightsOpen(true)}><span aria-hidden="true" style={{ width: 24, textAlign: 'center' }}>📊</span><span className="grow">Time insights</span></button>
        <button type="button" className="subnav-item" onClick={() => setBookingOpen(true)}><Icon name="link" /><span className="grow">Booking pages</span></button>
        <button type="button" className="subnav-item" onClick={() => setHoursOpen(true)}><Icon name="clock" /><span className="grow">Working hours</span></button>
        <button type="button" className="subnav-item" onClick={() => setSharingOpen(true)}><Icon name="share" /><span className="grow">Share my calendar</span></button>
        <button type="button" className="subnav-item" onClick={() => setPrintOpen(true)}><Icon name="print" /><span className="grow">Print or save as PDF</span></button>
        <button type="button" className="subnav-item" onClick={() => importInput.current.click()}><Icon name="upload" /><span className="grow">Import (.ics)</span></button>
        <input ref={importInput} type="file" accept=".ics,text/calendar" hidden aria-label="Calendar file to import" onChange={(e) => { importIcs(e.target.files[0]); e.target.value = ''; }} />
        <a className="subnav-item" href="/api/events/export" download><Icon name="download" /><span className="grow">Export (.ics)</span></a>
        </>}
        {!acting && <MyCalendars calendars={myCals} me={me} people={people.filter((p) => p.id !== me.id)} onChanged={() => { loadCals(); load(); }} onImport={importIcs}
          onToggle={(c, hidden) => { setMyCals((l) => l.map((x) => (x.id === c.id ? { ...x, hidden } : x))); patch(`/events/calendars/${c.id}`, { hidden }).catch((e) => { toast(e.message, 'error'); loadCals(); }); }} />}
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
        <Feeds onChanged={load} />
        <label className="check cal-show-tasks"><input type="checkbox" checked={showTasks} onChange={(e) => setShowTasks(e.target.checked)} /> Show tasks with due dates</label>
        <label className="check cal-show-tasks"><input type="checkbox" checked={showBirthdays} onChange={(e) => setShowBirthdays(e.target.checked)} /> Show contacts’ birthdays and dates</label>
        <label className="check cal-show-tasks"><input type="checkbox" checked={weekends} onChange={(e) => setWeekends(e.target.checked)} /> Show weekends</label>
        <label className="check cal-show-tasks"><input type="checkbox" checked={weekNums} onChange={(e) => setWeekNums(e.target.checked)} /> Show week numbers</label>
        <label className="row small cal-show-tasks" style={{ gap: 6 }}>Week starts on
          <select value={weekStart} onChange={(e) => setWeekStart(Number(e.target.value))} aria-label="Week starts on">
            <option value={0}>Sunday</option><option value={1}>Monday</option><option value={6}>Saturday</option>
          </select>
        </label>
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
          <h1 aria-live="polite">{title(view, anchor, undefined, weekStart)}{weekNums && (view === 'week' || view === 'day') && <span className="muted cal-weeknum"> · Week {isoWeek(view === 'week' ? gridDays[0] : anchor)}</span>}</h1>
          <div className="grow" />
          <div className="seg" role="radiogroup" aria-label="View">
            {VIEWS.map((v) => <button key={v} type="button" role="radio" aria-checked={view === v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>{VIEW_NAMES[v]}</button>)}
          </div>
        </div>
        {view === 'month' ? (
          <div className="month" style={weekends ? undefined : { gridTemplateColumns: 'repeat(5, minmax(0, 1fr))' }}>
            {weekOrder(weekStart).filter((i) => weekends || (i !== 0 && i !== 6)).map((i) => <div key={i} className="dow">{['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][i]}</div>)}
            {gridDays.map((d, k) => {
              const list = onDay(shown, d).sort((a, b) => b.all_day - a.all_day || a.start - b.start);
              return (
                <div key={d.toISOString()} data-day={d.getTime()} className={`day ${d.getMonth() !== anchor.getMonth() ? 'other' : ''} ${d.getTime() === today ? 'today' : ''}`}
                  onClick={drag.click((e) => e.target === e.currentTarget && newEvent(d))}>
                  {weekNums && k % (weekends ? 7 : 5) === 0 && <span className="weeknum muted" title={`Week ${isoWeek(d)}`}>W{isoWeek(d)}</span>}
                  <button type="button" className="daynum" aria-label={`Open ${d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}`} onClick={() => openDay(d)}>{d.getDate()}</button>
                  {list.slice(0, 3).map((ev) => (ev.task ? <TaskChip key={ev.key} ev={ev} onDone={taskDone} /> : ev.birthday ? <BirthdayChip key={ev.key} ev={ev} /> : ev.holiday ? <HolidayChip key={ev.key} ev={ev} /> : (
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
        ) : view === 'year' ? (
          <YearView year={anchor.getFullYear()} weekStart={weekStart} counts={eventsPerDay(shown, days)} today={today} onDay={openDay} />
        ) : view === 'schedule' ? (
          <Schedule days={days} events={shown} today={today} onOpen={setEditing} onTaskDone={taskDone} onDay={openDay} />
        ) : (
          <TimeGrid days={gridDays} events={shown} busy={busy} today={today} onOpen={setEditing} onNew={newEvent} onDay={view === 'week' ? openDay : null} drag={drag} onTaskDone={taskDone}
            locations={locations} onLocation={(d, place) => (place === 'other' ? setOtherFor(d) : setLocation(d, place))} />
        )}
      </section>
      {bookingOpen && <BookingPagesDialog onClose={() => setBookingOpen(false)} />}
      {hoursOpen && <WorkHoursDialog onClose={() => setHoursOpen(false)} />}
      {printOpen && <PrintAgenda weekStart={weekStart} onClose={() => setPrintOpen(false)} />}
      {sharingOpen && <ShareCalendarDialog people={people.filter((p) => p.id !== me.id)} onClose={() => setSharingOpen(false)} />}
      {insightsOpen && <TimeInsights anchor={anchor} onClose={() => setInsightsOpen(false)} />}
      {otherFor && <PromptModal title="Working elsewhere" label="Where?" confirm="Save" onClose={() => setOtherFor(null)}
        onSubmit={async (where) => { await setLocation(otherFor, 'other', where.trim() || null); setOtherFor(null); }} />}
      {editing && (editing.role === 'feed' || (editing.role === 'shared' && !editing.can_edit) ? <FeedEventDialog event={editing} calendar={myCals.find((c) => c.id === editing.calendar_id)} onClose={() => setEditing(null)} /> : editing.role === 'guest'
        ? <InvitationDialog event={editing} onClose={() => setEditing(null)} onAnswered={() => { setEditing(null); load(); }} />
        : <EventDialog key={editing.id ? `${editing.id}:${editing.start}` : `new:${editing.duplicateOf || ''}:${editing.start}`} event={editing} calendars={editing.role === 'shared' ? [] : myCals.filter((c) => !c.shared || c.can_edit)} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); loadCals(); }}
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
/** Twelve small months; days with events are marked (darker for more), and a click opens the day. */
function YearView({ year, weekStart = 0, counts, today, onDay }) {
  const dows = weekOrder(weekStart).map((i) => 'SMTWTFS'[i]);
  return (
    <div className="year-view">
      {Array.from({ length: 12 }, (_, m) => {
        const first = new Date(year, m, 1);
        const n = new Date(year, m + 1, 0).getDate();
        return (
          <section key={m} className="year-month" aria-label={first.toLocaleDateString([], { month: 'long', year: 'numeric' })}>
            <h3>{first.toLocaleDateString([], { month: 'long' })}</h3>
            <div className="year-grid">
              {dows.map((d, i) => <span key={i} className="year-dow muted" aria-hidden="true">{d}</span>)}
              {Array.from({ length: (first.getDay() - weekStart + 7) % 7 }, (_, i) => <span key={`b${i}`} />)}
              {Array.from({ length: n }, (_, i) => {
                const d = new Date(year, m, i + 1);
                const c = counts.get(d.getTime()) || 0;
                return (
                  <button key={i} type="button" className={`year-day ${c ? `busy busy-${Math.min(c, 3)}` : ''} ${d.getTime() === today ? 'today' : ''}`}
                    aria-label={`${d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}${c ? `, ${c} ${c === 1 ? 'event' : 'events'}` : ''}`}
                    title={c ? `${c} ${c === 1 ? 'event' : 'events'}` : undefined} onClick={() => onDay(d)}>{i + 1}</button>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

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
                {ev.task ? <TaskChip ev={ev} onDone={onTaskDone} /> : ev.birthday ? <BirthdayChip ev={ev} /> : ev.holiday ? <HolidayChip ev={ev} /> : (
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

/** How a week's time was spent: meetings, focus time and the rest, each day, and who you meet with most. */
function TimeInsights({ anchor, onClose }) {
  const { user } = useAuth();
  const monday = (d) => { const x = startOfDay(new Date(d)); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
  const [week, setWeek] = useState(() => monday(anchor).getTime());
  const [data, setData] = useState(null);
  useEffect(() => {
    const to = new Date(week); to.setDate(to.getDate() + 7);
    setData(null);
    get(`/events?from=${week}&to=${to.getTime()}`).then((list) => setData(insights(expandAll(list, week, to.getTime()), week, to.getTime(), user.username))).catch(() => setData(insights([], week, to.getTime(), user.username)));
  }, [week, user.username]);
  const step = (n) => { const d = new Date(week); d.setDate(d.getDate() + 7 * n); setWeek(d.getTime()); };
  const end = new Date(week); end.setDate(end.getDate() + 6);
  const range = `${new Date(week).toLocaleDateString([], { day: 'numeric', month: 'short' })} – ${end.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}`;
  const most = data ? Math.max(1, ...data.byDay.map((d) => d.meetings + d.focus + d.other)) : 1;
  return (
    <Modal title="Time insights" onClose={onClose}>
      <div className="stack insights">
        <div className="row"><button type="button" className="icon-btn" aria-label="Previous week" onClick={() => step(-1)}>‹</button><strong className="grow" style={{ textAlign: 'center' }}>{range}</strong><button type="button" className="icon-btn" aria-label="Next week" onClick={() => step(1)}>›</button></div>
        {!data ? <p className="muted">Loading…</p> : <>
          <div className="insight-tiles" role="list" aria-label="This week">
            <div role="listitem"><span className="insight-num">{hoursText(data.meetings)}</span><span className="muted small"><i className="ins-dot meetings" /> In meetings</span></div>
            <div role="listitem"><span className="insight-num">{hoursText(data.focus)}</span><span className="muted small"><i className="ins-dot focus" /> Focus time</span></div>
            <div role="listitem"><span className="insight-num">{hoursText(data.other)}</span><span className="muted small"><i className="ins-dot other" /> Other events</span></div>
          </div>
          <ul className="insight-days" aria-label="Each day">
            {data.byDay.map((d) => {
              const label = new Date(d.day).toLocaleDateString([], { weekday: 'short' });
              const sum = d.meetings + d.focus + d.other;
              return (
                <li key={d.day} title={`${label}: ${hoursText(d.meetings)} meetings, ${hoursText(d.focus)} focus, ${hoursText(d.other)} other`}>
                  <span className="insight-day">{label}</span>
                  <span className="insight-bar" aria-label={`${label}: ${hoursText(Math.round(sum * 10) / 10)}`}>
                    {['meetings', 'focus', 'other'].map((k) => d[k] > 0 && <span key={k} className={`seg ${k}`} style={{ width: `${(d[k] / most) * 100}%` }} />)}
                  </span>
                  <span className="muted small nowrap">{sum ? hoursText(Math.round(sum * 10) / 10) : '—'}</span>
                </li>
              );
            })}
          </ul>
          {data.people.length > 0 && (
            <div className="stack-tight">
              <strong className="small">Who you meet with most</strong>
              <ul className="insight-people">
                {data.people.map((p) => <li key={p.email} className="row"><span className="grow">{p.name}</span><span className="muted small">{hoursText(p.hours)} · {p.count === 1 ? '1 meeting' : `${p.count} meetings`}</span></li>)}
              </ul>
            </div>
          )}
          <p className="muted small" style={{ margin: 0 }}>Only you see this. Meetings are events with other people; all-day events, out of office and invitations you declined aren't counted.</p>
        </>}
      </div>
    </Modal>
  );
}

/** One day's working location, with a menu to change it. */
function LocationCell({ date, loc, onLocation }) {
  const label = new Date(`${date}T12:00:00`).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
  return (
    <Menu align="left" trigger={(p) => <button type="button" className={`tg-loc-btn ${loc ? 'set' : ''}`} aria-label={`Working location on ${label}: ${loc ? placeText(loc) : 'not set'}`} {...p}>{loc ? placeText(loc) : '+ Location'}</button>}
      items={[
        ...PLACES.map(([k, icon, name]) => ({ label: `${loc?.place === k ? '✓ ' : ''}${icon} ${k === 'other' ? 'Elsewhere…' : name}`, onClick: () => onLocation(date, k) })),
        ...(loc?.from === 'day' ? [{ label: 'Back to my usual week', onClick: () => onLocation(date, null) }] : []),
      ]} />
  );
}

function TimeGrid({ days, events, busy = [], today, onOpen, onNew, onDay: openDay, drag, onTaskDone, locations, onLocation }) {
  const { user } = useAuth();
  const tz2 = user.second_tz; // a second column of hours, if chosen
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
  const cols = { gridTemplateColumns: `${tz2 ? 72 : 56}px repeat(${days.length}, minmax(0, 1fr))` };
  const day0 = days[0]?.getTime() ?? Date.now();
  const dayLabel = (d) => d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });

  return (
    <div className="timegrid" data-days={days.length}>
      <div className="tg-head" style={cols}>
        {tz2 ? <div className="tg-zones small muted" title={`Your time, and ${cityOf(tz2)}`}><span>{zoneName(Intl.DateTimeFormat().resolvedOptions().timeZone, day0)}</span><span className="tz2">{zoneName(tz2, day0)}</span></div> : <div />}
        {days.map((d) => {
          const isToday = d.getTime() === today;
          const inner = <><span className="tg-dow">{d.toLocaleDateString([], { weekday: 'short' })}</span><span className={`tg-num ${isToday ? 'today' : ''}`}>{d.getDate()}</span></>;
          return openDay
            ? <button key={d.getTime()} type="button" className="tg-day" aria-label={`Open ${dayLabel(d)}`} onClick={() => openDay(d)}>{inner}</button>
            : <div key={d.getTime()} className="tg-day">{inner}</div>;
        })}
      </div>
      {locations && (
        <div className="tg-loc" style={cols} role="group" aria-label="Working location">
          <div className="tg-gutter small muted" title="Where you're working">📍</div>
          {days.map((d) => <div key={d.getTime()} className="tg-loc-cell"><LocationCell date={isoDay(d)} loc={locations[isoDay(d)]} onLocation={onLocation} /></div>)}
        </div>
      )}
      <div className="tg-allday" style={cols}>
        <div className="tg-gutter small muted">all day</div>
        {days.map((d) => (
          <div key={d.getTime()} className="tg-allday-cell" data-day={d.getTime()}>
            {onDay(events, d).filter((ev) => ev.all_day).map((ev) => (ev.task ? <TaskChip key={ev.key} ev={ev} onDone={onTaskDone} /> : ev.birthday ? <BirthdayChip key={ev.key} ev={ev} /> : ev.holiday ? <HolidayChip key={ev.key} ev={ev} /> : (
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
              <div key={h} className="tg-hour small muted" style={{ top: h * HOUR_PX }}>{h ? new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' }) : ''}
                {tz2 && h > 0 && <span className="tz2" aria-label={`${cityOf(tz2)}: ${timeIn(day0 + h * 36e5, tz2)}`}>{timeIn(day0 + h * 36e5, tz2)}</span>}</div>
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
                  title={b.room ? `${b.name}: ${b.title} (${b.organizer}), ${fmtTime(b.start)} – ${fmtTime(b.end)}` : b.title ? `${b.name}: ${b.title}${b.location ? ` (${b.location})` : ''}, ${fmtTime(b.start)} – ${fmtTime(b.end)}` : `${b.name} is ${b.ooo ? 'out of office' : 'busy'} ${fmtTime(b.start)} – ${fmtTime(b.end)}`}
                  aria-label={b.room ? `${b.name} booked: ${b.title} by ${b.organizer}, ${fmtTime(b.start)} to ${fmtTime(b.end)}` : b.title ? `${b.name}: ${b.title}${b.location ? ` at ${b.location}` : ''}, ${fmtTime(b.start)} to ${fmtTime(b.end)}` : `${b.name} ${b.ooo ? 'out of office' : 'busy'} ${fmtTime(b.start)} to ${fmtTime(b.end)}`}><span>{b.name}{b.room || b.title ? ` · ${b.title}` : b.ooo ? ' · out of office' : ''}</span></div>;
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
const inviteClass = (ev) => (ev.kind === 'ooo' ? 'ooo' : ev.kind === 'focus' ? 'focus' : ev.role !== 'guest' ? '' : ev.my_status === 'no' ? 'declined' : ev.my_status === 'yes' ? '' : 'tentative');
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
  const [note, setNote] = useState(event.my_note || ''); // goes with the answer, for the organizer
  const answer = async (status) => {
    try { await post(`/events/${event.id}/rsvp`, { status, note }); toast(`Answered ${ANSWER_LABELS[status]}${note.trim() ? ' with a note' : ''}`); onAnswered(); } catch (e) { toast(e.message, 'error'); }
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
          <input aria-label="Note for the organizer" placeholder="Add a note for the organizer (optional), e.g. “I'll join 10 minutes late”" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
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
        {guests.map((g) => <li key={g.email}><span className={`rsvp ${g.status}`} aria-hidden="true" />{g.name || g.email} <span className="muted small">{g.name ? `${g.email} · ` : ''}{g.external ? 'by email · ' : ''}{ANSWER_LABELS[g.status]}</span>{g.answer_note && <span className="small guest-note"> “{g.answer_note}”</span>}</li>)}
      </ul>
    </div>
  );
}

const WEEKDAY_LETTERS = Array.from({ length: 7 }, (_, d) => new Date(2026, 10, 1 + d)); // a Sunday-first week
/**
 * The menu's monthly choice that fits the start date: "on the second Monday" isn't offered for a
 * fifth Monday, and "on the last Friday" only in the last week of the month.
 */
const monthlyChoice = (freq, start) => {
  const w = weekdayInMonth(start);
  if (freq === 'monthly-nth' && w.nth > 4) return 'monthly-last';
  if (freq === 'monthly-last' && !w.last) return 'monthly-nth';
  return freq;
};
const ruleFromForm = (r, start) => {
  if (r.freq === 'none') return null;
  const freq = monthlyChoice(r.freq, start);
  const out = { freq: freq.startsWith('monthly') ? 'monthly' : freq };
  if (freq !== 'monthly' && freq.startsWith('monthly')) { const w = weekdayInMonth(start); out.nth = freq === 'monthly-last' ? -1 : w.nth; out.wd = w.wd; }
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
/** Print or save as PDF: an agenda of a week, a month, four weeks or chosen dates, day by day. */
function PrintAgenda({ onClose, weekStart = 1 }) {
  const [kind, setKind] = useState('week');
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const [custom, setCustom] = useState(() => { const r = printRange('week', new Date(), weekStart); return { from: iso(r.from), to: iso(r.to) }; });
  const range = kind === 'custom' ? { from: new Date(`${custom.from}T00:00`), to: new Date(`${custom.to}T00:00`) } : printRange(kind, new Date(), weekStart);
  const [events, setEvents] = useState(null);
  const from = range.from.getTime(), to = range.to.getTime() + DAY;
  useEffect(() => {
    if (!(to > from)) { setEvents([]); return; }
    setEvents(null);
    get(`/events?from=${from}&to=${to}`).then((list) => setEvents(expandAll(list, from, to).filter((e) => e.my_status !== 'no'))).catch(() => setEvents([]));
  }, [from, to]);
  const days = to > from ? daysFromTo(range.from, range.to) : [];
  const list = events ? scheduleOf(events, days) : [];
  const title = `${range.from.toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' })} – ${range.to.toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' })}`;
  const print = () => {
    document.body.classList.add('printing-agenda');
    const done = () => { document.body.classList.remove('printing-agenda'); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    window.print();
    setTimeout(done, 1000);
  };
  const agenda = (
    <div className="print-agenda" aria-label="Agenda to print">
      <h1>{title}</h1>
      {events === null ? <p className="muted">Loading…</p> : !list.length ? <p className="muted">Nothing scheduled.</p> : list.map(({ day, items }) => (
        <section key={day.getTime()} className="agenda-day">
          <h2>{day.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}</h2>
          <table><tbody>{items.map((ev) => (
            <tr key={ev.key || `${ev.id}:${ev.start}`}>
              <td className="agenda-time">{ev.all_day ? 'All day' : `${fmtTime(ev.start)} – ${fmtTime(ev.end)}`}</td>
              <td><strong>{ev.title || '(No title)'}</strong>{ev.location ? <span className="agenda-where"> · {ev.location}</span> : ''}{ev.kind === 'ooo' ? ' (out of office)' : ''}</td>
            </tr>
          ))}</tbody></table>
        </section>
      ))}
    </div>
  );
  return (<>
    <Modal wide title="Print or save as PDF" onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Close</button><button type="button" className="btn primary" disabled={events === null} onClick={print}><Icon name="print" size={18} /> Print</button></>}>
      <div className="stack">
        <div className="row wrap">
          <label className="field"><span>What to print</span>
            <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="What to print">
              <option value="week">This week</option><option value="month">This month</option><option value="four">The next four weeks</option><option value="custom">Dates I choose…</option>
            </select></label>
          {kind === 'custom' && <>
            <label className="field"><span>From</span><input type="date" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} /></label>
            <label className="field"><span>To</span><input type="date" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} /></label>
          </>}
        </div>
        <p className="muted small" style={{ margin: 0 }}>Your events and the invitations you haven't declined, day by day (up to three months). Choose “Save as PDF” in the print window to keep a copy.</p>
        <div className="agenda-preview">{agenda}</div>
      </div>
    </Modal>
    {createPortal(<div className="print-agenda-root">{agenda}</div>, document.body)}
  </>);
}

/** Share my calendar: the colleagues who see what your events are (everyone else sees only when you're busy). */
function ShareCalendarDialog({ people, onClose }) {
  const toast = useToast();
  const [shares, setShares] = useState(null);
  useEffect(() => { get('/freebusy/shares').then(setShares).catch(() => setShares({ with: [], from: [] })); }, []);
  const save = async (ids, editors = (shares?.with || []).filter((u) => u.can_edit && ids.includes(u.id)).map((u) => u.id)) => {
    // Ticks change at once; the server's answer follows (and wins).
    if (shares) setShares({ ...shares, with: shares.with.filter((u) => ids.includes(u.id)).map((u) => ({ ...u, can_edit: editors.includes(u.id) })) });
    try { setShares(await put('/freebusy/shares', { users: ids, editors })); } catch (e) { toast(e.message, 'error'); get('/freebusy/shares').then(setShares).catch(() => {}); }
  };
  if (!shares) return null;
  const ids = shares.with.map((u) => u.id);
  const editors = shares.with.filter((u) => u.can_edit).map((u) => u.id);
  return (
    <Modal title="Share my calendar" onClose={onClose} footer={<button type="button" className="btn" onClick={onClose}>Done</button>}>
      <div className="stack">
        <p className="muted small" style={{ margin: 0 }}>Colleagues see when you're busy when they look at your calendar beside theirs. The people here also see what your events are: the title and place of each.</p>
        {shares.with.length ? (
          <ul className="group-people" aria-label="Sees your event details">
            {shares.with.map((u) => (
              <li key={u.id} className="row"><span className="grow">{u.name}</span>
                <label className="check small"><input type="checkbox" checked={u.can_edit} onChange={(e) => save(ids, e.target.checked ? [...editors, u.id] : editors.filter((x) => x !== u.id))} aria-label={`${u.name} can make and change events`} /> Can make and change events</label>
                <button type="button" className="link-btn small" aria-label={`Stop sharing with ${u.name}`} onClick={() => save(ids.filter((x) => x !== u.id))}>Remove</button></li>
            ))}
          </ul>
        ) : <p className="small" style={{ margin: 0 }}>Nobody sees your event details yet.</p>}
        <select className="dm-pick" value="" aria-label="Share with a colleague" onChange={(e) => { if (e.target.value) save([...ids, e.target.value]); }}>
          <option value="">+ Share with a colleague…</option>
          {people.filter((p) => !ids.includes(p.id)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <p className="muted small" style={{ margin: 0 }}>With <strong>Can make and change events</strong> (an assistant), they can also open your calendar (Calendar at the top of the sidebar) and add, change and delete events on it, as you; you're told each time.</p>
        {shares.from.length > 0 && <p className="muted small" style={{ margin: 0 }}>Sharing theirs with you: {shares.from.map((u) => `${u.name}${u.can_edit ? ' (you can manage it)' : ''}`).join(', ')}. Add them under <strong>Other calendars</strong> to see their events.</p>}
      </div>
    </Modal>
  );
}

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

function EventDialog({ event, calendars = [], onClose, onSaved, onDuplicate }) {
  const toast = useToast();
  const recurring = !!(event.id && event.rrule);
  const [f, setF] = useState({
    title: event.title, location: event.location || '', description: event.description || '', color: event.color || COLORS[0], calendar_id: event.calendar_id || null,
    all_day: !!event.all_day, ooo: event.kind === 'ooo', focus: event.kind === 'focus',
    startDate: toDateInput(event.start), startTime: toTimeInput(event.start),
    endDate: toDateInput(event.end), endTime: toTimeInput(event.end),
  });
  const special = f.ooo || f.focus; // just you: no guests, rooms, place or video meeting
  // Out of office: also turn on the email auto-reply for the same days (when this server has email).
  const mail = useMailStatus();
  const [autoReply, setAutoReply] = useState(false);
  const r0 = event.rrule;
  const [rep, setRep] = useState({
    freq: r0?.nth ? (r0.nth === -1 ? 'monthly-last' : 'monthly-nth') : r0?.freq || 'none', interval: r0?.interval || 1, byday: r0?.byday || [new Date(event.start).getDay()],
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
  // Meeting notes: made (once) on the server, attached here, and opened in a new tab.
  const [notesId, setNotesId] = useState(event.notes_id || null);
  const takeNotes = async () => {
    const tab = window.open('', '_blank');
    try {
      const r = await post(`/events/${event.id}/notes`, { tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
      setNotesId(r.id);
      const doc = await get(`/files/${r.id}`);
      setAttachments((list) => (list.some((a) => a.id === r.id) ? list : [...list, { id: r.id, name: doc.name, kind: 'doc', can_open: true }]));
      if (tab) tab.location.href = `/docs/${r.id}`; else window.location.href = `/docs/${r.id}`;
      if (r.created) toast('Meeting notes made and attached. Guests can edit them.');
    } catch (e) { tab?.close(); toast(e.message, 'error'); }
  };
  const [guestInput, setGuestInput] = useState('');
  const [directory, setDirectory] = useState([]);
  useEffect(() => { get('/users/directory').then(setDirectory).catch(() => {}); }, []);
  const [groups, setGroups] = useState([]);
  useEffect(() => { get('/groups').then(setGroups).catch(() => {}); }, []);
  const { user: me } = useAuth();
  const addGroup = (id) => {
    const g = groups.find((x) => x.id === id);
    if (g) setGuests((list) => [...new Set([...list, ...g.members.map((m) => m.username.toLowerCase()).filter((u) => u !== me.username.toLowerCase())])]);
  };
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
    return { start, end, body: { title: f.title, location: special ? '' : f.location, description: f.description, color: f.color, all_day: f.all_day, start, end, ...(calendars.length || event.calendar_id ? { calendar_id: f.calendar_id } : {}), rrule: ruleFromForm(rep, start),
      guests: special ? [] : all, reminders, tz: TZ, attachments: attachments.map((a) => a.id), kind: f.ooo ? 'ooo' : f.focus ? 'focus' : null, meet_code: special ? null : meet, ...(event.id && !event.rooms?.length && !roomIds.length ? {} : { rooms: special ? [] : roomIds }) } };
  };

  async function save(which) {
    const { start, end, body } = read();
    if (end < start) return setError('The event ends before it starts');
    // With the auto-reply, the server turns it on for the event's days, along with saving it.
    await applyEdit(event, f.ooo && autoReply ? { ...body, auto_reply: true } : body, which);
    if (f.ooo && autoReply) toast(`Email auto-reply on from ${f.startDate} to ${f.endDate}`);
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
        {event.ext_organizer && <p className="muted small" style={{ margin: 0 }} role="note">📨 An invitation from {event.ext_organizer.name || event.ext_organizer.email}, by email{event.ext_status ? ` · you answered ${{ yes: 'Yes', maybe: 'Maybe', no: 'No' }[event.ext_status]}` : ''}. Changes here are only on your calendar; to change your answer, use the invitation in Mail.</p>}
        <label className="field"><span>Title</span><input autoFocus required value={f.title} onChange={set('title')} /></label>
        <label className="check"><input type="checkbox" checked={f.all_day} onChange={set('all_day')} /> All day</label>
        <div className="row wrap" style={{ gap: 16 }}>
          <label className="check"><input type="checkbox" checked={f.ooo} onChange={(e) => setF({ ...f, ooo: e.target.checked, focus: false })} /> Out of office</label>
          <label className="check"><input type="checkbox" checked={f.focus} onChange={(e) => setF({ ...f, focus: e.target.checked, ooo: false })} /> Focus time</label>
        </div>
        {f.focus && <p className="muted small" style={{ margin: 0 }}>While it lasts, new invitations for this time are declined for you and notifications are paused (they still arrive in the bell).</p>}
        {f.ooo && <p className="muted small" style={{ margin: 0 }}>While you're away, new invitations for this time are declined for you, and whoever sent them sees the description below as your message. Colleagues see you as out of office.</p>}
        {f.ooo && mail?.enabled && <label className="check"><input type="checkbox" checked={autoReply} onChange={(e) => setAutoReply(e.target.checked)} /> Also turn on my email auto-reply for these days (with the message below)</label>}
        <div className="row wrap">
          <label className="field"><span>Starts</span><input type="date" required value={f.startDate} onChange={(e) => setF(e.target.value ? moveStart(f, { startDate: e.target.value }) : { ...f, startDate: '' })} /></label>
          {!f.all_day && <label className="field"><span>&nbsp;</span><input type="time" required value={f.startTime} onChange={(e) => setF(e.target.value ? moveStart(f, { startTime: e.target.value }) : { ...f, startTime: '' })} aria-label="Start time" /></label>}
        </div>
        <div className="row wrap">
          <label className="field"><span>Ends</span><input type="date" required value={f.endDate} onChange={set('endDate')} /></label>
          {!f.all_day && <label className="field"><span>&nbsp;</span><input type="time" required value={f.endTime} onChange={set('endTime')} aria-label="End time" /></label>}
        </div>
        {!special && <FindATime guests={guests} directory={directory} minutes={(() => { const { start, end } = read(); return f.all_day || !(end > start) ? 60 : Math.min(480, Math.max(15, Math.round((end - start) / 6e4))); })()}
          onPick={(s, e) => setF({ ...f, all_day: false, startDate: toDateInput(s), startTime: toTimeInput(s), endDate: toDateInput(e), endTime: toTimeInput(e) })} />}
        <div className="repeat-box stack">
          <div className="row wrap">
            <label className="field"><span>Repeat</span>
              <select value={monthlyChoice(rep.freq, read().start)} onChange={setR('freq')} aria-label="Repeat">
                <option value="none">Does not repeat</option><option value="daily">Daily</option><option value="weekly">Weekly</option>
                <option value="monthly">Monthly (same date)</option>
                {(() => {
                  // "Monthly on the second Monday", and "on the last Monday" in a month's last week.
                  const start = read().start, w = weekdayInMonth(start);
                  return <>
                    {w.nth <= 4 && <option value="monthly-nth">{describeRule({ freq: 'monthly', nth: w.nth, wd: w.wd }, start)}</option>}
                    {w.last && <option value="monthly-last">{describeRule({ freq: 'monthly', nth: -1, wd: w.wd }, start)}</option>}
                  </>;
                })()}
                <option value="yearly">Yearly</option>
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
        {!special && <div className="field">
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
                  {known?.answer_note && <span className="small guest-note" title="Their note with the answer"> “{known.answer_note}”</span>}
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
          {groups.some((g) => g.members.length) && (
            <select value="" aria-label="Invite a group" onChange={(e) => addGroup(e.target.value)}>
              <option value="">Invite a group…</option>
              {groups.filter((g) => g.members.length).map((g) => <option key={g.id} value={g.id}>{g.name} ({g.members.length})</option>)}
            </select>
          )}
          {guests.length > 0 && <span className="muted small">They'll see it in their calendar{event.id ? '' : ' and get an email'} and can answer Yes, Maybe or No.
            {guests.some((g) => { const k = (event.guests || []).find((x) => x.email === g); return k ? k.external : !directory.some((d) => d.username === g); })
              && ' People outside Workspace get an email invitation for their own calendar (Outlook, Gmail, phone) and a link to answer; they also get changes and cancellations.'}</span>}
        </div>}
        {!special && <RoomPicker eventId={event.id} chosen={roomIds} booked={event.rooms || []} onChange={setRoomIds} when={(() => { const r = read(); return r.end > r.start ? [r.start, r.end] : null; })()} />}
        <RemindersField value={reminders} onChange={setReminders} />
        {!special && <label className="field"><span>Location</span><input value={f.location} onChange={set('location')} /></label>}
        {!special && (meet ? <MeetLine code={meet} onRemove={() => setMeet(null)} />
          : <div><button type="button" className="btn" onClick={addMeet}><Icon name="video" size={18} /> Add video meeting</button></div>)}
        <label className="field"><span>{f.ooo ? 'Message for people who invite you' : 'Description'}</span><textarea rows={3} value={f.description} onChange={set('description')} placeholder={f.ooo ? 'e.g. On holiday until Monday 9th; for anything urgent, ask Kim.' : undefined} /></label>
        {!special && (
          <div className="field"><span>Attachments</span>
            <Attachments list={attachments} onRemove={(a) => setAttachments(attachments.filter((x) => x.id !== a.id))} />
            <span className="row"><button type="button" className="btn small" onClick={() => setPickingFile(true)}><Icon name="attach" size={16} /> Attach from Drive</button>
              {event.id && <button type="button" className="btn small" onClick={takeNotes} title="A document for this meeting: when it is, who's coming, the agenda, notes and action items. Guests can edit it.">
                📝 {attachments.some((a) => a.id === notesId) ? 'Open meeting notes' : 'Take meeting notes'}</button>}</span>
            {attachments.length > 0 && (guests.length > 0 || guestInput.trim()) && <span className="muted small">Guests can view the files you own. They see the others only if they can already open them.</span>}
          </div>
        )}
        {pickingFile && <DrivePicker title="Attach to the event" accept={(x) => x.kind !== 'folder'} onClose={() => setPickingFile(false)}
          onPick={(x) => { if (!attachments.some((a) => a.id === x.id)) setAttachments([...attachments, { id: x.id, name: x.name, kind: x.kind, can_open: true }]); setPickingFile(false); }} />}
        {calendars.length > 0 && !special && (
          <label className="field"><span>Calendar</span>
            <select aria-label="Calendar" value={f.calendar_id || ''} onChange={(e) => {
              // The event takes the calendar's colour, unless it was given one of its own.
              const colourOf = (id) => calendars.find((c) => c.id === id)?.color || COLORS[0];
              const to = e.target.value || null;
              setF({ ...f, calendar_id: to, color: f.color === colourOf(f.calendar_id) ? colourOf(to) : f.color });
            }}>
              <option value="">My calendar</option>
              {calendars.map((c) => <option key={c.id} value={c.id}>{c.shared ? `${c.name} (${c.owner.name})` : c.name}</option>)}
            </select>
          </label>
        )}
        <div className="colors" role="radiogroup" aria-label="Color">
          {(COLORS.includes(f.color) ? COLORS : [...COLORS, f.color]).map((c) => (
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
              guests: body.guests.map((email) => ({ email })), reminders: body.reminders, duplicateOf: event.title, calendar_id: f.calendar_id });
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
/**
 * Your own calendars besides the main one, in the sidebar: tick to show or hide each one's events; ⋮ to
 * change its name and colour, download it, import a file into it, or delete it (with its events, or
 * keeping them in your main calendar); + to add one.
 */
function MyCalendars({ calendars: all, me, people = [], onChanged, onImport, onToggle }) {
  const toast = useToast();
  const calendars = all.filter((c) => !c.shared), theirs = all.filter((c) => c.shared);
  const [editing, setEditing] = useState(null); // {} for a new one, or the calendar
  const [deleting, setDeleting] = useState(null);
  const [sharing, setSharing] = useState(null);
  const importFor = useRef(null);
  const fileInput = useRef(null);
  const run = async (fn, ok) => { try { await fn(); if (ok) toast(ok); onChanged(); } catch (e) { toast(e.message, 'error'); } };
  return (
    <div className="cal-feeds my-cals">
      <div className="row"><span className="muted small grow" style={{ padding: '0 12px' }}>My calendars</span>
        <button type="button" className="icon-btn" aria-label="Add a calendar" title="A calendar of your own: Personal, Family, a project…" onClick={() => setEditing({})}><Icon name="plus" size={16} /></button></div>
      <ul className="cal-feed-list" aria-label="My calendars">
        <li className="row"><span className="cal-feed-dot" style={{ background: COLORS[0] }} aria-hidden="true" /><span className="grow ellipsis small">{me?.name || 'My calendar'}</span></li>
        {calendars.map((c) => (
          <li key={c.id} className="row">
            <label className="check grow small" style={{ minWidth: 0 }}>
              <input type="checkbox" checked={!c.hidden} aria-label={`Show ${c.name}`} style={{ accentColor: c.color }}
                onChange={(e) => onToggle(c, !e.target.checked)} />
              <span className="ellipsis">{c.name}</span>
            </label>
            <Menu trigger={(p) => <button type="button" className="icon-btn" aria-label={`Options for ${c.name}`} {...p}><Icon name="more" size={16} /></button>} items={[
              { label: 'Name and colour…', icon: 'edit', onClick: () => setEditing(c) },
              { label: 'Share…', icon: 'share', onClick: () => setSharing(c) },
              { label: 'Import into it (.ics)…', icon: 'upload', onClick: () => { importFor.current = c.id; fileInput.current.click(); } },
              { label: 'Download (.ics)', icon: 'download', onClick: () => { const a = document.createElement('a'); a.href = `/api/events/export?calendar=${c.id}`; a.download = `${c.name}.ics`; a.click(); } },
              { label: 'Delete…', icon: 'trash', danger: true, onClick: () => setDeleting(c) },
            ]} />
          </li>
        ))}
      </ul>
      {theirs.length > 0 && <>
        <div className="row"><span className="muted small grow" style={{ padding: '0 12px' }}>Shared with me</span></div>
        <ul className="cal-feed-list" aria-label="Calendars shared with me">
          {theirs.map((c) => (
            <li key={c.id} className="row" title={`${c.owner.name}’s calendar${c.can_edit ? ': you can make changes' : ''}`}>
              <label className="check grow small" style={{ minWidth: 0 }}>
                <input type="checkbox" checked={!c.hidden} aria-label={`Show ${c.name}`} style={{ accentColor: c.color }} onChange={(e) => onToggle(c, !e.target.checked)} />
                <span className="ellipsis">{c.name} <span className="muted">· {c.owner.name}</span></span>
              </label>
              <Menu trigger={(p) => <button type="button" className="icon-btn" aria-label={`Options for ${c.name}`} {...p}><Icon name="more" size={16} /></button>} items={[
                { label: 'Remove from my list', icon: 'close', onClick: () => run(() => del(`/events/calendars/${c.id}`), `${c.name} is off your list`) },
              ]} />
            </li>
          ))}
        </ul>
      </>}
      {sharing && <ShareOneCalendar calendar={calendars.find((c) => c.id === sharing.id) || sharing} people={people} onClose={() => setSharing(null)} onChanged={onChanged} />}
      <input ref={fileInput} type="file" accept=".ics,text/calendar" hidden aria-label="Calendar file to import into this calendar"
        onChange={async (e) => { const file = e.target.files[0]; e.target.value = ''; await onImport(file, importFor.current); onChanged(); }} />
      {editing && <CalendarForm calendar={editing} onClose={() => setEditing(null)}
        onSave={(body) => run(async () => { if (editing.id) await patch(`/events/calendars/${editing.id}`, body); else await post('/events/calendars', body); setEditing(null); }, editing.id ? null : `Added “${body.name}”`)} />}
      {deleting && (
        <Modal title={`Delete ${deleting.name}?`} onClose={() => setDeleting(null)}
          footer={<><button type="button" className="btn" onClick={() => setDeleting(null)}>Cancel</button>
            <button type="button" className="btn" onClick={() => run(async () => { await del(`/events/calendars/${deleting.id}?keep=1`); setDeleting(null); }, `Deleted ${deleting.name}; its events are in your main calendar`)}>Keep its events</button>
            <button type="button" className="btn danger" onClick={() => run(async () => { await del(`/events/calendars/${deleting.id}`); setDeleting(null); }, `Deleted ${deleting.name} and its events`)}>Delete with its events</button></>}>
          <p style={{ margin: 0 }}>{deleting.events ? <>It has {deleting.events} event{deleting.events === 1 ? '' : 's'}. Delete them too (guests are told they’re cancelled), or keep them in your main calendar?</> : 'It has no events.'}</p>
        </Modal>
      )}
    </div>
  );
}

/** Who a calendar of your own is shared with: colleagues who see its events, or can also change them. */
function ShareOneCalendar({ calendar, people, onClose, onChanged }) {
  const toast = useToast();
  const [members, setMembers] = useState(calendar.members || []);
  const save = async (next) => {
    const before = members;
    setMembers(next);
    try { await put(`/events/calendars/${calendar.id}/members`, { members: next.map((m) => ({ id: m.id, can_edit: m.can_edit })) }); onChanged(); }
    catch (e) { setMembers(before); toast(e.message, 'error'); }
  };
  const left = people.filter((p) => !members.some((m) => m.id === p.id));
  return (
    <Modal title={`Share “${calendar.name}”`} onClose={onClose} footer={<button type="button" className="btn primary" onClick={onClose}>Done</button>}>
      <div className="stack">
        <p className="muted small" style={{ margin: 0 }}>Colleagues you add see this calendar under <strong>Shared with me</strong> in their Calendar, with its events. Only this calendar: your others stay yours. Those who can make changes add, change and delete its events (you're told).</p>
        {members.length > 0 ? (
          <ul className="plain stack" aria-label="Shared with" style={{ gap: 6 }}>
            {members.map((m) => (
              <li key={m.id} className="row">
                <span className="grow ellipsis">{m.name} <span className="muted small">{m.email}</span></span>
                <select aria-label={`What ${m.name} can do`} value={m.can_edit ? 'edit' : 'see'} onChange={(e) => save(members.map((x) => (x.id === m.id ? { ...x, can_edit: e.target.value === 'edit' } : x)))}>
                  <option value="see">See events</option><option value="edit">Make changes</option>
                </select>
                <button type="button" className="icon-btn" aria-label={`Stop sharing with ${m.name}`} onClick={() => save(members.filter((x) => x.id !== m.id))}><Icon name="close" size={16} /></button>
              </li>
            ))}
          </ul>
        ) : <p className="muted small" style={{ margin: 0 }}>Not shared with anyone yet.</p>}
        {left.length > 0 && (
          <select className="dm-pick" value="" aria-label="Share with a colleague" onChange={(e) => { const p = people.find((x) => x.id === e.target.value); if (p) save([...members, { id: p.id, name: p.name, email: p.email || p.username || '', can_edit: false }]); }}>
            <option value="">+ Share with a colleague…</option>
            {left.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
      </div>
    </Modal>
  );
}

/** A calendar's name and colour, for a new one or a change. */
function CalendarForm({ calendar, onSave, onClose }) {
  const [name, setName] = useState(calendar.name || '');
  const [color, setColor] = useState(calendar.color || COLORS[1]);
  return (
    <Modal title={calendar.id ? 'Calendar' : 'New calendar'} onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); if (name.trim()) onSave({ name: name.trim(), color }); }}>
        <label className="field"><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required autoFocus placeholder="Personal, Family, a project…" /></label>
        <div className="colors" role="radiogroup" aria-label="Calendar colour">
          {COLORS.map((c) => <button type="button" key={c} role="radio" aria-checked={color === c} aria-label={c} className={`swatch ${color === c ? 'on' : ''}`} style={{ background: c }} onClick={() => setColor(c)} />)}
        </div>
        {calendar.id && <p className="muted small" style={{ margin: 0 }}>Its events in its old colour take the new one; events you gave a colour of their own keep it.</p>}
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">{calendar.id ? 'Save' : 'Add calendar'}</button></div>
      </form>
    </Modal>
  );
}

/** Calendars you subscribe to by address: listed in the sidebar, with refresh and remove; add one by its address. */
function Feeds({ onChanged }) {
  const toast = useToast();
  const [feeds, setFeeds] = useState([]);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const loadFeeds = useCallback(() => get('/events/feeds').then(setFeeds).catch(() => {}), []);
  useEffect(() => { loadFeeds(); }, [loadFeeds]);
  const changed = () => { loadFeeds(); onChanged(); };
  const add = async (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    try { const r = await post('/events/feeds', { url: f.get('url'), name: f.get('name') }); toast(`Added “${r.name}” (${r.events} event${r.events === 1 ? '' : 's'})`); setAdding(false); changed(); }
    catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
  };
  return (
    <div className="cal-feeds">
      <div className="row"><span className="muted small grow" style={{ padding: '0 12px' }}>Other calendars</span>
        <button type="button" className="icon-btn" aria-label="Subscribe to a calendar" title="Add a calendar by its address (public holidays, a published team calendar…)" onClick={() => setAdding(true)}><Icon name="plus" size={16} /></button></div>
      {feeds.length > 0 && (
        <ul className="cal-feed-list" aria-label="Subscribed calendars">
          {feeds.map((f) => (
            <li key={f.id} className="row" title={f.error ? `Couldn't update: ${f.error}` : `Updated ${f.fetched_at ? new Date(f.fetched_at).toLocaleString() : 'never'}`}>
              <span className="cal-feed-dot" style={{ background: f.color }} aria-hidden="true" />
              <span className="grow ellipsis small">{f.name}{f.error ? ' ⚠' : ''}</span>
              <Menu trigger={(p) => <button type="button" className="icon-btn" aria-label={`Options for ${f.name}`} {...p}><Icon name="more" size={16} /></button>} items={[
                { label: 'Update now', icon: 'restore', onClick: async () => { try { const r = await post(`/events/feeds/${f.id}/refresh`); toast(r.error ? `Couldn't update: ${r.error}` : `${r.name} is up to date`, r.error ? 'error' : 'info'); changed(); } catch (e) { toast(e.message, 'error'); } } },
                { label: 'Unsubscribe', icon: 'trash', danger: true, onClick: async () => { try { await del(`/events/feeds/${f.id}`); toast(`Removed ${f.name}`); changed(); } catch (e) { toast(e.message, 'error'); } } },
              ]} />
            </li>
          ))}
        </ul>
      )}
      {adding && (
        <Modal title="Subscribe to a calendar" onClose={() => setAdding(false)}>
          <form className="stack" onSubmit={add}>
            <p className="muted small" style={{ margin: 0 }}>Paste the address of a calendar published on the web (ending in .ics, or starting with webcal://), like your country's public holidays or a team's calendar. Its events show in your calendar, read-only, and are updated every few hours.</p>
            <label className="field"><span>Calendar address</span><input name="url" type="url" required placeholder="https://example.com/holidays.ics" autoFocus /></label>
            <label className="field"><span>Name (optional)</span><input name="name" maxLength={100} placeholder="Taken from the calendar if left empty" /></label>
            <div className="row end"><button type="button" className="btn" onClick={() => setAdding(false)}>Cancel</button><button className="btn primary" disabled={busy}>{busy ? 'Adding…' : 'Subscribe'}</button></div>
          </form>
        </Modal>
      )}
    </div>
  );
}

/** An event from a subscribed calendar: shown, not changed. */
function FeedEventDialog({ event, calendar, onClose }) {
  return (
    <Modal title={event.title} onClose={onClose}>
      <div className="stack">
        <p style={{ margin: 0 }}>{whenLabel(event)}{event.rrule && <><br /><span className="muted small">{describeRule(event.rrule, event.seriesStart ?? event.start)}</span></>}</p>
        {event.location && <p style={{ margin: 0 }}><span className="muted">Where:</span> {event.location}</p>}
        {event.description && <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{event.description}</p>}
        {event.role === 'shared'
          ? <p className="muted small" style={{ margin: 0 }}><span className="cal-feed-dot" style={{ background: event.color }} aria-hidden="true" /> In {calendar?.name || 'a calendar'}, which {event.organizer?.name || 'a colleague'} shares with you to see (only they can change it).</p>
          : <p className="muted small" style={{ margin: 0 }}><span className="cal-feed-dot" style={{ background: event.color }} aria-hidden="true" /> From {event.feed?.name}, a calendar you subscribe to (it can't be changed here).</p>}
      </div>
    </Modal>
  );
}

function useEventDrag(onDrop) {
  const [drag, setDrag] = useState(null); // { ev, start, end }
  const dragged = useRef(false);
  const begin = (e, ev, compute) => {
    if (e.button !== 0 || e.pointerType === 'touch') return;
    // Someone else's event doesn't move, but the gesture still isn't a click on the grid below.
    const locked = ev.role === 'guest' || ev.role === 'feed';
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
  const fresh = () => ({ title: 'Meeting', description: '', duration: 30, days: [1, 2, 3, 4, 5], from_min: 540, to_min: 1020, notice_hours: 4, days_ahead: 30, buffer_min: 0, max_per_day: 0, remind: true, questions: [], enabled: true });
  async function save(p) {
    try {
      const body = { ...p, tz: TZ, questions: (p.questions || []).filter((x) => x.label.trim()) }; // blank ones left out
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
                <span className="grow"><strong>{p.title}</strong> <span className="muted small">· {p.duration} min · {p.days.map((d) => WEEKDAYS[d]).join(', ')} {hhmm(p.from_min)}–{hhmm(p.to_min)}{p.host_names?.length ? ` · with ${p.host_names.join(', ')}` : ''}{p.bookings ? ` · ${p.bookings} booked` : ''}{p.enabled ? '' : ' · off'}</span></span>
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

/** Colleagues who also take bookings from the page (round robin). */
function CoHosts({ value, onChange }) {
  const { user } = useAuth();
  const [people, setPeople] = useState([]);
  const [q, setQ] = useState('');
  useEffect(() => { get('/users/directory').then((l) => setPeople(l.filter((x) => x.id !== user.id))).catch(() => {}); }, [user.id]);
  const chosen = people.filter((x) => value.includes(x.id));
  const matches = q.trim() ? people.filter((x) => !value.includes(x.id) && `${x.name} ${x.username}`.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 5) : [];
  return (
    <fieldset className="stack" style={{ gap: 6 }}><legend className="small muted">Also take bookings (shared by a team: each booking goes to whoever is free, the one with the fewest)</legend>
      {chosen.length > 0 && <ul className="cohost-chips" aria-label="Co-hosts">{chosen.map((x) => (
        <li key={x.id} className="cohost-chip">{x.name} <button type="button" className="icon-btn" aria-label={`Remove ${x.name}`} onClick={() => onChange(value.filter((id) => id !== x.id))}><Icon name="close" size={14} /></button></li>
      ))}</ul>}
      {value.length < 10 && <input aria-label="Add a co-host" placeholder="Add a colleague…" value={q} onChange={(e) => setQ(e.target.value)} />}
      {matches.length > 0 && <ul className="rule-list" aria-label="Colleagues to add">{matches.map((x) => (
        <li key={x.id}><button type="button" className="link-btn" onClick={() => { onChange([...value, x.id]); setQ(''); }}>{x.name} <span className="muted small">{x.username}</span></button></li>
      ))}</ul>}
    </fieldset>
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
        <label className="field"><span>Gap before and after</span><select value={p.buffer_min ?? 0} onChange={(e) => set('buffer_min', Number(e.target.value))}>
          {[[0, 'None'], [5, '5 minutes'], [10, '10 minutes'], [15, '15 minutes'], [30, '30 minutes'], [60, '1 hour']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        <label className="field"><span>Bookings a day</span><select value={p.max_per_day ?? 0} onChange={(e) => set('max_per_day', Number(e.target.value))}>
          {[[0, 'No limit'], [1, 'At most 1'], [2, 'At most 2'], [3, 'At most 3'], [4, 'At most 4'], [5, 'At most 5'], [8, 'At most 8'], [10, 'At most 10']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
      </div>
      <CoHosts value={p.hosts || []} onChange={(v) => set('hosts', v)} />
      <label className="check"><input type="checkbox" checked={p.enabled} onChange={(e) => set('enabled', e.target.checked)} /> Taking bookings</label>
      <label className="check"><input type="checkbox" checked={p.remind !== false} onChange={(e) => set('remind', e.target.checked)} /> Email visitors a reminder the day before</label>
      <fieldset className="stack" style={{ gap: 6 }}><legend className="small muted">Questions for visitors (besides name and email)</legend>
        {(p.questions || []).map((x, i) => (
          <div key={i} className="row" style={{ gap: 8 }}>
            <input className="grow" aria-label={`Question ${i + 1}`} placeholder="e.g. Phone number" maxLength={100} value={x.label}
              onChange={(e) => set('questions', p.questions.map((y, j) => (j === i ? { ...y, label: e.target.value } : y)))} />
            <label className="check small"><input type="checkbox" checked={!!x.required} aria-label={`Question ${i + 1} is required`}
              onChange={(e) => set('questions', p.questions.map((y, j) => (j === i ? { ...y, required: e.target.checked } : y)))} /> Required</label>
            <button type="button" className="icon-btn" aria-label={`Remove question ${i + 1}`} onClick={() => set('questions', p.questions.filter((_, j) => j !== i))}><Icon name="close" size={16} /></button>
          </div>
        ))}
        {(p.questions || []).length < 5 && <div><button type="button" className="link-btn small" onClick={() => set('questions', [...(p.questions || []), { label: '', required: false }])}>+ Add a question</button></div>}
      </fieldset>
      <p className="muted small" style={{ margin: 0 }}>Hours are in your time zone ({TZ}). Visitors see the times in theirs.</p>
      {!ok && <p className="error small" style={{ margin: 0 }}>Pick at least one day, with hours long enough for one booking.</p>}
      <div className="row end">
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        <button className="btn primary" disabled={!ok}>{page.id ? 'Save' : 'Create'}</button>
      </div>
    </form>
  );
}

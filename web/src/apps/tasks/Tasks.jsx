// Tasks: your to-do lists and the ones colleagues share with you. Add a task with Enter, tick it
// off, drag it into place, and open it for notes, a due date, who it's for, or another list.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { printHtml } from '../mail/mailprint.js';
import { listPrintHtml } from './listprint.js';
import { get, post, patch, put, del, onLive, uploadFile, postText } from '../../api.js';
import DrivePicker, { openUrl } from '../../components/DrivePicker.jsx';
import Icon from '../../components/Icon.jsx';
import { groupPlanned } from './planned.js';
import { Avatar, ConfirmModal, Empty, Menu, Modal, PromptModal, useToast } from '../../components/ui.jsx';
import { useAuth } from '../../App.jsx';
import { dueLabel, between, localToday, REPEATS, repeatText, readCustom, customRepeat, WEEKDAYS, SORTS, sortTasks } from './taskmath.js';
import { parseQuickAdd } from './quickadd.js';
import { taskLink } from '../chat/filelinks.js';
import { addDays, daysFrom, barOf, timelineRange, dragChange } from './timeline.js';

/** The open tasks a task still waits on (from the tasks on its list). */
const waitingOn = (t, all) => (t.blocked_by?.length && !t.done ? (all || []).filter((x) => t.blocked_by.includes(x.id) && !x.done) : []);

const ASSIGNED = 'assigned';
const IMPORTANT = 'important'; // tasks marked ★ on any of your lists
const PLANNED = 'planned'; // open tasks with a due date, from every list, grouped by when
const MYDAY = 'myday'; // tasks you picked for today, from any list (yours alone; empty again each day)
const VIRTUAL = { [ASSIGNED]: '/tasks/assigned', [IMPORTANT]: '/tasks/important', [PLANNED]: '/tasks/planned', [MYDAY]: '/tasks/myday' };

export default function Tasks() {
  const { listId } = useParams();
  const [params, setParams] = useSearchParams();
  const openId = params.get('task');
  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useAuth();
  const [lists, setLists] = useState(null);
  const [assignedCount, setAssignedCount] = useState(0);
  const [importantCount, setImportantCount] = useState(0);
  const [plannedCount, setPlannedCount] = useState(0); // due today or overdue
  // A tag's view (/tasks/tag:client): open tasks with that tag, from every list.
  const tagView = listId?.startsWith('tag:') ? listId.slice(4) : null;
  const virtual = !!VIRTUAL[listId] || !!tagView;
  const [tagList, setTagList] = useState([]); // tags in use on open tasks, with how many
  const [tasks, setTasks] = useState(null);
  const [title, setTitle] = useState('');
  const [asTyped, setAsTyped] = useState(false); // "Keep as typed": don't read dates and so on out of this one
  const [found, setFound] = useState(null); // { q, list }: search results across your lists
  const runSearch = async (text) => {
    const qs = String(text || '').trim();
    if (!qs) { setFound(null); return; }
    try { setFound({ q: qs, list: await get(`/tasks/search?q=${encodeURIComponent(qs)}`) }); } catch (e) { toast(e.message, 'error'); }
  };
  const [showDone, setShowDone] = useState(false);
  const [selecting, setSelecting] = useState(false); // choosing several tasks to change at once
  const [picked, setPicked] = useState(() => new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => { setSelecting(false); setPicked(new Set()); }, [listId]);
  const pick = (id) => setPicked((s0) => { const s1 = new Set(s0); if (s1.has(id)) s1.delete(id); else s1.add(id); return s1; });
  const stopSelecting = () => { setSelecting(false); setPicked(new Set()); };
  /** Change the chosen tasks together (or delete them): all or none. */
  async function batch(body, done) {
    try {
      const ids = [...picked];
      await post('/tasks/tasks/batch', { ids, ...body });
      toast(done(ids.length));
      setPicked(new Set());
      loadTasks();
    } catch (e) { toast(e.message, 'error'); }
  }
  const nTasks = (n) => `${n} task${n === 1 ? '' : 's'}`;
  // List or board, remembered for each list in this browser.
  const viewKey = `tasks-view:${listId}`;
  const [view, setViewState] = useState('list');
  useEffect(() => { try { setViewState(localStorage.getItem(viewKey) || 'list'); } catch { setViewState('list'); } }, [viewKey]);
  const setView = (v) => { setViewState(v); try { localStorage.setItem(viewKey, v); } catch { /* not kept */ } };
  const [dialog, setDialog] = useState(null); // 'new' | 'rename' | 'share' | 'delete'
  const [dragging, setDragging] = useState(null);
  const [dropAt, setDropAt] = useState(null); // index the dragged task would go before
  const addBox = useRef();
  const importInput = useRef();

  // My Day: what's in it (for the count, and the ☀ in a task's details), and suggestions while it's shown.
  const [myDay, setMyDay] = useState([]);
  const [suggested, setSuggested] = useState([]);
  const loadMyDay = useCallback(() => get(`/tasks/myday?today=${localToday()}`).then(setMyDay).catch(() => {}), []);
  const toMyDay = async (t, on = true) => {
    try { await post(`/tasks/tasks/${t.id}/myday`, { today: localToday(), on }); loadMyDay(); if (listId === MYDAY) loadTasks(); toast(on ? `“${t.title}” added to My Day` : 'Taken off My Day'); }
    catch (e) { toast(e.message, 'error'); }
  };
  const loadLists = useCallback(() => {
    loadMyDay();
    get('/tasks/tags').then((r) => setTagList(r.tags)).catch(() => {});
    return get(`/tasks/lists?today=${localToday()}`).then((r) => { setLists(r.lists); setAssignedCount(r.assigned); setImportantCount(r.important || 0); setPlannedCount(r.planned || 0); }).catch((e) => toast(e.message, 'error'));
  }, [toast, loadMyDay]);
  // Time spent per task on this list: { taskId: { minutes, running: [{ name }] } }.
  const [times, setTimes] = useState({});
  const [sections, setSections] = useState([]); // headings splitting this list into parts, in order
  const [sectionEdit, setSectionEdit] = useState(null); // { add: true } | { rename: section } | { remove: section } | { addTask: section }
  const [dropSec, setDropSec] = useState(undefined); // the section a dragged task would land in
  const loadTasks = useCallback(() => {
    if (!listId) return Promise.resolve();
    if (!VIRTUAL[listId] && !listId.startsWith('tag:')) { get(`/tasks/lists/${listId}/time`).then(setTimes).catch(() => setTimes({})); get(`/tasks/lists/${listId}/sections`).then(setSections).catch(() => setSections([])); }
    else { setTimes({}); setSections([]); }
    if (listId.startsWith('tag:')) return get(`/tasks/tags?tag=${encodeURIComponent(listId.slice(4))}`).then((r) => setTasks(r.tasks)).catch((e) => toast(e.message, 'error'));
    if (listId === MYDAY) get(`/tasks/myday/suggestions?today=${localToday()}`).then(setSuggested).catch(() => setSuggested([]));
    return get(listId === MYDAY ? `/tasks/myday?today=${localToday()}` : VIRTUAL[listId] || `/tasks/lists/${listId}/tasks`).then(setTasks).catch((e) => { toast(e.message, 'error'); navigate('/tasks', { replace: true }); });
  }, [listId, toast, navigate]);
  useEffect(() => { loadLists(); }, [loadLists]);
  useEffect(() => { setTasks(null); loadTasks(); }, [loadTasks]);
  useEffect(() => onLive((m) => {
    if (m.type === 'tasks-changed') { loadLists(); if (m.list_id === listId || VIRTUAL[listId] || listId?.startsWith('tag:')) loadTasks(); }
    if (m.type === 'live-connected') { loadLists(); loadTasks(); }
  }), [listId, loadLists, loadTasks]);
  // No list picked: your first one.
  useEffect(() => { if (!listId && lists?.length) navigate(`/tasks/${lists[0].id}`, { replace: true }); }, [listId, lists, navigate]);

  const list = lists?.find((l) => l.id === listId);
  const people = list ? [{ id: list.owner_id, name: list.owner_name }, ...list.members] : [];
  const sortBy = list?.sort || 'mine';
  const sorted = sortTasks((tasks || []).filter((t) => !t.done), sortBy);
  // With sections, tasks under none come first, then each section's in turn (each in the list's order).
  const secIndex = (t) => { const k = sections.findIndex((x) => x.id === t.section_id); return k; };
  const open = !virtual && sections.length ? sorted.map((t, k) => [t, k]).sort((x, y) => secIndex(x[0]) - secIndex(y[0]) || x[1] - y[1]).map(([t]) => t) : sorted;
  const setSort = async (sort) => {
    setLists((ls) => ls.map((l) => (l.id === list.id ? { ...l, sort } : l)));
    try { await put(`/tasks/lists/${list.id}/sort`, { sort }); } catch (e) { toast(e.message, 'error'); loadLists(); }
  };
  const done = (tasks || []).filter((t) => t.done);
  const current = (tasks || []).find((t) => t.id === openId);
  const show = (id) => setParams(id ? { task: id } : {});

  const update = async (t, changes) => {
    setTasks((all) => all && all.map((x) => (x.id === t.id ? { ...x, ...changes } : x)));
    try { const next = await patch(`/tasks/tasks/${t.id}`, changes); setTasks((all) => all && all.map((x) => (x.id === t.id ? next : x))); loadTasks(); return next; }
    catch (e) { toast(e.message, 'error'); loadTasks(); return null; }
  };
  const toggle = async (t) => {
    const next = await update(t, t.done ? { done: false } : { done: true, today: localToday() });
    if (!next?.done) return;
    // A repeating task comes back: say when.
    const again = next.next_id && (await get(`/tasks/lists/${next.list_id}/tasks`).catch(() => [])).find((x) => x.id === next.next_id);
    toast(`“${t.title}” done${again?.due ? ` · next due ${dueLabel(again.due).text}` : ''}`, 'info', { action: { label: 'Undo', onClick: () => update(next, { done: false }) } });
  };
  // Quick add: "Call Kim tomorrow 3pm !" fills in the due date, time and star (shown before adding).
  const quick = title.trim() && !asTyped ? parseQuickAdd(title, { today: localToday(), people: list?.members.length ? people : [] }) : null;
  async function add(e) {
    e.preventDefault();
    const text = title.trim();
    if (!text || !list) return;
    const body = quick?.found.length ? { title: quick.title, due: quick.due, due_time: quick.due_time, repeat: quick.repeat, important: quick.important, assignee_id: quick.assignee_id, tags: quick.tags } : { title: text };
    setTitle(''); setAsTyped(false);
    try { await post(`/tasks/lists/${list.id}/tasks`, body); loadTasks(); loadLists(); }
    catch (err) { toast(err.message, 'error'); setTitle(text); }
  }
  function drop(index, intoSection = dropSec) {
    const t = open.find((x) => x.id === dragging);
    setDragging(null); setDropAt(null); setDropSec(undefined);
    if (!t) return;
    const section = sections.length && intoSection !== undefined ? intoSection : t.section_id || null;
    const moved = (section || null) !== (t.section_id || null);
    const rest = open.filter((x) => x.id !== t.id);
    const at = Math.min(index - (open.indexOf(t) < index ? 1 : 0), rest.length);
    if (!moved && rest[at - 1]?.id === open[open.indexOf(t) - 1]?.id && rest[at]?.id === open[open.indexOf(t) + 1]?.id) return; // same place
    const position = between(rest[at - 1]?.position, rest[at]?.position);
    setTasks((all) => [...rest.slice(0, at), { ...t, position, section_id: section }, ...rest.slice(at), ...done]);
    update(t, moved ? { position, section_id: section } : { position });
  }
  /** Drop a dragged task into a section with nothing in it (or under no section): at its end. */
  function dropInto(section) {
    const t = open.find((x) => x.id === dragging);
    setDragging(null); setDropAt(null); setDropSec(undefined);
    if (!t || (t.section_id || null) === section) return;
    update(t, { section_id: section, position: Math.max(0, ...open.map((x) => x.position)) + 1 });
  }

  const row = (t, i) => {
    const due = t.due && dueLabel(t.due, new Date(), t.due_time);
    const waits = virtual ? [] : waitingOn(t, tasks);
    return (
      <li key={t.id} className={`task ${t.done ? 'done' : ''} ${t.id === openId ? 'open' : ''} ${dropAt === i && dragging ? 'drop-before' : ''}`}
        draggable={!t.done && !virtual && sortBy === 'mine'} onDragStart={(e) => { setDragging(t.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', t.title); }}
        onDragEnd={() => { setDragging(null); setDropAt(null); }}
        onDragOver={(e) => { if (!dragging || t.done) return; e.preventDefault(); e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); setDropAt(e.clientY < r.top + r.height / 2 ? i : i + 1); setDropSec(t.section_id || null); }}
        onDrop={(e) => { if (!dragging) return; e.preventDefault(); e.stopPropagation(); drop(dropAt ?? i, t.section_id || null); }}>
        {selecting && <input type="checkbox" className="task-pick" checked={picked.has(t.id)} aria-label={`Select: ${t.title}`} onChange={() => pick(t.id)} />}
        {!selecting && <input type="checkbox" checked={t.done} aria-label={`Done: ${t.title}`} onChange={() => toggle(t)} />}
        <button type="button" className="task-main" onClick={() => (selecting ? pick(t.id) : virtual ? navigate(`/tasks/${t.list_id}?task=${t.id}`) : show(t.id === openId ? null : t.id))}>
          <span className="task-title">{t.title}</span>
          <span className="task-meta">
            {virtual && <span className="muted small task-list-name">{t.list_color && <span className="list-dot" style={{ background: t.list_color }} aria-hidden="true" />}{t.list_emoji ? `${t.list_emoji} ` : ''}{t.list_name}</span>}
            {t.link_url && <span className="muted small task-link" title={t.link_label || 'Linked'}>{t.link_url.startsWith('/chat') ? '💬' : t.link_url.startsWith('/docs') ? '📄' : '✉'}</span>}
            {t.notes && <span className="muted small ellipsis task-notes">{t.notes.split('\n')[0]}</span>}
            {due && <span className={`pill due ${due.tone}`}>{due.text}</span>}
            {t.started && !t.done && <span className="pill doing">In progress</span>}
            {waits.length > 0 && <span className="pill waiting" title={`Waiting on ${waits.map((x) => `“${x.title}”`).join(', ')}`}>⏳ Waiting on {waits.length === 1 ? waits[0].title : `${waits.length} tasks`}</span>}
            {t.steps?.length > 0 && <span className={`muted small task-steps ${t.steps.every((x) => x.done) ? 'all' : ''}`} title="Steps done">☑ {t.steps.filter((x) => x.done).length}/{t.steps.length}</span>}
            {t.attachments?.length > 0 && <span className="muted small task-files" title={`${t.attachments.length} file${t.attachments.length === 1 ? '' : 's'}`}>📎 {t.attachments.length}</span>}
            {times[t.id]?.running.length > 0 && <span className="pill timing" title={`Timer running: ${times[t.id].running.map((x) => x.name).join(', ')}`}>● {times[t.id].running.map((x) => x.name.split(' ')[0]).join(', ')}</span>}
            {times[t.id]?.minutes > 0 && <span className="muted small task-time" title="Time spent">⏱ {formatMinutes(times[t.id].minutes)}</span>}
            {t.comments > 0 && <span className="muted small task-comments" title={`${t.comments} comment${t.comments === 1 ? '' : 's'}`}>💬 {t.comments}</span>}
            {t.tags?.map((tag) => <span key={tag} className="pill tag">#{tag}</span>)}
            {t.repeat && !t.done && <span className="muted small task-repeat" title={`Repeats: ${repeatText(t.repeat).toLowerCase()}${t.repeat_until ? `, until ${t.repeat_until}` : ''}`}>⟳ {repeatText(t.repeat)}</span>}
          </span>
        </button>
        {t.assignee_name && <span title={`For ${t.assignee_name}`}><Avatar name={t.assignee_name} size={24} userId={t.assignee_id} /></span>}
        {!t.done && <button type="button" className={`icon-btn task-star ${t.important ? 'on' : ''}`} aria-pressed={!!t.important} aria-label={`${t.important ? 'Not important' : 'Mark important'}: ${t.title}`}
          title={t.important ? 'Important (click to unmark)' : 'Mark important'} onClick={() => update(t, { important: !t.important })}>{t.important ? '★' : '☆'}</button>}
      </li>
    );
  };

  if (lists === null) return null;
  const heading = tagView ? `#${tagView}` : listId === MYDAY ? 'My Day' : listId === ASSIGNED ? 'Assigned to me' : listId === IMPORTANT ? 'Important' : listId === PLANNED ? 'Planned' : list?.name;
  return (
    <div className="tasks-app">
      <aside className="subnav">
        <form className="tasks-search" role="search" onSubmit={(e) => { e.preventDefault(); runSearch(new FormData(e.currentTarget).get('q')); }}>
          <Icon name="search" size={18} />
          <input name="q" type="search" placeholder="Search tasks" aria-label="Search tasks" onChange={(e) => { if (!e.target.value) setFound(null); }} />
        </form>
        <button type="button" className={`subnav-item ${listId === MYDAY ? 'active' : ''}`} onClick={() => navigate(`/tasks/${MYDAY}`)} title="Tasks you picked for today, from all your lists">
          <span className="nav-sun" aria-hidden="true">☀</span><span className="grow">My Day</span>{myDay.filter((t) => !t.done).length > 0 && <span className="count">{myDay.filter((t) => !t.done).length}</span>}
        </button>
        <button type="button" className={`subnav-item ${listId === ASSIGNED ? 'active' : ''}`} onClick={() => navigate(`/tasks/${ASSIGNED}`)}>
          <Icon name="person" /><span className="grow">Assigned to me</span>{assignedCount > 0 && <span className="count">{assignedCount}</span>}
        </button>
        <button type="button" className={`subnav-item ${listId === IMPORTANT ? 'active' : ''}`} onClick={() => navigate(`/tasks/${IMPORTANT}`)}>
          <span className="nav-star" aria-hidden="true">★</span><span className="grow">Important</span>{importantCount > 0 && <span className="count">{importantCount}</span>}
        </button>
        <button type="button" className={`subnav-item ${listId === PLANNED ? 'active' : ''}`} onClick={() => navigate(`/tasks/${PLANNED}`)} title="Tasks with a due date, from all your lists">
          <Icon name="calendar" /><span className="grow">Planned</span>{plannedCount > 0 && <span className="count" title="Due today or overdue">{plannedCount}</span>}
        </button>
        <div className="subnav-title row">Lists<div className="grow" /><button type="button" className="icon-btn" aria-label="New list" onClick={() => setDialog('new')}><Icon name="plus" size={18} /></button></div>
        {lists.map((l) => (
          <button key={l.id} type="button" className={`subnav-item ${l.id === listId ? 'active' : ''}`} onClick={() => navigate(`/tasks/${l.id}`)}>
            {l.emoji ? <span className="list-emoji" aria-hidden="true">{l.emoji}</span> : <Icon name={l.mine && !l.members.length ? 'check' : 'people'} style={l.color ? { color: l.color } : undefined} />}<span className="grow ellipsis">{l.name}</span>{l.color && <span className="list-dot" style={{ background: l.color }} aria-hidden="true" />}{l.open > 0 && <span className="count">{l.open}</span>}
          </button>
        ))}
        {(tagList.length > 0 || tagView) && <div className="subnav-title">Tags</div>}
        {tagList.map((t) => (
          <button key={t.name} type="button" className={`subnav-item ${tagView === t.name ? 'active' : ''}`} aria-label={`Tag ${t.name}, ${t.count} open`} onClick={() => navigate(`/tasks/tag:${encodeURIComponent(t.name)}`)}>
            <span className="nav-star" aria-hidden="true">#</span><span className="grow ellipsis">{t.name}</span><span className="count">{t.count}</span>
          </button>
        ))}
      </aside>
      {found && (
        <section className="tasks-main">
          <div className="page-head"><h1 className="grow ellipsis">Tasks matching “{found.q}”</h1><button type="button" className="icon-btn" aria-label="Close search" onClick={() => setFound(null)}><Icon name="close" /></button></div>
          {!found.list.length ? <Empty icon="search" title="No tasks found" /> : (
            <ul className="tasks task-results" aria-label="Search results">
              {found.list.map((t) => {
                const due = t.due && dueLabel(t.due, new Date(), t.due_time);
                return (
                  <li key={t.id} className={`task ${t.done ? 'done' : ''}`}>
                    <button type="button" className="task-main" onClick={() => { setFound(null); navigate(`/tasks/${t.list_id}?task=${t.id}`); }}>
                      <span className="task-title">{t.done ? '✓ ' : ''}{t.title}</span>
                      <span className="task-meta"><span className="muted small">{t.list_name}</span>{due && !t.done && <span className={`pill due ${due.tone}`}>{due.text}</span>}{t.notes && <span className="muted small ellipsis task-notes">{t.notes.split('\n')[0]}</span>}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
      <section className="tasks-main" hidden={!!found}>
        <div className="page-head">
          <h1 className="grow ellipsis">{list?.emoji && !virtual ? `${list.emoji} ` : ''}{heading}</h1>
          {list && !list.mine && <span className="muted small">Shared by {list.owner_name}</span>}
          {list?.mine && <button type="button" className="btn" onClick={() => setDialog('share')}><Icon name="share" size={18} /> {list.members.length ? `Shared with ${list.members.length}` : 'Share'}</button>}
          {list && (
            <div className="tabs view-toggle" role="tablist" aria-label="View">
              <button type="button" role="tab" aria-selected={view === 'list'} className={view === 'list' ? 'on' : ''} onClick={() => setView('list')}>List</button>
              <button type="button" role="tab" aria-selected={view === 'board'} className={view === 'board' ? 'on' : ''} onClick={() => setView('board')}>Board</button>
              <button type="button" role="tab" aria-selected={view === 'timeline'} className={view === 'timeline' ? 'on' : ''} onClick={() => setView('timeline')}>Timeline</button>
            </div>
          )}
          {((list && view === 'list') || virtual) && (tasks || []).length > 0 && (
            <button type="button" className={`btn small ${selecting ? 'primary' : ''}`} aria-pressed={selecting} onClick={() => (selecting ? stopSelecting() : setSelecting(true))}
              title="Choose several tasks to change at once">{selecting ? 'Done selecting' : 'Select'}</button>
          )}
          {list && view === 'list' && (
            <Menu trigger={(p) => <button type="button" className="btn small" aria-label={`Sort: ${SORTS.find(([k]) => k === sortBy)[1]}`} title="Sort this list (just for you)" {...p}>⇅ {SORTS.find(([k]) => k === sortBy)[1]}</button>}
              items={SORTS.map(([k, label]) => ({ label: `${k === sortBy ? '✓ ' : ''}${label}`, onClick: () => setSort(k) }))} />
          )}
          <input ref={importInput} type="file" accept=".csv,text/csv" hidden aria-label="Tasks file" onChange={async (e) => {
            const file = e.target.files[0]; e.target.value = '';
            if (!file || !list) return;
            try {
              const r = await postText(`/tasks/lists/${list.id}/import`, await file.text());
              toast(`Added ${r.added} ${r.added === 1 ? 'task' : 'tasks'}${r.done ? ` (${r.done} already done)` : ''}${r.skipped ? `; ${r.skipped} rows without a task skipped` : ''}`);
              loadTasks();
            } catch (err) { toast(err.message, 'error'); }
          }} />
          {list && (
            <Menu trigger={(p) => <button type="button" className="icon-btn" aria-label="List actions" {...p}><Icon name="more" /></button>} items={[
              ...(list.mine ? [{ label: 'Rename list', icon: 'edit', onClick: () => setDialog('rename') }, { label: 'Colour and emoji…', icon: 'star', onClick: () => setDialog('look') }] : []),
              { label: 'Time report…', icon: 'clock', onClick: () => setDialog('time') },
              { label: 'Import from CSV…', icon: 'upload', onClick: () => importInput.current?.click() },
              { label: 'Download as CSV', icon: 'download', onClick: () => { window.location.href = `/api/tasks/lists/${list.id}/export.csv`; } },
              { label: 'Download as Excel (.xlsx)', icon: 'download', onClick: () => { window.location.href = `/api/tasks/lists/${list.id}/export.xlsx`; } },
              { label: 'Print list', icon: 'print', onClick: () => printHtml(listPrintHtml(list.name, open, done)) },
              { label: 'Make a copy…', icon: 'copy', onClick: () => setDialog('copy') },
              ...(done.length ? [{ label: `Delete completed tasks (${done.length})`, icon: 'check', onClick: async () => { await del(`/tasks/lists/${list.id}/done`); loadTasks(); } }] : []),
              list.mine ? { label: 'Delete list', icon: 'trash', danger: true, onClick: () => setDialog('delete') } : { label: 'Leave list', icon: 'logout', onClick: () => setDialog('delete') },
            ]} />
          )}
        </div>
        {list && (
          <form className="task-add" onSubmit={add}>
            <Icon name="plus" />
            <input ref={addBox} value={title} onChange={(e) => { setTitle(e.target.value); if (!e.target.value.trim()) setAsTyped(false); }} placeholder="Add a task" aria-label="Add a task" maxLength={500}
              title="Add a date, time, repeat, ! or @name: “Send invoice tomorrow 3pm every month !”" />
          </form>
        )}
        {list && (quick?.found.length > 0 || asTyped) && (
          <div className="quick-add-preview small" role="status" aria-label="Quick add">
            {asTyped ? <span className="muted">Adding just as typed.</span> : <>
              <strong>{quick.title}</strong>
              {quick.due && <span className="chip">📅 {dueLabel(quick.due, new Date(), quick.due_time).text}</span>}
              {quick.repeat && <span className="chip">⟳ {repeatText(quick.repeat)}</span>}
              {quick.important && <span className="chip">★ Important</span>}
              {quick.tags?.map((t) => <span key={t} className="chip">#{t}</span>)}
              {quick.assignee_id && <span className="chip">👤 {people.find((x) => x.id === quick.assignee_id)?.name}</span>}
            </>}
            <button type="button" className="link-btn small" onClick={() => { setAsTyped(!asTyped); addBox.current?.focus(); }}>{asTyped ? 'Read dates again' : 'Keep as typed'}</button>
          </div>
        )}
        {selecting && (
          <div className="task-batch" role="toolbar" aria-label="Change the selected tasks">
            <strong className="small" aria-live="polite">{picked.size} selected</strong>
            <button type="button" className="link-btn small" onClick={() => setPicked(new Set(picked.size === open.length ? [] : open.map((t) => t.id)))}>{picked.size === open.length && open.length ? 'Select none' : 'Select all'}</button>
            <span className="grow" />
            <button type="button" className="btn small" disabled={!picked.size} onClick={() => batch({ change: { done: true } }, (n) => `${nTasks(n)} done`)}>✓ Mark done</button>
            <label className="small row" style={{ gap: 4 }}>Due
              <input type="date" aria-label="Due date for the selected tasks" disabled={!picked.size} onChange={(e) => e.target.value && batch({ change: { due: e.target.value } }, (n) => `${nTasks(n)} due ${dueLabel(e.target.value, new Date()).text}`)} />
            </label>
            <button type="button" className="btn small" disabled={!picked.size} onClick={() => batch({ change: { due: null } }, (n) => `${nTasks(n)}: no due date`)}>No date</button>
            <button type="button" className="btn small" disabled={!picked.size} onClick={() => batch({ change: { important: true } }, (n) => `${nTasks(n)} marked important`)}>★ Important</button>
            {!virtual && sections.length > 0 && <select aria-label="Put the selected tasks in a section" value="" disabled={!picked.size} onChange={(e) => { const v = e.target.value; if (v) batch({ change: { section_id: v === '__none__' ? null : v } }, (n) => (v === '__none__' ? `${nTasks(n)}: no section` : `${nTasks(n)} put in ${sections.find((x) => x.id === v)?.name}`)); }}>
              <option value="">Section…</option>
              {sections.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              <option value="__none__">No section</option>
            </select>}
            <select aria-label="Move the selected tasks to" value="" disabled={!picked.size} onChange={(e) => { const to = e.target.value; if (to) batch({ change: { list_id: to } }, (n) => `${nTasks(n)} moved to ${lists.find((l) => l.id === to)?.name}`); }}>
              <option value="">Move to…</option>
              {(lists || []).filter((l) => l.id !== listId).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
            <button type="button" className="btn small danger" disabled={!picked.size} onClick={() => setConfirmDelete(true)}><Icon name="trash" size={16} /> Delete</button>
          </div>
        )}
        {confirmDelete && <ConfirmModal title={`Delete ${nTasks(picked.size)}?`} confirm="Delete" message="They go for everyone on their lists." onClose={() => setConfirmDelete(false)}
          onConfirm={async () => { setConfirmDelete(false); await batch({ delete: true }, (n) => `${nTasks(n)} deleted`); }} />}
        {tasks === null ? null : list && view === 'timeline' ? (
          <Timeline open={open} openId={openId} onOpen={(t) => show(t.id === openId ? null : t.id)} onChange={(t, c) => update(t, c)} />
        ) : list && view === 'board' ? (
          <Board open={open} done={done} openId={openId} onOpen={(t) => show(t.id === openId ? null : t.id)}
            onMove={(t, col) => {
              if (col === 'done') { if (!t.done) toggle(t); return; }
              const started = col === 'doing';
              if (!t.done && !!t.started === started) return;
              update(t, t.done ? { done: false, started } : { started });
            }} />
        ) : open.length === 0 && done.length === 0 ? (
          <Empty icon="check" title={tagView ? `Nothing open tagged #${tagView}` : listId === MYDAY ? 'Nothing picked for today yet' : listId === ASSIGNED ? 'Nothing assigned to you' : listId === IMPORTANT ? 'Nothing important' : listId === PLANNED ? 'Nothing planned' : 'No tasks yet'}>{listId === MYDAY ? 'Add tasks from any list with ☀ in their details, or pick from the suggestions below. My Day starts empty each morning.' : listId === ASSIGNED ? 'Tasks people give you on shared lists show up here.' : listId === IMPORTANT ? 'Mark a task with ☆ and it shows up here, from every list.' : listId === PLANNED ? 'Tasks with a due date show up here, from every list, by when they’re due.' : 'Type a task above and press Enter.'}</Empty>
        ) : listId === PLANNED ? (
          <div className="planned">
            {groupPlanned((tasks || []).filter((t) => !t.done), localToday()).map((g) => (
              <section key={g.key} className={`planned-group ${g.key}`} aria-label={g.label}>
                <h3 className="planned-heading">{g.label} <span className="muted small">{g.tasks.length}</span></h3>
                <ul className="task-list">{g.tasks.map(row)}</ul>
              </section>
            ))}
            {open.length === 0 && <p className="muted tasks-alldone">All done 🎉</p>}
          </div>
        ) : (
          <>
            {!sections.length ? (
              <ul className="task-list" aria-label="Tasks" onDragOver={(e) => dragging && e.preventDefault()} onDrop={(e) => { if (dragging && dropAt === null) { e.preventDefault(); drop(open.length); } }}>
                {open.map(row)}
                {dragging && dropAt === open.length && <li className="drop-end" aria-hidden="true" />}
              </ul>
            ) : <>
              <ul className="task-list" aria-label="Tasks" onDragOver={(e) => dragging && e.preventDefault()} onDrop={(e) => { if (dragging) { e.preventDefault(); dropInto(null); } }}>
                {open.map((t, i) => (!t.section_id || secIndex(t) < 0 ? row(t, i) : null))}
              </ul>
              {sections.map((sec, k) => {
                const mine = open.map((t, i) => [t, i]).filter(([t]) => t.section_id === sec.id);
                const moveSec = (d) => { const o = sections[k + d]; if (!o) return; const after = sections[k + d + d]; const position = d < 0 ? between(after?.position, o.position) : between(o.position, after?.position); patch(`/tasks/sections/${sec.id}`, { position }).then(loadTasks).catch((e) => toast(e.message, 'error')); };
                return (
                  <section key={sec.id} className="task-section" aria-label={`Section ${sec.name}`}>
                    <div className="task-section-head row">
                      <h3 className="grow"><button type="button" className="link-btn task-section-fold" aria-expanded={!sec.folded} title={sec.folded ? 'Show its tasks' : 'Fold it away (just for you)'}
                        onClick={() => { const folded = !sec.folded; setSections((all) => all.map((x) => (x.id === sec.id ? { ...x, folded } : x))); put(`/tasks/sections/${sec.id}/folded`, { folded }).catch((e) => { toast(e.message, 'error'); loadTasks(); }); }}>
                        {sec.folded ? '▸' : '▾'} {sec.name}</button> <span className="muted small">{mine.length}</span></h3>
                      <Menu align="right" trigger={(p) => <button type="button" className="icon-btn" aria-label={`Section actions: ${sec.name}`} {...p}><Icon name="more" size={18} /></button>} items={[
                        { label: 'Add a task here…', icon: 'plus', onClick: () => setSectionEdit({ addTask: sec }) },
                        { label: 'Rename section…', icon: 'edit', onClick: () => setSectionEdit({ rename: sec }) },
                        ...(k > 0 ? [{ label: 'Move section up', onClick: () => moveSec(-1) }] : []),
                        ...(k < sections.length - 1 ? [{ label: 'Move section down', onClick: () => moveSec(1) }] : []),
                        { label: 'Delete section…', icon: 'trash', danger: true, onClick: () => setSectionEdit({ remove: sec }) },
                      ]} />
                    </div>
                    {!sec.folded && <ul className="task-list" aria-label={`Tasks in ${sec.name}`} onDragOver={(e) => dragging && e.preventDefault()} onDrop={(e) => { if (dragging) { e.preventDefault(); dropInto(sec.id); } }}>
                      {mine.map(([t, i]) => row(t, i))}
                      {!mine.length && <li className="task-section-empty muted small">{dragging ? 'Drop here' : 'Nothing here yet: drag tasks in, or ⋯ → Add a task here'}</li>}
                    </ul>}
                  </section>
                );
              })}
            </>}
            {list && view === 'list' && <button type="button" className="link-btn small task-add-section" onClick={() => setSectionEdit({ add: true })}>+ Add section</button>}
            {open.length === 0 && <p className="muted tasks-alldone">All done 🎉</p>}
            {done.length > 0 && (
              <>
                <button type="button" className="link-btn tasks-done-toggle" aria-expanded={showDone} onClick={() => setShowDone(!showDone)}>{showDone ? '▾' : '▸'} Completed ({done.length})</button>
                {showDone && <ul className="task-list" aria-label="Completed tasks">{done.map(row)}</ul>}
              </>
            )}
          </>
        )}
        {listId === MYDAY && suggested.length > 0 && (
          <section className="myday-suggest" aria-label="Suggestions for My Day">
            <h3 className="planned-heading">Suggestions <span className="muted small">due today or overdue</span></h3>
            <ul className="task-list">
              {suggested.map((t) => {
                const due = t.due ? dueLabel(t.due, new Date(), t.due_time) : null;
                return (
                  <li key={t.id} className="task">
                    <button type="button" className="icon-btn" aria-label={`Add to My Day: ${t.title}`} title="Add to My Day" onClick={() => toMyDay(t)}><Icon name="plus" size={18} /></button>
                    <button type="button" className="task-main" onClick={() => navigate(`/tasks/${t.list_id}?task=${t.id}`)}>
                      <span className="task-title">{t.title}</span>
                      <span className="task-meta"><span className="muted small">{t.list_name}</span>{due && <span className={`pill due ${due.tone}`}>{due.text}</span>}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </section>
      {current && list && <TaskDetails key={current.id} task={current} sections={sections} inMyDay={myDay.some((x) => x.id === current.id)} onMyDay={(on) => toMyDay(current, on)} tasks={tasks} lists={lists} people={people} onChange={(c) => update(current, c)} onClose={() => show(null)}
        onReplaced={(next) => setTasks((all) => all && all.map((x) => (x.id === next.id ? next : x)))}
        onDelete={async () => { show(null); try { await del(`/tasks/tasks/${current.id}`); toast('Task deleted'); loadTasks(); } catch (e) { toast(e.message, 'error'); } }}
        onMove={async (to) => { show(null); if (await update(current, { list_id: to })) toast(`Moved to ${lists.find((l) => l.id === to)?.name}`); }} />}
      {dialog === 'new' && <PromptModal title="New list" label="List name" confirm="Create" onClose={() => setDialog(null)}
        onSubmit={async (name) => { const r = await post('/tasks/lists', { name }); await loadLists(); navigate(`/tasks/${r.id}`); }} />}
      {dialog === 'rename' && list && <PromptModal title="Rename list" label="List name" initial={list.name} confirm="Rename" onClose={() => setDialog(null)}
        onSubmit={async (name) => { await patch(`/tasks/lists/${list.id}`, { name }); loadLists(); }} />}
      {sectionEdit?.add && list && <PromptModal title="New section" label="Section name" confirm="Add" message="A heading that splits the list into parts, such as This week or Later."
        onClose={() => setSectionEdit(null)} onSubmit={async (name) => { await post(`/tasks/lists/${list.id}/sections`, { name }); loadTasks(); }} />}
      {sectionEdit?.rename && <PromptModal title="Rename section" label="Section name" initial={sectionEdit.rename.name} confirm="Rename"
        onClose={() => setSectionEdit(null)} onSubmit={async (name) => { await patch(`/tasks/sections/${sectionEdit.rename.id}`, { name }); loadTasks(); }} />}
      {sectionEdit?.addTask && list && <PromptModal title={`Add a task to ${sectionEdit.addTask.name}`} label="Task" confirm="Add"
        onClose={() => setSectionEdit(null)} onSubmit={async (text) => { await post(`/tasks/lists/${list.id}/tasks`, { title: text, section_id: sectionEdit.addTask.id, at: 'end' }); loadTasks(); loadLists(); }} />}
      {sectionEdit?.remove && (() => {
        const n = (tasks || []).filter((t) => t.section_id === sectionEdit.remove.id).length;
        return <ConfirmModal title={`Delete the section “${sectionEdit.remove.name}”?`} confirm={n ? 'Delete section, keep tasks' : 'Delete section'} danger={false}
          message={n ? `Its ${n} task${n === 1 ? '' : 's'} stay on the list, under no section.` : 'It has no tasks.'}
          onClose={() => setSectionEdit(null)} onConfirm={async () => { await del(`/tasks/sections/${sectionEdit.remove.id}`); loadTasks(); }}>
          {n > 0 && <button type="button" className="link-btn small danger" onClick={async () => { await del(`/tasks/sections/${sectionEdit.remove.id}?tasks=1`); setSectionEdit(null); loadTasks(); loadLists(); }}>Delete the section and its {n} task{n === 1 ? '' : 's'}</button>}
        </ConfirmModal>;
      })()}
      {dialog === 'time' && list && <TimeReport list={list} onClose={() => setDialog(null)} />}
      {dialog === 'look' && list && <ListLook list={list} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); loadLists(); }} />}
      {dialog === 'copy' && list && <CopyList list={list} onClose={() => setDialog(null)} onDone={async (r) => { setDialog(null); await loadLists(); navigate(`/tasks/${r.id}`); }} />}
      {dialog === 'share' && list && <ShareList list={list} me={user} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); loadLists(); }} />}
      {dialog === 'delete' && list && (
        <ConfirmModal title={list.mine ? `Delete “${list.name}”?` : `Leave “${list.name}”?`} confirm={list.mine ? 'Delete list' : 'Leave'}
          message={list.mine ? `Its ${open.length + done.length} task${open.length + done.length === 1 ? '' : 's'} go too${list.members.length ? ', for everyone it’s shared with' : ''}.` : 'You won’t see it any more, and tasks given to you on it become nobody’s.'}
          onClose={() => setDialog(null)} onConfirm={async () => { await del(`/tasks/lists/${list.id}`); setDialog(null); await loadLists(); navigate('/tasks'); }} />
      )}
    </div>
  );
}

const DAY_W = 32; // pixels per day on the timeline
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDay = (d) => `${+d.slice(8, 10)} ${MONTHS[+d.slice(5, 7) - 1]}`;

/**
 * The list's open tasks on a strip of days: a bar from each one's start to its due date. Drag a
 * bar to move it, or its ends to change the start or due date; with the keyboard, ← → move it a
 * day, Shift+← → change the due date and Alt+← → the start. Tasks without a due date are listed below.
 */
function Timeline({ open, openId, onOpen, onChange }) {
  const today = localToday();
  const dated = open.filter((t) => t.due).sort((a, b) => barOf(a).from.localeCompare(barOf(b).from) || a.due.localeCompare(b.due));
  const undated = open.filter((t) => !t.due);
  const { from, days } = timelineRange(dated, today);
  const [drag, setDrag] = useState(null); // { id, mode, x, delta }
  const scroller = useRef(null);
  useEffect(() => { // start with today in view
    const el = scroller.current;
    if (el) el.scrollLeft = Math.max(0, (daysFrom(from, today) - 3) * DAY_W);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const dayList = Array.from({ length: days }, (_, i) => addDays(from, i));
  const begin = (e, t, mode) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDrag({ id: t.id, mode, x: e.clientX, delta: 0 });
  };
  const moveTo = (e) => { if (drag) setDrag({ ...drag, delta: Math.round((e.clientX - drag.x) / DAY_W) }); };
  const end = (t) => {
    if (!drag || drag.id !== t.id) return;
    const { mode, delta } = drag;
    setDrag(null);
    if (!delta) { if (mode === 'move') onOpen(t); return; }
    onChange(t, dragChange(t, mode, delta));
  };
  const keys = (e, t) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') { if (e.key === 'Enter') onOpen(t); return; }
    e.preventDefault();
    const d = e.key === 'ArrowRight' ? 1 : -1;
    const c = dragChange(t, e.shiftKey ? 'end' : e.altKey ? 'start' : 'move', d);
    if (Object.keys(c).length) onChange(t, c);
  };
  const shown = (t) => {
    if (drag?.id !== t.id || !drag.delta) return barOf(t);
    const c = { ...t, ...dragChange(t, drag.mode, drag.delta) };
    return barOf(c);
  };
  return (
    <div className="timeline">
      <div className="timeline-scroll" ref={scroller}>
        <div className="timeline-grid" style={{ '--days': days, '--day-w': `${DAY_W}px` }}>
          <div className="tl-corner">Task</div>
          <div className="tl-days" aria-hidden="true">
            {dayList.map((d) => {
              const wd = new Date(`${d}T12:00:00`).getDay();
              return <span key={d} className={`tl-day ${wd === 0 || wd === 6 ? 'weekend' : ''} ${d === today ? 'today' : ''}`}>{wd === 1 || d === from ? <b>{shortDay(d)}</b> : null}{+d.slice(8, 10)}</span>;
            })}
          </div>
          {dated.map((t) => {
            const b = shown(t);
            const left = daysFrom(from, b.from) * DAY_W, width = (daysFrom(b.from, b.to) + 1) * DAY_W;
            const late = t.due < today;
            return (
              <div key={t.id} className="tl-row" role="group" aria-label={t.title}>
                <button type="button" className={`tl-name ellipsis ${t.id === openId ? 'on' : ''}`} onClick={() => onOpen(t)}>{t.title}</button>
                <div className="tl-track">
                  {daysFrom(from, today) >= 0 && <span className="tl-now" style={{ left: daysFrom(from, today) * DAY_W + DAY_W / 2 }} aria-hidden="true" />}
                  <div role="slider" tabIndex={0} aria-label={`${t.title}: ${b.from === b.to ? shortDay(b.to) : `${shortDay(b.from)} to ${shortDay(b.to)}`}`}
                    aria-valuetext={b.from === b.to ? `Due ${shortDay(b.to)}` : `${shortDay(b.from)} to ${shortDay(b.to)}`} aria-valuenow={daysFrom(from, b.to)}
                    title="Drag to move; drag an end to change the start or due date (← → with Shift or Alt)"
                    className={`tl-bar ${late ? 'late' : ''} ${t.started ? 'doing' : ''} ${drag?.id === t.id ? 'dragging' : ''}`} style={{ left, width }}
                    onPointerDown={(e) => begin(e, t, 'move')} onPointerMove={moveTo} onPointerUp={() => end(t)} onPointerCancel={() => setDrag(null)} onKeyDown={(e) => keys(e, t)}>
                    <span className="tl-handle start" onPointerDown={(e) => begin(e, t, 'start')} onPointerMove={moveTo} onPointerUp={() => end(t)} aria-hidden="true" />
                    <span className="tl-label ellipsis">{t.title}</span>
                    <span className="tl-handle end" onPointerDown={(e) => begin(e, t, 'end')} onPointerMove={moveTo} onPointerUp={() => end(t)} aria-hidden="true" />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {!dated.length && <p className="muted">Give tasks a due date (and a start, in their details) to see them here.</p>}
      {undated.length > 0 && (
        <div className="tl-undated">
          <h2 className="small muted">No due date ({undated.length})</h2>
          <ul>{undated.map((t) => <li key={t.id}><button type="button" className="link-btn" onClick={() => onOpen(t)}>{t.title}</button></li>)}</ul>
        </div>
      )}
    </div>
  );
}

const COLUMNS = [['todo', 'To do'], ['doing', 'In progress'], ['done', 'Done']];
const columnOf = (t) => (t.done ? 'done' : t.started ? 'doing' : 'todo');

/** The list as a board: To do, In progress, Done. Drag a card to another column, or use its arrows. */
function Board({ open, done, openId, onOpen, onMove }) {
  const [dragging, setDragging] = useState(null);
  const [over, setOver] = useState(null);
  const all = [...open, ...done];
  return (
    <div className="task-board">
      {COLUMNS.map(([key, label], ci) => {
        const cards = all.filter((t) => columnOf(t) === key);
        return (
          <section key={key} className={`board-col ${over === key ? 'over' : ''}`} aria-label={label}
            onDragOver={(e) => { if (dragging) { e.preventDefault(); setOver(key); } }} onDragLeave={() => setOver(null)}
            onDrop={(e) => { e.preventDefault(); const t = all.find((x) => x.id === dragging); setDragging(null); setOver(null); if (t) onMove(t, key); }}>
            <h2 className="board-head">{label} <span className="muted small">{cards.length}</span></h2>
            <ul>
              {cards.map((t) => {
                const due = t.due && !t.done && dueLabel(t.due, new Date(), t.due_time);
                return (
                  <li key={t.id} className={`board-card ${t.id === openId ? 'open' : ''}`} draggable onDragStart={(e) => { setDragging(t.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', t.title); }} onDragEnd={() => { setDragging(null); setOver(null); }}>
                    <button type="button" className="board-open" onClick={() => onOpen(t)}>
                      <span className="task-title">{t.important ? '★ ' : ''}{t.title}</span>
                      <span className="task-meta">
                        {due && <span className={`pill due ${due.tone}`}>{due.text}</span>}
                        {waitingOn(t, all).length > 0 && <span className="pill waiting">⏳ Waiting</span>}
                        {t.steps?.length > 0 && <span className="muted small">☑ {t.steps.filter((x) => x.done).length}/{t.steps.length}</span>}
                        {t.comments > 0 && <span className="muted small">💬 {t.comments}</span>}
                      </span>
                    </button>
                    <div className="row board-foot">
                      {t.assignee_name ? <span title={`For ${t.assignee_name}`}><Avatar name={t.assignee_name} size={22} userId={t.assignee_id} /></span> : <span />}
                      <span className="grow" />
                      {ci > 0 && <button type="button" className="icon-btn" aria-label={`Move “${t.title}” to ${COLUMNS[ci - 1][1]}`} onClick={() => onMove(t, COLUMNS[ci - 1][0])}>‹</button>}
                      {ci < COLUMNS.length - 1 && <button type="button" className="icon-btn" aria-label={`Move “${t.title}” to ${COLUMNS[ci + 1][1]}`} onClick={() => onMove(t, COLUMNS[ci + 1][0])}>›</button>}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/** A task's details beside the list: changes save as you make them. */
export const formatMinutes = (min) => { const h = Math.floor(min / 60), m = Math.round(min % 60); return h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`; };
const dayOf = (ms) => new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short' });

/** Time spent on a task: your timer, time added by hand, and everyone's entries (yours can be removed). */
/** Schedule time: a block on your own calendar for working on the task (warned when it clashes with something). */
const pad2 = (n) => String(n).padStart(2, '0');
const localInput = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const blockText = (b) => `${new Date(b.start).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}, ${new Date(b.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} – ${new Date(b.end).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
function TaskSchedule({ task }) {
  const toast = useToast();
  const [blocks, setBlocks] = useState([]);
  const [form, setForm] = useState(null); // { at: 'YYYY-MM-DDTHH:MM', minutes }
  const [clash, setClash] = useState([]);
  const load = useCallback(() => get(`/tasks/tasks/${task.id}/blocks`).then((r) => setBlocks(r.blocks)).catch(() => {}), [task.id]);
  useEffect(() => { load(); }, [load]);
  const startMs = form ? new Date(form.at).getTime() : NaN;
  useEffect(() => {
    if (!form || !Number.isFinite(startMs)) { setClash([]); return undefined; }
    const t = setTimeout(() => get(`/tasks/tasks/${task.id}/blocks?start=${startMs}&end=${startMs + form.minutes * 60000}`).then((r) => setClash(r.clashes || [])).catch(() => {}), 250);
    return () => clearTimeout(t);
  }, [form, startMs, task.id]);
  const open = () => {
    const next = new Date(); next.setMinutes(0, 0, 0); next.setHours(next.getHours() + 1);
    setForm({ at: localInput(next.getTime()), minutes: 60 });
  };
  const book = async (e) => {
    e.preventDefault();
    try {
      const r = await post(`/tasks/tasks/${task.id}/blocks`, { start: startMs, end: startMs + form.minutes * 60000, tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
      setForm(null); load();
      toast(`On your calendar: ${blockText(r.event)}${r.clashes.length ? ` (clashes with ${r.clashes.map((x) => x.title).join(', ')})` : ''}`);
    } catch (err) { toast(err.message, 'error'); }
  };
  return (
    <section className="field task-schedule" aria-label="Schedule time">
      <span>Schedule time</span>
      {blocks.length > 0 && (
        <ul className="plain-list" aria-label="Time booked on your calendar">
          {blocks.map((b) => <li key={b.id} className="small"><Link to={`/calendar?event=${b.id}`}>📅 {blockText(b)}</Link></li>)}
        </ul>
      )}
      {!form ? <div><button type="button" className="link-btn small" onClick={open}>+ Book time on my calendar</button></div> : (
        <form className="row wrap" style={{ gap: 6 }} onSubmit={book}>
          <input type="datetime-local" aria-label="Starts" value={form.at} required onChange={(e) => setForm({ ...form, at: e.target.value })} />
          <select aria-label="For how long" value={form.minutes} onChange={(e) => setForm({ ...form, minutes: Number(e.target.value) })}>
            {[15, 30, 45, 60, 90, 120, 180, 240].map((m) => <option key={m} value={m}>{m < 60 ? `${m} min` : `${m / 60} h`}</option>)}
          </select>
          <button className="btn small primary" disabled={!Number.isFinite(startMs)}>Book</button>
          <button type="button" className="btn small" onClick={() => setForm(null)}>Cancel</button>
          {clash.length > 0 && <p className="small task-clash" role="status">⚠ Clashes with {clash.map((x) => x.title).join(', ')}</p>}
        </form>
      )}
    </section>
  );
}

function TaskTime({ task }) {
  const { user } = useAuth();
  const toast = useToast();
  const [t, setT] = useState(null);
  const [adding, setAdding] = useState(null); // { duration, day, note }
  const [, tick] = useState(0);
  const load = useCallback(() => get(`/tasks/tasks/${task.id}/time`).then(setT).catch(() => {}), [task.id]);
  useEffect(() => { load(); }, [load, task.updated_at]);
  useEffect(() => onLive((m) => { if (m.type === 'tasks-changed' && m.list_id === task.list_id) load(); }), [load, task.list_id]);
  const mine = t?.entries.find((e) => e.running && e.user_id === user.id);
  useEffect(() => { if (!mine) return undefined; const i = setInterval(() => tick((n) => n + 1), 30000); return () => clearInterval(i); }, [mine]);
  if (!t) return null;
  const act = async (fn, msg) => { try { setT(await fn()); if (msg) toast(msg); return true; } catch (e) { toast(e.message, 'error'); return false; } };
  const elapsed = mine ? Math.max(0, Math.round((Date.now() - mine.started_at) / 60000)) : 0;
  return (
    <section className="field task-time" aria-label="Time">
      <span>Time{t.total ? ` · ${formatMinutes(t.total)} in all` : ''}</span>
      <div className="row wrap" style={{ gap: 8 }}>
        {mine
          ? <button type="button" className="btn small primary" onClick={() => act(() => post('/tasks/timer/stop').then(() => get(`/tasks/tasks/${task.id}/time`)), 'Timer stopped')}>■ Stop timer ({formatMinutes(elapsed)})</button>
          : <button type="button" className="btn small" onClick={() => act(() => post(`/tasks/tasks/${task.id}/timer`))}>▶ Start timer</button>}
        {!adding && <button type="button" className="link-btn small" onClick={() => setAdding({ duration: '', day: new Date().toISOString().slice(0, 10), note: '' })}>Add time</button>}
      </div>
      {adding && (
        <form className="row wrap task-time-add" style={{ gap: 6 }} onSubmit={(e) => { e.preventDefault(); act(() => post(`/tasks/tasks/${task.id}/time`, adding)).then((ok) => ok && setAdding(null)); }}>
          <input aria-label="How long" placeholder="1h 30m" value={adding.duration} size={8} autoFocus onChange={(e) => setAdding({ ...adding, duration: e.target.value })} />
          <input aria-label="Day" type="date" value={adding.day} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setAdding({ ...adding, day: e.target.value })} />
          <input aria-label="What for (optional)" placeholder="What for (optional)" value={adding.note} maxLength={300} onChange={(e) => setAdding({ ...adding, note: e.target.value })} />
          <button className="btn small primary">Add</button><button type="button" className="btn small" onClick={() => setAdding(null)}>Cancel</button>
        </form>
      )}
      {t.people.length > 1 && <div className="muted small">{t.people.map((p) => `${p.name} ${formatMinutes(p.minutes)}`).join(' · ')}</div>}
      {t.entries.length > 0 && (
        <ul className="plain-list task-time-list" aria-label="Time entries">
          {t.entries.slice(0, 20).map((e) => (
            <li key={e.id} className="row small">
              <span className="grow">{e.running ? '● ' : ''}{e.user_name} · {dayOf(e.started_at)} · {e.running ? `running, ${formatMinutes(e.minutes)} so far` : formatMinutes(e.minutes)}{e.note ? ` · ${e.note}` : ''}</span>
              {e.user_id === user.id && !e.running && <button type="button" className="icon-btn" aria-label={`Remove ${formatMinutes(e.minutes)} on ${dayOf(e.started_at)}`} onClick={() => act(() => del(`/tasks/time/${e.id}`))}><Icon name="close" size={14} /></button>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Who spent how long on what in a list, between two dates; downloadable as CSV. */
function TimeReport({ list, onClose }) {
  const today = new Date().toISOString().slice(0, 10);
  const [range, setRange] = useState({ from: `${today.slice(0, 8)}01`, to: today });
  const [rep, setRep] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { setError(''); get(`/tasks/lists/${list.id}/time-report?from=${range.from}&to=${range.to}`).then(setRep).catch((e) => { setRep(null); setError(e.message); }); }, [list.id, range.from, range.to]);
  return (
    <Modal wide title={`Time on “${list.name}”`} onClose={onClose} footer={<>
      <a className="btn" href={`/api/tasks/lists/${list.id}/time-report?from=${range.from}&to=${range.to}&format=csv`}><Icon name="download" size={18} /> Download CSV</a>
      <span className="grow" /><button type="button" className="btn primary" onClick={onClose}>Close</button></>}>
      <div className="stack">
        <div className="row wrap" style={{ gap: 12 }}>
          <label className="field"><span>From</span><input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></label>
          <label className="field"><span>To</span><input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></label>
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        {rep && (rep.lines.length ? (
          <table className="data-table" aria-label="Time report">
            <thead><tr><th scope="col">Person</th><th scope="col">Task</th><th scope="col" className="num">Time</th></tr></thead>
            <tbody>{rep.lines.map((l, i) => <tr key={i}><td>{l.person}</td><td>{l.task}</td><td className="num">{formatMinutes(l.minutes)}</td></tr>)}</tbody>
            <tfoot><tr><th scope="row" colSpan={2}>Total</th><td className="num"><strong>{formatMinutes(rep.total)}</strong></td></tr></tfoot>
          </table>
        ) : <p className="muted">No time recorded on this list in those dates.</p>)}
      </div>
    </Modal>
  );
}

const LIST_COLORS = [['#d93025', 'Red'], ['#e8710a', 'Orange'], ['#f9ab00', 'Yellow'], ['#188038', 'Green'], ['#12b5cb', 'Teal'], ['#1a73e8', 'Blue'], ['#9334e6', 'Purple'], ['#e52592', 'Pink'], ['#5f6368', 'Grey']];
const LIST_EMOJI = ['🚀', '🏠', '💼', '🛒', '📚', '🎯', '💡', '🧾', '✈️', '🎉', '🏃', '❤️'];
/** A list's colour and emoji (everyone on the list sees them). */
function ListLook({ list, onClose, onSaved }) {
  const toast = useToast();
  const [color, setColor] = useState(list.color || '');
  const [emoji, setEmoji] = useState(list.emoji || '');
  const save = async () => { try { await patch(`/tasks/lists/${list.id}`, { color: color || null, emoji }); toast('Saved'); onSaved(); } catch (e) { toast(e.message, 'error'); } };
  return (
    <Modal title={`Colour and emoji for “${list.name}”`} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" onClick={save}>Save</button></>}>
      <div className="stack">
        <span className="small">Colour</span>
        <div className="row wrap" role="radiogroup" aria-label="Colour" style={{ gap: 6 }}>
          <button type="button" role="radio" aria-checked={!color} className={`swatch none ${!color ? 'on' : ''}`} aria-label="No colour" onClick={() => setColor('')}>∅</button>
          {LIST_COLORS.map(([c, n]) => <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={n} title={n} className={`swatch ${color === c ? 'on' : ''}`} style={{ background: c }} onClick={() => setColor(c)} />)}
        </div>
        <span className="small">Emoji</span>
        <div className="row wrap" role="radiogroup" aria-label="Emoji" style={{ gap: 4 }}>
          <button type="button" role="radio" aria-checked={!emoji} className={`emoji-pick ${!emoji ? 'on' : ''}`} aria-label="No emoji" onClick={() => setEmoji('')}>∅</button>
          {LIST_EMOJI.map((e) => <button key={e} type="button" role="radio" aria-checked={emoji === e} aria-label={`Emoji ${e}`} className={`emoji-pick ${emoji === e ? 'on' : ''}`} onClick={() => setEmoji(e)}>{e}</button>)}
          <input aria-label="Another emoji" placeholder="or type one" maxLength={8} value={LIST_EMOJI.includes(emoji) ? '' : emoji} onChange={(e) => setEmoji(e.target.value)} style={{ width: 110 }} />
        </div>
      </div>
    </Modal>
  );
}

function TaskDetails({ task, tasks, lists, sections = [], people, onChange, onClose, onDelete, onMove, onReplaced, inMyDay, onMyDay }) {
  const [title, setTitle] = useState(task.title);
  const [notes, setNotes] = useState(task.notes || '');
  useEffect(() => { setTitle(task.title); }, [task.title]);
  useEffect(() => { setNotes(task.notes || ''); }, [task.notes]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('.modal-backdrop')) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const toast = useToast();
  const copyLink = async () => {
    const url = taskLink(task);
    try { await navigator.clipboard.writeText(url); toast('Link to the task copied: people on this list can open it'); } catch { toast(url); }
  };
  const saveTitle = () => { const t = title.trim(); if (!t) setTitle(task.title); else if (t !== task.title) onChange({ title: t }); };
  return (
    <aside className="task-details" aria-label="Task details">
      <div className="row"><strong className="grow">Details</strong>
        <button type="button" className={`icon-btn myday-btn ${inMyDay ? 'on' : ''}`} aria-pressed={!!inMyDay} aria-label={inMyDay ? 'Remove from My Day' : 'Add to My Day'} title={inMyDay ? 'In My Day (click to take it off)' : 'Add to My Day: your list for today'} onClick={() => onMyDay(!inMyDay)}>☀</button>
        <button type="button" className="icon-btn" aria-label="Copy link to task" title="Copy link to task (paste it in Chat, an email or a document)" onClick={copyLink}><Icon name="link" /></button>
        <button type="button" className="icon-btn" aria-label="Close details" onClick={onClose}><Icon name="close" /></button></div>
      <label className="field"><span>Task</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} onBlur={saveTitle} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} maxLength={500} />
      </label>
      <label className="field"><span>Notes</span>
        <textarea rows={5} value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={() => { if (notes.trim() !== (task.notes || '')) onChange({ notes: notes.trim() || null }); }} />
      </label>
      {task.link_url && (
        <div className="field"><span>From</span>
          <span className="row"><Link to={task.link_url} className="grow ellipsis">{task.link_url.startsWith('/chat') ? '💬' : task.link_url.startsWith('/docs') ? '📄' : '✉'} {task.link_label || 'Open'}</Link>
            <button type="button" className="link-btn small" onClick={() => onChange({ link: null })}>Remove</button></span>
        </div>
      )}
      <Steps task={task} onReplaced={onReplaced} />
      <TaskFiles task={task} onReplaced={onReplaced} />
      <WaitingOn task={task} tasks={tasks} onReplaced={onReplaced} />
      <TaskTags task={task} onChange={onChange} />
      <TaskTime task={task} />
      <TaskSchedule task={task} />
      <label className="field"><span>Due</span>
        <span className="row"><input type="date" value={task.due || ''} onChange={(e) => onChange({ due: e.target.value || null })} />
          {task.due && <input type="time" aria-label="Time" title="Due time (optional)" value={task.due_time || ''} onChange={(e) => onChange({ due_time: e.target.value || null })} />}
          {task.due && <button type="button" className="link-btn small" onClick={() => onChange({ due: null })}>Clear</button>}</span>
      </label>
      {task.due && (
        <label className="field"><span>Starts</span>
          <span className="row"><input type="date" aria-label="Starts" max={task.due} value={task.start || ''} onChange={(e) => onChange({ start: e.target.value || null })} />
            {task.start && <button type="button" className="link-btn small" onClick={() => onChange({ start: null })}>Clear</button>}
            {!task.start && <span className="muted small">optional, for the timeline</span>}</span>
        </label>
      )}
      <RepeatField task={task} onChange={onChange} />
      {people.length > 1 && (
        <label className="field"><span>Assigned to</span>
          <select value={task.assignee_id || ''} onChange={(e) => onChange({ assignee_id: e.target.value || null })}>
            <option value="">Nobody</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
      )}
      {sections.length > 0 && (
        <label className="field"><span>Section</span>
          <select value={task.section_id || ''} onChange={(e) => onChange({ section_id: e.target.value || null })}>
            <option value="">No section</option>
            {sections.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </label>
      )}
      {lists.length > 1 && (
        <label className="field"><span>List</span>
          <select value={task.list_id} onChange={(e) => onMove(e.target.value)}>
            {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </label>
      )}
      <p className="muted small">Added by {task.created_by_name || 'someone'} · {new Date(task.created_at).toLocaleDateString([], { dateStyle: 'medium' })}{task.done && ` · done ${new Date(task.done_at).toLocaleDateString([], { dateStyle: 'medium' })}`}</p>
      <TaskComments task={task} />
      <div className="row wrap" style={{ gap: 8 }}>
        {task.repeat && task.due && !task.done && (
          <button type="button" className="btn" title="Move it to its next date without ticking it off" onClick={async () => {
            try { const t = await post(`/tasks/tasks/${task.id}/skip`, { today: localToday() }); onReplaced(t); toast(`Skipped: next due ${dueLabel(t.due, new Date(), t.due_time).text}`); } catch (e) { toast(e.message, 'error'); }
          }}>⏭ Skip this time</button>
        )}
        <button type="button" className="btn" onClick={async () => {
          try { await post(`/tasks/tasks/${task.id}/duplicate`); toast('Duplicated: the copy is just below'); } catch (e) { toast(e.message, 'error'); }
        }}><Icon name="copy" size={16} /> Duplicate</button>
        <button type="button" className="btn danger" onClick={onDelete}><Icon name="trash" size={16} /> Delete task</button>
      </div>
    </aside>
  );
}

/** Who a list is shared with: people in your company (and, if allowed, others you've worked with). */
function ShareList({ list, me, onClose, onSaved }) {
  const toast = useToast();
  const [people, setPeople] = useState([]);
  const [chosen, setChosen] = useState(new Set(list.members.map((m) => m.id)));
  const [filter, setFilter] = useState('');
  useEffect(() => { get('/users/directory').then(setPeople).catch(() => {}); }, []);
  const shown = people.filter((p) => p.id !== me.id && `${p.name} ${p.username}`.toLowerCase().includes(filter.toLowerCase()));
  async function save() {
    try { await put(`/tasks/lists/${list.id}/members`, { user_ids: [...chosen] }); toast(chosen.size ? `Shared with ${chosen.size}` : 'Not shared any more'); onSaved(); }
    catch (e) { toast(e.message, 'error'); }
  }
  return (
    <Modal title={`Share “${list.name}”`} onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" onClick={save}>Save</button></>}>
      <p className="muted small" style={{ marginTop: 0 }}>People you share with can add, change, tick off and be given tasks on this list.</p>
      <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find people" aria-label="Find people" />
      <ul className="share-pick">
        {shown.map((p) => (
          <li key={p.id}><label className="row">
            <input type="checkbox" checked={chosen.has(p.id)} onChange={(e) => { const n = new Set(chosen); e.target.checked ? n.add(p.id) : n.delete(p.id); setChosen(n); }} />
            <Avatar name={p.name} size={24} userId={p.id} /><span className="grow">{p.name} <span className="muted small">{p.username}</span></span>
          </label></li>
        ))}
      </ul>
    </Modal>
  );
}

/** A task's checklist: tick steps off, rename them (click the text), remove them, and add more. */
function Steps({ task, onReplaced }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const steps = task.steps || [];
  const call = async (fn) => { try { onReplaced(await fn()); } catch (e) { toast(e.message, 'error'); onReplaced(task); } }; // on failure, back as it was
  const add = (e) => {
    e.preventDefault();
    const title = text.trim();
    if (!title) return;
    setText('');
    call(() => post(`/tasks/tasks/${task.id}/steps`, { title }));
  };
  const done = steps.filter((x) => x.done).length;
  return (
    <div className="field task-steps-box">
      <span>Steps{steps.length > 0 && ` · ${done} of ${steps.length} done`}</span>
      {steps.length > 0 && (
        <ul className="steps" aria-label="Steps">
          {steps.map((x) => (
            <li key={x.id} className={x.done ? 'done' : ''}>
              <input type="checkbox" checked={x.done} aria-label={`Step done: ${x.title}`} onChange={() => { onReplaced({ ...task, steps: steps.map((y) => (y.id === x.id ? { ...y, done: !x.done } : y)) }); call(() => patch(`/tasks/tasks/${task.id}/steps/${x.id}`, { done: !x.done })); }} />
              <input className="step-title" defaultValue={x.title} key={x.title} aria-label={`Step: ${x.title}`} maxLength={500}
                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { e.currentTarget.value = x.title; e.currentTarget.blur(); e.stopPropagation(); } }}
                onBlur={(e) => { const v = e.target.value.trim(); if (!v) e.target.value = x.title; else if (v !== x.title) call(() => patch(`/tasks/tasks/${task.id}/steps/${x.id}`, { title: v })); }} />
              <button type="button" className="icon-btn" aria-label={`Remove step: ${x.title}`} onClick={() => call(() => del(`/tasks/tasks/${task.id}/steps/${x.id}`))}><Icon name="close" size={14} /></button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add} className="row"><input value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a step" aria-label="Add a step" maxLength={500} /></form>
    </div>
  );
}

/** What a task waits on: other tasks on its list to do first. */
function WaitingOn({ task, tasks, onReplaced }) {
  const toast = useToast();
  const ids = task.blocked_by || [];
  const byId = new Map((tasks || []).map((t) => [t.id, t]));
  const save = async (next) => {
    onReplaced({ ...task, blocked_by: next });
    try { onReplaced(await put(`/tasks/tasks/${task.id}/waiting-on`, { task_ids: next })); } catch (e) { toast(e.message, 'error'); onReplaced(task); }
  };
  const choices = (tasks || []).filter((t) => t.id !== task.id && !t.done && !ids.includes(t.id));
  return (
    <div className="field task-waiting-box"><span>Waiting on</span>
      {ids.length > 0 && (
        <ul className="steps" aria-label="Waiting on">
          {ids.map((id) => { const t = byId.get(id); if (!t) return null; return (
            <li key={id} className={t.done ? 'done' : ''}>
              <span className="grow">{t.done ? '✓' : '⏳'} {t.title}</span>
              <button type="button" className="icon-btn" aria-label={`No longer waiting on ${t.title}`} onClick={() => save(ids.filter((x) => x !== id))}><Icon name="close" size={14} /></button>
            </li>
          ); })}
        </ul>
      )}
      {choices.length > 0 && (
        <select aria-label="Add a task this waits on" value="" onChange={(e) => e.target.value && save([...ids, e.target.value])}>
          <option value="">{ids.length ? 'And on…' : 'Nothing (choose a task to do first)'}</option>
          {choices.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
        </select>
      )}
      {ids.length > 0 && <span className="muted small">When they're all done, {task.assignee_name ? task.assignee_name.split(' ')[0] : 'whoever added it'} gets a notification.</span>}
    </div>
  );
}

/** Files on a task: from Drive, or uploaded from your computer (into "Task files" in your Drive). */
function TaskFiles({ task, onReplaced }) {
  const toast = useToast();
  const [picking, setPicking] = useState(false);
  const [uploading, setUploading] = useState(0);
  const input = useRef();
  const files = task.attachments || [];
  const attach = async (fileId) => { try { onReplaced(await post(`/tasks/tasks/${task.id}/attachments`, { file_id: fileId })); } catch (e) { toast(e.message, 'error'); } };
  const upload = async (list) => {
    if (!list?.length) return;
    let folder;
    try { folder = (await post('/tasks/files-folder')).id; } catch (e) { toast(e.message, 'error'); return; }
    for (const f of list) {
      setUploading((n) => n + 1);
      try { const up = await uploadFile(f, folder); await attach(up.id); } catch (e) { toast(e.message, 'error'); } finally { setUploading((n) => n - 1); }
    }
  };
  return (
    <div className="field task-files-box" onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }}
      onDrop={(e) => { if (!e.dataTransfer.files.length) return; e.preventDefault(); upload([...e.dataTransfer.files]); }}>
      <span>Files</span>
      {files.length > 0 && (
        <ul className="event-attachments" aria-label="Files">
          {files.map((a) => (
            <li key={a.id}>
              <Icon name={['doc', 'sheet', 'slides'].includes(a.kind) ? a.kind : 'file'} size={16} />
              {a.can_open === false ? <span className="muted" title="Not shared with you">{a.name} (no access)</span>
                : <a href={openUrl(a)} target="_blank" rel="noreferrer">{a.name}</a>}
              <button type="button" className="icon-btn" aria-label={`Remove ${a.name}`} onClick={async () => { try { onReplaced(await del(`/tasks/tasks/${task.id}/attachments/${a.id}`)); } catch (e) { toast(e.message, 'error'); } }}><Icon name="close" size={14} /></button>
            </li>
          ))}
        </ul>
      )}
      <span className="row wrap">
        <button type="button" className="btn small" onClick={() => setPicking(true)}><Icon name="folder" size={16} /> From Drive</button>
        <button type="button" className="btn small" onClick={() => input.current?.click()}><Icon name="attach" size={16} /> Upload</button>
        {uploading > 0 && <span className="muted small" role="status">Uploading…</span>}
        <input ref={input} type="file" multiple hidden aria-label="Upload files to the task" onChange={(e) => { upload([...e.target.files]); e.target.value = ''; }} />
      </span>
      {files.length > 0 && <span className="muted small">Everyone on the list can view the files that people on it own.</span>}
      {picking && <DrivePicker title="Attach to the task" accept={(x) => x.kind !== 'folder'} onClose={() => setPicking(false)} onPick={(x) => { setPicking(false); attach(x.id); }} />}
    </div>
  );
}

/** A task's comments: everyone on the list sees them; you can remove your own. */
function TaskComments({ task }) {
  const toast = useToast();
  const { user } = useAuth();
  const [list, setList] = useState([]);
  const [text, setText] = useState('');
  const load = useCallback(() => get(`/tasks/tasks/${task.id}/comments`).then(setList).catch(() => {}), [task.id]);
  useEffect(() => { load(); }, [load, task.comments]); // the count changes live when someone comments
  const send = async (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    try { await post(`/tasks/tasks/${task.id}/comments`, { body: text }); setText(''); load(); } catch (err) { toast(err.message, 'error'); }
  };
  return (
    <div className="field task-comments-box"><span>Comments</span>
      {list.length > 0 && (
        <ul className="task-comment-list" aria-label="Comments">
          {list.map((c) => (
            <li key={c.id}>
              <div className="row"><strong className="small">{c.author_name || 'Someone'}</strong><span className="muted small grow">{new Date(c.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</span>
                {c.author_id === user.id && <button type="button" className="icon-btn" aria-label="Delete comment" onClick={async () => { await del(`/tasks/tasks/${task.id}/comments/${c.id}`).catch((err) => toast(err.message, 'error')); load(); }}><Icon name="close" size={14} /></button>}</div>
              <p className="task-comment-body">{c.body}</p>
            </li>
          ))}
        </ul>
      )}
      <form className="row" onSubmit={send}>
        <input className="grow" value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a comment" aria-label="Add a comment" maxLength={4000} />
        <button className="btn small" disabled={!text.trim()}>Post</button>
      </form>
    </div>
  );
}

/** Tags in a task's details: type them (with or without #, separated by spaces or commas); × takes one off. */
function TaskTags({ task, onChange }) {
  const [text, setText] = useState('');
  const tags = task.tags || [];
  const add = () => {
    const more = text.split(/[\s,]+/).map((x) => x.replace(/^#+/, '').toLowerCase()).filter(Boolean);
    setText('');
    if (more.length) onChange({ tags: [...new Set([...tags, ...more])] });
  };
  return (
    <div className="field"><span>Tags</span>
      <div className="row wrap task-tags">
        {tags.map((t) => <span key={t} className="pill tag">#{t}<button type="button" className="icon-btn" aria-label={`Remove tag ${t}`} onClick={() => onChange({ tags: tags.filter((x) => x !== t) })}>×</button></span>)}
        <input className="grow" value={text} aria-label="Add a tag" placeholder={tags.length ? 'Add a tag' : 'Add a tag, like client'} maxLength={100}
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); } }} onBlur={add} />
      </div>
    </div>
  );
}

/** A copy of a list, to use it again (an onboarding checklist, month-end): its open tasks, due dates moved to a new start. */
function CopyList({ list, onClose, onDone }) {
  const toast = useToast();
  const [name, setName] = useState(`${list.name} (copy)`);
  const [start, setStart] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async (e) => {
    e.preventDefault(); setBusy(true);
    try {
      const r = await post(`/tasks/lists/${list.id}/copy`, { name, ...(start && { start }) });
      toast(`${r.tasks} task${r.tasks === 1 ? '' : 's'} copied to “${r.name}”`);
      onDone(r);
    } catch (err) { toast(err.message, 'error'); setBusy(false); }
  };
  return (
    <Modal title="Make a copy" onClose={onClose}
      footer={<><span className="grow" /><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="submit" form="copy-list" className="btn primary" disabled={busy || !name.trim()}>Make a copy</button></>}>
      <form id="copy-list" className="stack" onSubmit={go}>
        <p className="muted small" style={{ margin: 0 }}>The open tasks, with their notes, steps (unticked), tags, stars, files and what they wait on. Not who they're for, comments or time.</p>
        <label className="field"><span>Name of the copy</span><input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} autoFocus /></label>
        <label className="field"><span>Start on (optional)</span><input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></label>
        <p className="muted small" style={{ margin: 0 }}>{start ? 'Due dates move so the earliest falls on this day, keeping the same gaps between them.' : 'Without a start day, the copy has no due dates.'}</p>
      </form>
    </Modal>
  );
}

/** A first end day for a repeating task: three months after it's due. */
function untilDefault(task) {
  const d = new Date(`${task.due || localToday()}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 3);
  return d.toISOString().slice(0, 10);
}

/** How a task repeats: the usual choices, or Custom… (every N days, weeks on chosen days, months or years). */
function RepeatField({ task, onChange }) {
  const custom = readCustom(task.repeat);
  const [editing, setEditing] = useState(null); // { n, unit, days } while the custom repeat is being chosen
  const set = (repeat) => onChange({ repeat: repeat || null, ...(!task.due && repeat && { due: localToday() }) });
  const value = editing || custom ? 'custom' : task.repeat || '';
  return (
    <div className="field"><label htmlFor="task-repeat"><span>Repeat</span></label>
      <select id="task-repeat" value={value} onChange={(e) => {
        if (e.target.value === 'custom') setEditing(custom || { n: 2, unit: 'week', days: [] });
        else { setEditing(null); set(e.target.value); }
      }}>
        {REPEATS.map(([v, n]) => <option key={v} value={v}>{n}</option>)}
        <option value="custom">{custom ? repeatText(task.repeat) : 'Custom…'}</option>
      </select>
      {editing && (
        <div className="repeat-custom stack-tight" role="group" aria-label="Custom repeat">
          <div className="row" style={{ gap: 6 }}>
            <span>Every</span>
            <input type="number" min={1} max={99} aria-label="Repeat every" value={editing.n} onChange={(e) => setEditing({ ...editing, n: e.target.value })} style={{ width: 64 }} />
            <select aria-label="Repeat unit" value={editing.unit} onChange={(e) => setEditing({ ...editing, unit: e.target.value })}>
              {[['day', 'days'], ['week', 'weeks'], ['month', 'months'], ['year', 'years']].map(([v, n]) => <option key={v} value={v}>{n}</option>)}
            </select>
          </div>
          {editing.unit === 'week' && (
            <div className="row repeat-days" style={{ gap: 4 }} aria-label="On these days">
              {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                <button key={d} type="button" aria-pressed={editing.days.includes(d)} className={`btn small ${editing.days.includes(d) ? 'primary' : ''}`}
                  onClick={() => setEditing({ ...editing, days: editing.days.includes(d) ? editing.days.filter((x) => x !== d) : [...editing.days, d] })}>{WEEKDAYS[d]}</button>
              ))}
            </div>
          )}
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn small primary" onClick={() => { set(customRepeat(editing)); setEditing(null); }}>Done</button>
            <button type="button" className="link-btn small" onClick={() => setEditing(null)}>Cancel</button>
            <span className="muted small">{repeatText(customRepeat(editing))}</span>
          </div>
        </div>
      )}
      {task.repeat && !editing && <span className="muted small">When you tick it off, the next one is added{task.due ? '' : ' (it needs a due date)'}{task.repeat_until ? `, until ${new Date(`${task.repeat_until}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}.</span>}
      {task.repeat && !editing && (
        <div className="row repeat-until" style={{ gap: 6 }}>
          <label className="row" style={{ gap: 6 }}>
            <input type="checkbox" checked={!!task.repeat_until} onChange={(e) => onChange({ repeat_until: e.target.checked ? untilDefault(task) : null })} />
            <span>Stop repeating after</span>
          </label>
          {task.repeat_until && <input type="date" aria-label="Last day it repeats" value={task.repeat_until} min={task.due || undefined}
            onChange={(e) => e.target.value && onChange({ repeat_until: e.target.value })} />}
        </div>
      )}
    </div>
  );
}

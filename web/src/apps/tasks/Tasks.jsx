import { unreachable, changeAdd, patchKeptTask, appendKept, offlineId, keepDelete } from '../offlinedocs.js';
// Tasks: your to-do lists and the ones colleagues share with you. Add a task with Enter, tick it
// off, drag it into place, and open it for notes, a due date, who it's for, or another list.
import { createPortal } from 'react-dom';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useMentions } from '../../components/mentions.jsx';
import { ReactionBar } from '../comments.jsx';
import LinkedText from '../../components/LinkedText.jsx';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { printHtml } from '../mail/mailprint.js';
import { listPrintHtml, taskPrintHtml, listEmail, taskEmail, taskNote, linkIcon } from './listprint.js';
import { DRAFT_KEY } from '../docs/blocks.js';
import { useMailStatus } from '../../mailStatus.js';
import SendInChat from '../../components/SendInChat.jsx';
import { get, post, patch, put, del, onLive, uploadFile, postText } from '../../api.js';
import DrivePicker, { openUrl } from '../../components/DrivePicker.jsx';
import PeopleTicks from '../../components/PeopleTicks.jsx';
import Icon from '../../components/Icon.jsx';
import RecentlyDeleted from '../../components/RecentlyDeleted.jsx';
import { groupPlanned, groupCompleted } from './planned.js';
import { Avatar, ConfirmModal, Empty, Menu, Modal, NotSent, PromptModal, useToast } from '../../components/ui.jsx';
import { useAuth } from '../../App.jsx';
import { dueLabel, between, localToday, REPEATS, repeatText, readCustom, customRepeat, readMonthWeek, monthWeekRepeat, WEEKDAYS, SORTS, sortTasks, PRIORITIES, assignedTo } from './taskmath.js';
import { parseQuickAdd } from './quickadd.js';
import { historyText } from './taskhistory.js';
import { taskKey, stepTask, afterLeaving } from './taskkeys.js';
import { taskLink } from '../chat/filelinks.js';
import { addDays, daysFrom, barOf, timelineRange, dragChange } from './timeline.js';
import { timesheet, timesheetCsv, hm, cellEntries } from './timesheet.js';

/** The open tasks a task still waits on (from the tasks on its list). */
const waitingOn = (t, all) => (t.blocked_by?.length && !t.done ? (all || []).filter((x) => t.blocked_by.includes(x.id) && !x.done) : []);

const ASSIGNED = 'assigned';
const IMPORTANT = 'important'; // tasks marked ★ on any of your lists
const PLANNED = 'planned'; // open tasks with a due date, from every list, grouped by when
// "Move dates…" on the selection bar: by how many days, and how it's said.
const SHIFTS = [[1, 'a day later'], [2, '2 days later'], [7, 'a week later'], [14, '2 weeks later'], [-1, 'a day earlier'], [-7, 'a week earlier']];
const MYDAY = 'myday'; // tasks you picked for today, from any list (yours alone; empty again each day)
const COMPLETED = 'completed'; // what you ticked off in the last 30 days, from every list, by day
const VIRTUAL = { [ASSIGNED]: '/tasks/assigned', [IMPORTANT]: '/tasks/important', [PLANNED]: '/tasks/planned', [MYDAY]: '/tasks/myday', [COMPLETED]: '/tasks/completed' };

export default function Tasks() {
  const { listId } = useParams();
  const [params, setParams] = useSearchParams();
  const openId = params.get('task');
  const navigate = useNavigate();
  const toast = useToast();
  const googleRef = useRef(null); // Import from Google Tasks…
  const csvListsRef = useRef(null); // Import lists from CSV…
  const trelloRef = useRef(null); // Import a Trello board…
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
  // A task's comments read in its details: not new any more on its row.
  useEffect(() => {
    const seen = (e) => setTasks((l) => (l && l.some((t) => t.id === e.detail && t.comments_new) ? l.map((t) => (t.id === e.detail ? { ...t, comments_new: 0 } : t)) : l));
    window.addEventListener('task-comments-seen', seen);
    return () => window.removeEventListener('task-comments-seen', seen);
  }, []);
  const [title, setTitle] = useState('');
  const [asTyped, setAsTyped] = useState(false); // "Keep as typed": don't read dates and so on out of this one
  const [found, setFound] = useState(null); // { q, list }: search results across your lists
  const runSearch = async (text) => {
    const qs = String(text || '').trim();
    if (!qs) { setFound(null); return; }
    try { setFound({ q: qs, list: await get(`/tasks/search?q=${encodeURIComponent(qs)}`) }); } catch (e) { toast(e.message, 'error'); }
  };
  const [showDone, setShowDone] = useState(false);
  // The Completed view: the last 7 or 30 days (kept on this device).
  const [doneDays, setDoneDaysState] = useState(() => { try { return localStorage.getItem('nw.tasksDoneDays') === '7' ? 7 : 30; } catch { return 30; } });
  const setDoneDays = (d) => { setDoneDaysState(d); try { localStorage.setItem('nw.tasksDoneDays', String(d)); } catch { /* private window */ } };
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
  /** Copies of the selected tasks in another list: each goes to the top there, so last first keeps this list's order. */
  async function copyPicked(to, toName) {
    const ids = (tasks || []).filter((t) => picked.has(t.id)).map((t) => t.id).reverse();
    let n = 0;
    try {
      for (const id of ids) { await post(`/tasks/tasks/${id}/duplicate`, { list_id: to }); n++; }
      toast(`${nTasks(n)} copied to ${toName}`);
      setPicked(new Set());
    } catch (err) { toast(n ? `${nTasks(n)} copied; then: ${err.message}` : err.message, 'error'); }
  }
  /** "+ New list…" in a Move to… or Copy to…: the list made (this one stays open). { id, name } */
  async function newList(name) {
    const r = await post('/tasks/lists', { name });
    loadLists();
    return { id: r.id, name: r.name || name };
  }
  // List or board, remembered for each list in this browser.
  const viewKey = `tasks-view:${listId}`;
  const [view, setViewState] = useState('list');
  useEffect(() => { try { setViewState(localStorage.getItem(viewKey) || 'list'); } catch { setViewState('list'); } }, [viewKey]);
  const setView = (v) => { setViewState(v); try { localStorage.setItem(viewKey, v); } catch { /* not kept */ } };
  const [dialog, setDialog] = useState(null); // 'new' | 'movenew' | 'rename' | 'share' | 'delete'
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
  // Hidden lists (finished projects) stay out of the left until "Hidden lists" is opened.
  const [showHidden, setShowHidden] = useState(false);
  const hideList = async (l, hidden) => {
    try { await put(`/tasks/lists/${l.id}/hidden`, { hidden }); toast(hidden ? `“${l.name}” is hidden from the left (under Hidden lists)` : `“${l.name}” is back on the left`); loadLists(); }
    catch (e) { toast(e.message, 'error'); }
  };
  // This list one place up (by -1) or down (by 1) among your lists on the left: your own order from then on.
  const orderList = async (by) => {
    const ids = lists.map((l) => l.id);
    const i = ids.indexOf(listId);
    [ids[i], ids[i + by]] = [ids[i + by], ids[i]];
    setLists((ls) => ids.map((id) => ls.find((l) => l.id === id)));
    try { await put('/tasks/lists/order', { ids }); } catch (e) { toast(e.message, 'error'); }
    loadLists();
  };
  const loadLists = useCallback(() => {
    loadMyDay();
    get('/tasks/tags').then((r) => setTagList(r.tags)).catch(() => {});
    return get(`/tasks/lists?today=${localToday()}`).then((r) => { setLists(r.lists); setAssignedCount(r.assigned); setImportantCount(r.important || 0); setPlannedCount(r.planned || 0); }).catch((e) => toast(e.message, 'error'));
  }, [toast, loadMyDay]);
  // A task's comments read: its list's 💬 mark in the sidebar may go.
  const hasNew = (lists || []).some((l) => l.comments_new > 0);
  useEffect(() => {
    if (!hasNew) return undefined;
    const seen = () => loadLists();
    window.addEventListener('task-comments-seen', seen);
    return () => window.removeEventListener('task-comments-seen', seen);
  }, [hasNew, loadLists]);
  // Time spent per task on this list: { taskId: { minutes, running: [{ name }] } }.
  const [times, setTimes] = useState({});
  const [sections, setSections] = useState([]); // headings splitting this list into parts, in order
  const [sectionEdit, setSectionEdit] = useState(null); // { add: true } | { rename: section } | { remove: section } | { addTask: section }
  const [dropSec, setDropSec] = useState(undefined); // the section a dragged task would land in
  // Only the latest request's answers are shown: switching lists quickly, the list you left can answer last
  // (and its tasks would show under the new list's name).
  const loadSeq = useRef(0);
  const loadTasks = useCallback(() => {
    if (!listId) return Promise.resolve();
    const seq = ++loadSeq.current;
    const latest = (fn) => (v) => { if (seq === loadSeq.current) fn(v); };
    if (!VIRTUAL[listId] && !listId.startsWith('tag:')) { get(`/tasks/lists/${listId}/time`).then(latest(setTimes)).catch(() => latest(setTimes)({})); get(`/tasks/lists/${listId}/sections`).then(latest(setSections)).catch(() => latest(setSections)([])); }
    else { setTimes({}); setSections([]); }
    if (listId.startsWith('tag:')) return get(`/tasks/tags?tag=${encodeURIComponent(listId.slice(4))}`).then((r) => latest(setTasks)(r.tasks)).catch((e) => toast(e.message, 'error'));
    if (listId === MYDAY) get(`/tasks/myday/suggestions?today=${localToday()}`).then(latest(setSuggested)).catch(() => latest(setSuggested)([]));
    return get(listId === MYDAY ? `/tasks/myday?today=${localToday()}` : listId === COMPLETED ? `/tasks/completed?days=${doneDays}` : VIRTUAL[listId] || `/tasks/lists/${listId}/tasks`).then(latest(setTasks)).catch((e) => { if (seq !== loadSeq.current) return; toast(e.message, 'error'); navigate('/tasks', { replace: true }); });
  }, [listId, toast, navigate, doneDays]);
  useEffect(() => { loadLists(); }, [loadLists]);
  // Changes made offline have gone in: the list as the server has it now.
  useEffect(() => { const again = () => { loadTasks(); loadLists(); }; window.addEventListener('nw:changes-sent', again); return () => window.removeEventListener('nw:changes-sent', again); }, [loadTasks, loadLists]);
  useEffect(() => { setTasks(null); loadTasks(); }, [loadTasks]);
  useEffect(() => onLive((m) => {
    if (m.type === 'tasks-changed') { loadLists(); if (m.list_id === listId || VIRTUAL[listId] || listId?.startsWith('tag:')) loadTasks(); }
    if (m.type === 'live-connected') { loadLists(); loadTasks(); }
  }), [listId, loadLists, loadTasks]);
  // No list picked: your first one.
  useEffect(() => { if (!listId && lists?.length) navigate(`/tasks/${lists[0].id}`, { replace: true }); }, [listId, lists, navigate]);

  const list = lists?.find((l) => l.id === listId);
  const people = list ? [{ id: list.owner_id, name: list.owner_name, username: list.owner_email }, ...list.members] : [];
  const sortBy = list?.sort || 'mine';
  // A shared list for one person only (?who=…: from the menu by Select, or a name in Workload).
  const who = list?.members.length ? params.get('who') : null;
  const whoName = who === 'none' ? 'Not assigned' : people.find((p) => p.id === who)?.name;
  const setWho = (id) => setParams((p) => { const n = new URLSearchParams(p); if (id) n.set('who', id); else n.delete('who'); return n; });
  const sorted = sortTasks((tasks || []).filter((t) => !t.done).filter(assignedTo(who)), sortBy);
  // With sections, tasks under none come first, then each section's in turn (each in the list's order).
  const secIndex = (t) => { const k = sections.findIndex((x) => x.id === t.section_id); return k; };
  const open = !virtual && sections.length ? sorted.map((t, k) => [t, k]).sort((x, y) => secIndex(x[0]) - secIndex(y[0]) || x[1] - y[1]).map(([t]) => t) : sorted;
  const setSort = async (sort) => {
    setLists((ls) => ls.map((l) => (l.id === list.id ? { ...l, sort } : l)));
    try { await put(`/tasks/lists/${list.id}/sort`, { sort }); } catch (e) { toast(e.message, 'error'); loadLists(); }
  };
  const done = (tasks || []).filter((t) => t.done).filter(assignedTo(who));
  const mail = useMailStatus();
  const [chatting, setChatting] = useState(null); // tasks to send in Chat
  /** A new email in Mail with the list in it (handed over in this browser's storage, as Docs and Notes do). */
  // Copy to a document: the list as a checklist in a new document of yours (sections as headings, due dates, who, steps).
  const listToDoc = async (withDone) => {
    try { const r = await post(`/tasks/lists/${list.id}/doc`, { done: withDone, tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' }); toast(`Made “${r.name}” in your Drive`, 'info', { action: { label: 'Open', onClick: () => navigate(`/docs/${r.id}`) } }); } catch (e) { toast(e.message, 'error'); }
  };
  // Copy to a note: the open tasks (as shown: this person's, in the list's order) as a checklist note of yours, each with
  // its steps still to do as sub-items; for a shopping run or a day out, ticked off on a phone.
  const listToNote = async () => {
    const items = [];
    for (const t of open) {
      if (items.length >= 200) break;
      items.push({ text: t.title.slice(0, 1000) });
      for (const st of (t.steps || []).filter((x) => !x.done)) if (items.length < 200) items.push({ text: String(st.title || '').slice(0, 1000), indent: 1 });
    }
    if (!items.length) { toast('There are no open tasks to copy'); return; }
    try {
      const n = await post('/notes', { title: (list?.name || 'Tasks').slice(0, 300), items });
      toast(`Saved to Notes: a checklist of ${open.length} task${open.length === 1 ? '' : 's'}`, 'info', { action: { label: 'Open', onClick: () => navigate(`/notes?note=${n.id}`) } });
    } catch (e) { toast(e.message, 'error'); }
  };
  const emailList = (withDone, only = null) => {
    const pick = (l) => (only ? l.filter((t) => only.has(t.id)) : l);
    const name = list?.name || 'Tasks';
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(listEmail(name, pick(open), pick(done), { withDone, link: list ? `${window.location.origin}/tasks/${list.id}` : '' }))); }
    catch { toast('Your browser’s storage is off', 'error'); return; }
    navigate('/mail?compose_doc=1');
  };
  const current = (tasks || []).find((t) => t.id === openId);
  const show = (id) => setParams(id ? { task: id } : {});

  const update = async (t, changes) => {
    setTasks((all) => all && all.map((x) => (x.id === t.id ? { ...x, ...changes } : x)));
    try { const next = await patch(`/tasks/tasks/${t.id}`, changes); setTasks((all) => all && all.map((x) => (x.id === t.id ? next : x))); loadTasks(); return next; }
    catch (e) {
      // No connection: kept here and sent when it's back; the change stays on screen (and in the lists kept here).
      if (unreachable(e)) {
        await changeAdd({ method: 'PATCH', url: `/tasks/tasks/${t.id}`, body: changes, user: user?.id, label: t.title });
        await patchKeptTask(t.id, { ...changes, offline: true });
        window.dispatchEvent(new Event('nw:changes'));
        setTasks((all) => all && all.map((x) => (x.id === t.id ? { ...x, offline: true } : x)));
        return { ...t, ...changes, offline: true };
      }
      toast(e.message, 'error'); loadTasks(); return null;
    }
  };
  const toggle = async (t) => {
    const next = await update(t, t.done ? { done: false } : { done: true, today: localToday() });
    if (next?.offline) { toast(`“${t.title}” ${next.done ? 'done' : 'not done'}: saved on this device, sent when the connection is back`); return; }
    if (!next?.done) return;
    // A repeating task comes back: say when.
    const again = next.next_id && (await get(`/tasks/lists/${next.list_id}/tasks`).catch(() => [])).find((x) => x.id === next.next_id);
    toast(`“${t.title}” done${again?.due ? ` · next due ${dueLabel(again.due).text}` : ''}`, 'info', { action: { label: 'Undo', onClick: () => update(next, { done: false }) } });
  };
  /** Delete a task (to its list's trash), with Undo. */
  const deleteTask = async (gone) => {
    try { await del(`/tasks/tasks/${gone.id}`); toast('Task deleted', 'info', { action: { label: 'Undo', onClick: () => post(`/tasks/trash/${gone.id}/restore`).then(() => { loadTasks(); loadLists(); }).catch((e) => toast(e.message, 'error')) } }); loadTasks(); loadLists(); }
    catch (e) {
      // No connection: deleted when it's back (gone from here meanwhile, also after reloading).
      if (unreachable(e)) { await keepDelete({ url: `/tasks/tasks/${gone.id}`, user: user?.id, label: gone.title, id: gone.id }); setTasks((all) => all && all.filter((x) => x.id !== gone.id)); toast(`“${gone.title}” deleted on this device, deleted for everyone when the connection is back`); return; }
      toast(e.message, 'error');
    }
  };

  // Keyboard shortcuts (see taskkeys.js) in the list view: J / K move between the open tasks (focus moves
  // with them), O or Enter opens one, X ticks it off, S stars it, # deletes it, N goes to Add a task.
  const keyState = useRef();
  // T: your timer on a task, started (stopping any other) or stopped if it's running on that one.
  const toggleTimer = async (t) => {
    try {
      const run = await get('/tasks/timer');
      if (run?.task_id === t.id) { await post('/tasks/timer/stop'); toast(`Timer stopped on “${t.title}”`); }
      else { await post(`/tasks/tasks/${t.id}/timer`); toast(`Timer started on “${t.title}”`); }
      loadTasks();
    } catch (e) { toast(e.message, 'error'); }
  };
  keyState.current = { on: user?.keys !== false, view, tasks, toggle, update, deleteTask, addBox, toggleTimer, openId };
  useEffect(() => {
    const focusTask = (id) => {
      const b = id && document.querySelector(`li.task[data-task="${CSS.escape(id)}"] .task-main`);
      if (b) { b.focus(); b.scrollIntoView?.({ block: 'nearest' }); }
    };
    const onKey = (e) => {
      const st = keyState.current;
      if (!st.on || st.view !== 'list') return;
      const action = taskKey(e);
      if (!action || document.querySelector('.modal-backdrop, [role=menu], [role=dialog]')) return;
      if (action === 'new') { if (st.addBox.current) { e.preventDefault(); st.addBox.current.focus(); } return; }
      const ids = [...document.querySelectorAll('li.task[data-task]:not(.done)')].map((li) => li.dataset.task);
      const here = document.activeElement?.closest?.('li.task[data-task]')?.dataset.task || null;
      if (action === 'next' || action === 'prev') { const id = stepTask(ids, here, action); if (id) { e.preventDefault(); focusTask(id); } return; }
      const t = here && (st.tasks || []).find((x) => x.id === here);
      if (!t) return;
      e.preventDefault();
      if (action === 'open') document.activeElement.closest('li.task').querySelector('.task-main')?.click();
      else if (action === 'comment') {
        if (st.openId !== t.id) document.activeElement.closest('li.task').querySelector('.task-main')?.click(); // (open already: stays so)
        // (once its details are open)
        let tries = 0;
        const go = () => { const box = document.querySelector('.task-comments-box input[aria-label="Add a comment"]'); if (box) { box.focus(); box.scrollIntoView?.({ block: 'nearest' }); } else if (tries++ < 20) setTimeout(go, 50); };
        go();
      }
      else if (action === 'star') { if (!t.done) st.update(t, { important: !t.important }); }
      else if (action === 'timer') st.toggleTimer(t);
      else if (action === 'done' || action === 'delete') {
        const next = t.done ? null : afterLeaving(ids, t.id);
        if (action === 'done') st.toggle(t); else st.deleteTask(t);
        setTimeout(() => focusTask(next), 50);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Quick add: "Call Kim tomorrow 3pm !" fills in the due date, time and star (shown before adding).
  const quick = title.trim() && !asTyped ? parseQuickAdd(title, { today: localToday(), people: list?.members.length ? people : [] }) : null;
  async function add(e) {
    e.preventDefault();
    const text = title.trim();
    if (!text || !list) return;
    const body = quick?.found.length ? { title: quick.title, due: quick.due, due_time: quick.due_time, repeat: quick.repeat, important: quick.important, ...(quick.priority && { priority: quick.priority }), assignee_id: quick.assignee_id, tags: quick.tags } : { title: text };
    if (who && who !== 'none' && !body.assignee_id) body.assignee_id = who; // showing Kim's tasks: a new one is Kim's (or it would vanish)
    setTitle(''); setAsTyped(false);
    const id = offlineId();
    try { await post(`/tasks/lists/${list.id}/tasks`, { ...body, id }); loadTasks(); loadLists(); }
    catch (err) {
      // No connection: the task is made when it's back (with this id, so a repeat makes nothing twice); shown meanwhile.
      if (unreachable(err)) {
        const url = `/tasks/lists/${list.id}/tasks`;
        const task = { id, list_id: list.id, title: body.title, notes: '', due: body.due || null, due_time: body.due_time || null, important: !!body.important, priority: body.priority || null, done: false, started: false, steps: [], attachments: [], blocked_by: [], tags: body.tags || [], section_id: null, assignee_id: body.assignee_id || null, created_by: user?.id, created_at: new Date().toISOString(), offline: true };
        await changeAdd({ method: 'POST', url, body: { ...body, id }, user: user?.id, label: body.title });
        await appendKept(url, task);
        window.dispatchEvent(new Event('nw:changes'));
        setTasks((all) => (all ? [...all, task] : [task]));
        toast(`“${body.title}” added on this device, sent when the connection is back`);
        return;
      }
      toast(err.message, 'error'); setTitle(text);
    }
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
      <li key={t.id} data-task={t.id} className={`task ${t.done ? 'done' : ''} ${t.id === openId ? 'open' : ''} ${dropAt === i && dragging ? 'drop-before' : ''}`}
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
            {t.notes && <span className="muted small ellipsis task-notes">{t.notes.split('\n')[0]}</span>}
            {due && <span className={`pill due ${due.tone}`}>{due.text}</span>}
            {t.priority && !t.done && (() => { const [, name, mark] = PRIORITIES.find(([k]) => k === t.priority); return <span className={`pill priority ${t.priority}`} title={`${name} priority`} aria-label={`${name} priority`}>{mark} {name}</span>; })()}
            {t.offline && <NotSent />}
            {t.started && !t.done && <span className="pill doing">In progress</span>}
            {waits.length > 0 && <span className="pill waiting" title={`Waiting on ${waits.map((x) => `“${x.title}”`).join(', ')}`}>⏳ Waiting on {waits.length === 1 ? waits[0].title : `${waits.length} tasks`}</span>}
            {t.steps?.length > 0 && <span className={`muted small task-steps ${t.steps.every((x) => x.done) ? 'all' : ''}`} title="Steps done">☑ {t.steps.filter((x) => x.done).length}/{t.steps.length}</span>}
            {t.attachments?.length > 0 && <span className="muted small task-files" title={`${t.attachments.length} file${t.attachments.length === 1 ? '' : 's'}`}>📎 {t.attachments.length}</span>}
            {times[t.id]?.running.length > 0 && <span className="pill timing" title={`Timer running: ${times[t.id].running.map((x) => x.name).join(', ')}`}>● {times[t.id].running.map((x) => x.name.split(' ')[0]).join(', ')}</span>}
            {times[t.id]?.minutes > 0 && <span className="muted small task-time" title="Time spent">⏱ {formatMinutes(times[t.id].minutes)}{t.estimate ? ` of ~${formatMinutes(t.estimate)}` : ''}</span>}
            {t.estimate > 0 && !(times[t.id]?.minutes > 0) && !t.done && <span className="muted small task-estimate" title="Estimate">~{formatMinutes(t.estimate)}</span>}
            {t.comments > 0 && (
              <span className="muted small task-comments" title={`${t.comments} comment${t.comments === 1 ? '' : 's'}${t.comments_new > 0 ? `, ${t.comments_new} new` : ''}`}>
                💬 {t.comments}{t.comments_new > 0 && <strong className="task-comments-new"> · {t.comments_new} new</strong>}
              </span>
            )}
            {t.tags?.map((tag) => <span key={tag} className="pill tag">#{tag}</span>)}
            {t.repeat && !t.done && <span className="muted small task-repeat" title={`Repeats: ${repeatText(t.repeat).toLowerCase()}${t.repeat_until ? `, until ${t.repeat_until}` : ''}`}>⟳ {repeatText(t.repeat)}</span>}
          </span>
        </button>
        {t.link_url && !selecting && <Link to={t.link_url} className="task-link" title={t.link_label || 'Linked'} aria-label={`Open what “${t.title}” is about`}>{linkIcon(t.link_url)}</Link>}
        {t.assignee_name && <span title={`For ${t.assignee_name}`}><Avatar name={t.assignee_name} size={24} userId={t.assignee_id} /></span>}
        {!t.done && <button type="button" className={`icon-btn task-star ${t.important ? 'on' : ''}`} aria-pressed={!!t.important} aria-label={`${t.important ? 'Not important' : 'Mark important'}: ${t.title}`}
          title={t.important ? 'Important (click to unmark)' : 'Mark important'} onClick={() => update(t, { important: !t.important })}>{t.important ? '★' : '☆'}</button>}
      </li>
    );
  };

  if (lists === null) return null;
  const heading = tagView ? `#${tagView}` : listId === MYDAY ? 'My Day' : listId === ASSIGNED ? 'Assigned to me' : listId === IMPORTANT ? 'Important' : listId === PLANNED ? 'Planned' : listId === COMPLETED ? 'Completed' : list?.name;
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
        <button type="button" className={`subnav-item ${listId === COMPLETED ? 'active' : ''}`} onClick={() => navigate(`/tasks/${COMPLETED}`)} title="What you ticked off in the last 30 days, from all your lists">
          <Icon name="check" /><span className="grow">Completed</span>
        </button>
        <button type="button" className="subnav-item" onClick={() => setDialog('sheet')} title="Your time on tasks this week, day by day">
          <Icon name="clock" /><span className="grow">My timesheet</span>
        </button>
        {lists?.some((l) => l.members.length) && <button type="button" className="subnav-item" onClick={() => setDialog('team')} title="Open tasks per person across the shared lists you're on">
          <Icon name="people" /><span className="grow">Team workload</span>
        </button>}
        <div className="subnav-title row">Lists<div className="grow" /><button type="button" className="icon-btn" aria-label="New list" onClick={() => setDialog('new')}><Icon name="plus" size={18} /></button></div>
        {lists.filter((l) => l.mine && !l.hidden).map((l) => (
          <button key={l.id} type="button" className={`subnav-item ${l.id === listId ? 'active' : ''}`} onClick={() => navigate(`/tasks/${l.id}`)}>
            {l.emoji ? <span className="list-emoji" aria-hidden="true">{l.emoji}</span> : <Icon name={l.mine && !l.members.length ? 'check' : 'people'} style={l.color ? { color: l.color } : undefined} />}<span className="grow ellipsis">{l.name}</span>{l.inbox && lists.length > 1 && <span className="inbox-mark" role="img" aria-label="Add to Tasks puts things here" title="Add to Tasks (in Mail, Chat and Notes) puts things here">📥</span>}{l.color && <span className="list-dot" style={{ background: l.color }} aria-hidden="true" />}{l.comments_new > 0 && <span className="list-new-comments" role="img" aria-label={`${l.comments_new} ${l.comments_new === 1 ? 'task' : 'tasks'} with new comments`} title={`${l.comments_new} ${l.comments_new === 1 ? 'task' : 'tasks'} with new comments`}>💬</span>}{l.open > 0 && <span className="count">{l.open}</span>}
          </button>
        ))}
        {lists.some((l) => !l.mine && !l.hidden) && <div className="subnav-title">Shared with me</div>}
        {lists.filter((l) => !l.mine && !l.hidden).map((l) => (
          <button key={l.id} type="button" className={`subnav-item ${l.id === listId ? 'active' : ''}`} onClick={() => navigate(`/tasks/${l.id}`)}>
            {l.emoji ? <span className="list-emoji" aria-hidden="true">{l.emoji}</span> : <Icon name={l.mine && !l.members.length ? 'check' : 'people'} style={l.color ? { color: l.color } : undefined} />}<span className="grow ellipsis">{l.name} <span className="muted small">from {String(l.owner_name || '').split(' ')[0]}</span></span>{l.inbox && lists.length > 1 && <span className="inbox-mark" role="img" aria-label="Add to Tasks puts things here" title="Add to Tasks (in Mail, Chat and Notes) puts things here">📥</span>}{l.color && <span className="list-dot" style={{ background: l.color }} aria-hidden="true" />}{l.comments_new > 0 && <span className="list-new-comments" role="img" aria-label={`${l.comments_new} ${l.comments_new === 1 ? 'task' : 'tasks'} with new comments`} title={`${l.comments_new} ${l.comments_new === 1 ? 'task' : 'tasks'} with new comments`}>💬</span>}{l.open > 0 && <span className="count">{l.open}</span>}
          </button>
        ))}
        {lists.some((l) => l.hidden) && <>
          <button type="button" className="subnav-item muted" aria-expanded={showHidden} onClick={() => setShowHidden(!showHidden)}>
            <span aria-hidden="true" style={{ width: 24, textAlign: 'center' }}>{showHidden ? '▾' : '▸'}</span><span className="grow">Hidden lists</span><span className="count">{lists.filter((l) => l.hidden).length}</span></button>
          {showHidden && <div role="group" aria-label="Hidden lists">{lists.filter((l) => l.hidden).map((l) => (
            <button key={l.id} type="button" className={`subnav-item ${l.id === listId ? 'active' : ''}`} onClick={() => navigate(`/tasks/${l.id}`)}>
              {l.emoji ? <span className="list-emoji" aria-hidden="true">{l.emoji}</span> : <Icon name={l.members.length ? 'people' : 'check'} style={l.color ? { color: l.color } : undefined} />}<span className="grow ellipsis">{l.name}{!l.mine && <span className="muted small"> from {String(l.owner_name || '').split(' ')[0]}</span>}</span>{l.open > 0 && <span className="count">{l.open}</span>}
            </button>
          ))}</div>}
        </>}
        {(tagList.length > 0 || tagView) && <div className="subnav-title">Tags</div>}
        {tagList.map((t) => (
          <button key={t.name} type="button" className={`subnav-item ${tagView === t.name ? 'active' : ''}`} aria-label={`Tag ${t.name}, ${t.count} open`} onClick={() => navigate(`/tasks/tag:${encodeURIComponent(t.name)}`)}>
            <span className="nav-star" aria-hidden="true">#</span><span className="grow ellipsis">{t.name}</span><span className="count">{t.count}</span>
          </button>
        ))}
        <button type="button" className="subnav-item" onClick={() => setDialog('bin')}><Icon name="trash" /><span className="grow">Recently deleted</span></button>
        <button type="button" className="subnav-item" title="Tasks.json from the Tasks folder of a Google Takeout download: each list comes in as a new list" onClick={() => googleRef.current?.click()}><Icon name="upload" /><span className="grow">Import from Google Tasks…</span></button>
        <input ref={googleRef} type="file" accept=".json,application/json" hidden aria-label="Google Tasks file" onChange={async (e) => {
          const f = e.target.files[0]; e.target.value = '';
          if (!f) return;
          try {
            let data; try { data = JSON.parse(await f.text()); } catch { throw new Error('That isn’t a Google Tasks export (Tasks.json from Google Takeout)'); }
            const r = await post('/tasks/import/google', { data });
            await loadLists();
            const n = r.lists.reduce((sum, l) => sum + l.tasks, 0);
            toast(`Imported ${r.lists.length} list${r.lists.length === 1 ? '' : 's'} with ${n} task${n === 1 ? '' : 's'} from Google Tasks`);
            navigate(`/tasks/${r.lists[0].id}`);
          } catch (err) { toast(err.message, 'error'); }
        }} />
        <button type="button" className="subnav-item" title="A Trello board's JSON (in Trello: board menu → Print, export and share → Export as JSON): it comes in as a list, its lists as sections" onClick={() => trelloRef.current?.click()}><Icon name="upload" /><span className="grow">Import a Trello board…</span></button>
        <input ref={trelloRef} type="file" accept=".json,application/json" hidden aria-label="Trello board file" onChange={async (e) => {
          const f = e.target.files[0]; e.target.value = '';
          if (!f) return;
          try {
            let data; try { data = JSON.parse(await f.text()); } catch { throw new Error('That isn’t a Trello board export (its JSON)'); }
            const r = await post('/tasks/import/trello', { data });
            await loadLists();
            toast(`Imported “${r.name}”: ${r.tasks} task${r.tasks === 1 ? '' : 's'} in ${r.sections} section${r.sections === 1 ? '' : 's'}`);
            navigate(`/tasks/${r.id}`);
          } catch (err) { toast(err.message, 'error'); }
        }} />
        <button type="button" className="subnav-item" title="A spreadsheet (CSV) with a List column, such as Tasks.csv from Settings → Download your data: each list comes in as a new list" onClick={() => csvListsRef.current?.click()}><Icon name="upload" /><span className="grow">Import lists from CSV…</span></button>
        <input ref={csvListsRef} type="file" accept=".csv,text/csv" hidden aria-label="Task lists spreadsheet" onChange={async (e) => {
          const f = e.target.files[0]; e.target.value = '';
          if (!f) return;
          try {
            const r = await postText('/tasks/import/csv', await f.text());
            await loadLists();
            const n = r.lists.reduce((sum, l) => sum + l.tasks, 0);
            toast(`Imported ${r.lists.length} list${r.lists.length === 1 ? '' : 's'} with ${n} task${n === 1 ? '' : 's'}`);
            navigate(`/tasks/${r.lists[0].id}`);
          } catch (err) { toast(err.message, 'error'); }
        }} />
      </aside>
      {found && (
        <section className="tasks-main">
          <div className="page-head"><h1 className="grow ellipsis">Tasks matching “{found.q}”</h1><button type="button" className="icon-btn" aria-label="Close search" onClick={() => setFound(null)}><Icon name="close" /></button></div>
          {!found.list.length ? <Empty icon="search" title="No tasks found" /> : (
            <ul className="tasks task-results" aria-label="Search results">
              {found.list.map((t) => {
                const due = t.due && dueLabel(t.due, new Date(), t.due_time);
                return (
                  <li key={t.id} data-task={t.id} className={`task ${t.done ? 'done' : ''}`}>
                    <button type="button" className="task-main" onClick={() => { setFound(null); navigate(`/tasks/${t.list_id}?task=${t.id}`); }}>
                      <span className="task-title">{t.done ? '✓ ' : ''}{t.title}</span>
                      <span className="task-meta"><span className="muted small">{t.list_name}</span>{due && !t.done && <span className={`pill due ${due.tone}`}>{due.text}</span>}{t.notes && <span className="muted small ellipsis task-notes">{t.notes.split('\n')[0]}</span>}
                        {t.comment_match && <span className="muted small ellipsis task-comment-match">Comment: “{t.comment_match}”</span>}</span>
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
          <h1 className="grow ellipsis">{list?.emoji && !virtual ? `${list.emoji} ` : ''}{heading}
            {open.some((t) => t.estimate) && <span className="muted small task-estimate-total" title="Estimates of the open tasks here, added up"> ~{formatMinutes(open.reduce((n, t) => n + (t.estimate || 0), 0))} to do</span>}</h1>
          {list && !list.mine && <span className="muted small">Shared by {list.owner_name}</span>}
          {list?.mine && <button type="button" className="btn" onClick={() => setDialog('share')}><Icon name="share" size={18} /> {list.members.length ? `Shared with ${list.members.length}` : 'Share'}</button>}
          {list && (
            <div className="tabs view-toggle" role="tablist" aria-label="View">
              <button type="button" role="tab" aria-selected={view === 'list'} className={view === 'list' ? 'on' : ''} onClick={() => setView('list')}>List</button>
              <button type="button" role="tab" aria-selected={view === 'board'} className={view === 'board' ? 'on' : ''} onClick={() => setView('board')}>Board</button>
              <button type="button" role="tab" aria-selected={view === 'timeline'} className={view === 'timeline' ? 'on' : ''} onClick={() => setView('timeline')}>Timeline</button>
            </div>
          )}
          {list?.members.length > 0 && (
            <select className="task-who" aria-label="Show tasks for" value={who || ''} onChange={(e) => setWho(e.target.value || null)}>
              <option value="">Everyone</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              <option value="none">Not assigned</option>
            </select>
          )}
          {whoName && <button type="button" className="btn small" onClick={() => setWho(null)}>Show everyone</button>}
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
              toast(`Added ${r.added} ${r.added === 1 ? 'task' : 'tasks'}${r.done ? ` (${r.done} already done)` : ''}${r.already ? `; ${r.already} already in the list` : ''}${r.skipped ? `; ${r.skipped} rows without a task skipped` : ''}`);
              loadTasks();
            } catch (err) { toast(err.message, 'error'); }
          }} />
          {list && (
            <Menu trigger={(p) => <button type="button" className="icon-btn" aria-label="List actions" {...p}><Icon name="more" /></button>} items={[
              ...(list.mine ? [{ label: 'Rename list', icon: 'edit', onClick: () => setDialog('rename') }, { label: 'Colour and emoji…', icon: 'star', onClick: () => setDialog('look') }] : []),
              ...(lists.findIndex((l) => l.id === list.id) > 0 ? [{ label: 'Move up on the left', icon: 'move', onClick: () => orderList(-1) }] : []),
              ...(lists.findIndex((l) => l.id === list.id) < lists.length - 1 ? [{ label: 'Move down on the left', icon: 'move', onClick: () => orderList(1) }] : []),
              ...(list.hidden ? [{ label: 'Show on the left', icon: 'restore', onClick: () => hideList(list, false) }]
                : !list.inbox ? [{ label: 'Hide from the left', icon: 'archive', onClick: () => hideList(list, true) }] : []),
              { label: 'Time report…', icon: 'clock', onClick: () => setDialog('time') },
              ...(list.members.length ? [{ label: 'Workload…', icon: 'people', onClick: () => setDialog('workload') }] : []),
              { label: 'Import from CSV…', icon: 'upload', onClick: () => importInput.current?.click() },
              { label: 'Import from Sheets…', icon: 'sheet', onClick: () => setDialog('from-sheet') }, // (a spreadsheet in Drive, its first sheet, read as the CSV is)
              { label: 'Download as CSV', icon: 'download', onClick: () => { window.location.href = `/api/tasks/lists/${list.id}/export.csv`; } },
              { label: 'Download as Excel (.xlsx)', icon: 'download', onClick: () => { window.location.href = `/api/tasks/lists/${list.id}/export.xlsx`; } },
              ...((tasks || []).length ? [{ label: 'Open in Sheets', icon: 'sheet', onClick: async () => {
                try { const r = await post(`/tasks/lists/${list.id}/sheet`, {}); toast(`Made “${r.name}” in your Drive`, 'info', { action: { label: 'Open', onClick: () => navigate(`/sheets/${r.id}`) } }); } catch (e) { toast(e.message, 'error'); }
              } }] : []),
              { label: 'Print list', icon: 'print', onClick: () => printHtml(listPrintHtml(list.name, open, done)) },
              ...(mail?.enabled ? [{ label: 'Send by email', icon: 'mail', onClick: () => emailList(false) }, ...(done.length ? [{ label: 'Send by email, with completed', icon: 'mail', onClick: () => emailList(true) }] : [])] : []),
              ...(open.length ? [{ label: 'Copy to a note', icon: 'note', onClick: listToNote }] : []),
              ...(list ? [{ label: 'Copy to a document', icon: 'doc', onClick: () => listToDoc(false) }, ...(done.length ? [{ label: 'Copy to a document, with completed', icon: 'doc', onClick: () => listToDoc(true) }] : [])] : []),
              ...(mail?.enabled && list.members.length ? [{ label: 'Email the list’s people', icon: 'mail', onClick: () => { // (its owner and everyone it's shared with, not you)
                const to = [{ name: list.owner_name, username: list.owner_email }, ...list.members].filter((x) => x.username && x.username !== user.username);
                navigate(`/mail?compose=${encodeURIComponent(to.map((x) => `${String(x.name || '').replace(/[",<>]/g, '')} <${x.username}>`).join(', '))}&subject=${encodeURIComponent(list.name)}`);
              } }] : []),
              ...(list.members.length ? [{ label: 'Chat with the list’s people', icon: 'chat', onClick: async () => {
                try { const r = await post(`/tasks/lists/${list.id}/chat`, {}); toast(r.created ? 'A channel for this list, with everyone on it' : r.added ? `Added ${r.added} more to the list’s channel` : 'The list’s channel'); navigate(`/chat/${r.id}`); } catch (e) { toast(e.message, 'error'); }
              } }] : []),
              ...(list.inbox ? ((lists || []).find((l) => l.mine)?.id !== list.id ? [{ label: 'Stop using for Add to Tasks', icon: 'close', onClick: async () => {
                try { const r = await put('/tasks/inbox', { list_id: null }); toast(`Add to Tasks uses “${r.list.name}” again`); loadLists(); } catch (e) { toast(e.message, 'error'); }
              } }] : []) : [{ label: 'Use for Add to Tasks', icon: 'check', onClick: async () => { // (where Mail, Chat and Notes put the tasks they add)
                try { await put('/tasks/inbox', { list_id: list.id }); toast(`Add to Tasks (in Mail, Chat and Notes) now uses “${list.name}”`); loadLists(); } catch (e) { toast(e.message, 'error'); }
              } }]),
              { label: 'Make a copy…', icon: 'copy', onClick: () => setDialog('copy') },
              ...(done.length ? [{ label: `Delete completed tasks (${done.length})`, icon: 'check', onClick: async () => { await del(`/tasks/lists/${list.id}/done`); loadTasks(); toast('Completed tasks deleted: ⋮ → Deleted tasks… puts them back'); } }] : []),
              { label: 'Activity…', icon: 'clock', onClick: () => setDialog('activity') },
              { label: 'Deleted tasks…', icon: 'trash', onClick: () => setDialog('trash') },
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
              {quick.priority && <span className="chip">{PRIORITIES.find(([k]) => k === quick.priority).slice(1).reverse().join(' ')} priority</span>}
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
            <select className="small" aria-label="Move the selected tasks' due dates" disabled={!picked.size} value="" title="Each one's own date moved; those without a date stay without"
              onChange={(e) => { const d = Number(e.target.value); if (d) batch({ change: { due_shift: d } }, (n) => `${nTasks(n)}: dates moved ${SHIFTS.find(([v]) => v === d)[1]}`); }}>
              <option value="">Move dates…</option>
              {SHIFTS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </select>
            <select className="small" aria-label="Priority for the selected tasks" disabled={!picked.size} value="" onChange={(e) => { const v = e.target.value; if (v) batch({ change: { priority: v === 'none' ? null : v } }, (n) => `${nTasks(n)}: ${v === 'none' ? 'no priority' : `${v} priority`}`); }}>
              <option value="">Priority…</option>
              {PRIORITIES.map(([k, name, mark]) => <option key={k} value={k}>{mark} {name}</option>)}
              <option value="none">None</option>
            </select>
            <button type="button" className="btn small" disabled={!picked.size} onClick={() => batch({ change: { important: true } }, (n) => `${nTasks(n)} marked important`)}>★ Important</button>
            {/* In My Day: take them off it; anywhere else: add them to it */}
            <button type="button" className="btn small" disabled={!picked.size} title={listId === MYDAY ? 'Take them off today’s list (they stay on their own lists)' : 'Add them to My Day: your list for today'} onClick={async () => {
              const ids = (tasks || []).filter((t) => picked.has(t.id)).map((t) => t.id); // in this list's order
              const off = listId === MYDAY;
              try {
                const r = await post('/tasks/myday/batch', { ids, today: localToday(), ...(off && { on: false }) });
                toast(off ? `${nTasks(r.changed)} taken off My Day` : r.changed ? `${nTasks(r.changed)} added to My Day` : 'They’re in My Day already');
                setPicked(new Set()); loadMyDay(); if (off) loadTasks();
              } catch (e) { toast(e.message, 'error'); }
            }}>{listId === MYDAY ? 'Take off My Day' : '☀ My Day'}</button>
            {!virtual && people.length > 1 && <select aria-label="Assign the selected tasks to" value="" disabled={!picked.size} onChange={(e) => { const v = e.target.value; if (!v) return; const to = v === '__none__' ? null : v; batch({ change: { assignee_id: to } }, (n) => (to ? `${nTasks(n)} assigned to ${people.find((p) => p.id === to)?.name}` : `${nTasks(n)}: not assigned`)); }}>
              <option value="">Assign to…</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.id === user?.id ? `${p.name} (me)` : p.name}</option>)}
              <option value="__none__">No one</option>
            </select>}
            {(() => { // a tag for them all (one used here, or a new one); one some of them have, taken off
              const used = [...new Set((tasks || []).flatMap((t) => t.tags || []))].sort();
              const onPicked = [...new Set((tasks || []).filter((t) => picked.has(t.id)).flatMap((t) => t.tags || []))].sort();
              return (<>
                <select aria-label="Tag the selected tasks" value="" disabled={!picked.size} onChange={(e) => { const v = e.target.value; if (v === '__new__') setDialog('tagnew'); else if (v) batch({ change: { add_tag: v } }, (n) => `${nTasks(n)} tagged #${v}`); }}>
                  <option value="">Tag…</option>
                  {used.map((t) => <option key={t} value={t}>#{t}</option>)}
                  <option value="__new__">+ New tag…</option>
                </select>
                {onPicked.length > 0 && <select aria-label="Take a tag off the selected tasks" value="" onChange={(e) => { const v = e.target.value; if (v) batch({ change: { remove_tag: v } }, (n) => `#${v} taken off ${nTasks(n)}`); }}>
                  <option value="">Remove tag…</option>
                  {onPicked.map((t) => <option key={t} value={t}>#{t}</option>)}
                </select>}
              </>);
            })()}
            {!virtual && <select aria-label="Put the selected tasks in a section" value="" disabled={!picked.size} onChange={(e) => { const v = e.target.value; if (v === '__new__') setDialog('secnew'); else if (v) batch({ change: { section_id: v === '__none__' ? null : v } }, (n) => (v === '__none__' ? `${nTasks(n)}: no section` : `${nTasks(n)} put in ${sections.find((x) => x.id === v)?.name}`)); }}>
              <option value="">Section…</option>
              {sections.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              {sections.length > 0 && <option value="__none__">No section</option>}
              <option value="__new__">+ New section…</option>
            </select>}
            <select aria-label="Move the selected tasks to" value="" disabled={!picked.size} onChange={(e) => { const to = e.target.value; if (to === '__new__') setDialog('movenew'); else if (to) batch({ change: { list_id: to } }, (n) => `${nTasks(n)} moved to ${lists.find((l) => l.id === to)?.name}`); }}>
              <option value="">Move to…</option>
              {(lists || []).filter((l) => l.id !== listId).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              <option value="__new__">+ New list…</option>
            </select>
            <select aria-label="Copy the selected tasks to" value="" disabled={!picked.size} onChange={(e) => {
              const to = e.target.value;
              if (to === '__new__') setDialog('copynew');
              else if (to) copyPicked(to, lists.find((l) => l.id === to)?.name);
            }}>
              <option value="">Copy to…</option>
              {(lists || []).filter((l) => l.id !== listId).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              <option value="__new__">+ New list…</option>
            </select>
            <button type="button" className="btn small" disabled={!picked.size} title="Links to these tasks in a Chat conversation's message box (they show as task cards)" onClick={() => setChatting((tasks || []).filter((t) => picked.has(t.id)))}><Icon name="chat" size={16} /> Send in Chat…</button>
            {mail?.enabled && <button type="button" className="btn small" disabled={!picked.size} title="A new email with just these tasks in it, as a list's email has them" onClick={() => emailList(true, picked)}><Icon name="mail" size={16} /> Email</button>}
            <button type="button" className="btn small" disabled={!picked.size} title="Just these tasks, printed (or saved as PDF) as a list prints"
              onClick={() => printHtml(listPrintHtml(list?.name || 'Tasks', open.filter((t) => picked.has(t.id)), done.filter((t) => picked.has(t.id))))}><Icon name="print" size={16} /> Print</button>
            <button type="button" className="btn small" disabled={!picked.size} title="Just these tasks as a spreadsheet (CSV), in the same columns as a list's download"
              onClick={() => { window.location.href = `/api/tasks/export.csv?ids=${[...picked].join(',')}`; }}><Icon name="download" size={16} /> Download (CSV)</button>
            <button type="button" className="btn small danger" disabled={!picked.size} onClick={() => setConfirmDelete(true)}><Icon name="trash" size={16} /> Delete</button>
          </div>
        )}
        {chatting && <SendInChat items={chatting.map((t) => ({ name: t.title, url: taskLink(t) }))} what={chatting.length === 1 ? 'the task' : `${chatting.length} tasks`} onClose={() => setChatting(null)} />}
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
        ) : listId === COMPLETED ? (
          !done.length ? <Empty icon="check" title="Nothing completed lately">Tasks you tick off, on any list, show up here for 30 days.{doneDays === 7 && <> <button type="button" className="link-btn" onClick={() => setDoneDays(30)}>Show the last 30 days</button></>}</Empty> : (
            <div className="planned completed-days">
              <div className="row"><p className="muted small grow" style={{ margin: 0 }}>{done.length} {done.length === 1 ? 'task' : 'tasks'} done in the last {doneDays} days</p>
                <select aria-label="Completed in" value={doneDays} onChange={(e) => setDoneDays(Number(e.target.value))}><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option></select></div>
              {groupCompleted(done).map((g) => (
                <section key={g.key} className="planned-group" aria-label={g.label}>
                  <h3 className="planned-heading">{g.label} <span className="muted small">{g.tasks.length}</span></h3>
                  <ul className="task-list">{g.tasks.map(row)}</ul>
                </section>
              ))}
            </div>
          )
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
        onDelete={() => { show(null); deleteTask(current); }}
        onNewList={newList}
        onMove={async (to, toName) => { show(null); if (await update(current, { list_id: to })) toast(`Moved to ${toName || lists.find((l) => l.id === to)?.name}`); }} />}
      {dialog === 'bin' && <RecentlyDeleted title="Recently deleted lists" what="Lists" list="/tasks/bin" restore={(id) => `/tasks/bin/${id}/restore`} forever={(id) => `/tasks/bin/${id}`} empty="/tasks/bin"
        onClose={() => setDialog(null)} onRestored={async (b) => { setDialog(null); await loadLists(); navigate(`/tasks/${b.list_id}`); }} />}
      {dialog === 'new' && <PromptModal title="New list" label="List name" confirm="Create" onClose={() => setDialog(null)}
        onSubmit={async (name) => { const r = await post('/tasks/lists', { name }); await loadLists(); navigate(`/tasks/${r.id}`); }} />}
      {/* "Move to… → + New list…": a list made with a name, the tasks selected moved into it (this list stays open) */}
      {dialog === 'movenew' && <PromptModal title={`Move ${nTasks(picked.size)} to a new list`} label="List name" confirm="Make it and move" onClose={() => setDialog(null)}
        onSubmit={async (name) => { const r = await newList(name); await batch({ change: { list_id: r.id } }, (n) => `${nTasks(n)} moved to ${r.name}`); loadLists(); }} />}
      {dialog === 'tagnew' && <PromptModal title={`Tag ${nTasks(picked.size)}`} label="Tag (a word, like client)" confirm="Tag them" onClose={() => setDialog(null)}
        onSubmit={async (tag) => {
          const t = tag.replace(/^#+/, '').trim().toLowerCase();
          const ids = [...picked];
          await post('/tasks/tasks/batch', { ids, change: { add_tag: t } }); // an error (not a word) shows here
          toast(`${nTasks(ids.length)} tagged #${t}`); setPicked(new Set()); loadTasks();
        }} />}
      {dialog === 'secnew' && list && <PromptModal title={`Put ${nTasks(picked.size)} in a new section`} label="Section name" confirm="Make it and put them there" onClose={() => setDialog(null)}
        onSubmit={async (name) => { const sec = await post(`/tasks/lists/${list.id}/sections`, { name }); await batch({ change: { section_id: sec.id } }, (n) => `${nTasks(n)} put in ${sec.name || name}`); get(`/tasks/lists/${list.id}/sections`).then(setSections).catch(() => {}); }} />}
      {dialog === 'copynew' && <PromptModal title={`Copy ${nTasks(picked.size)} to a new list`} label="List name" confirm="Make it and copy" onClose={() => setDialog(null)}
        onSubmit={async (name) => { const r = await newList(name); await copyPicked(r.id, r.name); }} />}
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
      {dialog === 'team' && <Workload onClose={() => setDialog(null)} />}
      {dialog === 'workload' && list && <Workload list={list} onClose={() => setDialog(null)} onPick={(id) => { setWho(id); setDialog(null); }} />}
      {dialog === 'time' && list && <TimeReport list={list} onClose={() => setDialog(null)} onRate={loadLists} />}
      {dialog === 'from-sheet' && list && <DrivePicker title={`Import into ${list.name} from a spreadsheet`} accept={(x) => x.kind === 'sheet'} empty="No spreadsheets found." onClose={() => setDialog(null)}
        onPick={async (x) => {
          setDialog(null);
          try {
            const r = await post(`/tasks/lists/${list.id}/from-sheet`, { file: x.id, sheet: 0 });
            toast(`Added ${r.added} ${r.added === 1 ? 'task' : 'tasks'} from “${x.name}”${r.done ? ` (${r.done} already done)` : ''}${r.already ? `; ${r.already} already in the list` : ''}${r.skipped ? `; ${r.skipped} rows without a task skipped` : ''}`);
            loadTasks();
          } catch (e) { toast(e.message, 'error'); }
        }} />}
      {dialog === 'sheet' && <Timesheet onClose={() => setDialog(null)} onOpen={(t) => { setDialog(null); navigate(`/tasks/${t.list_id}?task=${t.id}`); }} />}
      {dialog === 'activity' && list && <ListActivity list={list} onClose={() => setDialog(null)} onOpen={(id) => { setDialog(null); navigate(`/tasks/${list.id}?task=${id}`); }} />}
      {dialog === 'trash' && list && <TaskTrash list={list} onClose={() => setDialog(null)} onRestored={() => { loadTasks(); loadLists(); }} />}
      {dialog === 'look' && list && <ListLook list={list} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); loadLists(); }} />}
      {dialog === 'copy' && list && <CopyList list={list} onClose={() => setDialog(null)} onDone={async (r) => { setDialog(null); await loadLists(); navigate(`/tasks/${r.id}`); }} />}
      {dialog === 'share' && list && <ShareList list={list} me={user} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); loadLists(); }} />}
      {dialog === 'delete' && list && (
        <ConfirmModal title={list.mine ? `Delete “${list.name}”?` : `Leave “${list.name}”?`} confirm={list.mine ? 'Delete list' : 'Leave'}
          message={list.mine ? `Its ${open.length + done.length} task${open.length + done.length === 1 ? '' : 's'} go too${list.members.length ? ', for everyone it’s shared with' : ''}. You can put it back from Recently deleted for 30 days.` : 'You won’t see it any more, and tasks given to you on it become nobody’s.'}
          onClose={() => setDialog(null)} onConfirm={async () => {
            const r = await del(`/tasks/lists/${list.id}`); setDialog(null); await loadLists(); navigate('/tasks');
            if (r?.bin_id) {
              toast(`“${list.name}” deleted`, 'info', { action: { label: 'Undo', onClick: async () => {
                try { const b = await post(`/tasks/bin/${r.bin_id}/restore`); await loadLists(); navigate(`/tasks/${b.list_id}`); } catch (e) { toast(e.message, 'error'); }
              } } });
            }
          }} />
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
                        {t.priority && !t.done && (() => { const [, name, mark] = PRIORITIES.find(([k]) => k === t.priority); return <span className={`pill priority ${t.priority}`} aria-label={`${name} priority`}>{mark} {name}</span>; })()}
                        {waitingOn(t, all).length > 0 && <span className="pill waiting">⏳ Waiting</span>}
                        {t.steps?.length > 0 && <span className="muted small">☑ {t.steps.filter((x) => x.done).length}/{t.steps.length}</span>}
                        {t.comments > 0 && <span className="muted small" title={`${t.comments} comment${t.comments === 1 ? '' : 's'}${t.comments_new > 0 ? `, ${t.comments_new} new` : ''}`}>💬 {t.comments}{t.comments_new > 0 && <strong className="task-comments-new"> · {t.comments_new} new</strong>}</span>}
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
    setForm({ at: localInput(next.getTime()), minutes: task.estimate || 60 }); // as long as it's estimated to take
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
            {[...new Set([15, 30, 45, 60, 90, 120, 180, 240, form.minutes])].sort((a, b) => a - b).map((m) => <option key={m} value={m}>{formatMinutes(m)}</option>)}
          </select>
          <button className="btn small primary" disabled={!Number.isFinite(startMs)}>Book</button>
          <button type="button" className="btn small" onClick={() => setForm(null)}>Cancel</button>
          {clash.length > 0 && <p className="small task-clash" role="status">⚠ Clashes with {clash.map((x) => x.title).join(', ')}</p>}
        </form>
      )}
    </section>
  );
}

const durationText = (min) => { const h = Math.floor(min / 60), m = min % 60; return [h && `${h}h`, m && `${m}m`].filter(Boolean).join(' ') || '0m'; };

/** ✎ on one of your time entries: change how long it was, or its note. onSaved(the task's time). */
function EntryEdit({ entry, minutes, onSaved, onCancel }) {
  const toast = useToast();
  const [f, setF] = useState({ duration: durationText(minutes ?? entry.minutes), note: entry.note || '' });
  return (
    <form className="row wrap" style={{ gap: 6 }} aria-label="Change time entry" onSubmit={async (e) => {
      e.preventDefault();
      try { const r = await patch(`/tasks/time/${entry.id}`, f); toast('Time entry changed'); onSaved(r); } catch (err) { toast(err.message, 'error'); }
    }}>
      <input aria-label="How long" size={8} autoFocus value={f.duration} onChange={(e) => setF({ ...f, duration: e.target.value })} />
      <input aria-label="Note" placeholder="What for (optional)" maxLength={300} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
      <button className="btn small primary">Save</button><button type="button" className="btn small" onClick={onCancel}>Cancel</button>
    </form>
  );
}

function TaskTime({ task }) {
  const { user } = useAuth();
  const toast = useToast();
  const [t, setT] = useState(null);
  const [adding, setAdding] = useState(null); // { duration, day, note }
  const [editing, setEditing] = useState(null); // an entry's id
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
          ? <button type="button" className="btn small primary" onClick={() => act(() => post('/tasks/timer/stop').then(() => get(`/tasks/tasks/${task.id}/time`)), 'Timer stopped')}>
            ■ {mine.until ? `Stop focus (${Math.max(0, Math.ceil((mine.until - Date.now()) / 60000))} min left)` : `Stop timer (${formatMinutes(elapsed)})`}</button>
          : <>
            <button type="button" className="btn small" onClick={() => act(() => post(`/tasks/tasks/${task.id}/timer`))}>▶ Start timer</button>
            {/* A focus session: the timer stops by itself after 25 minutes (you're told), counting just that. */}
            <Menu trigger={(p) => <button type="button" className="btn small" title="Time a set while on this task; it stops by itself and tells you" {...p}>◎ Focus</button>}
              items={[15, 25, 50, 90].map((m) => ({ label: `${m} minutes`, onClick: () => act(() => post(`/tasks/tasks/${task.id}/timer`, { minutes: m }), `Focus for ${m} minutes: the timer stops by itself`) }))} />
          </>}
        {!adding && <button type="button" className="link-btn small" onClick={() => setAdding({ duration: '', day: localToday(), note: '' })}>Add time</button>}
      </div>
      {adding && (
        <form className="row wrap task-time-add" style={{ gap: 6 }} onSubmit={(e) => { e.preventDefault(); act(() => post(`/tasks/tasks/${task.id}/time`, adding)).then((ok) => ok && setAdding(null)); }}>
          <input aria-label="How long" placeholder="1h 30m" value={adding.duration} size={8} autoFocus onChange={(e) => setAdding({ ...adding, duration: e.target.value })} />
          <input aria-label="Day" type="date" value={adding.day} max={localToday()} onChange={(e) => setAdding({ ...adding, day: e.target.value })} />
          <input aria-label="What for (optional)" placeholder="What for (optional)" value={adding.note} maxLength={300} onChange={(e) => setAdding({ ...adding, note: e.target.value })} />
          <button className="btn small primary">Add</button><button type="button" className="btn small" onClick={() => setAdding(null)}>Cancel</button>
        </form>
      )}
      {t.people.length > 1 && <div className="muted small">{t.people.map((p) => `${p.name} ${formatMinutes(p.minutes)}`).join(' · ')}</div>}
      {t.entries.length > 0 && (
        <ul className="plain-list task-time-list" aria-label="Time entries">
          {t.entries.slice(0, 20).map((e) => (
            editing === e.id ? <li key={e.id}><EntryEdit entry={e} onCancel={() => setEditing(null)} onSaved={(r) => { setT(r); setEditing(null); }} /></li> : (
            <li key={e.id} className="row small">
              <span className="grow">{e.running ? '● ' : ''}{e.user_name} · {dayOf(e.started_at)} · {e.running ? `running, ${formatMinutes(e.minutes)} so far` : formatMinutes(e.minutes)}{e.note ? ` · ${e.note}` : ''}</span>
              {e.user_id === user.id && !e.running && <button type="button" className="icon-btn" aria-label={`Change ${formatMinutes(e.minutes)} on ${dayOf(e.started_at)}`} title="Change" onClick={() => setEditing(e.id)}><Icon name="edit" size={14} /></button>}
              {e.user_id === user.id && !e.running && <button type="button" className="icon-btn" aria-label={`Remove ${formatMinutes(e.minutes)} on ${dayOf(e.started_at)}`} onClick={() => act(() => del(`/tasks/time/${e.id}`))}><Icon name="close" size={14} /></button>}
            </li>)
          ))}
        </ul>
      )}
    </section>
  );
}

/** Your week: time on each task, each day; a day's cell adds time to it; ‹ › other weeks; CSV for Excel or Sheets. */
function Timesheet({ onClose, onOpen }) {
  const toast = useToast();
  const monday = () => { const x = new Date(); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x.getTime(); };
  const [week, setWeek] = useState(monday);
  const [data, setData] = useState(null);
  const [adding, setAdding] = useState(null); // { task, day, duration }
  const [editing, setEditing] = useState(null); // an entry's id, in the open cell
  const end = (() => { const d = new Date(week); d.setDate(d.getDate() + 7); return d.getTime(); })();
  const load = useCallback(() => get(`/tasks/time/mine?from=${week}&to=${end}&all=1`).then(setData).catch((e) => toast(e.message, 'error')), [week, end, toast]);
  useEffect(() => { setData(null); setAdding(null); load(); }, [load]);
  useEffect(() => onLive((m) => { if (m.type === 'tasks-changed') load(); }), [load]);
  const step = (n) => { const d = new Date(week); d.setDate(d.getDate() + 7 * n); setWeek(d.getTime()); };
  const sheet = data && timesheet(data.spans, data.tasks, week);
  const today = localToday();
  const dayName = (d) => new Date(d.start).toLocaleDateString([], { weekday: 'short', day: 'numeric' });
  const range = `${new Date(week).toLocaleDateString([], { day: 'numeric', month: 'short' })} – ${new Date(end - 864e5).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}`;
  const download = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([timesheetCsv(sheet)], { type: 'text/csv' }));
    a.download = `timesheet-${sheet.days[0].date}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const add = async (e) => {
    e.preventDefault();
    try {
      await post(`/tasks/tasks/${adding.task.id}/time`, { duration: adding.duration, day: adding.day.date });
      toast(`Added to “${adding.task.title}”`); setAdding({ ...adding, duration: '' }); load();
    } catch (err) { toast(err.message, 'error'); }
  };
  return (
    <Modal wide title="My timesheet" onClose={onClose} footer={<>
      {sheet?.rows.length > 0 && <button type="button" className="btn" onClick={download}><Icon name="download" size={18} /> Download CSV</button>}
      <span className="grow" /><button type="button" className="btn primary" onClick={onClose}>Close</button></>}>
      <div className="stack">
        <div className="row"><button type="button" className="icon-btn" aria-label="Previous week" onClick={() => step(-1)}>‹</button><strong className="grow" style={{ textAlign: 'center' }}>{range}</strong><button type="button" className="icon-btn" aria-label="Next week" onClick={() => step(1)}>›</button></div>
        {!sheet ? <p className="muted">Loading…</p> : !sheet.rows.length ? <p className="muted">No time on tasks this week. Start a timer or add time in a task’s details.</p> : (
          <div className="table-scroll">
            <table className="data-table timesheet" aria-label="Timesheet">
              <thead><tr><th scope="col">Task</th>{sheet.days.map((d) => <th key={d.date} scope="col" className={`num ${d.date === today ? 'today' : ''}`}>{dayName(d)}</th>)}<th scope="col" className="num">Total</th></tr></thead>
              <tbody>{sheet.rows.map((r) => (
                <tr key={r.id}>
                  <th scope="row"><button type="button" className="link-btn" onClick={() => onOpen(r)}>{r.title}</button></th>
                  {sheet.days.map((d, i) => (
                    <td key={d.date} className="num">
                      <button type="button" className="ts-cell" disabled={d.date > today} aria-label={`${r.title}, ${dayName(d)}: ${r.cells[i] ? formatMinutes(r.cells[i]) : 'nothing'}. Add time`}
                        onClick={() => setAdding({ task: r, day: d, duration: '' })}>{hm(r.cells[i]) || '·'}</button>
                    </td>
                  ))}
                  <td className="num"><strong>{hm(r.total)}</strong></td>
                </tr>
              ))}</tbody>
              <tfoot><tr><th scope="row">Total</th>{sheet.dayTotals.map((m, i) => <td key={i} className="num">{hm(m)}</td>)}<td className="num" aria-label={`Week total: ${formatMinutes(sheet.total)}`}><strong>{hm(sheet.total)}</strong></td></tr></tfoot>
            </table>
          </div>
        )}
        {adding && (
          <section className="stack-tight ts-cell-panel" aria-label={`Time on ${adding.task.title}, ${dayName(adding.day)}`}>
          {(() => {
            const here = cellEntries(data?.spans, adding.task.id, adding.day);
            const clock = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
            return here.length > 0 && (
              <ul className="plain-list" aria-label="Entries that day">
                {here.map((e) => editing === e.id ? <li key={e.id}><EntryEdit entry={e} minutes={e.logged ? e.minutes : Math.round((e.end - e.start) / 60e3)} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} /></li> : (
                  <li key={e.id} className="row small" style={{ gap: 6 }}>
                    <span className="grow">{e.logged ? 'Added by hand' : e.running ? `${clock(e.start)} – now (running)` : `${clock(e.start)} – ${clock(e.end)}`} · {formatMinutes(e.minutes_here)}{e.note ? ` · ${e.note}` : ''}</span>
                    {!e.running && <button type="button" className="icon-btn" aria-label={`Change ${formatMinutes(e.minutes_here)}${e.note ? ` (${e.note})` : ''}`} title="Change" onClick={() => setEditing(e.id)}><Icon name="edit" size={14} /></button>}
                    {!e.running && <button type="button" className="icon-btn" aria-label={`Remove ${formatMinutes(e.minutes_here)}${e.note ? ` (${e.note})` : ''}`} onClick={async () => {
                      try { await del(`/tasks/time/${e.id}`); toast('Time removed'); load(); } catch (err) { toast(err.message, 'error'); }
                    }}><Icon name="close" size={14} /></button>}
                  </li>
                ))}
              </ul>
            );
          })()}
          <form className="row wrap" style={{ gap: 6 }} onSubmit={add} aria-label="Add time">
            <span className="small">Add to <strong>{adding.task.title}</strong> on {dayName(adding.day)}:</span>
            <input aria-label="How long" placeholder="1h 30m" size={8} autoFocus value={adding.duration} onChange={(e) => setAdding({ ...adding, duration: e.target.value })} />
            <button className="btn small primary">Add</button><button type="button" className="btn small" onClick={() => setAdding(null)}>Close</button>
          </form>
          </section>
        )}
        <p className="muted small" style={{ margin: 0 }}>Only you see this: the time you tracked or added, on tasks in all your lists.</p>
      </div>
    </Modal>
  );
}

/** Who spent how long on what in a list, between two dates; downloadable as CSV. */
/** " · 3 open, 1 overdue" after a name in the Assigned to menu ('' when there's nothing to say). */
const loadText = (w) => (w?.open ? ` · ${w.open} open${w.overdue ? `, ${w.overdue} overdue` : ''}` : '');

/** Workload: who on a shared list has how much open, and when it's due (server: taskworkload.js). */
/** With a list: that list's Workload (names filter it, Remind). Without: Team workload across your shared lists. */
function Workload({ list = null, onClose, onPick }) {
  const { user } = useAuth();
  const toast = useToast();
  const [sent, setSent] = useState(() => new Set());
  const remind = async (p) => {
    try { const r = await post(`/tasks/lists/${list.id}/workload/remind`, { user_id: p.user_id, today: localToday() }); setSent((x) => new Set([...x, p.user_id])); toast(`Reminded ${p.name} of ${r.reminded === 1 ? '1 overdue task' : `${r.reminded} overdue tasks`}`); }
    catch (e) { toast(e.message, 'error'); }
  };
  const [w, setW] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { get(list ? `/tasks/lists/${list.id}/workload?today=${localToday()}` : `/tasks/workload?today=${localToday()}`).then(setW).catch((e) => setError(e.message)); }, [list?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const navigate = useNavigate();
  // Open in Sheets: the table in a new spreadsheet of yours (as the .csv has it).
  const toSheet = async () => {
    try { const r = await post(list ? `/tasks/lists/${list.id}/workload/sheet` : '/tasks/workload/sheet', { today: localToday() }); toast(`Made “${r.name}” in your Drive`, 'info', { action: { label: 'Open', onClick: () => navigate(`/sheets/${r.id}`) } }); }
    catch (e) { toast(e.message, 'error'); }
  };
  const most = w ? Math.max(1, ...w.people.map((p) => p.open)) : 1;
  const hours = (m) => (m ? (m >= 60 ? `${Math.round(m / 6) / 10} h` : `${m} min`) : '');
  const cols = [['overdue', 'Overdue'], ['this_week', 'This week'], ['next_week', 'Next week'], ['later', 'Later'], ['no_date', 'No date']];
  return (
    <Modal wide title={list ? `Workload on “${list.name}”` : 'Team workload'} onClose={onClose} footer={<>{w?.people.length > 0 && <a className="btn" href={`/api/tasks/${list ? `lists/${list.id}/` : ''}workload.csv?today=${localToday()}`} download>Download (.csv)</a>}{w?.people.some((p) => p.open > 0) && <button type="button" className="btn" onClick={toSheet}>Open in Sheets</button>}<button type="button" className="btn" onClick={onClose}>Close</button></>}>
      {error && <p className="error">{error}</p>}
      {!w && !error && <p className="muted">Loading…</p>}
      {w && !list && !w.people.length && <p className="muted">Nobody to show yet: share a list with colleagues and give them tasks.</p>}
      {w && (list || w.people.length > 0) && (
        <table className="data-table workload" aria-label="Workload">
          <thead><tr><th scope="col">Person</th>{!list && <th scope="col">Lists</th>}<th scope="col">Open</th>{cols.map(([k, label]) => <th key={k} scope="col">{label}</th>)}<th scope="col">Estimated</th>{list && <th scope="col"><span className="sr-only">Remind</span></th>}</tr></thead>
          <tbody>
            {w.people.map((p) => (
              <tr key={p.user_id || 'none'}>
                <th scope="row">{list ? <button type="button" className="link-btn" title={`Show only ${p.user_id ? `${p.name}’s tasks` : 'tasks nobody has'}`} onClick={() => onPick(p.user_id || 'none')}>{p.name}</button> : p.name}</th>
                {!list && <td>{p.lists || ''}</td>}
                <td><span className="workload-open">{p.open > 0 && <span className="workload-bar" style={{ width: `${Math.round((p.open / most) * 60)}px` }} aria-hidden="true" />}{p.open}</span></td>
                {cols.map(([k]) => <td key={k} className={k === 'overdue' && p[k] ? 'workload-late' : ''}>{p[k] || ''}</td>)}
                <td>{hours(p.estimate)}</td>
                {list && <td>{p.user_id && p.user_id !== user.id && p.overdue > 0 && (sent.has(p.user_id)
                  ? <span className="muted small">Reminded</span>
                  : <button type="button" className="btn small" aria-label={`Remind ${p.name} of overdue tasks`} title="A note in their bell naming their overdue tasks here (once a day)" onClick={() => remind(p)}>Remind</button>)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted small">{list ? 'Open tasks on this list' : `Open tasks on the ${w?.lists ?? ''} shared lists you’re on (Lists: how many of them each person has open tasks on)`}, by who they're given to and when they're due (weeks run Monday to Sunday). Estimated adds up the tasks' time estimates.</p>
    </Modal>
  );
}

function TimeReport({ list, onClose, onRate }) {
  const navigate = useNavigate();
  const today = localToday(); // (where you are: in Kuala Lumpur at 7am it's already today, still yesterday in UTC)
  const [range, setRange] = useState({ from: `${today.slice(0, 8)}01`, to: today });
  const [rep, setRep] = useState(null);
  const [error, setError] = useState('');
  const [billing, setBilling] = useState(null); // { rate, currency } while changing the rate
  const toast = useToast();
  const load = useCallback(() => get(`/tasks/lists/${list.id}/time-report?from=${range.from}&to=${range.to}`).then(setRep).catch((e) => { setRep(null); setError(e.message); }), [list.id, range.from, range.to]);
  useEffect(() => { setError(''); load(); }, [load]);
  const money = (x) => { try { return new Intl.NumberFormat([], { style: 'currency', currency: rep.currency }).format(x); } catch { return `${x.toFixed(2)} ${rep.currency}`; } };
  const saveRate = async (body) => {
    try { await put(`/tasks/lists/${list.id}/rate`, body); setBilling(null); toast(body.rate == null ? 'Rate removed' : 'Rate saved'); load(); onRate?.(); } catch (e) { toast(e.message, 'error'); }
  };
  return (
    <Modal wide title={`Time on “${list.name}”`} onClose={onClose} footer={<>
      <a className="btn" href={`/api/tasks/lists/${list.id}/time-report?from=${range.from}&to=${range.to}&format=csv`}><Icon name="download" size={18} /> Download CSV</a>
      {rep?.lines.length > 0 && <button type="button" className="btn" title="A copy of this report in a new spreadsheet in your Drive, with formulas for the totals" onClick={async () => {
        try { const r = await post(`/tasks/lists/${list.id}/time-report/sheet`, range); toast('Report saved as a spreadsheet in your Drive'); navigate(`/sheets/${r.id}`); } catch (e) { toast(e.message, 'error'); }
      }}>Open in Sheets</button>}
      <span className="grow" /><button type="button" className="btn primary" onClick={onClose}>Close</button></>}>
      <div className="stack">
        <div className="row wrap" style={{ gap: 12 }}>
          <label className="field"><span>From</span><input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></label>
          <label className="field"><span>To</span><input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></label>
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        {rep && (billing ? (
          <form className="row wrap" style={{ gap: 6 }} aria-label="Hourly rate" onSubmit={(e) => { e.preventDefault(); saveRate(billing); }}>
            <label className="field"><span>Hourly rate</span><input type="number" min="0.01" step="0.01" required autoFocus value={billing.rate} onChange={(e) => setBilling({ ...billing, rate: e.target.value })} /></label>
            <label className="field"><span>Currency</span><select value={billing.currency} onChange={(e) => setBilling({ ...billing, currency: e.target.value })}>
              {[...new Set([billing.currency, 'EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD', 'JPY', 'INR', 'SEK', 'NOK', 'DKK', 'PLN'])].map((c) => <option key={c}>{c}</option>)}
            </select></label>
            <button className="btn small primary">Save rate</button>
            {rep.rate != null && <button type="button" className="btn small" onClick={() => saveRate({ rate: null })}>Remove rate</button>}
            <button type="button" className="btn small" onClick={() => setBilling(null)}>Cancel</button>
          </form>
        ) : (
          <div className="row small" style={{ gap: 8 }}>
            <span className="muted">{rep.rate != null ? `Billed at ${money(rep.rate)} an hour` : 'No hourly rate'}</span>
            {rep.can_bill && <button type="button" className="link-btn small" onClick={() => setBilling({ rate: rep.rate ?? '', currency: rep.currency || 'EUR' })}>{rep.rate != null ? 'Change rate' : 'Set an hourly rate'}</button>}
          </div>
        ))}
        {rep && (rep.lines.length ? (
          <table className="data-table" aria-label="Time report">
            <thead><tr><th scope="col">Person</th><th scope="col">Task</th><th scope="col" className="num">Time</th>{rep.rate != null && <th scope="col" className="num">Amount</th>}</tr></thead>
            <tbody>{rep.lines.map((l, i) => <tr key={i}><td>{l.person}</td><td>{l.task}</td><td className="num">{formatMinutes(l.minutes)}</td>{rep.rate != null && <td className="num">{l.billable === false ? <span className="muted">not billable</span> : money(l.amount)}</td>}</tr>)}</tbody>
            <tfoot><tr><th scope="row" colSpan={2}>Total</th><td className="num"><strong>{formatMinutes(rep.total)}</strong></td>{rep.rate != null && <td className="num" aria-label={`Total amount: ${money(rep.amount)}`}><strong>{money(rep.amount)}</strong></td>}</tr></tfoot>
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

function TaskDetails({ task, tasks, lists, sections = [], people, onChange, onClose, onDelete, onMove, onNewList, onReplaced, inMyDay, onMyDay }) {
  const [toNew, setToNew] = useState(null); // 'move' | 'copy': this task to a list made with a name
  // How much each person on the list already has (Workload), beside their name when giving the task to someone.
  const [load, setLoad] = useState(null);
  const shared = people.length > 1;
  useEffect(() => { if (shared) get(`/tasks/lists/${task.list_id}/workload?today=${localToday()}`).then((w) => setLoad(w.people)).catch(() => {}); }, [shared, task.list_id, task.assignee_id]);
  const [chattingOne, setChattingOne] = useState(false); // Send in Chat, from here
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
  const mailOn = useMailStatus();
  const goTo = useNavigate();
  // Send by email: a new email in Mail with the task (what it says now, edits not yet saved included), to address and send.
  const emailTask = () => {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(taskEmail({ ...task, title: title.trim() || task.title, notes }, { link: taskLink(task), listName: lists.find((l) => l.id === task.list_id)?.name || '' }))); }
    catch { toast('Your browser’s storage is off', 'error'); return; }
    goTo('/mail?compose_doc=1');
  };
  // Save to Notes: a note of your own with what the task says now and a link back to it.
  const saveToNotes = async () => {
    try {
      const made = await post('/notes', taskNote({ ...task, title: title.trim() || task.title, notes }, { link: taskLink(task), listName: lists.find((l) => l.id === task.list_id)?.name || '' }));
      toast(`Saved to Notes: ${made.title}`, 'info', { action: { label: 'Open', onClick: () => goTo(`/notes?note=${made.id}`) } });
    } catch (e) { toast(e.message, 'error'); }
  };
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
        <button type="button" className="icon-btn" aria-label="Send in Chat" title="Send in Chat: a link to it in a conversation (it shows as a task card)" onClick={() => setChattingOne(true)}><Icon name="chat" /></button>
        <button type="button" className="icon-btn" aria-label="Save to Notes" title="Save to Notes: a note of your own with the task, its notes and steps, and a link back" onClick={saveToNotes}><Icon name="note" /></button>
        {mailOn?.enabled && <button type="button" className="icon-btn" aria-label="Send by email" title="Send by email: a new email with the task, its notes and steps" onClick={emailTask}><Icon name="mail" /></button>}
        {chattingOne && createPortal(<SendInChat items={[{ name: task.title, url: taskLink(task) }]} what="the task" onClose={() => setChattingOne(false)} />, document.body)}
        <button type="button" className="icon-btn" aria-label="Close details" onClick={onClose}><Icon name="close" /></button></div>
      <label className="field"><span>Task</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} onBlur={saveTitle} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} maxLength={500} />
      </label>
      <label className="field"><span>Notes</span>
        <textarea rows={5} value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={() => { if (notes.trim() !== (task.notes || '')) onChange({ notes: notes.trim() || null }); }} />
      </label>
      {task.link_url && (
        <div className="field"><span>From</span>
          <span className="row"><Link to={task.link_url} className="grow ellipsis">{linkIcon(task.link_url)} {task.link_label || 'Open'}</Link>
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
        <span className="row"><input type="date" aria-label="Due date" value={task.due || ''} onChange={(e) => onChange({ due: e.target.value || null })} />
          {task.due && <input type="time" aria-label="Due time" title="Due time (optional)" value={task.due_time || ''} onChange={(e) => onChange({ due_time: e.target.value || null })} />}
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
      <label className="field"><span>Priority</span>
        <select value={task.priority || ''} onChange={(e) => onChange({ priority: e.target.value || null })}>
          <option value="">None</option>
          {PRIORITIES.map(([k, name, mark]) => <option key={k} value={k}>{mark} {name}</option>)}
        </select>
      </label>
      <label className="field"><span>Estimate</span>
        <select value={task.estimate || ''} onChange={(e) => onChange({ estimate: e.target.value ? Number(e.target.value) : null })}>
          <option value="">None</option>
          {[...new Set([15, 30, 45, 60, 90, 120, 180, 240, 360, 480, ...(task.estimate ? [task.estimate] : [])])].sort((a, b) => a - b).map((m) => <option key={m} value={m}>{formatMinutes(m)}</option>)}
        </select>
      </label>
      {lists?.find((l) => l.id === task.list_id)?.rate != null && (
        <label className="row small" style={{ gap: 6 }} title="Time on a task that isn't billable stays in the time report, at nothing">
          <input type="checkbox" checked={!task.nonbillable} onChange={(e) => onChange({ billable: e.target.checked, nonbillable: e.target.checked ? 0 : 1 })} /> Billable (the list’s hourly rate applies)
        </label>
      )}
      {people.length > 1 && (
        <label className="field"><span>Assigned to</span>
          <select value={task.assignee_id || ''} onChange={(e) => onChange({ assignee_id: e.target.value || null })}>
            <option value="">Nobody</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}{loadText(load?.find((x) => x.user_id === p.id))}</option>)}
          </select>
        </label>
      )}
      {task.assignee_id && <Availability userId={task.assignee_id} name={task.assignee_name} />}
      {sections.length > 0 && (
        <label className="field"><span>Section</span>
          <select value={task.section_id || ''} onChange={(e) => onChange({ section_id: e.target.value || null })}>
            <option value="">No section</option>
            {sections.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </label>
      )}
      <label className="field"><span>List</span>
        <select value={task.list_id} onChange={(e) => (e.target.value === '__new__' ? setToNew('move') : onMove(e.target.value))}>
          {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          <option value="__new__">+ New list…</option>
        </select>
      </label>
      {toNew && <PromptModal title={toNew === 'move' ? 'Move this task to a new list' : 'Copy this task to a new list'} label="List name" confirm={toNew === 'move' ? 'Make it and move' : 'Make it and copy'} onClose={() => setToNew(null)}
        onSubmit={async (name) => {
          const r = await onNewList(name);
          if (toNew === 'move') onMove(r.id, r.name);
          else { await post(`/tasks/tasks/${task.id}/duplicate`, { list_id: r.id }); toast(`Copied to ${r.name}`); }
        }} />}
      <p className="muted small">Added by {task.created_by_name || 'someone'} · {new Date(task.created_at).toLocaleDateString([], { dateStyle: 'medium' })}{task.done && ` · done ${new Date(task.done_at).toLocaleDateString([], { dateStyle: 'medium' })}`}</p>
      <TaskComments task={task} people={people} canShare={!!lists.find((l) => l.id === task.list_id)?.mine} />
      <TaskHistory task={task} />
      <div className="row wrap" style={{ gap: 8 }}>
        {task.repeat && task.due && !task.done && (
          <button type="button" className="btn" title="Move it to its next date without ticking it off" onClick={async () => {
            try { const t = await post(`/tasks/tasks/${task.id}/skip`, { today: localToday() }); onReplaced(t); toast(`Skipped: next due ${dueLabel(t.due, new Date(), t.due_time).text}`); } catch (e) { toast(e.message, 'error'); }
          }}>⏭ Skip this time</button>
        )}
        <button type="button" className="btn" onClick={async () => {
          try { await post(`/tasks/tasks/${task.id}/duplicate`); toast('Duplicated: the copy is just below'); } catch (e) { toast(e.message, 'error'); }
        }}><Icon name="copy" size={16} /> Duplicate</button>
        <button type="button" className="btn" title="This task, with its notes, steps and comments" onClick={async () => {
          const comments = task.comments > 0 ? await get(`/tasks/tasks/${task.id}/comments`).catch(() => []) : [];
          printHtml(taskPrintHtml(task, comments));
        }}><Icon name="print" size={16} /> Print</button>
        <select aria-label="Copy this task to" value="" onChange={async (e) => {
          const to = e.target.value;
          if (to === '__new__') { setToNew('copy'); return; }
          if (!to) return;
          try { await post(`/tasks/tasks/${task.id}/duplicate`, { list_id: to }); toast(`Copied to ${lists.find((l) => l.id === to)?.name}`); } catch (err) { toast(err.message, 'error'); }
        }}>
          <option value="">Copy to…</option>
          {lists.filter((l) => l.id !== task.list_id).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          <option value="__new__">+ New list…</option>
        </select>
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
  useEffect(() => { get('/users/directory').then((l) => setPeople(l.filter((p) => p.id !== me.id))).catch(() => {}); }, [me.id]);
  const [message, setMessage] = useState(''); // for the people added now
  const adding = [...chosen].filter((id) => !list.members.some((m) => m.id === id));
  async function save() {
    try { await put(`/tasks/lists/${list.id}/members`, { user_ids: [...chosen], ...(message.trim() && { message: message.trim() }) }); toast(chosen.size ? `Shared with ${chosen.size}` : 'Not shared any more'); onSaved(); }
    catch (e) { toast(e.message, 'error'); }
  }
  return (
    <Modal title={`Share “${list.name}”`} onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" onClick={save}>Save</button></>}>
      <p className="muted small" style={{ marginTop: 0 }}>People you share with can add, change, tick off and be given tasks on this list.</p>
      {/* Find people (in a bigger company), how many are ticked, and + a company group to tick everyone in it. */}
      <PeopleTicks people={people} chosen={chosen} label="Colleagues" withAddress onToggle={(id, on) => { const n = new Set(chosen); on ? n.add(id) : n.delete(id); setChosen(n); }} onAddMany={(ids) => setChosen(new Set([...chosen, ...ids]))} />
      {adding.length > 0 && (
        <label className="field"><span>Message to {adding.length === 1 ? people.find((p) => p.id === adding[0])?.name || 'them' : 'the people you added'} (optional)</span>
          <textarea rows={2} maxLength={500} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="What you’d like them to pick up…" /></label>
      )}
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

/** Who changed what on a task, newest first: read when opened, and again as the task changes. */
function TaskHistory({ task }) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    get(`/tasks/tasks/${task.id}/history`).then((d) => live && setData(d)).catch(() => {});
    return () => { live = false; };
  }, [open, task.id, task.updated_at]);
  const when = (at) => new Date(at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <details className="task-history" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>History</summary>
      {open && !data && <p className="muted small">Loading…</p>}
      {data && (
        <ol className="task-history-list" aria-label="History">
          {data.entries.map((e, i) => (
            <li key={i}><strong>{e.user.id === user.id ? 'You' : e.user.name}</strong> {historyText(e, { me: user.id })}<span className="muted small"> · {when(e.at)}</span></li>
          ))}
          <li><strong>{data.created_by && data.created_by === user.id ? 'You' : data.created_by_name || 'Someone'}</strong> added it<span className="muted small"> · {when(data.created_at)}</span></li>
        </ol>
      )}
    </details>
  );
}

/** A task's comments: everyone on the list sees them; you can change or remove your own. */
function TaskComments({ task, people = [], canShare = false }) {
  const toast = useToast();
  const { user } = useAuth();
  const [list, setList] = useState([]);
  const [text, setText] = useState('');
  const [editing, setEditing] = useState(null); // { id, body }: your comment being changed
  const [added, setAdded] = useState([]); // addresses just shared with (until the list's people catch up)
  const box = useRef(null);
  const mention = useMentions(box, text, setText); // "@" plus a few letters suggests people to mention
  // (read now: the list stops calling them new)
  const load = useCallback(() => get(`/tasks/tasks/${task.id}/comments`).then((l) => { setList(l); window.dispatchEvent(new CustomEvent('task-comments-seen', { detail: task.id })); }).catch(() => {}), [task.id]);
  const saveEdit = async (e) => {
    e.preventDefault();
    if (!editing.body.trim()) return;
    try { await patch(`/tasks/tasks/${task.id}/comments/${editing.id}`, { body: editing.body }); setEditing(null); load(); } catch (err) { toast(err.message, 'error'); }
  };
  useEffect(() => { load(); }, [load, task.comments]); // the count changes live when someone comments
  useEffect(() => onLive((m) => { if (m.type === 'tasks-changed' && m.list_id === task.list_id) load(); }), [load, task.list_id]); // and an edited one
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
              <div className="row"><strong className="small">{c.author_name || 'Someone'}</strong><span className="muted small grow">{new Date(c.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}{c.edited_at && ' (edited)'}</span>
                {c.author_id === user.id && editing?.id !== c.id && <button type="button" className="icon-btn" aria-label="Edit comment" title="Edit" onClick={() => setEditing({ id: c.id, body: c.body })}><Icon name="edit" size={14} /></button>}
                {c.author_id === user.id && <button type="button" className="icon-btn" aria-label="Delete comment" onClick={async () => { await del(`/tasks/tasks/${task.id}/comments/${c.id}`).catch((err) => toast(err.message, 'error')); load(); }}><Icon name="close" size={14} /></button>}</div>
              {editing?.id === c.id
                ? (
                  <form className="row" onSubmit={saveEdit} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setEditing(null); } }}>
                    <input className="grow" aria-label="Change your comment" maxLength={4000} autoFocus value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} />
                    <button className="btn small" disabled={!editing.body.trim()}>Save</button>
                    <button type="button" className="btn small" onClick={() => setEditing(null)}>Cancel</button>
                  </form>
                  )
                : <p className="task-comment-body"><LinkedText text={c.body} /></p>}
              <ReactionBar list={c.reactions || []} onReact={async (emoji) => { try { setList(await post(`/tasks/tasks/${task.id}/comments/${c.id}/reactions`, { emoji })); } catch (err) { toast(err.message, 'error'); } }} />
            </li>
          ))}
        </ul>
      )}
      {/* someone mentioned who isn't on the list won't be told (or see the task) */}
      {(() => {
        const on = new Set([...people.map((p) => String(p.username || '').toLowerCase()), ...added].filter(Boolean));
        const off = [...new Set([...text.matchAll(/@([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/gi)].map((m) => m[1].toLowerCase()))].filter((e) => !on.has(e));
        const share = async () => { try { await put(`/tasks/lists/${task.list_id}/members`, { add: off }); setAdded([...added, ...off]); toast(`List shared with ${off.join(', ')}`); } catch (err) { toast(err.message, 'error'); } };
        return off.length > 0 && (
          <p className="small muted row wrap" role="status" style={{ gap: 8 }}>{off.map((e) => `@${e}`).join(', ')} {off.length === 1 ? "isn't" : "aren't"} on this list, so won't be told. {canShare ? '' : 'Share the list first.'}
            {canShare && <button type="button" className="btn small" onClick={share}>Share the list with {off.length === 1 ? 'them' : `all ${off.length}`}</button>}</p>
        );
      })()}
      <form className="row" onSubmit={send}>
        <div className="mention-box grow">
          <input ref={box} style={{ width: '100%' }} value={text} onChange={(e) => { setText(e.target.value); mention.track(e.target.value, e.target.selectionStart); }} onKeyDown={(e) => mention.keyDown(e)} onBlur={() => mention.close()}
            placeholder="Add a comment (@ to mention someone)" aria-label="Add a comment" maxLength={4000} />
          {mention.list}
        </div>
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

/** A list's deleted tasks (kept 30 days), newest first: Restore puts one back as it was, with its comments. */
/** What happened on a list lately, newest first: changes to its tasks, tasks added and deleted. */
function ListActivity({ list, onClose, onOpen }) {
  const toast = useToast();
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { get(`/tasks/lists/${list.id}/activity`).then(setData).catch((e) => toast(e.message, 'error')); }, [list.id, toast]);
  const older = async () => {
    setBusy(true);
    try { const r = await get(`/tasks/lists/${list.id}/activity?before=${data.before}`); setData({ ...r, entries: [...data.entries, ...r.entries] }); } catch (e) { toast(e.message, 'error'); }
    setBusy(false);
  };
  const text = (e) => (e.field === 'added' ? 'added it' : e.field === 'deleted' ? 'deleted it' : historyText(e, { me: user.id }));
  let day = '';
  return (
    <Modal title={`Activity · ${list.name}`} onClose={onClose} footer={<button type="button" className="btn" onClick={onClose}>Close</button>}>
      {!data ? <p className="muted">Loading…</p> : !data.entries.length ? <p className="muted">Nothing has happened on this list yet.</p> : (
        <ol className="list-activity" aria-label="Activity">
          {data.entries.map((e, i) => {
            const d = new Date(e.at).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
            const head = d !== day ? (day = d) : null;
            return (
              <li key={i}>
                {head && <h3 className="list-activity-day">{head}</h3>}
                <div><strong>{e.user.id === user.id ? 'You' : e.user.name}</strong> {text(e)}<span className="muted small"> · {new Date(e.at).toLocaleTimeString([], { timeStyle: 'short' })}</span></div>
                <div className="small">{e.task.gone ? <span className="muted">{e.task.title} (deleted)</span>
                  : <button type="button" className="link-btn" onClick={() => onOpen(e.task.id)}>{e.task.title}</button>}</div>
              </li>
            );
          })}
        </ol>
      )}
      {data?.more && <button type="button" className="btn small" disabled={busy} onClick={older}>Show older</button>}
      <p className="muted small">Changes to the tasks on this list, and tasks added and deleted. A task moved to another list takes its history with it.</p>
    </Modal>
  );
}

function TaskTrash({ list, onClose, onRestored }) {
  const toast = useToast();
  const [items, setItems] = useState(null);
  const load = useCallback(() => get(`/tasks/lists/${list.id}/trash`).then(setItems).catch((e) => toast(e.message, 'error')), [list.id, toast]);
  useEffect(() => { load(); }, [load]);
  const restore = async (t) => { try { await post(`/tasks/trash/${t.id}/restore`); toast(`“${t.title}” is back`); onRestored(); load(); } catch (e) { toast(e.message, 'error'); } };
  const [picked, setPicked] = useState(() => new Set()); // ticked to put back together
  const restoreMany = async () => {
    try { const r = await post('/tasks/trash/restore-many', { ids: [...picked] }); toast(`${r.restored === 1 ? '1 task' : `${r.restored} tasks`} back`); setPicked(new Set()); onRestored(); load(); } catch (e) { toast(e.message, 'error'); }
  };
  const [forever, setForever] = useState(null); // 'picked' or 'all', asked first
  const deleteForever = async () => {
    const r = forever === 'all' ? await del(`/tasks/lists/${list.id}/trash`) : await post('/tasks/trash/delete-many', { ids: [...picked] });
    toast(`${r.deleted === 1 ? '1 task' : `${r.deleted} tasks`} deleted for good`); setPicked(new Set()); load();
  };
  return (
    <Modal title={`Deleted tasks · ${list.name}`} onClose={onClose} footer={<button type="button" className="btn" onClick={onClose}>Close</button>}>
      {!items ? null : !items.length ? <p className="muted">Nothing deleted in the last 30 days.</p> : (<>
        {items.length > 1 && (
          <div className="row" style={{ gap: 8, marginBottom: 8 }}>
            <label className="check small grow"><input type="checkbox" aria-label="Select all deleted tasks" checked={items.every((t) => picked.has(t.id))} onChange={(e) => setPicked(e.target.checked ? new Set(items.map((t) => t.id)) : new Set())} /> Select all</label>
            <button type="button" className="btn small primary" disabled={!picked.size} onClick={restoreMany}>{`Restore ${picked.size || ''}`.trim()}</button>
            <button type="button" className="btn small danger" disabled={!picked.size} onClick={() => setForever('picked')}>Delete forever</button>
          </div>
        )}
        <ul className="task-trash" aria-label="Deleted tasks">
          {items.map((t) => (
            <li key={t.id} className="row">
              {items.length > 1 && <input type="checkbox" aria-label={`Select deleted task: ${t.title}`} checked={picked.has(t.id)} onChange={(e) => { const n = new Set(picked); e.target.checked ? n.add(t.id) : n.delete(t.id); setPicked(n); }} />}
              <span className="grow"><span className="ellipsis">{t.title}</span>
                <span className="muted small"> · deleted {new Date(t.deleted_at).toLocaleDateString([], { day: 'numeric', month: 'short' })}{t.deleted_by_name ? ` by ${t.deleted_by_name}` : ''}</span></span>
              <button type="button" className="btn small" aria-label={`Restore ${t.title}`} onClick={() => restore(t)}>Restore</button>
            </li>
          ))}
        </ul>
      </>)}
      <div className="row"><p className="muted small grow">Deleted tasks stay here for 30 days, for everyone on the list.</p>
        {items?.length > 0 && <button type="button" className="btn small" onClick={() => setForever('all')}>Empty</button>}</div>
      {forever && <ConfirmModal title={forever === 'all' ? `Delete all ${items.length === 1 ? '1 task' : `${items.length} tasks`} here for good?` : `Delete ${picked.size === 1 ? '1 task' : `${picked.size} tasks`} for good?`}
        confirm="Delete forever" danger message="They can’t be put back, for anyone on the list." onClose={() => setForever(null)} onConfirm={deleteForever} />}
    </Modal>
  );
}

/** How a task repeats: the usual choices, or Custom… (every N days, weeks on chosen days, months or years). */
function RepeatField({ task, onChange }) {
  const custom = readCustom(task.repeat);
  const [editing, setEditing] = useState(null); // { n, unit, days } while the custom repeat is being chosen
  const set = (repeat) => onChange({ repeat: repeat || null, ...(!task.due && repeat && { due: localToday() }) });
  const value = editing || custom ? 'custom' : task.repeat || '';
  // Weeks of the month, from the due date: "Monthly on the third Monday" (and "the last" in its last week).
  const due = task.due ? new Date(`${task.due}T00:00:00`) : null;
  const weekOpts = [];
  if (due) {
    const nth = Math.ceil(due.getDate() / 7), last = due.getDate() + 7 > new Date(due.getFullYear(), due.getMonth() + 1, 0).getDate();
    weekOpts.push(monthWeekRepeat({ weeks: [nth], wd: due.getDay() }));
    if (last) weekOpts.push(monthWeekRepeat({ weeks: [-1], wd: due.getDay() }));
  }
  if (readMonthWeek(task.repeat) && !weekOpts.includes(task.repeat)) weekOpts.push(task.repeat);
  return (
    <div className="field"><label htmlFor="task-repeat"><span>Repeat</span></label>
      <select id="task-repeat" value={value} onChange={(e) => {
        if (e.target.value === 'custom') setEditing(custom || { n: 2, unit: 'week', days: [] });
        else { setEditing(null); set(e.target.value); }
      }}>
        {REPEATS.map(([v, n]) => <option key={v} value={v}>{n}</option>)}
        {weekOpts.map((v) => <option key={v} value={v}>{repeatText(v)}</option>)}
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

/** Whether the person a task is for is away (vacation reply on) or outside their working hours right now. */
function Availability({ userId, name }) {
  const { user } = useAuth();
  const [a, setA] = useState(null);
  useEffect(() => {
    setA(null);
    if (!userId || userId === user?.id) return undefined;
    let live = true;
    get(`/users/${userId}/availability`).then((r) => { if (live) setA(r); }).catch(() => {});
    return () => { live = false; };
  }, [userId, user?.id]);
  if (!a || (!a.away && !a.after)) return null;
  const day = (ymd) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString([], { day: 'numeric', month: 'short' });
  const first = (name || '').split(' ')[0] || 'They';
  return (
    <p className="task-availability small muted" role="status">
      {a.away && <span><span aria-hidden="true">🌴</span> {first} is away{a.away.until ? ` until ${day(a.away.until)}` : ''}. </span>}
      {a.after && <span><span aria-hidden="true">🌙</span> It's {a.after.local} for {first}, outside their working hours.</span>}
    </p>
  );
}

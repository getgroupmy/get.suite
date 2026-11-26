import { has } from '../../fold.js';
import PeopleTicks from '../../components/PeopleTicks.jsx';
import { unreachable, keepChange, changeAdd, appendKept, offlineId, keepDelete } from '../offlinedocs.js';
// Notes: quick notes and checklists on coloured cards. "Take a note…" at the top, pinned ones first,
// labels and the archive on the left, and sharing with colleagues (they see changes as they happen).
import { useCallback, useEffect, useRef, useState } from 'react';
import { noteKey } from './notekeys.js';
import { stepTask, afterLeaving } from '../tasks/taskkeys.js';
import { useAuth } from '../../App.jsx';
import { useLocation, useNavigate } from 'react-router';
import { get, post, patch, put, del, onLive } from '../../api.js';
import { moveTo, moveBy, sortNotes, NOTE_SORTS } from './order.js';
import { indent, moveItem, moveItemTo, tick as tickItem, untickAll, dropTicked, sortItems } from './checklist.js';
import { noteLink } from '../chat/filelinks.js';
import TasksAbout from '../../components/TasksAbout.jsx';
import { dueFromText } from '../tasks/addtask.js';
import { printHtml } from '../mail/mailprint.js';
import { notePrintHtml, notesPrintHtml, noteEmail, notesEmail, noteEventAt, withComments } from './noteprint.js';
import { DRAFT_KEY } from '../docs/blocks.js';
import { useMailStatus } from '../../mailStatus.js';
import SendInChat from '../../components/SendInChat.jsx';
import Icon from '../../components/Icon.jsx';
import { Avatar, Empty, Menu, Modal, PromptModal, ConfirmModal, NotSent, useToast } from '../../components/ui.jsx';
import { quickTimes, reminderText } from './remind.js';
import DrawPad from '../../components/DrawPad.jsx';
import VoiceRecorder from '../../components/VoiceRecorder.jsx';
import { useBatches } from '../../components/useBatches.jsx';
import { useMentions } from '../../components/mentions.jsx';
import { ReactionBar } from '../comments.jsx';
import LinkedText from '../../components/LinkedText.jsx';

export const COLORS = [['', 'Default'], ['#faafa8', 'Coral'], ['#f39f76', 'Peach'], ['#fff8b8', 'Sand'], ['#e2f6d3', 'Mint'], ['#b4ddd3', 'Sage'],
  ['#d4e4ed', 'Fog'], ['#aeccdc', 'Storm'], ['#d3bfdb', 'Dusk'], ['#f6e2dd', 'Blossom'], ['#e9e3d4', 'Clay'], ['#efeff1', 'Chalk']];
/** Kinds of note to filter by (Filter, beside Search notes). */
const NOTE_KINDS = [['list', '☑ Lists'], ['picture', '🖼 Pictures'], ['voice', '🎙 Voice'], ['link', '🔗 Links'], ['reminder', '🔔 Reminders'], ['daily', '📅 Daily notes'], ['comment', '💬 Comments']];
/** Put a picture on a note (PNG, JPEG, GIF or WebP, up to 10 MB). */
async function addPicture(noteId, file) {
  const res = await fetch(`/api/notes/${noteId}/pictures`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': file.type || 'application/octet-stream' }, body: file });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || 'The picture could not be added');
  return data;
}
/** Put a voice recording on a note (up to five, 10 MB each), with how long it ran. */
async function addRecording(noteId, file, ms) {
  const res = await fetch(`/api/notes/${noteId}/recordings?duration_ms=${Math.round(ms) || ''}`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': file.type || 'application/octet-stream' }, body: file });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || 'The recording could not be added');
  return data;
}
/** 0:04, 2:31 */
export const clock = (ms) => { const s = Math.max(0, Math.round((ms || 0) / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

function PictureButton({ noteId, onAdded, label = 'Insert picture' }) {
  const toast = useToast();
  const input = useRef();
  const [drawing, setDrawing] = useState(false);
  return (<>
    <button type="button" className="icon-btn" aria-label="Draw" title="Draw" onClick={() => setDrawing(true)}>✏️</button>
    {drawing && <DrawPad saveLabel="Add to note" onClose={() => setDrawing(false)} onSave={async (file) => { try { await addPicture(noteId, file); toast('Drawing added'); onAdded?.(); } catch (err) { toast(err.message, 'error'); throw err; } }} />}
    <button type="button" className="icon-btn" aria-label={label} title={label} onClick={() => input.current.click()}>🖼</button>
    <input ref={input} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden aria-label="Picture to add" onChange={async (e) => {
      const files = [...e.target.files]; e.target.value = '';
      for (const f of files) { try { await addPicture(noteId, f); } catch (err) { toast(err.message, 'error'); break; } }
      onAdded?.();
    }} />
  </>);
}
const newItem = (text = '') => ({ id: Math.random().toString(36).slice(2, 10), text, done: false });

const LABEL_COLORS = [['#d93025', 'Red'], ['#e8710a', 'Orange'], ['#f9ab00', 'Yellow'], ['#188038', 'Green'], ['#12b5cb', 'Teal'], ['#1a73e8', 'Blue'], ['#9334e6', 'Purple'], ['#e52592', 'Pink'], ['#5f6368', 'Grey']];

export default function Notes() {
  const toast = useToast();
  // Keyboard (see notekeys.js): the card's own buttons do the work, so the keys act as clicking them does.
  const { user } = useAuth();
  const keyState = useRef({});
  useEffect(() => {
    const cards = () => [...document.querySelectorAll('article.note-card:not(.trashed) .note-open')];
    const focusCard = (el) => { if (el) { el.focus(); el.scrollIntoView?.({ block: 'nearest' }); } };
    const onKey = (e) => {
      const st = keyState.current;
      if (!st.keysOn || document.querySelector('.modal-backdrop, [role=menu], [role=dialog]')) return;
      const action = noteKey(e);
      if (!action) return;
      if (action === 'new') { const take = document.querySelector('.note-take'); if (take) { e.preventDefault(); take.click(); } return; }
      const all = cards();
      const here = all.indexOf(document.activeElement?.closest?.('article.note-card')?.querySelector('.note-open'));
      const ids = all.map((_, i) => String(i));
      if (action === 'next' || action === 'prev') {
        const j = stepTask(ids, here < 0 ? null : String(here), action);
        if (j !== null) { e.preventDefault(); focusCard(all[Number(j)]); }
        return;
      }
      if (here < 0) return;
      const card = all[here].closest('article.note-card');
      const n = (st.notes || []).find((x) => x.id === card.dataset.note);
      if (!n) return;
      e.preventDefault();
      const id = n.id;
      if (action === 'pin') { st.change(n, { pinned: !n.pinned }); setTimeout(() => focusCard(document.querySelector(`article.note-card[data-note="${CSS.escape(id)}"] .note-open`)), 100); return; }
      const nextOne = all[Number(afterLeaving(ids, String(here)))] || null;
      const after = () => setTimeout(() => focusCard(nextOne?.isConnected ? nextOne : cards()[0]), 150);
      if (action === 'archive') { st.archive(n, !n.archived); after(); return; }
      if (action === 'delete') { if (n.mine) { st.trash(n); after(); } else st.setDeleting(n); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const [notes, setNotes] = useState(null);
  const [labels, setLabels] = useState([]);
  // A label one place up (by -1) or down (by 1) on the left: your own order from then on.
  const orderLabels = async (i, by) => {
    const next = [...labels];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    setLabels(next);
    try { await put('/notes/labels/order', { labels: next }); } catch { get('/notes/labels').then(setLabels).catch(() => {}); }
  };
  const [labelColors, setLabelColors] = useState({}); // your colour for each label
  const setLabelColor = async (label, color) => { try { await put('/notes/label-colors', { label, color }); setLabelColors((c) => { const n = { ...c }; if (color) n[label] = color; else delete n[label]; return n; }); } catch (e) { toast(e.message, 'error'); } };
  // /notes?reminders=1 (from Home's Note reminders) opens on Reminders.
  const [where, setWhere] = useState(() => ({ archived: false, label: null, reminders: new URLSearchParams(window.location.search).get('reminders') === '1' }));
  const [picking, setPicking] = useState(null); // a note whose reminder time is being picked
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState({ type: null, color: null }); // Filter: a kind of note and a card colour
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtering = !!(kind.type || kind.color);
  const [editing, setEditing] = useState(null); // note id
  const [sharing, setSharing] = useState(null);
  const [history, setHistory] = useState(null); // a note whose earlier versions are shown
  const [toTasks, setToTasks] = useState(null); // { note, lists }: choosing the task list its items go to
  const copyToTasks = async (n, listId) => {
    // The day an unticked item names ("Book hotel friday") becomes its task's due date, read as Tasks' quick add reads it.
    const dues = {};
    for (const it of n.items || []) { const d = !it.done && it.id ? dueFromText(it.text).due : null; if (d) dues[it.id] = d; }
    const r = await post(`/notes/${n.id}/tasks`, { ...(listId && { list_id: listId }), ...(Object.keys(dues).length && { dues }) });
    toast(`${r.added === 1 ? '1 task' : `${r.added} tasks`} added to ${r.list.name}`, 'info', { action: { label: 'Open', onClick: () => navigate(`/tasks/${r.list.id}`) } });
  };
  const [labelling, setLabelling] = useState(null);
  const [labelEdit, setLabelEdit] = useState(null); // { rename: label } or { remove: label }
  const [deleting, setDeleting] = useState(null);
  const importRef = useRef(null); // Import notes…: .md and .txt files, and Google Keep's .json
  const [view, setView] = useState('grid'); // grid of cards, or one column (list): your choice, on every device
  const [sort, setSort] = useState('mine'); // your own order, last edited, newest or title
  const chooseSort = async (next) => { setSort(next); try { await put('/notes/view', { sort: next }); } catch (e) { toast(e.message, 'error'); } };
  const switchView = async () => { const next = view === 'grid' ? 'list' : 'grid'; setView(next); try { await put('/notes/view', { view: next }); } catch (e) { toast(e.message, 'error'); } };
  // Only the latest request's answer is shown: an older one (for a label just deleted, say) can arrive last.
  const loadSeq = useRef(0);
  const load = useCallback(() => {
    const qs = new URLSearchParams({ ...(where.trash && { trash: '1' }), ...(where.archived && { archived: '1' }), ...(where.reminders && { reminders: '1' }), ...(where.shared && { shared: '1' }), ...(where.label && { label: where.label }), ...(search.trim() && { q: search.trim() }), ...(kind.type && { type: kind.type }), ...(kind.color && { color: kind.color }) });
    const seq = ++loadSeq.current;
    get(`/notes?${qs}`).then((list) => { if (seq === loadSeq.current) setNotes(list); }).catch((e) => toast(e.message, 'error'));
    get('/notes/labels').then(setLabels).catch(() => {});
    get('/notes/label-colors').then(setLabelColors).catch(() => {});
    get('/notes/view').then((r) => { setView(r.view); setSort(r.sort || 'mine'); }).catch(() => {});
  }, [where, search, kind, toast]);
  useEffect(() => { const t = setTimeout(load, search ? 250 : 0); return () => clearTimeout(t); }, [load, search]);
  useEffect(() => onLive((m) => { if (m.type === 'notes-changed' || m.type === 'live-connected') load(); }), [load]);
  // A task made from a note ticked off or added: its card's ✓ count follows (one reload for several changes close together).
  const taskTimer = useRef(null);
  useEffect(() => { const off = onLive((m) => { if (m.type === 'tasks-changed') { clearTimeout(taskTimer.current); taskTimer.current = setTimeout(load, 800); } }); return () => { off(); clearTimeout(taskTimer.current); }; }, [load]);
  useEffect(() => { window.addEventListener('nw:changes-sent', load); return () => window.removeEventListener('nw:changes-sent', load); }, [load]);
  // A result from the search box in the top bar: open that note.
  const location = useLocation();
  const navigate = useNavigate();
  const mail = useMailStatus();
  const [chatting, setChatting] = useState(null); // notes to send in Chat
  const [sharingMany, setSharingMany] = useState(false); // the picked notes, shared with more people
  useEffect(() => {
    const id = location.state?.openNote;
    if (!id) return;
    navigate(location.pathname, { replace: true, state: null });
    get('/notes').then((list) => { if (!list.some((n) => n.id === id)) setWhere({ archived: true, label: null, reminders: false }); setEditing(id); }).catch(() => {});
  }, [location.state]); // eslint-disable-line react-hooks/exhaustive-deps

  // A link to a note (/notes?note=<id>): open it (among the archived ones if it's there).
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const id = params.get('note');
    if (!id) return;
    navigate(location.pathname, { replace: true });
    get('/notes').then((list) => {
      if (list.some((n) => n.id === id)) { setEditing(id); return; }
      return get(`/notes/${encodeURIComponent(id)}/preview`).then(() => { setWhere({ archived: true, label: null, reminders: false }); setEditing(id); });
    }).catch(() => toast('That note isn’t one of yours or shared with you (or it was deleted)', 'error'));
  }, [location.search]); // eslint-disable-line react-hooks/exhaustive-deps

  const change = async (n, changes) => {
    setNotes((list) => list.map((x) => (x.id === n.id ? { ...x, ...changes } : x)));
    try { await patch(`/notes/${n.id}`, changes); } catch (e) {
      // No connection: kept here, made when it's back (the note shows the change meanwhile, also after reloading).
      if (unreachable(e)) { await keepChange({ method: 'PATCH', url: `/notes/${n.id}`, body: changes, user: user?.id, label: n.title || 'a note', id: n.id }); load(); return; }
      toast(e.message, 'error');
    }
    load();
  };
  const archive = async (n, on) => {
    await change(n, { archived: on });
    toast(on ? 'Note archived' : 'Note back from the archive', 'info', { action: { label: 'Undo', onClick: () => change(n, { archived: !on }) } });
  };
  // Deleting your note puts it in the trash (with Undo); there it can be restored or deleted for good.
  const trash = async (n) => {
    try { await del(`/notes/${n.id}`); } catch (e) {
      // No connection: to the trash when it's back (gone from here meanwhile, also after reloading).
      if (unreachable(e)) { await keepDelete({ url: `/notes/${n.id}`, user: user?.id, label: n.title || 'a note', id: n.id }); setNotes((all) => all && all.filter((x) => x.id !== n.id)); toast('Note deleted on this device, moved to the trash when the connection is back'); return; }
      toast(e.message, 'error'); return;
    }
    load();
    toast('Note moved to the trash', 'info', { action: { label: 'Undo', onClick: async () => { await post(`/notes/${n.id}/restore`); load(); } } });
  };
  keyState.current = { keysOn: user?.keys !== false, notes, change, archive, trash, setDeleting };

  const restore = async (n) => { try { await post(`/notes/${n.id}/restore`); toast('Note restored'); load(); } catch (e) { toast(e.message, 'error'); } };
  const [forever, setForever] = useState(null); // a note, 'all' or 'picked' to delete for good
  const [trashPicked, setTrashPicked] = useState(() => new Set()); // notes ticked in the trash
  useEffect(() => { setTrashPicked(new Set()); }, [where.trash]);
  const copy = async (n) => { try { await post(`/notes/${n.id}/copy`); toast('Copy made'); load(); } catch (e) { toast(e.message, 'error'); } };
  const [templating, setTemplating] = useState(null); // a note being saved as a template
  const [templates, setTemplates] = useState(false); // the Templates window

  const pinned = sortNotes((notes || []).filter((n) => n.pinned), sort);
  const others = sortNotes((notes || []).filter((n) => !n.pinned), sort);
  // Up to 2,000 notes: the others go on the page 150 at a time (all at once took two seconds).
  const batch = useBatches(others, 150, `${JSON.stringify(where)}|${search}|${sort}`);
  const current = notes?.find((n) => n.id === editing);
  // Your own order: drag a card onto another (within Pinned or Others), or ⋮ → Move earlier / later.
  // Not while searching or looking at a label or reminders, where only some cards show.
  const sortable = !search && !where.label && !where.reminders && !where.trash && sort === 'mine';
  const [dragging, setDragging] = useState(null);
  const reorder = async (group, next) => {
    const ids = group === 'pinned' ? [...next, ...others.map((n) => n.id)] : [...pinned.map((n) => n.id), ...next];
    const byId = new Map((notes || []).map((n) => [n.id, n]));
    setNotes(ids.map((id) => byId.get(id)));
    try { await post('/notes/order', { ids }); } catch (e) { toast(e.message, 'error'); load(); }
  };
  const groupOf = (n) => (n.pinned ? pinned : others).map((x) => x.id);
  const dragProps = (n) => (!sortable ? {} : {
    draggable: true,
    onDragStart: (e) => { setDragging(n.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', n.id); },
    onDragEnd: () => setDragging(null),
    onDragOver: (e) => { const d = (notes || []).find((x) => x.id === dragging); if (d && d.id !== n.id && !!d.pinned === !!n.pinned) e.preventDefault(); },
    onDrop: (e) => { e.preventDefault(); const d = (notes || []).find((x) => x.id === dragging); setDragging(null); if (d && d.id !== n.id && !!d.pinned === !!n.pinned) reorder(n.pinned ? 'pinned' : 'others', moveTo(groupOf(n), d.id, n.id)); },
  });
  // Several notes at once: pick them (the ✓ on a card), then pin, colour, label, archive or delete them together.
  const [picked, setPicked] = useState(() => new Set());
  const [newLabel, setNewLabel] = useState(false);
  useEffect(() => { setPicked(new Set()); }, [where.archived, where.label, where.reminders, where.trash]);
  const pickNote = (id) => setPicked((s0) => { const s1 = new Set(s0); if (s1.has(id)) s1.delete(id); else s1.add(id); return s1; });
  const nNotes = (k) => `${k} note${k === 1 ? '' : 's'}`;
  async function many(body, say) {
    try { const r = await post('/notes/batch', { ids: [...picked], ...body }); toast(say(r)); setPicked(new Set()); load(); } catch (e) { toast(e.message, 'error'); }
  }
  const card = (n) => <NoteCard key={n.id} labelColors={labelColors} note={n} drag={dragProps(n)} dragging={dragging === n.id} picked={picked.has(n.id)} picking={picked.size > 0} onPick={() => pickNote(n.id)}
    onMove={sortable ? (by) => reorder(n.pinned ? 'pinned' : 'others', moveBy(groupOf(n), n.id, by)) : null}
    first={groupOf(n)[0] === n.id} last={groupOf(n).at(-1) === n.id} onOpen={() => setEditing(n.id)} onChange={(c) => change(n, c)} onArchive={() => archive(n, !n.archived)}
    onLabel={() => setLabelling(n)} onShare={() => setSharing(n)} onHistory={() => setHistory(n)} onChat={() => setChatting([n])} onCopy={() => copy(n)} onTemplate={() => setTemplating(n)} onDelete={() => (n.mine ? trash(n) : setDeleting(n))}
    onToSheet={async () => { try { const d = await post(`/notes/${n.id}/sheet`); toast(`Copied to a new spreadsheet in My Drive (${d.items} item${d.items === 1 ? '' : 's'})`, 'info', { action: { label: 'Open', onClick: () => navigate(`/sheets/${d.id}`) } }); } catch (e) { toast(e.message, 'error'); } }}
    onToDoc={async () => { try { const d = await post(`/notes/${n.id}/doc`); toast(`Copied to a new document in My Drive${d.pictures ? `, with its ${d.pictures === 1 ? 'picture' : `${d.pictures} pictures`}` : ''}`, 'info', { action: { label: 'Open', onClick: () => navigate(`/docs/${d.id}`) } }); } catch (e) { toast(e.message, 'error'); } }}
    onToTasks={async () => { // (with several task lists: which one; otherwise straight to the only list)
      try {
        const lists = (await get('/tasks/lists')).lists || [];
        if (lists.length > 1) setToTasks({ note: n, lists }); else await copyToTasks(n, null);
      } catch (e) { toast(e.message, 'error'); }
    }}
    onRemind={(t) => { if (t === 'pick') setPicking(n); else { change(n, { remind_at: t }); if (t) toast(`Reminder set for ${reminderText(t)}`); } }} />;
  return (
    <div className="notes-app">
      <aside className="subnav">
        <button type="button" className={`subnav-item ${!where.archived && !where.label && !where.reminders && !where.shared && !where.trash ? 'active' : ''}`} onClick={() => setWhere({ archived: false, label: null, reminders: false })}><Icon name="note" /><span className="grow">Notes</span></button>
        <button type="button" className={`subnav-item ${where.reminders ? 'active' : ''}`} onClick={() => setWhere({ archived: false, label: null, reminders: true })}><Icon name="bell" /><span className="grow">Reminders</span></button>
        <button type="button" className={`subnav-item ${where.shared ? 'active' : ''}`} onClick={() => setWhere({ archived: false, label: null, reminders: false, shared: true })}><Icon name="share" /><span className="grow">Shared with me</span></button>
        {labels.map((l, i) => (
          <div key={l} className="note-label-row">
          <button type="button" className={`subnav-item ${where.label === l ? 'active' : ''}`} onClick={() => setWhere({ archived: false, label: l, reminders: false })}>{labelColors[l] ? <span className="note-label-dot" style={{ background: labelColors[l] }} aria-hidden="true" /> : <span className="note-label-icon" aria-hidden="true">🏷</span>}<span className="grow ellipsis">{l}</span></button>
          <Menu align="right" trigger={(p) => <button type="button" className="icon-btn note-label-color" aria-label={`Edit label ${l}`} title="Colour, rename or delete" {...p}>●</button>}
            items={[...LABEL_COLORS.map(([c, name]) => ({ label: `${labelColors[l] === c ? '✓ ' : ''}${name}`, onClick: () => setLabelColor(l, c) })), '-', { label: 'No colour', onClick: () => setLabelColor(l, null) }, '-', ...(i > 0 ? [{ label: 'Move up', onClick: () => orderLabels(i, -1) }] : []), ...(i < labels.length - 1 ? [{ label: 'Move down', onClick: () => orderLabels(i, 1) }] : []), { label: 'Rename label…', onClick: () => setLabelEdit({ rename: l }) }, { label: 'Download its notes (.zip)', onClick: () => { window.location.href = `/api/notes/export.zip?label=${encodeURIComponent(l)}`; } }, { label: 'Delete label', danger: true, onClick: () => setLabelEdit({ remove: l }) }]} />
          </div>
        ))}
        <button type="button" className={`subnav-item ${where.archived ? 'active' : ''}`} onClick={() => setWhere({ archived: true, label: null, reminders: false })}><Icon name="archive" /><span className="grow">Archive</span></button>
        <button type="button" className={`subnav-item ${where.trash ? 'active' : ''}`} onClick={() => setWhere({ archived: false, label: null, reminders: false, trash: true })}><Icon name="trash" /><span className="grow">Trash</span></button>
        <button type="button" className="subnav-item" title="One note a day (a journal, a stand-up log), made from the template you choose for it" onClick={async () => {
          const d = new Date();
          const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          try {
            const n = await post('/notes/daily', { date, title: d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) });
            if (n.made) toast(`${n.from_template ? `Today’s note, from “${n.from_template}”` : 'Today’s note'}${n.carried ? `, with ${n.carried === 1 ? '1 unticked item' : `${n.carried} unticked items`} from last time` : ''}`);
            setWhere({ archived: false, label: null, reminders: false }); await load(); setEditing(n.id);
          } catch (e) { toast(e.message, 'error'); }
        }}><Icon name="calendar" /><span className="grow">Today’s note</span></button>
        <button type="button" className="subnav-item" title="Start a note from one you saved as a template" onClick={() => setTemplates(true)}><Icon name="copy" /><span className="grow">Templates</span></button>
        <button type="button" className="subnav-item" title="Markdown (.md), text (.txt) or HTML files, one note each; Evernote exports (.enex); notes from Google Keep (its Google Takeout .zip, or the .json files in it); or a .zip of any of these" onClick={() => importRef.current?.click()}><Icon name="upload" /><span className="grow">Import notes…</span></button>
        <input ref={importRef} type="file" accept=".md,.markdown,.txt,.json,.enex,.html,.htm,.zip,text/markdown,text/plain,application/json,text/html,application/zip" multiple hidden aria-label="Notes to import" onChange={async (e) => {
          const picked = [...e.target.files]; e.target.value = '';
          try {
            if (picked.some((f) => /\.zip$/i.test(f.name) && f.size > 18e6)) throw new Error('A .zip of notes can be up to 18 MB: unzip it and choose the files instead');
            const b64 = async (f) => { const bytes = new Uint8Array(await f.arrayBuffer()); let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(bin); };
            const files = await Promise.all(picked.map(async (f) => (/\.zip$/i.test(f.name) ? { name: f.name, base64: await b64(f) } : { name: f.name, text: await f.text() })));
            const r = await post('/notes/import', { files });
            toast(`${r.added} note${r.added === 1 ? '' : 's'} imported${r.skipped ? ` (${r.skipped} empty or deleted skipped)` : ''}`);
            setWhere({ archived: false, label: null, reminders: false }); load();
          } catch (err) { toast(err.message, 'error'); }
        }} />
      </aside>
      <section className="notes-main">
        <div className="row notes-top"><div className="notes-search"><Icon name="search" size={18} /><input type="search" aria-label="Search notes" placeholder="Search notes" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
          <select className="notes-sort" aria-label="Sort notes" value={sort} onChange={(e) => chooseSort(e.target.value)} title="The order of your notes (dragging them works in Your order)">
            {NOTE_SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <button type="button" className="icon-btn notes-view" aria-label={view === 'grid' ? 'List view' : 'Grid view'} title={view === 'grid' ? 'Show notes in one column' : 'Show notes as a grid'} onClick={switchView}>{view === 'grid' ? '☰' : '▦'}</button>
          {!where.trash && <button type="button" className={`btn small ${filtersOpen || filtering ? 'primary' : ''}`} aria-expanded={filtersOpen || filtering} aria-controls="note-filters" onClick={() => { if (filtering) { setKind({ type: null, color: null }); setFiltersOpen(false); } else setFiltersOpen((o) => !o); }}>{filtering ? '× Clear filter' : 'Filter'}</button>}</div>
        {!where.trash && (filtersOpen || filtering) && (
          <div className="note-filters" id="note-filters">
            <div className="note-filter-row" role="group" aria-label="Kind of note">
              {NOTE_KINDS.map(([t, label]) => <button key={t} type="button" className={`btn small ${kind.type === t ? 'primary' : ''}`} aria-pressed={kind.type === t} onClick={() => setKind((k) => ({ ...k, type: k.type === t ? null : t }))}>{label}</button>)}
            </div>
            <div className="note-filter-row" role="group" aria-label="Colour">
              {COLORS.map(([c, name]) => { const v = c || 'none'; return <button key={name} type="button" className={`swatch note-swatch ${kind.color === v ? 'on' : ''}`} style={{ background: c || 'var(--surface)' }} aria-pressed={kind.color === v} aria-label={name} title={name} onClick={() => setKind((k) => ({ ...k, color: k.color === v ? null : v }))} />; })}
            </div>
          </div>
        )}
        {!where.archived && !where.reminders && !where.trash && <Composer label={where.label} onMade={load} />}
        {where.trash ? <>
          <div className="row notes-trash-head"><p className="muted small grow" style={{ margin: 0 }}>Notes in the trash are deleted for good after 7 days.</p>
            {notes?.length > 0 && <button type="button" className="btn small" onClick={() => setForever('all')}>Empty trash</button>}</div>
          {trashPicked.size > 0 && (
            <div className="notes-batch" role="toolbar" aria-label="Change the selected deleted notes">
              <strong className="small" aria-live="polite">{trashPicked.size} selected</strong>
              <button type="button" className="btn small" onClick={async () => {
                try { const r = await post('/notes/trash/batch', { ids: [...trashPicked], action: 'restore' }); toast(`${nNotes(r.restored)} restored`); setTrashPicked(new Set()); load(); } catch (e) { toast(e.message, 'error'); }
              }}>Restore</button>
              <button type="button" className="btn small danger" onClick={() => setForever('picked')}>Delete forever</button>
              <button type="button" className="link-btn small" onClick={() => setTrashPicked(new Set((notes || []).map((n) => n.id)))}>Select all</button>
              <button type="button" className="link-btn small" onClick={() => setTrashPicked(new Set())}>Clear</button>
            </div>
          )}
          {notes && !notes.length ? <Empty icon="trash" title="The trash is empty" /> : (
            <div className={`notes-grid ${view === 'list' ? 'list' : ''}`} aria-label="Deleted notes">{(notes || []).map((n) => (
              <article key={n.id} className="note-card trashed" style={{ background: n.color || undefined }} aria-label={n.title || 'Note'}>
                <label className="check small note-trash-pick"><input type="checkbox" aria-label={`Select deleted note: ${n.title || 'Note'}`} checked={trashPicked.has(n.id)} onChange={(e) => { const s0 = new Set(trashPicked); e.target.checked ? s0.add(n.id) : s0.delete(n.id); setTrashPicked(s0); }} /></label>
                {n.title && <h3>{n.title}</h3>}
                {n.items ? <ul className="note-items">{n.items.slice(0, 6).map((i) => <li key={i.id} className={i.done ? 'done' : ''}>{i.done ? '☑' : '☐'} {i.text}</li>)}</ul> : <p className="note-body">{n.body.slice(0, 300)}</p>}
                <div className="row note-tools">
                  <button type="button" className="btn small" onClick={() => restore(n)}>Restore</button>
                  <button type="button" className="btn small danger" onClick={() => setForever(n)}>Delete forever</button>
                </div>
              </article>
            ))}</div>
          )}
        </> : notes === null ? null : !notes.length ? (
          <Empty icon={where.archived ? 'archive' : 'note'} title={search || filtering ? 'No matching notes' : where.reminders ? 'No reminders set' : where.shared ? 'Nobody has shared a note with you' : where.archived ? 'Nothing archived' : where.label ? `No notes labelled “${where.label}”` : 'Notes you add appear here'} />
        ) : <>
          {picked.size > 0 && (
            <div className="notes-batch" role="toolbar" aria-label="Change the selected notes">
              <strong className="small" aria-live="polite">{picked.size} selected</strong>
              <button type="button" className="btn small" onClick={() => many({ change: { pinned: true } }, (r) => `${nNotes(r.notes.length)} pinned`)}>📌 Pin</button>
              <button type="button" className="btn small" onClick={() => many({ change: { pinned: false } }, (r) => `${nNotes(r.notes.length)} unpinned`)}>Unpin</button>
              <select aria-label="Colour for the selected notes" value="x" onChange={(e) => many({ change: { color: e.target.value || null } }, (r) => `${nNotes(r.notes.length)} coloured`)}>
                <option value="x" disabled>Colour…</option>
                {COLORS.map(([v, name]) => <option key={name} value={v}>{name}</option>)}
              </select>
              <select aria-label="Remind me about the selected notes" value="" onChange={(e) => { const v = e.target.value; if (!v) return; const t = v === 'none' ? null : Number(v); many({ change: { remind_at: t } }, (r) => (t ? `${nNotes(r.notes.length)}: reminder ${reminderText(t)}` : `${nNotes(r.notes.length)}: no reminder`)); }}>
                <option value="">Remind me…</option>
                {quickTimes().map(([label, t]) => <option key={label} value={t}>{label}</option>)}
                <option value="none">No reminder</option>
              </select>
              <select aria-label="Label the selected notes" value="" onChange={(e) => { if (e.target.value === '+new') setNewLabel(true); else if (e.target.value) many({ change: { label: e.target.value } }, (r) => `${nNotes(r.notes.length)} labelled ${e.target.value}`); }}>
                <option value="">Label…</option>
                {labels.map((l) => <option key={l} value={l}>{l}</option>)}
                <option value="+new">New label…</option>
              </select>
              {(() => { // the labels some of the picked notes have, to take off them all
                const on = [...new Set([...pinned, ...others].filter((x) => picked.has(x.id)).flatMap((x) => x.labels || []))].sort((x, y) => x.localeCompare(y));
                return on.length > 0 && (
                  <select aria-label="Take a label off the selected notes" value="" onChange={(e) => { const l = e.target.value; if (l) many({ change: { unlabel: l } }, (r) => `${l} taken off ${nNotes(r.notes.length)}`); }}>
                    <option value="">Remove label…</option>
                    {on.map((l) => <option key={l} value={l}>{l}</option>)}
                  </select>
                );
              })()}
              <button type="button" className="btn small" onClick={() => many({ change: { archived: !where.archived } }, (r) => `${nNotes(r.notes.length)} ${where.archived ? 'back in Notes' : 'archived'}`)}><Icon name="archive" size={16} /> {where.archived ? 'Unarchive' : 'Archive'}</button>
              {mail?.enabled && <button type="button" className="btn small" title="A new email with the picked notes in it" onClick={() => {
                try { localStorage.setItem(DRAFT_KEY, JSON.stringify(notesEmail([...pinned, ...others].filter((x) => picked.has(x.id)), noteLink))); } catch { toast('Your browser’s storage is off', 'error'); return; }
                navigate('/mail?compose_doc=1');
              }}><Icon name="mail" size={16} /> Email</button>}
              <button type="button" className="btn small" title="A copy of each, yours, at the top" onClick={() => many({ copy: true }, (r) => (r.notes.length === 1 ? 'Copy made' : `${r.notes.length} copies made`))}><Icon name="copy" size={16} /> Make copies</button>
              {[...pinned, ...others].filter((x) => picked.has(x.id)).every((x) => x.mine) && <button type="button" className="btn small" title="Share the picked notes with more colleagues (whoever has them already keeps them)" onClick={() => setSharingMany(true)}><Icon name="share" size={16} /> Share…</button>}
              <button type="button" className="btn small" title="Links to the picked notes in a Chat conversation's message box (they show as note cards)" onClick={() => setChatting([...pinned, ...others].filter((x) => picked.has(x.id)))}><Icon name="chat" size={16} /> Send in Chat…</button>
              <button type="button" className="btn small" title="The picked notes on one printout, each on its own page" onClick={async () => printHtml(notesPrintHtml(await withComments([...pinned, ...others].filter((x) => picked.has(x.id)), get)))}><Icon name="print" size={16} /> Print</button>
              <button type="button" className="btn small" title="Each note as a Markdown (.md) file, in one .zip" onClick={async () => {
                const url = `/notes/export.zip?ids=${[...picked].map(encodeURIComponent).join(',')}`;
                try { await get(`${url}&check=1`); } catch (e) { toast(e.message, 'error'); return; }
                const l = document.createElement('a'); l.href = `/api${url}`; l.download = ''; document.body.appendChild(l); l.click(); l.remove();
              }}><Icon name="download" size={16} /> Download (.zip)</button>
              <button type="button" className="btn small danger" onClick={() => many({ trash: true }, (r) => [r.trashed && `${nNotes(r.trashed)} moved to the trash`, r.left && `left ${nNotes(r.left)} shared with you`].filter(Boolean).join('; '))}><Icon name="trash" size={16} /> Delete</button>
              <button type="button" className="link-btn small" onClick={() => setPicked(new Set())}>Clear</button>
            </div>
          )}
          {newLabel && <PromptModal title="New label" label="Label" confirm="Add" onClose={() => setNewLabel(false)}
            onSubmit={async (name) => { setNewLabel(false); await many({ change: { label: name } }, (r) => `${nNotes(r.notes.length)} labelled ${name.trim()}`); }} />}
          {pinned.length > 0 && <><h2 className="notes-heading">Pinned</h2><div className={`notes-grid ${view === 'list' ? 'list' : ''}`} aria-label="Pinned notes">{pinned.map(card)}</div></>}
          {others.length > 0 && <>{pinned.length > 0 && <h2 className="notes-heading">Others</h2>}<div className={`notes-grid ${view === 'list' ? 'list' : ''}`} aria-label={where.archived ? 'Archived notes' : 'Notes'}>{batch.shown.map(card)}</div>{batch.more}</>}
        </>}
      </section>
      {current && <NoteEditor key={current.id} note={current} onClose={() => { setEditing(null); load(); }} />}
 {toTasks && <NoteToTasks lists={toTasks.lists} items={!!toTasks.note.items?.length} onClose={() => setToTasks(null)} onPick={async (id) => { await copyToTasks(toTasks.note, id); setToTasks(null); }} />}
 {history && <NoteHistory note={history} onClose={() => setHistory(null)} onRestored={() => { setHistory(null); load(); toast('Earlier version restored (what was there is kept in the history)'); }} />}
      {sharing && <ShareNote note={sharing} onClose={() => { setSharing(null); load(); }} />}
      {templating && <PromptModal title="Save as template" label="Template name" initial={templating.title || ''} confirm="Save" message="New notes can start from it (Templates, on the left): its title, text or list (unticked), colour and labels."
        onClose={() => setTemplating(null)} onSubmit={async (name) => {
          try { const t = await post('/notes/templates', { note_id: templating.id, name }); toast(`Saved as the template “${t.name}”`); setTemplating(null); } catch (e) { toast(e.message, 'error'); }
        }} />}
      {templates && <NoteTemplates onClose={() => setTemplates(false)} onUse={async (t) => {
        try {
          const n = await post('/notes', { title: t.title, body: t.body, ...(t.items && { items: t.items }), ...(t.color && { color: t.color }), labels: t.labels || [] });
          post(`/notes/templates/${t.id}/used`).catch(() => {});
          setTemplates(false); toast(`New note from “${t.name}”`); await load(); setEditing(n.id);
        } catch (e) { toast(e.message, 'error'); }
      }} />}
      {labelling && <LabelNote note={labelling} all={labels} onSave={async (ls) => { await change(labelling, { labels: ls }); setLabelling(null); }} onClose={() => setLabelling(null)} />}
      {picking && <PickTime note={picking} onClose={() => setPicking(null)} onPick={(t, more) => { change(picking, { remind_at: t, ...more }); toast(`Reminder set for ${reminderText(t)}${more?.remind_repeat ? `, ${REPEAT_CHOICES.find(([k]) => k === more.remind_repeat)?.[1].toLowerCase()}` : ''}`); setPicking(null); }} />}
      {labelEdit?.rename && <PromptModal title="Rename label" label="Label name" initial={labelEdit.rename} confirm="Rename"
        message="On every note with it, yours and those shared with you. A name you already use joins the two."
        onClose={() => setLabelEdit(null)} onSubmit={async (to) => {
          const from = labelEdit.rename;
          await post('/notes/labels/rename', { from, to });
          setLabelEdit(null);
          if (where.label === from) setWhere((w) => ({ ...w, label: to.trim() })); // (which loads the notes again)
          else load();
        }} />}
      {labelEdit?.remove && <ConfirmModal title={`Delete the label “${labelEdit.remove}”?`} confirm="Delete label"
        message="It comes off every note with it, yours and those shared with you. The notes stay."
        onClose={() => setLabelEdit(null)} onConfirm={async () => {
          const label = labelEdit.remove;
          await post('/notes/labels/delete', { label });
          if (where.label === label) setWhere({ archived: false, label: null, reminders: false }); // (which loads the notes again)
          else load();
        }} />}
      {forever && <ConfirmModal title={forever === 'all' ? 'Empty the trash?' : forever === 'picked' ? `Delete ${nNotes(trashPicked.size)} for good?` : 'Delete this note for good?'} confirm="Delete forever" message="This can’t be undone."
        onClose={() => setForever(null)} onConfirm={async () => {
          try {
            if (forever === 'picked') { await post('/notes/trash/batch', { ids: [...trashPicked], action: 'delete' }); setTrashPicked(new Set()); }
            else await del(forever === 'all' ? '/notes/trash' : `/notes/${forever.id}?forever=1`);
          } catch (e) { toast(e.message, 'error'); }
          setForever(null); load();
        }} />}
      {deleting && <ConfirmModal title={deleting.mine ? 'Delete this note?' : 'Remove this note?'} confirm={deleting.mine ? 'Delete' : 'Remove'}
        message={deleting.mine ? (deleting.shared.length ? 'It goes for everyone it’s shared with too.' : 'This can’t be undone.') : 'It stays for its owner and the others it’s shared with.'}
        onClose={() => setDeleting(null)} onConfirm={async () => { await del(`/notes/${deleting.id}`); setDeleting(null); load(); }} />}
      {sharingMany && <ShareMany count={picked.size} me={user?.id} onClose={() => setSharingMany(false)}
        onShare={(ids) => many({ share_with: ids }, (r) => (r.shared ? `Shared: ${r.shared === 1 ? '1 new share' : `${r.shared} new shares`}` : 'They already had them'))} />}
      {chatting && <SendInChat items={chatting.map((x) => ({ name: x.title || 'Note', url: noteLink(x) }))} what={chatting.length === 1 ? 'the note' : `${chatting.length} notes`} onClose={() => setChatting(null)} />}
    </div>
  );
}

/** "Take a note…": opens into a title and text (or a checklist) when clicked. */
function Composer({ label, onMade }) {
  const toast = useToast();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ title: '', body: '', items: null, color: '' });
  const box = useRef();
  const reset = () => { setF({ title: '', body: '', items: null, color: '' }); setOpen(false); };
  const save = async () => {
    const items = f.items?.filter((i) => i.text.trim());
    if (!f.title.trim() && !f.body.trim() && !items?.length) { reset(); return; }
    const body = { id: offlineId(), title: f.title, body: f.items ? '' : f.body, ...(f.items && { items }), color: f.color || null, labels: label ? [label] : [] };
    try { await post('/notes', body); reset(); onMade(); }
    catch (e) {
      // No connection: the note is made when it's back (with this id, so a repeat makes nothing twice); shown first meanwhile.
      if (unreachable(e)) {
        const note = { ...body, items: body.items || null, pinned: false, archived: false, trashed_at: null, remind_at: null, pictures: [], recordings: [], mine: true, owner: user && { id: user.id, name: user.name, username: user.username }, shared: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString(), offline: true };
        await changeAdd({ method: 'POST', url: '/notes', body, user: user?.id, label: f.title || 'a note' });
        await appendKept('/notes?', note, { first: true });
        window.dispatchEvent(new Event('nw:changes'));
        reset(); onMade(note);
        toast('Note saved on this device, made when the connection is back');
        return;
      }
      toast(e.message, 'error');
    }
  };
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (box.current && !box.current.contains(e.target) && !e.target.closest('.menu, .modal-backdrop')) save(); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  });
  if (!open) {
    return (
      <div className="note-composer closed">
        <button type="button" className="grow note-take" onClick={() => setOpen(true)}>Take a note…</button>
        <button type="button" className="icon-btn" aria-label="New checklist" title="New checklist" onClick={() => { setF({ ...f, items: [newItem()] }); setOpen(true); }}><Icon name="check" /></button>
      </div>
    );
  }
  return (
    <div className="note-composer" ref={box} style={f.color ? { background: f.color, color: '#202124' } : undefined}>
      <input aria-label="Title" placeholder="Title" value={f.title} maxLength={300} onChange={(e) => setF({ ...f, title: e.target.value })} />
      {f.items ? <ChecklistEdit items={f.items} onChange={(items) => setF({ ...f, items })} autoFocus />
        : <textarea autoFocus aria-label="Take a note" placeholder="Take a note…" rows={3} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} />}
      <div className="row note-tools">
        <ColorPicker value={f.color} onChange={(color) => setF({ ...f, color })} />
        <button type="button" className="icon-btn" aria-label={f.items ? 'Plain text' : 'Checklist'} title={f.items ? 'Plain text' : 'Checklist'}
          onClick={() => setF(f.items ? { ...f, body: f.items.map((i) => i.text).filter(Boolean).join('\n'), items: null } : { ...f, items: (f.body ? f.body.split('\n') : ['']).map((t) => newItem(t)), body: '' })}>{f.items ? '¶' : <Icon name="check" size={18} />}</button>
        <span className="grow" />
        <button type="button" className="btn small" onClick={save}>Close</button>
      </div>
    </div>
  );
}

function ChecklistEdit({ items, onChange, autoFocus }) {
  const refs = useRef({});
  const [focusId, setFocusId] = useState(null);
  const [dragId, setDragId] = useState(null);
  useEffect(() => { if (focusId) { refs.current[focusId]?.focus(); setFocusId(null); } }, [focusId]);
  const set = (id, patch) => onChange(items.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  const keep = (next, id) => { onChange(next); setFocusId(id); };
  return (
    <ul className="note-checklist editing">
      {items.map((it, k) => (
        <li key={it.id} className={`row ${it.done ? 'done' : ''} ${it.indent ? 'sub' : ''} ${dragId === it.id ? 'dragging' : ''}`}
          onDragOver={(e) => { if (dragId && dragId !== it.id) e.preventDefault(); }}
          onDrop={(e) => { e.preventDefault(); if (dragId && dragId !== it.id) onChange(moveItemTo(items, dragId, it.id)); setDragId(null); }}>
          <span className="drag-handle" draggable aria-hidden="true" title="Drag to move (or Alt+↑ / Alt+↓)"
            onDragStart={(e) => { setDragId(it.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', it.id); }} onDragEnd={() => setDragId(null)}>⠿</span>
          <input type="checkbox" checked={it.done} aria-label={`Done: ${it.text || 'item'}`} onChange={(e) => onChange(tickItem(items, it.id, e.target.checked))} />
          <input ref={(el) => { refs.current[it.id] = el; }} className="grow" aria-label={`List item ${k + 1}${it.indent ? ' (sub-item)' : ''}`} value={it.text} maxLength={1000} autoFocus={autoFocus && k === items.length - 1}
            placeholder="List item" onChange={(e) => set(it.id, { text: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); const n = { ...newItem(), ...(it.indent && { indent: 1 }) }; keep([...items.slice(0, k + 1), n, ...items.slice(k + 1)], n.id); }
              else if (e.key === 'Backspace' && !it.text && it.indent) { e.preventDefault(); keep(indent(items, it.id, -1), it.id); }
              else if (e.key === 'Backspace' && !it.text && items.length > 1) { e.preventDefault(); onChange(items.filter((x) => x.id !== it.id)); setFocusId(items[k - 1]?.id || items[1]?.id); }
              else if (e.key === 'Tab' && (e.shiftKey ? it.indent : k > 0 && !it.indent)) { e.preventDefault(); keep(indent(items, it.id, e.shiftKey ? -1 : 1), it.id); }
              else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); keep(moveItem(items, it.id, e.key === 'ArrowUp' ? -1 : 1), it.id); }
            }} />
          <button type="button" className="icon-btn" aria-label={`Remove item ${k + 1}`} onClick={() => onChange(items.filter((x) => x.id !== it.id))}><Icon name="close" size={14} /></button>
        </li>
      ))}
      <li><button type="button" className="link-btn small" onClick={() => { const n = newItem(); onChange([...items, n]); setFocusId(n.id); }}>+ List item</button></li>
      <li className="muted small note-checklist-help">Tab makes an item a sub-item; Alt+↑ and Alt+↓ move it.</li>
    </ul>
  );
}

function ColorPicker({ value, onChange }) {
  return (
    <Menu align="left" trigger={(p) => <button type="button" className="icon-btn" aria-label="Background colour" title="Background colour" {...p}>🎨</button>}
      items={COLORS.map(([c, name]) => ({ label: `${value === c || (!value && !c) ? '✓ ' : ''}${name}`, onClick: () => onChange(c) }))} />
  );
}

/** Pick a day and time for a reminder. */
function PickTime({ note, onPick, onClose }) {
  const pad = (x) => String(x).padStart(2, '0');
  const start = new Date(note.remind_at || quickTimes()[0][1]);
  const [v, setV] = useState(`${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}T${pad(start.getHours())}:${pad(start.getMinutes())}`);
  const t = new Date(v).getTime();
  const [repeat, setRepeat] = useState(note.remind_repeat || '');
  const [reset, setReset] = useState(!!note.remind_reset);
  const save = () => onPick(t, { remind_repeat: repeat || null, ...(repeat && { remind_tz: Intl.DateTimeFormat().resolvedOptions().timeZone, ...(note.items && { remind_reset: reset }) }) });
  return (
    <Modal title="Remind me" onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" disabled={!(t > Date.now())} onClick={save}>Save</button></>}>
      <label className="field"><span>Day and time</span><input type="datetime-local" value={v} onChange={(e) => setV(e.target.value)} /></label>
      <label className="field"><span>Repeat</span>
        <select value={repeat} onChange={(e) => setRepeat(e.target.value)}>
          {REPEAT_CHOICES.map(([k, label]) => <option key={k || 'none'} value={k || ''}>{k ? label.replace('Repeat ', '').replace(/^./, (c) => c.toUpperCase()) : label}</option>)}
        </select>
      </label>
      {repeat && note.items && <label className="check"><input type="checkbox" checked={reset} onChange={(e) => setReset(e.target.checked)} /> Untick the list each time</label>}
      <p className="muted small">{note.shared.length ? 'Everyone the note is shared with gets the reminder too.' : 'You get a notification then.'}</p>
    </Modal>
  );
}

/** How a reminder can repeat (the server's REPEATS), with what the menu says. */
const REPEAT_CHOICES = [[null, 'Doesn’t repeat'], ['daily', 'Repeat daily'], ['weekdays', 'Repeat on weekdays'], ['weekly', 'Repeat weekly'], ['monthly', 'Repeat monthly']];

/** Your note templates: start a note from one, rename or delete one. */
function NoteTemplates({ onClose, onUse }) {
  const toast = useToast();
  const [list, setList] = useState(null);
  const [renaming, setRenaming] = useState(null); // the template being given a new name
  const fileRef = useRef(null);
  const load = useCallback(() => get('/notes/templates').then(setList).catch((e) => toast(e.message, 'error')), [toast]);
  useEffect(() => { load(); }, [load]);
  // Moving templates to another account or server: Export gives Note templates.json, Import reads one back.
  const exportAll = () => {
    const out = list.map(({ name, title, body, items, color, labels }) => ({ name, title, body, items, color, labels }));
    const url = URL.createObjectURL(new Blob([`${JSON.stringify(out, null, 2)}\n`], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'Note templates.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const importFile = async (file) => {
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const r = await post('/notes/templates/import', { templates: Array.isArray(data) ? data : data?.templates });
      load();
      toast(r.added ? `Added ${r.added} template${r.added === 1 ? '' : 's'}${r.skipped ? ` (${r.skipped} already here)` : ''}` : 'Those templates are all here already');
    } catch (e) { toast(e instanceof SyntaxError ? 'That isn’t a templates file (Note templates.json)' : e.message, 'error'); }
  };
  return (
    <Modal title="Note templates" onClose={onClose} footer={<>
      <input ref={fileRef} type="file" accept=".json,application/json" hidden aria-label="Import note templates" onChange={(e) => { importFile(e.target.files[0]); e.target.value = ''; }} />
      <button type="button" className="btn" onClick={() => fileRef.current?.click()}><Icon name="upload" size={18} /> Import…</button>
      <button type="button" className="btn" disabled={!list?.length} onClick={exportAll}><Icon name="download" size={18} /> Export</button>
      <button type="button" className="btn" onClick={onClose}>Close</button>
    </>}>
      {!list ? <p className="muted">Loading…</p> : !list.length ? <p className="muted">No templates yet. On a note, choose ⋮ → <strong>Save as template…</strong> to start new notes from it, or <strong>Import…</strong> a Note templates.json exported from Workspace.</p> : (
        <ul className="plain-list stack-tight" aria-label="Templates">
          {/* With several, the three you used last first; then the rest, by name. */}
          {(() => { const recent = list.length > 3 ? list.filter((t) => t.used_at).sort((x, y) => y.used_at - x.used_at).slice(0, 3) : []; return [...recent, ...list.filter((t) => !recent.includes(t))]; })().map((t) => (
            <li key={t.id} className="stack-tight">
            <div className="row" style={{ gap: 8 }}>
              <span className="grow"><strong>{t.name}</strong>{t.daily && <span className="muted small"> · Today’s note</span>} <span className="muted small">{t.items ? `☑ ${t.items.length} item${t.items.length === 1 ? '' : 's'}` : (t.body || '').slice(0, 60)}</span></span>
              <button type="button" className={`btn small ${t.daily ? 'on' : ''}`} aria-pressed={t.daily} title="Today’s note (on the left) starts from this template"
                onClick={async () => { try { await patch(`/notes/templates/${t.id}`, { daily: !t.daily }); toast(t.daily ? 'Today’s note starts empty' : `Today’s note starts from “${t.name}”`); load(); } catch (e) { toast(e.message, 'error'); } }}>{t.daily ? '✓ For Today’s note' : 'For Today’s note'}</button>
              <button type="button" className="btn small primary" onClick={() => onUse(t)}>Use</button>
              <button type="button" className="icon-btn" aria-label={`Rename the template ${t.name}`} onClick={() => setRenaming(t)}><Icon name="edit" size={16} /></button>
              <button type="button" className="icon-btn" aria-label={`Delete the template ${t.name}`} onClick={async () => { try { await del(`/notes/templates/${t.id}`); toast('Template deleted'); load(); } catch (e) { toast(e.message, 'error'); } }}><Icon name="trash" size={16} /></button>
            </div>
            {t.daily && t.items && (
              <label className="row small" style={{ gap: 6 }}>
                <input type="checkbox" checked={t.carry} onChange={async (e) => {
                  const on = e.target.checked;
                  setList((l) => l.map((x) => (x.id === t.id ? { ...x, carry: on } : x)));
                  try { await patch(`/notes/templates/${t.id}`, { carry: on }); } catch (err) { toast(err.message, 'error'); load(); }
                }} />
                Carry over the unticked items from the last daily note
              </label>
            )}
            </li>
          ))}
        </ul>
      )}
      {renaming && <PromptModal title="Rename template" label="Template name" initial={renaming.name} confirm="Rename" onClose={() => setRenaming(null)}
        onSubmit={async (name) => { await patch(`/notes/templates/${renaming.id}`, { name }); toast('Template renamed'); load(); }} />}
    </Modal>
  );
}

/** Which task list a note's items go to (asked when you have more than one). */
function NoteToTasks({ lists, items, onPick, onClose }) {
  const [list, setList] = useState(lists[0]?.id || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const go = async () => { setBusy(true); setError(''); try { await onPick(list); } catch (e) { setError(e.message); setBusy(false); } };
  return (
    <Modal title="Copy to Tasks" onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" disabled={busy || !list} onClick={go}>Copy</button></>}>
      <p className="muted small" style={{ marginTop: 0 }}>{items ? 'The unticked items become tasks at the top of the list (sub-items as steps).' : 'The note becomes a task at the top of the list.'}</p>
      <label className="field"><span>List</span><select value={list} onChange={(e) => setList(e.target.value)}>{lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
      {error && <p className="error" role="alert">{error}</p>}
    </Modal>
  );
}

function NoteCard({ labelColors = {}, note: n, drag = {}, dragging, picked, picking, onPick, onMove, first, last, onOpen, onChange, onArchive, onLabel, onShare, onCopy, onTemplate, onDelete, onRemind, onToDoc, onToSheet, onToTasks, onHistory, onChat }) {
  const mail = useMailStatus();
  const navigate = useNavigate();
  const toast = useToast();
  const items = n.items || [];
  const open = items.filter((i) => !i.done);
  const done = items.filter((i) => i.done);
  const tick = (it) => onChange({ items: tickItem(items, it.id, !it.done) });
  return (
    <article data-note={n.id} className={`note-card ${dragging ? 'dragging' : ''} ${picked ? 'picked' : ''} ${picking ? 'picking' : ''}`} {...drag} style={n.color ? { background: n.color, color: '#202124' } : undefined} aria-label={n.title || (n.body || items.map((i) => i.text).join(', ')).slice(0, 60) || 'Note'}>
      {onPick && <button type="button" className="note-select" aria-pressed={!!picked} aria-label={`Select note: ${n.title || (n.body || items.map((i) => i.text).join(', ')).slice(0, 60) || 'Note'}`} onClick={onPick}>✓</button>}
      <button type="button" className={`icon-btn note-pin ${n.pinned ? 'on' : ''}`} aria-pressed={n.pinned} aria-label={n.pinned ? 'Unpin note' : 'Pin note'} onClick={() => onChange({ pinned: !n.pinned })}>📌</button>
      <div className="note-open" role="button" tabIndex={0} onClick={picking ? onPick : onOpen} onKeyDown={(e) => { if (e.key === 'Enter') (picking ? onPick : onOpen)(); }}>
        {n.pictures?.length > 0 && (
          <div className={`note-pictures n${Math.min(n.pictures.length, 3)}`}>
            {n.pictures.slice(0, 3).map((pid) => <img key={pid} src={`/api/notes/${n.id}/pictures/${pid}`} alt="" loading="lazy" />)}
          </div>
        )}
        {n.title && <h3>{n.title}</h3>}
        {n.offline && <NotSent />}
        {n.recordings?.length > 0 && <span className="note-rec-chip small" title="Open the note to listen">🎙 {n.recordings.length === 1 ? `Recording ${clock(n.recordings[0].duration_ms)}` : `${n.recordings.length} recordings`}</span>}
        {n.body && <p className="note-body">{n.body.length > 800 ? `${n.body.slice(0, 800)}…` : n.body}</p>}
      </div>
      {items.length > 0 && (
        <ul className="note-checklist">
          {open.slice(0, 12).map((it) => <li key={it.id} className={it.indent ? 'sub' : undefined}><label className="check"><input type="checkbox" checked={false} onChange={() => tick(it)} /> <span>{it.text}</span></label></li>)}
          {open.length > 12 && <li className="muted small">+ {open.length - 12} more</li>}
          {done.length > 0 && <li className="muted small">{done.length} ticked {done.length === 1 ? 'item' : 'items'}</li>}
        </ul>
      )}
      {n.tasks_open > 0 && <div className="note-chips" onClick={(e) => e.stopPropagation()}><TasksAbout url={`/notes?note=${n.id}`} what="note" bump={n.tasks_open} /></div>}
      {n.comments > 0 && (
        <div className="muted small" aria-label={`${n.comments} comment${n.comments === 1 ? '' : 's'}${n.comments_new > 0 ? `, ${n.comments_new} new` : ''}`}>
          💬 {n.comments}{n.comments_new > 0 && <strong className="note-comments-new"> · {n.comments_new} new</strong>}
        </div>
      )}
      {n.comment_match && <div className="muted small note-comment-match" title="Found in a comment">Comment: “{n.comment_match.length > 120 ? `${n.comment_match.slice(0, 119)}…` : n.comment_match}”</div>}
      {(n.labels.length > 0 || n.shared.length > 0 || !n.mine || n.remind_at) && (
        <div className="note-chips">
          {n.remind_at && <span className={`note-chip remind ${n.remind_at < Date.now() ? 'past' : ''}`}>⏰ {reminderText(n.remind_at)}{n.remind_repeat && <span title={REPEAT_CHOICES.find(([v]) => v === n.remind_repeat)?.[1]} aria-label={`repeats ${n.remind_repeat}`}> 🔁</span>}<button type="button" className="chip-x" aria-label="Remove reminder" onClick={() => onRemind(null)}>×</button></span>}
          {n.labels.map((l) => <span key={l} className={`note-chip ${labelColors[l] ? 'coloured' : ''}`} style={labelColors[l] ? { '--lc': labelColors[l] } : undefined}>{l}</span>)}
          {!n.mine && <span title={`Shared by ${n.owner?.name}`}><Avatar name={n.owner?.name} size={22} userId={n.owner?.id} /></span>}
          {n.shared.filter((u) => n.mine || u.id !== n.owner?.id).slice(0, 4).map((u) => <span key={u.id} title={u.name}><Avatar name={u.name} size={22} userId={u.id} /></span>)}
        </div>
      )}
      <div className="row note-tools">
        <Menu align="left" trigger={(p) => <button type="button" className="icon-btn" aria-label="Remind me" title="Remind me" {...p}><Icon name="bell" size={18} /></button>} items={[
          ...quickTimes().map(([label, t]) => ({ label: `${label} · ${reminderText(t)}`, onClick: () => onRemind(t) })),
          { label: 'Pick a day and time…', onClick: () => onRemind('pick') },
          ...(n.remind_at ? [{ label: 'Remove reminder', onClick: () => onRemind(null) }, '-',
            ...REPEAT_CHOICES.map(([v, label]) => ({ label: `${(n.remind_repeat || null) === v ? '✓ ' : ''}${label}`,
              onClick: () => onChange({ remind_repeat: v, ...(v && { remind_tz: Intl.DateTimeFormat().resolvedOptions().timeZone }) }) })),
            ...(n.remind_repeat && n.items ? ['-', { label: `${n.remind_reset ? '✓ ' : ''}Untick the list each time`, onClick: () => onChange({ remind_reset: !n.remind_reset }) }] : [])] : []),
        ]} />
        <ColorPicker value={n.color || ''} onChange={(color) => onChange({ color: color || null })} />
        <PictureButton noteId={n.id} />
        <button type="button" className="icon-btn" aria-label={n.archived ? 'Unarchive' : 'Archive'} title={n.archived ? 'Unarchive' : 'Archive'} onClick={onArchive}><Icon name={n.archived ? 'restore' : 'archive'} size={18} /></button>
        {n.mine && <button type="button" className="icon-btn" aria-label="Share note" title="Share with colleagues" onClick={onShare}><Icon name="share" size={18} /></button>}
        <Menu trigger={(p) => <button type="button" className="icon-btn" aria-label="More" {...p}><Icon name="more" size={18} /></button>} items={[
          ...(onMove ? [{ label: 'Move earlier', onClick: () => onMove(-1), disabled: first }, { label: 'Move later', onClick: () => onMove(1), disabled: last }] : []),
          ...(items?.length > 1 ? [{ label: 'Sort items A–Z', onClick: () => onChange({ items: sortItems(items) }) }] : []), // (sub-items stay with theirs)
          ...(done.length ? [{ label: 'Untick all items', onClick: () => onChange({ items: untickAll(items) }) }, { label: `Delete ticked items (${done.length})`, onClick: () => onChange({ items: dropTicked(items) }) }] : []),
          { label: 'Labels…', onClick: onLabel },
          { label: n.items ? 'Hide tick boxes' : 'Show tick boxes', icon: 'check', onClick: async () => { try { await post(`/notes/${n.id}/convert`, { to: n.items ? 'text' : 'checklist' }); } catch (e) { toast(e.message, 'error'); } } },
          ...(onChat ? [{ label: 'Send in Chat…', icon: 'chat', onClick: onChat }] : []),
          ...(n.shared?.length || !n.mine ? [{ label: 'Chat with people it’s shared with', icon: 'chat', onClick: async () => {
            try { const r = await post(`/notes/${n.id}/chat`, {}); toast(r.created ? 'A channel for this note, with everyone it’s shared with' : r.added ? `Added ${r.added} more to its channel` : 'The note’s channel'); navigate(`/chat/${r.id}`); } catch (e) { toast(e.message, 'error'); }
          } }] : []),
          { label: 'Copy link', icon: 'link', onClick: async () => { const url = noteLink(n); try { await navigator.clipboard.writeText(url); toast('Link to the note copied: people it’s shared with can open it'); } catch { toast(url); } } },
          { label: 'Make a copy', icon: 'copy', onClick: onCopy },
          ...(onTemplate ? [{ label: 'Save as template…', icon: 'copy', onClick: onTemplate }] : []),
          { label: 'Download (.md)', icon: 'download', onClick: () => { window.location.href = `/api/notes/${n.id}/export.md`; } },
          { label: 'Print', icon: 'print', onClick: async () => printHtml(notePrintHtml((await withComments([n], get))[0])) },
          mail?.enabled && { label: 'Send by email', icon: 'mail', onClick: () => {
            // A new email in Mail with the note in it (handed over in this browser's storage, as Docs does).
            try { localStorage.setItem(DRAFT_KEY, JSON.stringify(noteEmail(n, noteLink(n)))); } catch { toast('Your browser’s storage is off', 'error'); return; }
            navigate('/mail?compose_doc=1');
          } },
          { label: 'Version history', icon: 'clock', onClick: onHistory },
          { label: 'Copy to a document', icon: 'doc', onClick: onToDoc },
          n.items && onToSheet && { label: 'Copy to a spreadsheet', icon: 'sheet', onClick: onToSheet },
          { label: 'Schedule time for it…', icon: 'calendar', onClick: () => {
            // A new event in Calendar at the next full hour, with the note in its description: yours to move and save.
            navigate('/calendar', { state: { newEvent: noteEventAt(n, noteLink(n)) } }); // (or the day and time its title names)
          } },
          { label: n.items?.length ? 'Copy unticked items to Tasks' : 'Copy to Tasks', icon: 'check', onClick: onToTasks },
          { label: n.mine ? 'Delete note' : 'Remove from my notes', icon: 'trash', onClick: onDelete },
        ]} />
      </div>
    </article>
  );
}

/** A note open for editing: changes save when it closes (and every few seconds while typing). */
function NoteEditor({ note, onClose }) {
  const toast = useToast();
  const { user } = useAuth();
  const [f, setF] = useState({ title: note.title, body: note.body, items: note.items });
  const dirty = useRef(false);
  const saveRef = useRef(null);
  // Only what was changed here is sent, so a change made elsewhere meanwhile (the title on a phone, say) stays.
  const sent = useRef({ title: note.title, body: note.body, items: note.items });
  const save = useCallback(async () => {
    if (!dirty.current) return;
    dirty.current = false;
    const was = sent.current;
    const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    const body = {
      ...(!same(f.title, was.title) && { title: f.title }),
      ...(f.items ? !same(f.items, was.items) && { items: f.items } : (!same(f.body, was.body) || was.items) && { body: f.body, items: null }),
    };
    if (!Object.keys(body).length) return;
    sent.current = { ...f };
    try { await patch(`/notes/${note.id}`, body); } catch (e) {
      if (unreachable(e)) { await keepChange({ method: 'PATCH', url: `/notes/${note.id}`, body, user: user?.id, label: f.title || 'a note', id: note.id }); return; }
      toast(e.message, 'error');
    }
  }, [f, note.id, toast, user?.id]);
  saveRef.current = save;
  useEffect(() => { const t = setTimeout(() => saveRef.current(), 1500); return () => clearTimeout(t); }, [f]);
  const edit = (patchF) => { dirty.current = true; setF({ ...f, ...patchF }); };
  const close = async () => { await save(); onClose(); };
  return (
    <Modal title={note.title || 'Note'} onClose={close} footer={<><span className="muted small grow">Edited {new Date(note.updated_at).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</span><button type="button" className="btn" onClick={close}>Close</button></>}>
      <div className="stack note-editor" style={note.color ? { background: note.color, color: '#202124', padding: 12, borderRadius: 8 } : undefined}>
        {note.pictures?.length > 0 && (
          <ul className="note-editor-pictures" aria-label="Pictures">
            {note.pictures.map((pid, i) => (
              <li key={pid}><img src={`/api/notes/${note.id}/pictures/${pid}`} alt={`Picture ${i + 1}`} />
                <button type="button" className="chip-x" aria-label={`Remove picture ${i + 1}`} onClick={() => del(`/notes/${note.id}/pictures/${pid}`).catch((e) => toast(e.message, 'error'))}>×</button></li>
            ))}
          </ul>
        )}
        {note.recordings?.length > 0 && (
          <ul className="note-recordings" aria-label="Recordings">
            {note.recordings.map((x, i) => (
              <li key={x.id} className="row">
                <span className="small nowrap">🎙 {i + 1}{x.duration_ms ? ` · ${clock(x.duration_ms)}` : ''}</span>
                <audio controls preload="metadata" src={`/api/notes/${note.id}/recordings/${x.id}`} aria-label={`Recording ${i + 1}`} />
                <button type="button" className="chip-x" aria-label={`Remove recording ${i + 1}`} onClick={() => del(`/notes/${note.id}/recordings/${x.id}`).catch((e) => toast(e.message, 'error'))}>×</button>
              </li>
            ))}
          </ul>
        )}
        <input aria-label="Title" placeholder="Title" value={f.title} maxLength={300} onChange={(e) => edit({ title: e.target.value })} />
        {f.items ? <ChecklistEdit items={f.items} onChange={(items) => edit({ items })} />
          : <textarea aria-label="Note" rows={8} value={f.body} onChange={(e) => edit({ body: e.target.value })} />}
        <div className="row"><PictureButton noteId={note.id} />
          {(note.recordings?.length || 0) < 5 && <VoiceRecorder what="a voice recording" name="Recording" maxSecs={10 * 60} transcribe onDone={(file, ms, words) => {
            // What was said goes on the note too (a new item on a checklist), so it can be read and searched.
            if (words) { dirty.current = true; setF((cur) => (cur.items ? { ...cur, items: [...cur.items, newItem(words)] } : { ...cur, body: cur.body ? `${cur.body}\n\n${words}` : words })); }
            addRecording(note.id, file, ms).then(() => toast(words ? 'Recording added, with what was said' : 'Recording added')).catch((e) => toast(e.message, 'error'));
          }} />}
          <button type="button" className="link-btn small" onClick={() => edit(f.items ? { items: null, body: f.items.map((i) => i.text).filter(Boolean).join('\n') } : { items: (f.body ? f.body.split('\n') : ['']).map((t) => newItem(t)), body: '' })}>
          {f.items ? 'Change to plain text' : 'Change to a checklist'}</button></div>
      </div>
      {(note.shared?.length > 0 || note.comments > 0) && <NoteComments note={note} />}
    </Modal>
  );
}

/** Comments on a shared note: everyone on it can write one (the others are told); your own, or any on your note, can be deleted. */
function NoteComments({ note }) {
  const toast = useToast();
  const { user } = useAuth();
  const [list, setList] = useState(null);
  const [text, setText] = useState('');
  const [editing, setEditing] = useState(null); // { id, text }: your comment being changed
  const [added, setAdded] = useState([]); // addresses just shared with (until the note catches up)
  const box = useRef(null);
  const mention = useMentions(box, text, setText); // "@" plus a few letters suggests people to mention
  const load = useCallback(() => get(`/notes/${note.id}/comments`).then(setList).catch(() => setList([])), [note.id]);
  const saveEdit = async (e) => {
    e.preventDefault();
    if (!editing.text.trim()) return;
    try { setList(await patch(`/notes/${note.id}/comments/${editing.id}`, { text: editing.text })); setEditing(null); } catch (err) { toast(err.message, 'error'); }
  };
  useEffect(() => { load(); }, [load]);
  useEffect(() => onLive((m) => { if (m.type === 'notes-changed') load(); }), [load]);
  const send = async (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    try { setList(await post(`/notes/${note.id}/comments`, { text })); setText(''); } catch (err) { toast(err.message, 'error'); }
  };
  return (
    <section className="stack-tight" aria-label="Comments" style={{ marginTop: 12 }}>
      <strong className="small">Comments{list?.length ? ` (${list.length})` : ''}</strong>
      {list?.map((c) => (
        <div key={c.id} className="row" style={{ alignItems: 'flex-start', gap: 8 }}>
          <span className="grow"><strong className="small">{c.by.name}</strong> <span className="muted small">{new Date(c.at).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}{c.edited_at && ' (edited)'}</span><br />
            {editing?.id === c.id
              ? (
                <form className="row" onSubmit={saveEdit} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setEditing(null); } }}>
                  <input className="grow" aria-label="Change your comment" maxLength={2000} autoFocus value={editing.text} onChange={(e) => setEditing({ ...editing, text: e.target.value })} />
                  <button className="btn small" disabled={!editing.text.trim()}>Save</button>
                  <button type="button" className="btn small" onClick={() => setEditing(null)}>Cancel</button>
                </form>
                )
              : <span style={{ whiteSpace: 'pre-wrap' }}><LinkedText text={c.text} /></span>}
            <ReactionBar list={c.reactions || []} onReact={async (emoji) => { try { setList(await post(`/notes/${note.id}/comments/${c.id}/reactions`, { emoji })); } catch (err) { toast(err.message, 'error'); } }} />
          </span>
          {c.by.id === user?.id && editing?.id !== c.id && <button type="button" className="icon-btn" aria-label="Edit your comment" title="Edit" onClick={() => setEditing({ id: c.id, text: c.text })}><Icon name="edit" size={14} /></button>}
          {(c.by.id === user?.id || note.mine) && <button type="button" className="icon-btn" aria-label={`Delete ${c.by.name}’s comment`} onClick={async () => { try { setList(await del(`/notes/${note.id}/comments/${c.id}`)); } catch (err) { toast(err.message, 'error'); } }}><Icon name="close" size={14} /></button>}
        </div>
      ))}
      {/* someone mentioned who isn't on the note won't be told (or see it) */}
      {(() => {
        const on = new Set([...[note.owner, ...(note.shared || [])].map((p) => String(p?.username || '').toLowerCase()), ...added].filter(Boolean));
        const off = [...new Set([...text.matchAll(/@([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/gi)].map((m) => m[1].toLowerCase()))].filter((e) => !on.has(e));
        const share = async () => { try { await put(`/notes/${note.id}/shares`, { add: off }); setAdded([...added, ...off]); toast(`Note shared with ${off.join(', ')}`); } catch (err) { toast(err.message, 'error'); } };
        return off.length > 0 && (
          <p className="small muted row wrap" role="status" style={{ margin: 0, gap: 8 }}>{off.map((e) => `@${e}`).join(', ')} {off.length === 1 ? "isn't" : "aren't"} on this note, so won't be told. {note.mine ? '' : 'Only its owner can share it.'}
            {note.mine && <button type="button" className="btn small" onClick={share}>Share the note with {off.length === 1 ? 'them' : `all ${off.length}`}</button>}</p>
        );
      })()}
      <form className="row" onSubmit={send}>
        <div className="mention-box grow">
          <input ref={box} style={{ width: '100%' }} aria-label="Write a comment" placeholder="Write a comment (@ to mention someone)" maxLength={2000} value={text}
            onChange={(e) => { setText(e.target.value); mention.track(e.target.value, e.target.selectionStart); }} onKeyDown={(e) => mention.keyDown(e)} onBlur={() => mention.close()} />
          {mention.list}
        </div>
        <button className="btn small" disabled={!text.trim()}>Comment</button>
      </form>
    </section>
  );
}

function ShareNote({ note, onClose }) {
  const toast = useToast();
  const [people, setPeople] = useState([]);
  const [chosen, setChosen] = useState(new Set(note.shared.map((u) => u.id)));
  useEffect(() => { get('/users/directory').then((l) => setPeople(l.filter((p) => p.id !== note.owner?.id))).catch(() => {}); }, [note.owner?.id]);
  const [message, setMessage] = useState(''); // for the people added now
  const had = new Set(note.shared.map((u) => u.id));
  const adding = [...chosen].filter((id) => !had.has(id));
  const save = async () => { try { await put(`/notes/${note.id}/shares`, { user_ids: [...chosen], ...(message.trim() && { message: message.trim() }) }); toast('Sharing updated'); onClose(); } catch (e) { toast(e.message, 'error'); } };
  return (
    <Modal title="Share note" onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" onClick={save}>Save</button></>}>
      <p className="muted small" style={{ marginTop: 0 }}>People you share it with can change it and see changes as they're made. Only you can delete it.</p>
      <PeopleTicks people={people} chosen={chosen} label="Colleagues" onToggle={(id, on) => { const n = new Set(chosen); on ? n.add(id) : n.delete(id); setChosen(n); }} onAddMany={(ids) => setChosen(new Set([...chosen, ...ids]))} />
      {adding.length > 0 && (
        <label className="field"><span>Message to {adding.length === 1 ? people.find((p) => p.id === adding[0])?.name || 'them' : 'the people you added'} (optional)</span>
          <textarea rows={2} maxLength={500} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Why you’re sharing it…" /></label>
      )}
    </Modal>
  );
}

/** Several notes of yours shared with more colleagues at once: added to whoever has each already. */
function ShareMany({ count, me, onShare, onClose }) {
  const [people, setPeople] = useState([]);
  const [chosen, setChosen] = useState(new Set());
  useEffect(() => { get('/users/directory').then((l) => setPeople(l.filter((p) => p.id !== me))).catch(() => {}); }, [me]);
  const share = async () => { await onShare([...chosen]); onClose(); };
  return (
    <Modal title={`Share ${count === 1 ? '1 note' : `${count} notes`}`} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" disabled={!chosen.size} onClick={share}>Share</button></>}>
      <p className="muted small" style={{ marginTop: 0 }}>The people you tick can change them and see changes as they're made; anyone who has one already keeps it. They're told once.</p>
      <PeopleTicks people={people} chosen={chosen} label="Colleagues" onToggle={(id, on) => { const n = new Set(chosen); on ? n.add(id) : n.delete(id); setChosen(n); }} onAddMany={(ids) => setChosen(new Set([...chosen, ...ids]))} />
    </Modal>
  );
}

function LabelNote({ note, all, onSave, onClose }) {
  const [chosen, setChosen] = useState(new Set(note.labels));
  const [adding, setAdding] = useState(false);
  const names = [...new Set([...all, ...chosen])].sort((a, b) => a.localeCompare(b));
  // Find or make a label: typing narrows the list; a name that isn't a label yet can be made (and ticked) from here.
  const [find, setFind] = useState('');
  const typed = find.trim().slice(0, 40);
  const shown = names.filter((l) => has(l, typed));
  const fresh = typed && !names.some((l) => l.toLowerCase() === typed.toLowerCase());
  const make = () => { setChosen(new Set([...chosen, typed])); setFind(''); };
  if (adding) return <PromptModal title="New label" label="Label" confirm="Add" onClose={() => setAdding(false)} onSubmit={async (name) => { setChosen(new Set([...chosen, name.trim().slice(0, 40)])); setAdding(false); }} />;
  return (
    <Modal title="Labels" onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" onClick={() => onSave([...chosen])}>Save</button></>}>
      <div className="stack-tight">
        <input type="search" aria-label="Find or make a label" placeholder="Find or make a label" value={find} onChange={(e) => setFind(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (shown.length === 1) { const n = new Set(chosen); n.add(shown[0]); setChosen(n); setFind(''); } else if (fresh) make(); } }} />
        {shown.map((l) => <label key={l} className="check"><input type="checkbox" checked={chosen.has(l)} onChange={(e) => { const n = new Set(chosen); e.target.checked ? n.add(l) : n.delete(l); setChosen(n); }} /> {l}</label>)}
        {fresh ? <div><button type="button" className="link-btn" onClick={make}>+ Make label “{typed}”</button></div>
          : <div><button type="button" className="link-btn" onClick={() => setAdding(true)}>+ New label</button></div>}
      </div>
    </Modal>
  );
}

/** Earlier versions of a note: pick one to see it, Restore puts it back. */
function NoteHistory({ note, onClose, onRestored }) {
  const toast = useToast();
  const [list, setList] = useState(null);
  const [pick, setPick] = useState(0);
  useEffect(() => { get(`/notes/${note.id}/versions`).then(setList).catch((e) => { toast(e.message, 'error'); setList([]); }); }, [note.id, toast]);
  const v = list?.[pick];
  const when = (t) => new Date(t).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  return (
    <Modal wide title={`Version history: ${note.title || 'Untitled note'}`} onClose={onClose}
      footer={v && <button type="button" className="btn primary" onClick={async () => { try { await post(`/notes/${note.id}/versions/${v.id}/restore`); onRestored(); } catch (e) { toast(e.message, 'error'); } }}>Restore this version</button>}>
      {list === null ? <p className="muted">Loading…</p> : !list.length ? <p className="muted">No earlier versions yet. A version is kept when someone else changes the note, or when you come back to it after a while.</p> : (
        <div className="note-history">
          <ul className="note-versions" aria-label="Versions">
            {list.map((x, i) => (
              <li key={x.id}><button type="button" className={i === pick ? 'on' : ''} aria-pressed={i === pick} onClick={() => setPick(i)}>
                <strong>{when(x.saved_at)}</strong><span className="muted small">{x.saved_by}</span></button></li>
            ))}
          </ul>
          <article className="note-version-preview" aria-label="This version">
            {v.title && <h3 style={{ marginTop: 0 }}>{v.title}</h3>}
            {v.items ? <ul className="note-version-items">{v.items.map((it) => <li key={it.id}>{it.done ? '☑' : '☐'} {it.text}</li>)}</ul> : <p style={{ whiteSpace: 'pre-wrap' }}>{v.body}</p>}
          </article>
        </div>
      )}
    </Modal>
  );
}

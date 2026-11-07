// Tasks: your to-do lists and the ones colleagues share with you. Add a task with Enter, tick it
// off, drag it into place, and open it for notes, a due date, who it's for, or another list.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { get, post, patch, put, del, onLive } from '../../api.js';
import Icon from '../../components/Icon.jsx';
import { Avatar, ConfirmModal, Empty, Menu, Modal, PromptModal, useToast } from '../../components/ui.jsx';
import { useAuth } from '../../App.jsx';
import { dueLabel, between, localToday, REPEATS, repeatText } from './taskmath.js';

const ASSIGNED = 'assigned';
const IMPORTANT = 'important'; // tasks marked ★ on any of your lists
const VIRTUAL = { [ASSIGNED]: '/tasks/assigned', [IMPORTANT]: '/tasks/important' };

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
  const virtual = !!VIRTUAL[listId];
  const [tasks, setTasks] = useState(null);
  const [title, setTitle] = useState('');
  const [found, setFound] = useState(null); // { q, list }: search results across your lists
  const runSearch = async (text) => {
    const qs = String(text || '').trim();
    if (!qs) { setFound(null); return; }
    try { setFound({ q: qs, list: await get(`/tasks/search?q=${encodeURIComponent(qs)}`) }); } catch (e) { toast(e.message, 'error'); }
  };
  const [showDone, setShowDone] = useState(false);
  const [dialog, setDialog] = useState(null); // 'new' | 'rename' | 'share' | 'delete'
  const [dragging, setDragging] = useState(null);
  const [dropAt, setDropAt] = useState(null); // index the dragged task would go before
  const addBox = useRef();

  const loadLists = useCallback(() => get('/tasks/lists').then((r) => { setLists(r.lists); setAssignedCount(r.assigned); setImportantCount(r.important || 0); }).catch((e) => toast(e.message, 'error')), [toast]);
  const loadTasks = useCallback(() => {
    if (!listId) return Promise.resolve();
    return get(VIRTUAL[listId] || `/tasks/lists/${listId}/tasks`).then(setTasks).catch((e) => { toast(e.message, 'error'); navigate('/tasks', { replace: true }); });
  }, [listId, toast, navigate]);
  useEffect(() => { loadLists(); }, [loadLists]);
  useEffect(() => { setTasks(null); loadTasks(); }, [loadTasks]);
  useEffect(() => onLive((m) => {
    if (m.type === 'tasks-changed') { loadLists(); if (m.list_id === listId || VIRTUAL[listId]) loadTasks(); }
    if (m.type === 'live-connected') { loadLists(); loadTasks(); }
  }), [listId, loadLists, loadTasks]);
  // No list picked: your first one.
  useEffect(() => { if (!listId && lists?.length) navigate(`/tasks/${lists[0].id}`, { replace: true }); }, [listId, lists, navigate]);

  const list = lists?.find((l) => l.id === listId);
  const people = list ? [{ id: list.owner_id, name: list.owner_name }, ...list.members] : [];
  const open = (tasks || []).filter((t) => !t.done);
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
  async function add(e) {
    e.preventDefault();
    const text = title.trim();
    if (!text || !list) return;
    setTitle('');
    try { await post(`/tasks/lists/${list.id}/tasks`, { title: text }); loadTasks(); loadLists(); }
    catch (err) { toast(err.message, 'error'); setTitle(text); }
  }
  function drop(index) {
    const t = open.find((x) => x.id === dragging);
    setDragging(null); setDropAt(null);
    if (!t) return;
    const rest = open.filter((x) => x.id !== t.id);
    const at = Math.min(index - (open.indexOf(t) < index ? 1 : 0), rest.length);
    if (rest[at - 1]?.id === open[open.indexOf(t) - 1]?.id && rest[at]?.id === open[open.indexOf(t) + 1]?.id) return; // same place
    const position = between(rest[at - 1]?.position, rest[at]?.position);
    setTasks((all) => [...rest.slice(0, at), { ...t, position }, ...rest.slice(at), ...done]);
    update(t, { position });
  }

  const row = (t, i) => {
    const due = t.due && dueLabel(t.due);
    return (
      <li key={t.id} className={`task ${t.done ? 'done' : ''} ${t.id === openId ? 'open' : ''} ${dropAt === i && dragging ? 'drop-before' : ''}`}
        draggable={!t.done && !virtual} onDragStart={(e) => { setDragging(t.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', t.title); }}
        onDragEnd={() => { setDragging(null); setDropAt(null); }}
        onDragOver={(e) => { if (!dragging || t.done) return; e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(); setDropAt(e.clientY < r.top + r.height / 2 ? i : i + 1); }}
        onDrop={(e) => { if (!dragging) return; e.preventDefault(); drop(dropAt ?? i); }}>
        <input type="checkbox" checked={t.done} aria-label={`Done: ${t.title}`} onChange={() => toggle(t)} />
        <button type="button" className="task-main" onClick={() => (virtual ? navigate(`/tasks/${t.list_id}?task=${t.id}`) : show(t.id === openId ? null : t.id))}>
          <span className="task-title">{t.title}</span>
          <span className="task-meta">
            {virtual && <span className="muted small">{t.list_name}</span>}
            {t.notes && <span className="muted small ellipsis task-notes">{t.notes.split('\n')[0]}</span>}
            {due && <span className={`pill due ${due.tone}`}>{due.text}</span>}
            {t.steps?.length > 0 && <span className={`muted small task-steps ${t.steps.every((x) => x.done) ? 'all' : ''}`} title="Steps done">☑ {t.steps.filter((x) => x.done).length}/{t.steps.length}</span>}
            {t.repeat && !t.done && <span className="muted small task-repeat" title={`Repeats: ${repeatText(t.repeat).toLowerCase()}`}>⟳ {repeatText(t.repeat)}</span>}
          </span>
        </button>
        {t.assignee_name && <span title={`For ${t.assignee_name}`}><Avatar name={t.assignee_name} size={24} /></span>}
        {!t.done && <button type="button" className={`icon-btn task-star ${t.important ? 'on' : ''}`} aria-pressed={!!t.important} aria-label={`${t.important ? 'Not important' : 'Mark important'}: ${t.title}`}
          title={t.important ? 'Important (click to unmark)' : 'Mark important'} onClick={() => update(t, { important: !t.important })}>{t.important ? '★' : '☆'}</button>}
      </li>
    );
  };

  if (lists === null) return null;
  const heading = listId === ASSIGNED ? 'Assigned to me' : listId === IMPORTANT ? 'Important' : list?.name;
  return (
    <div className="tasks-app">
      <aside className="subnav">
        <form className="tasks-search" role="search" onSubmit={(e) => { e.preventDefault(); runSearch(new FormData(e.currentTarget).get('q')); }}>
          <Icon name="search" size={18} />
          <input name="q" type="search" placeholder="Search tasks" aria-label="Search tasks" onChange={(e) => { if (!e.target.value) setFound(null); }} />
        </form>
        <button type="button" className={`subnav-item ${listId === ASSIGNED ? 'active' : ''}`} onClick={() => navigate(`/tasks/${ASSIGNED}`)}>
          <Icon name="person" /><span className="grow">Assigned to me</span>{assignedCount > 0 && <span className="count">{assignedCount}</span>}
        </button>
        <button type="button" className={`subnav-item ${listId === IMPORTANT ? 'active' : ''}`} onClick={() => navigate(`/tasks/${IMPORTANT}`)}>
          <span className="nav-star" aria-hidden="true">★</span><span className="grow">Important</span>{importantCount > 0 && <span className="count">{importantCount}</span>}
        </button>
        <div className="subnav-title row">Lists<div className="grow" /><button type="button" className="icon-btn" aria-label="New list" onClick={() => setDialog('new')}><Icon name="plus" size={18} /></button></div>
        {lists.map((l) => (
          <button key={l.id} type="button" className={`subnav-item ${l.id === listId ? 'active' : ''}`} onClick={() => navigate(`/tasks/${l.id}`)}>
            <Icon name={l.mine && !l.members.length ? 'check' : 'people'} /><span className="grow ellipsis">{l.name}</span>{l.open > 0 && <span className="count">{l.open}</span>}
          </button>
        ))}
      </aside>
      {found && (
        <section className="tasks-main">
          <div className="page-head"><h1 className="grow ellipsis">Tasks matching “{found.q}”</h1><button type="button" className="icon-btn" aria-label="Close search" onClick={() => setFound(null)}><Icon name="close" /></button></div>
          {!found.list.length ? <Empty icon="search" title="No tasks found" /> : (
            <ul className="tasks task-results" aria-label="Search results">
              {found.list.map((t) => {
                const due = t.due && dueLabel(t.due);
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
          <h1 className="grow ellipsis">{heading}</h1>
          {list && !list.mine && <span className="muted small">Shared by {list.owner_name}</span>}
          {list?.mine && <button type="button" className="btn" onClick={() => setDialog('share')}><Icon name="share" size={18} /> {list.members.length ? `Shared with ${list.members.length}` : 'Share'}</button>}
          {list && (
            <Menu trigger={(p) => <button type="button" className="icon-btn" aria-label="List actions" {...p}><Icon name="more" /></button>} items={[
              ...(list.mine ? [{ label: 'Rename list', icon: 'edit', onClick: () => setDialog('rename') }] : []),
              ...(done.length ? [{ label: `Delete completed tasks (${done.length})`, icon: 'check', onClick: async () => { await del(`/tasks/lists/${list.id}/done`); loadTasks(); } }] : []),
              list.mine ? { label: 'Delete list', icon: 'trash', danger: true, onClick: () => setDialog('delete') } : { label: 'Leave list', icon: 'logout', onClick: () => setDialog('delete') },
            ]} />
          )}
        </div>
        {list && (
          <form className="task-add" onSubmit={add}>
            <Icon name="plus" />
            <input ref={addBox} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a task" aria-label="Add a task" maxLength={500} />
          </form>
        )}
        {tasks === null ? null : open.length === 0 && done.length === 0 ? (
          <Empty icon="check" title={listId === ASSIGNED ? 'Nothing assigned to you' : listId === IMPORTANT ? 'Nothing important' : 'No tasks yet'}>{listId === ASSIGNED ? 'Tasks people give you on shared lists show up here.' : listId === IMPORTANT ? 'Mark a task with ☆ and it shows up here, from every list.' : 'Type a task above and press Enter.'}</Empty>
        ) : (
          <>
            <ul className="task-list" aria-label="Tasks" onDragOver={(e) => dragging && e.preventDefault()} onDrop={(e) => { if (dragging && dropAt === null) { e.preventDefault(); drop(open.length); } }}>
              {open.map(row)}
              {dragging && dropAt === open.length && <li className="drop-end" aria-hidden="true" />}
            </ul>
            {open.length === 0 && <p className="muted tasks-alldone">All done 🎉</p>}
            {done.length > 0 && (
              <>
                <button type="button" className="link-btn tasks-done-toggle" aria-expanded={showDone} onClick={() => setShowDone(!showDone)}>{showDone ? '▾' : '▸'} Completed ({done.length})</button>
                {showDone && <ul className="task-list" aria-label="Completed tasks">{done.map(row)}</ul>}
              </>
            )}
          </>
        )}
      </section>
      {current && list && <TaskDetails key={current.id} task={current} lists={lists} people={people} onChange={(c) => update(current, c)} onClose={() => show(null)}
        onReplaced={(next) => setTasks((all) => all && all.map((x) => (x.id === next.id ? next : x)))}
        onDelete={async () => { show(null); try { await del(`/tasks/tasks/${current.id}`); toast('Task deleted'); loadTasks(); } catch (e) { toast(e.message, 'error'); } }}
        onMove={async (to) => { show(null); if (await update(current, { list_id: to })) toast(`Moved to ${lists.find((l) => l.id === to)?.name}`); }} />}
      {dialog === 'new' && <PromptModal title="New list" label="List name" confirm="Create" onClose={() => setDialog(null)}
        onSubmit={async (name) => { const r = await post('/tasks/lists', { name }); await loadLists(); navigate(`/tasks/${r.id}`); }} />}
      {dialog === 'rename' && list && <PromptModal title="Rename list" label="List name" initial={list.name} confirm="Rename" onClose={() => setDialog(null)}
        onSubmit={async (name) => { await patch(`/tasks/lists/${list.id}`, { name }); loadLists(); }} />}
      {dialog === 'share' && list && <ShareList list={list} me={user} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); loadLists(); }} />}
      {dialog === 'delete' && list && (
        <ConfirmModal title={list.mine ? `Delete “${list.name}”?` : `Leave “${list.name}”?`} confirm={list.mine ? 'Delete list' : 'Leave'}
          message={list.mine ? `Its ${open.length + done.length} task${open.length + done.length === 1 ? '' : 's'} go too${list.members.length ? ', for everyone it’s shared with' : ''}.` : 'You won’t see it any more, and tasks given to you on it become nobody’s.'}
          onClose={() => setDialog(null)} onConfirm={async () => { await del(`/tasks/lists/${list.id}`); setDialog(null); await loadLists(); navigate('/tasks'); }} />
      )}
    </div>
  );
}

/** A task's details beside the list: changes save as you make them. */
function TaskDetails({ task, lists, people, onChange, onClose, onDelete, onMove, onReplaced }) {
  const [title, setTitle] = useState(task.title);
  const [notes, setNotes] = useState(task.notes || '');
  useEffect(() => { setTitle(task.title); }, [task.title]);
  useEffect(() => { setNotes(task.notes || ''); }, [task.notes]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('.modal-backdrop')) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const saveTitle = () => { const t = title.trim(); if (!t) setTitle(task.title); else if (t !== task.title) onChange({ title: t }); };
  return (
    <aside className="task-details" aria-label="Task details">
      <div className="row"><strong className="grow">Details</strong><button type="button" className="icon-btn" aria-label="Close details" onClick={onClose}><Icon name="close" /></button></div>
      <label className="field"><span>Task</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} onBlur={saveTitle} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} maxLength={500} />
      </label>
      <label className="field"><span>Notes</span>
        <textarea rows={5} value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={() => { if (notes.trim() !== (task.notes || '')) onChange({ notes: notes.trim() || null }); }} />
      </label>
      <Steps task={task} onReplaced={onReplaced} />
      <label className="field"><span>Due</span>
        <span className="row"><input type="date" value={task.due || ''} onChange={(e) => onChange({ due: e.target.value || null })} />
          {task.due && <button type="button" className="link-btn small" onClick={() => onChange({ due: null })}>Clear</button>}</span>
      </label>
      <label className="field"><span>Repeat</span>
        <select value={task.repeat || ''} onChange={(e) => onChange({ repeat: e.target.value || null, ...(!task.due && e.target.value && { due: localToday() }) })}>
          {REPEATS.map(([v, n]) => <option key={v} value={v}>{n}</option>)}
        </select>
        {task.repeat && <span className="muted small">When you tick it off, the next one is added{task.due ? '' : ' (it needs a due date)'}.</span>}
      </label>
      {people.length > 1 && (
        <label className="field"><span>Assigned to</span>
          <select value={task.assignee_id || ''} onChange={(e) => onChange({ assignee_id: e.target.value || null })}>
            <option value="">Nobody</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
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
      <div className="row"><button type="button" className="btn danger" onClick={onDelete}><Icon name="trash" size={16} /> Delete task</button></div>
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
            <Avatar name={p.name} size={24} /><span className="grow">{p.name} <span className="muted small">{p.username}</span></span>
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
